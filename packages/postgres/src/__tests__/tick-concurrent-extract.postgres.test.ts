import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, TickResult } from "@mnemora/core";
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
 * 並行の2本の配達で extract のジョブが今どうなるかを、Postgres で実測して縛る。
 * **今の振る舞いを縛る歯であり、望ましい姿ではない。**直すなら、この歯を先に書き換えること。
 *
 * 順序はタイミングではなく、時計と門（Promise）で決める。
 * 1. tick①が extract のジョブを claim し、事前の確認（ADR 0347 決定1）を通って LLM の中で門に止まる。
 * 2. 時計をリースより先へ進め、tick②が同じジョブを claim（attempts 2）し、事前の確認を通って書き、`complete` する。
 * 3. ①の門を開ける。①は自分の LLM の結果を書き、`complete` がリース競合で弾かれる。
 * 2つの tick は1本のテストの中で `Promise.all` で走らせる（プロセスを並列に起こさない）。
 */

let nowMs = 0;
const clock = { now: () => new Date(nowMs) };

interface LlmStep {
  /** 返す候補の本文。`null` は LLM の失敗（全文フォールバックへ倒れる）。 */
  output: readonly string[] | null;
  /** 在れば、呼ばれたことを `entered` で知らせ、`gate` が解決するまで返さない。 */
  gate?: Promise<void>;
  entered?: () => void;
}
let steps: LlmStep[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    const step = steps.shift();
    if (step === undefined) throw new Error("unexpected LLM call");
    step.entered?.();
    if (step.gate !== undefined) await step.gate;
    if (step.output === null) throw new Error("LLM が落ちた");
    return req.schema.parse({
      memories: step.output.map((content) => ({ content, provenanceKind: "stated" })),
    });
  },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ctx: Ctx = { tenantId: "tick-concurrent-extract" };
const LEASE_MS = 60_000;

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

/** ①が LLM の中で止まっている間に②が claim して終わらせ、その後で①を進める。 */
async function runConcurrently(first: LlmStep["output"], second: LlmStep["output"]) {
  nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  const kit = await makeKit();
  const firstGate = deferred();
  const firstEntered = deferred();
  steps = [
    { output: first, gate: firstGate.promise, entered: firstEntered.resolve },
    { output: second },
  ];
  const { observationId } = await kit.runtime.observe(ctx, {
    kind: "utterance",
    text: "発話",
    extract: "deferred",
  });
  nowMs += 1000;
  const [firstResult, secondResult] = await Promise.all([
    kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS, claimedBy: "worker-1" }),
    (async (): Promise<TickResult> => {
      await firstEntered.promise;
      nowMs += LEASE_MS * 2;
      const result = await kit.runtime.tick(ctx, {
        kinds: ["extract"],
        leaseMs: LEASE_MS,
        claimedBy: "worker-2",
      });
      firstGate.resolve();
      return result;
    })(),
  ]);
  expect(steps).toEqual([]);
  const memories = (
    await kit.pool.query(
      `SELECT status, content, source_observation_id AS obs FROM memories
        WHERE tenant_id = $1 ORDER BY content`,
      [ctx.tenantId],
    )
  ).rows.map((r) => ({ status: r.status, content: r.content, obs: r.obs }));
  const created = (
    await kit.pool.query(
      `SELECT meta->>'reason' AS reason FROM memory_events
        WHERE tenant_id = $1 AND kind = 'created' ORDER BY meta->>'reason'`,
      [ctx.tenantId],
    )
  ).rows.map((r) => r.reason as string);
  const outbox = (
    await kit.pool.query(
      `SELECT kind, attempts, claimed_by, completed_at IS NOT NULL AS completed,
              failed_at IS NOT NULL AS failed
         FROM outbox WHERE tenant_id = $1 ORDER BY kind, created_at`,
      [ctx.tenantId],
    )
  ).rows;
  const summary = (r: TickResult) => ({
    processed: r.processed,
    failed: r.failed,
    leaseConflicts: r.leaseConflicts.map((c) => ({ kind: c.kind, outcome: c.attemptedOutcome })),
  });
  return {
    observationId,
    memories,
    created,
    outbox,
    first: summary(firstResult),
    second: summary(secondResult),
  };
}

afterAll(async () => {
  await closeTestClient();
});

describe("Postgres: extract のジョブの並行の2本の配達（今の振る舞い。ADR 0347 の 2026-09-28 追記）", () => {
  // どの形でも、outbox と TickResult は同じ: ②が完了させ、遅れた①は complete がリース競合に載る。
  // ①は processed にも failed にも数えられない（`OutboxLeaseConflict` の doc）。
  const expectLeaseOutcome = (got: Awaited<ReturnType<typeof runConcurrently>>) => {
    expect(got.second).toEqual({ processed: 1, failed: 0, leaseConflicts: [] });
    expect(got.first).toEqual({
      processed: 0,
      failed: 0,
      leaseConflicts: [{ kind: "extract", outcome: "complete" }],
    });
    expect(got.outbox.filter((j) => j.kind === "extract")).toEqual([
      { kind: "extract", attempts: 2, claimed_by: "worker-2", completed: true, failed: false },
    ]);
  };

  it("違う本文（① A・② B）: 2件とも active で残る（事前の確認は塞がない。#1092 の L1）", async () => {
    const got = await runConcurrently(["候補A"], ["候補B"]);
    expect(got.memories).toEqual([
      { status: "active", content: "候補A", obs: got.observationId },
      { status: "active", content: "候補B", obs: got.observationId },
    ]);
    expect(got.created).toEqual(["extracted", "extracted"]);
    // 2件とも embed のジョブを積む。
    expect(got.outbox.filter((j) => j.kind === "embed")).toHaveLength(2);
    expectLeaseOutcome(got);
  });

  it("同じ本文（① A・② A）: 1件のまま（冪等の鍵で同じ行に当たる）", async () => {
    const got = await runConcurrently(["候補A"], ["候補A"]);
    expect(got.memories).toEqual([{ status: "active", content: "候補A", obs: got.observationId }]);
    expect(got.created).toEqual(["extracted"]);
    expect(got.outbox.filter((j) => j.kind === "embed")).toHaveLength(1);
    expectLeaseOutcome(got);
  });

  it("遅れた①の LLM が失敗（② B の後）: B と全文フォールバックの2件が active で残る（#1092 の L5）", async () => {
    const got = await runConcurrently(null, ["候補B"]);
    expect(got.memories).toEqual([
      { status: "active", content: "候補B", obs: got.observationId },
      { status: "active", content: "発話", obs: got.observationId },
    ]);
    expect(got.created).toEqual(["extracted", "extraction_failed_whole_observation_fallback"]);
    expect(got.outbox.filter((j) => j.kind === "embed")).toHaveLength(2);
    expectLeaseOutcome(got);
  });
});
