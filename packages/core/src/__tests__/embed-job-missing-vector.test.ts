import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";

/**
 * `Runtime.tick` の embed ジョブは、`EmbeddingProvider.embed` が1件もベクトルを返さなければ、
 * そのジョブを失敗にし、Memory の `embeddingStatus` を `'failed'` にする——ベクトルを書かない
 * まま `'ready'` にしない。
 *
 * 約束: `packages/core/src/interfaces/embedding-provider.ts` の doc（2026-09-27 追記、ADR 0305 の
 * 追記）。embed ジョブは `embed` に常に1件だけ渡すので、「渡した件数より少ない」はこのジョブでは
 * 「空」と同じである。変異試験（PR #1045 の S14）で、`processEmbedJob` の検査を外しても既存の歯が
 * すり抜けたため足した。
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

describe("tick の embed ジョブ：provider がベクトルを返さなければ失敗にする", () => {
  it("embed が空の配列を返すと、ジョブは failed に数えられ、embeddingStatus は failed、ベクトルは書かれない", async () => {
    const stores = createFakeRuntimeStores();
    const emptyProvider: EmbeddingProvider = {
      space: stores.embeddingProvider.space,
      embed: async () => [],
    };
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: emptyProvider,
      hashContent: (content: string) => `sha256(${content})`,
      // 以前の Fake は outbox のジョブの availableAt を実時刻で付けたため、tick が claim できるよう
      // 実時計で動かす。
      clock: { now: () => new Date() },
    });
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);

    const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
    const vectors = await stores.vectorStore.getVectors!(ctx, emptyProvider.space, [memory.id]);
    expect(vectors).toEqual([]);
  });
});
