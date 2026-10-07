import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// どちらも、`tick` が既定値（`DEFAULT_TICK_LIMIT`・`TICK_SUPPORTED_JOB_KINDS`）へ倒さないことを見る。
// 積んだ extract ジョブが claim されず（attempts が 0 のまま、claimedAt が null のまま）、LLM も呼ばれない。

const ctx: Ctx = { tenantId: "tenant-1" };
const LEASE_MS = 60_000;

function build() {
  const stores = createFakeRuntimeStores();
  const llm = {
    structuredCalls: 0,
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      llm.structuredCalls += 1;
      return req.schema.parse({ memories: [{ content: "本文", provenanceKind: "stated" }] }) as T;
    },
  } satisfies LLMProvider & { structuredCalls: number };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores, llm };
}

const CASES: Array<[string, { limit?: number; kinds?: [] }]> = [
  ["limit: 0", { limit: 0 }],
  ["kinds: []", { kinds: [] }],
];

describe("runtime.tick: limit: 0 と kinds: [] では何も claim しない", () => {
  it.each(CASES)("%s: 積んだジョブに触らず、processed も 0", async (_label, opts) => {
    const { runtime, stores, llm } = build();
    await runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
    const jobsBefore = stores.outboxStore.listJobs(ctx);
    // 前提: claim されうる extract ジョブが1件ある。
    expect(jobsBefore.map((j) => ({ kind: j.kind, attempts: j.attempts }))).toEqual([
      { kind: "extract", attempts: 0 },
    ]);

    const result = await runtime.tick(ctx, { ...opts, leaseMs: LEASE_MS });

    expect({
      result,
      jobs: stores.outboxStore
        .listJobs(ctx)
        .map((j) => ({ attempts: j.attempts, claimedAt: j.claimedAt ?? null })),
      llmCalls: llm.structuredCalls,
    }).toEqual({
      result: { processed: 0, failed: 0, unsupported: [], leaseConflicts: [] },
      jobs: [{ attempts: 0, claimedAt: null }],
      llmCalls: 0,
    });
  });
});
