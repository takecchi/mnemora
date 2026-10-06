import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RuntimeDeps.embeddingInput` を渡さないとき、`embed()` へ送る文字列は `memory.content`
 * そのものである（ADR 0336・`runtime.ts` の `embeddingInput` の TSDoc「省略時は `memory.content`
 * をそのまま送る」。Issue #1775 の #834）。
 *
 * 既存の歯は「何を送ったか」をフックを渡した構成でしか見ていない。`content` と `digest` が
 * 違う記憶で、送った文字列が `content` であることを見る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const LATER = new Date(Date.now() + 60_000);

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "元の本文（content）",
    contentHash: "hash-default-input",
    digest: "短い要約（digest）",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: LATER,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: LATER,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

describe("embeddingInput を渡さないとき、embed() へ送るのは memory.content（ADR 0336）", () => {
  it("content と digest が違う記憶で、provider が受け取るのは content", async () => {
    const stores = createFakeRuntimeStores();
    const received: string[] = [];
    const provider: EmbeddingProvider = {
      space: { provider: "fake", model: "recording", dimensions: 2 },
      embed: async (_ctx, texts) => {
        received.push(...texts);
        return texts.map(() => [1, 0]);
      },
    };
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: provider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => LATER },
    });
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);

    const result = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(result.processed).toBe(1);
    expect(received).toEqual(["元の本文（content）"]);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("ready");
  });
});
