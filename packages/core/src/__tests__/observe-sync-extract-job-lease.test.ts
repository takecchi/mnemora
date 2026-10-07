import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 順序は時計と門（Promise）で決める。タイミングには頼らない。

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

function makeKit() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock,
    memoryStore: stores.memoryStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    outboxStore: stores.outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
  });
  return { runtime, memoryStore: stores.memoryStore, outboxStore: stores.outboxStore };
}

function allJobs(kit: Kit): OutboxJobRecord[] {
  return kit.outboxStore.listJobs(ctx);
}

type Kit = ReturnType<typeof makeKit>;

async function activeContents(kit: Kit) {
  const out: string[] = [];
  for (const job of allJobs(kit).filter((j) => j.kind === "extract")) {
    const obsId = (job.payload as { observationId: string }).observationId;
    const ms = await kit.memoryStore.listBySourceObservationAllVersions(ctx, obsId);
    out.push(...ms.filter((m) => m.status === "active").map((m) => m.content));
  }
  return out.sort();
}

function extractJobs(kit: Kit) {
  return allJobs(kit)
    .filter((j) => j.kind === "extract")
    .map((j) => ({
      completed: (j.completedAt ?? null) !== null,
      failed: (j.failedAt ?? null) !== null,
    }));
}

describe("core の Fake: sync observe が積んだ extract のジョブは、observe が持っている間 claim されない（ADR 0407）", () => {
  it("LLM を待つ間に tick が走っても、LLM は1回・active は1件・observe は memoryIds を返す", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = makeKit();
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
    expect(await activeContents(kit)).toEqual(["候補A"]);
    expect(await extractJobs(kit)).toEqual([{ completed: true, failed: false }]);
  });

  it("observe が LLM の途中で死んだ（戻らない）とき、リースが切れた後は tick が拾う", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = makeKit();
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
    expect(await activeContents(kit)).toEqual(["候補B"]);
    expect(await extractJobs(kit)).toEqual([{ completed: true, failed: false }]);
  });

  it("LLM がリースより長くかかり tick に取り直されても、書き込み済みの observe は例外を投げず memoryIds を返す", async () => {
    nowMs = T0;
    llmCalls = 0;
    const kit = makeKit();
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
    expect(await extractJobs(kit)).toEqual([{ completed: true, failed: false }]);
  });
});
