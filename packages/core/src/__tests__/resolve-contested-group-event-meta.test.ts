import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-rcg-meta" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(digest: string): NewMemory {
  return {
    tenantId: "tenant-rcg-meta",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
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

async function resolveTrio(
  resolution: { kind: "both_active" } | { kind: "supersede"; winnerIndex: number },
  reason?: string,
) {
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
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  const members = [
    await stores.memoryStore.createMemory(ctx, newMemory("A")),
    await stores.memoryStore.createMemory(ctx, newMemory("B")),
    await stores.memoryStore.createMemory(ctx, newMemory("C")),
  ];
  const ids = members.map((m) => m.id);
  await runtime.markContestedGroup!(ctx, ids);
  const eventsBefore = stores.eventStore.events.length;

  await runtime.resolveContestedGroup!(
    ctx,
    ids,
    resolution.kind === "supersede"
      ? { kind: "supersede", winnerId: ids[resolution.winnerIndex]! }
      : { kind: "both_active" },
    reason === undefined ? undefined : { reason },
  );

  const written = stores.eventStore.events.slice(eventsBefore);
  const byMemory = new Map(written.map((e) => [e.memoryId, e]));
  return { ids, byMemory };
}

describe("resolveContestedGroup が積むイベントの meta", () => {
  it("supersede: 敗者の superseded は、supersededById に加えて reason・resolution・note を持つ", async () => {
    const { ids, byMemory } = await resolveTrio(
      { kind: "supersede", winnerIndex: 0 },
      "人が選んだ",
    );

    for (const loser of [ids[1]!, ids[2]!]) {
      expect(byMemory.get(loser)?.kind).toBe("superseded");
      expect(byMemory.get(loser)?.meta).toEqual({
        reason: "contested_resolved",
        resolution: "supersede",
        note: "人が選んだ",
        supersededById: ids[0],
      });
    }
  });

  it("supersede: 勝者の updated は reason・resolution だけを持ち、supersededById を持たない", async () => {
    const { ids, byMemory } = await resolveTrio({ kind: "supersede", winnerIndex: 0 });

    expect(byMemory.get(ids[0]!)?.kind).toBe("updated");
    expect(byMemory.get(ids[0]!)?.meta).toEqual({
      reason: "contested_resolved",
      resolution: "supersede",
    });
  });

  it("both_active: 全員の updated は reason・resolution だけを持ち、supersededById を持たない", async () => {
    const { ids, byMemory } = await resolveTrio({ kind: "both_active" });

    for (const id of ids) {
      expect(byMemory.get(id)?.kind).toBe("updated");
      expect(byMemory.get(id)?.meta).toEqual({
        reason: "contested_resolved",
        resolution: "both_active",
      });
    }
  });
});
