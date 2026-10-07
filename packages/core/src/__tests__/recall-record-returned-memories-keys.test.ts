import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 記録に足すと recall のたびに保存される行が太るので、後から再現できないものだけを運ぶ。キーを固定する。 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-record-keys", subjectId: "user-a" };

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: "user-a",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: {
      kind: "stated",
      speaker: "田中",
      sourceObservationId: "obs-1",
      at: NOW.toISOString(),
    } as never,
    tags: [],
    occurredAt: new Date("2026-05-01T00:00:00.000Z"),
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

const ALLOWED_KEYS = ["associationOf", "companionOf", "memoryId", "retrievedVia", "score"];

describe("recall の記録の returnedMemories は、memoryId・score・retrievedVia（と companionOf・associationOf）だけを持つ", () => {
  it("speaker・subjectId・recordedAt・occurredAt が recall の結果には載っていても、記録には足さない（ann と連想の枠の両方）", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const anchor: Memory = await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      anchor.id,
      [0.70710678, 0.70710678],
    );
    const associated: Memory = await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, associated.id, [0, 1]);

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: { maxCount: 5, anchorCount: 1 },
    });

    // 検算: 結果の側には4欄が載っている（この歯が何も見ていない、にならないため）。
    const viaAnn = result.memories.find((m) => m.memoryId === anchor.id);
    expect(viaAnn?.speaker).toBe("田中");
    expect(viaAnn?.subjectId).toBe("user-a");
    expect(viaAnn?.recordedAt).toEqual(NOW);
    expect(viaAnn?.occurredAt).toEqual(new Date("2026-05-01T00:00:00.000Z"));
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(true);

    const record = await stores.memoryStore.getRecall(ctx, result.recallId);
    expect(record?.returnedMemories.breakdownCaptured).toBe(true);
    expect(record?.returnedMemories.memories.length).toBe(result.memories.length);
    for (const returned of record!.returnedMemories.memories) {
      expect(
        Object.keys(returned)
          .sort()
          .filter((k) => !ALLOWED_KEYS.includes(k)),
      ).toEqual([]);
      for (const forbidden of ["speaker", "subjectId", "recordedAt", "occurredAt"]) {
        expect(returned).not.toHaveProperty(forbidden);
      }
    }
    const annRow = record!.returnedMemories.memories.find((m) => m.memoryId === anchor.id);
    expect(Object.keys(annRow!).sort()).toEqual(["memoryId", "retrievedVia", "score"]);
  });
});
