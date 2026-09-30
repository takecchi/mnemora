import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0407: `observe({ extract: "sync" })` が積む extract のジョブは、observe が LLM を待っている間、
 * tick に claim されない（observe がリースを持った状態で作る）。
 *
 * 穴（D-1）: 以前は「すぐ claim できる状態」で作っていたため、observe が LLM を待つ間に tick が
 * 同じジョブを claim し、LLM が2回呼ばれ、中身の違う記憶が2件とも active で残り、observe は
 * `complete` が `OutboxLeaseConflictError` で落ちて `memoryIds` を返せなかった。
 *
 * 順序は時計と門（Promise）で決める。タイミングには頼らない。
 */

let nowMs = 0;
const clock = { now: () => new Date(nowMs) };
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}
function gate(): Gate {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Step {
  content: string;
  /** 在れば、呼ばれたことを `entered` で知らせ、`hold` が解決するまで返さない。 */
  hold?: Promise<void>;
  entered?: () => void;
}
let steps: Step[] = [];
let llmCalls = 0;
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    llmCalls += 1;
    const step = steps.shift();
    if (step === undefined) throw new Error("unexpected LLM call");
    step.entered?.();
    if (step.hold !== undefined) await step.hold;
    return req.schema.parse({
      memories: [{ content: step.content, provenanceKind: "stated" }],
    });
  },
};

const ctx: Ctx = { tenantId: "observe-sync-extract-job-lease" };

async function makeKit() {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock,
    memoryStore: new PostgresMemoryStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  });
  return { runtime, pool };
}

async function activeContents(pool: Awaited<ReturnType<typeof makeKit>>["pool"]) {
  return (
    await pool.query(
      `SELECT content FROM memories WHERE tenant_id = $1 AND status = 'active' ORDER BY content`,
      [ctx.tenantId],
    )
  ).rows.map((r) => r.content as string);
}

async function extractJobs(pool: Awaited<ReturnType<typeof makeKit>>["pool"]) {
  return (
    await pool.query(
      `SELECT completed_at IS NOT NULL AS completed, failed_at IS NOT NULL AS failed
         FROM outbox WHERE tenant_id = $1 AND kind = 'extract'`,
      [ctx.tenantId],
    )
  ).rows;
}

afterAll(async () => {
  await closeTestClient();
});

describe("Postgres: sync observe が積んだ extract のジョブは、observe が持っている間 claim されない（ADR 0407）", () => {
  it("LLM を待つ間に tick が走っても、LLM は1回・active は1件・observe は memoryIds を返す", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = await makeKit();
    const hold = gate();
    const entered = gate();
    steps = [
      { content: "候補A", hold: hold.promise, entered: entered.resolve },
      { content: "候補B" }, // tick が claim してしまった場合にだけ使われる
    ];
    const observing = kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });
    await entered.promise;

    nowMs = T0 + 1000; // リースの内側
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(tick.processed).toBe(0);
    expect(tick.leaseConflicts).toEqual([]);

    hold.resolve();
    const result = await observing;
    expect(result.memoryIds).toHaveLength(1);
    expect(llmCalls).toBe(1);
    expect(await activeContents(kit.pool)).toEqual(["候補A"]);
    expect(await extractJobs(kit.pool)).toEqual([{ completed: true, failed: false }]);
  });

  it("observe が LLM の途中で死んだ（戻らない）とき、リースが切れた後は tick が拾う", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = await makeKit();
    const entered = gate();
    steps = [
      { content: "死んだ observe", hold: new Promise<void>(() => {}), entered: entered.resolve },
      { content: "候補B" },
    ];
    void kit.runtime.observe(ctx, { kind: "utterance", text: "発話" }).catch(() => {});
    await entered.promise;

    nowMs = T0 + LEASE_MS + 1;
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(tick.processed).toBe(1);
    expect(await activeContents(kit.pool)).toEqual(["候補B"]);
    expect(await extractJobs(kit.pool)).toEqual([{ completed: true, failed: false }]);
  });

  it("LLM がリースより長くかかり tick に取り直されても、書き込み済みの observe は例外を投げず memoryIds を返す", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = await makeKit();
    const hold = gate();
    const entered = gate();
    steps = [
      { content: "候補A", hold: hold.promise, entered: entered.resolve },
      { content: "候補B" },
    ];
    const observing = kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });
    await entered.promise;

    nowMs = T0 + LEASE_MS + 1; // リース切れ
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(tick.processed).toBe(1);

    hold.resolve();
    const result = await observing; // 例外を投げない
    expect(result.memoryIds).toHaveLength(1);
    expect(await extractJobs(kit.pool)).toEqual([{ completed: true, failed: false }]);
  });
});
