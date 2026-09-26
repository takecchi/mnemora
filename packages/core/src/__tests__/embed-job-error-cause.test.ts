import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #962（前半）: `processEmbedJob` は埋め込みの失敗を受けて `embeddingStatus: 'failed'`
 * を書いてから元の例外を投げ直す。その `failed` の書き込み自体が失敗すると、元の例外
 * （なぜ埋め込めなかったか）が失われ、outbox 行の `lastError` には二次的な失敗しか残らなかった。
 * 元の例外は `cause` に残し、`lastError` にも両方が載ることを測る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
// Fake の outbox 行の `availableAt` は実時刻で付くので、runtime の時計はそれより後にする。
const LATER = new Date(Date.now() + 60_000);

function newMemory(): NewMemory {
  const recordedAt = LATER;
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
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

describe("processEmbedJob — failed の書き込みが失敗しても元の例外を失わない（Issue #962）", () => {
  it("lastError に元の例外（埋め込みの失敗）と二次的な失敗の両方が載る", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: notUsedLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => LATER },
    });
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    stores.embeddingProvider.embed = async () => {
      throw new Error("embedding provider down");
    };
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw new Error("db connection reset while marking failed");
    };

    const result = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(result.failed).toBe(1);
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.lastError).toContain("embedding provider down");
    expect(job?.lastError).toContain("db connection reset while marking failed");
  });
});
