import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 例外の種類（`ZodError`）そのものは `runtime-entry-exception-kinds.postgres.test.ts` が縛るので、
// ここでは落ちたのがスキーマの段であることの前提として `name` を見るだけにする。

const ctx: Ctx = { tenantId: "tenant-1" };

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

interface Backing {
  observations: Map<string, unknown>;
  memories: Map<string, unknown>;
  outboxJobs: unknown[];
  events: unknown[];
}

function build() {
  const stores = createFakeRuntimeStores();
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
  const backing = (stores.memoryStore as unknown as { backing: Backing }).backing;
  const counts = () => ({
    observations: backing.observations.size,
    outboxJobs: backing.outboxJobs.length,
    memories: backing.memories.size,
    events: backing.events.length,
  });
  return { runtime, counts };
}

const tooManyKeys = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));

const INVALID_INPUTS: Array<[string, unknown]> = [
  ["型の外の kind", { kind: "bogus", text: "x" }],
  ["utterance の text が欠けている", { kind: "utterance" }],
  [
    "attributes のキーが多すぎる（deferred）",
    { kind: "utterance", text: "x", attributes: tooManyKeys, extract: "deferred" },
  ],
  ["extract が型の外", { kind: "utterance", text: "x", extract: "later" }],
  ["memory_usage の usedMemoryIds が欠けている", { kind: "memory_usage", recallId: "r-1" }],
];

describe("runtime.observe: スキーマに合わない入力は、何も書く前に落ちる", () => {
  it.each(INVALID_INPUTS)(
    "%s: Observation・outbox・Memory・監査ログが0件のまま",
    async (_label, input) => {
      const { runtime, counts } = build();
      const before = counts();
      expect(before).toEqual({ observations: 0, outboxJobs: 0, memories: 0, events: 0 });

      const err = await runtime.observe(ctx, input as never).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err?.name).toBe("ZodError");
      expect(counts()).toEqual(before);
    },
  );
});
