import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";

/**
 * `Runtime.tick` の embed ジョブは、provider が返したベクトルに `NaN`・`Infinity`・`-Infinity` が
 * 含まれていれば、ベクトルを書かずにジョブを失敗にし、`embeddingStatus` を `'failed'` にする
 * （2026-09-30、ADR 0393。次元の検査 `embed-job-dimension-mismatch.test.ts` と同じ経路）。
 *
 * 以前は確かめずに `vectorStore.upsert` へ渡していた。Postgres は pgvector が拒んで SQL の失敗に見え、
 * InMemory / Fake は黙って `'ready'` で保存した（`interfaces/vector-store.ts` の表）。
 */

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

describe("tick の embed ジョブ：有限でない成分を含むベクトルは失敗にする", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "成分に %s を含むベクトルなら、ジョブは failed、embeddingStatus は failed、upsert されず、メッセージに位置と値が出る",
    async (bad) => {
      const stores = createFakeRuntimeStores();
      const dims = stores.embeddingProvider.space.dimensions;
      const vec = new Array<number>(dims).fill(0.5);
      vec[1] = bad;
      const provider: EmbeddingProvider = {
        space: stores.embeddingProvider.space,
        embed: async () => [vec],
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
      const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), [
        "embed",
      ]);

      const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);
      expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
      expect(upsert).not.toHaveBeenCalled();
      expect(await stores.vectorStore.getVectors!(ctx, provider.space, [memory.id])).toEqual([]);
      const [job] = stores.outboxStore.listJobs(ctx);
      expect(job?.lastError).toContain("non-finite");
      expect(job?.lastError).toContain(`index 1 (${String(bad)})`);
    },
  );
});
