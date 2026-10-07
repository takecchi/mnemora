import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> => {
    throw new Error("not used");
  },
};

describe("tick の embed ジョブ：次元違いのベクトルは失敗にする", () => {
  it("space.dimensions と違う長さのベクトルなら、ジョブは failed、embeddingStatus は failed、upsert されず、メッセージに期待と実際の次元が出る", async () => {
    const stores = createFakeRuntimeStores();
    const expected = stores.embeddingProvider.space.dimensions;
    const actual = expected + 1;
    const provider: EmbeddingProvider = {
      space: stores.embeddingProvider.space,
      embed: async () => [new Array<number>(actual).fill(0.5)],
    };
    const upsert = vi.spyOn(stores.vectorStore, "upsert");
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: provider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date() },
    });
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);

    const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
    expect(upsert).not.toHaveBeenCalled();
    expect(await stores.vectorStore.getVectors!(ctx, provider.space, [memory.id])).toEqual([]);
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.lastError).toContain(`expected ${expected} dimensions`);
    expect(job?.lastError).toContain(`got ${actual}`);
  });
});
