import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    // `strength` が NaN/Infinity だと `defaultDecayStrategy.floorAt` が `Invalid Date` を返す。
    // 検査したいのは `strength` だけなので、`decayFloorAt` は妥当な値に固定する。
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const outOfRange: Array<[string, number]> = [
  ["上限をわずかに超える", 1.0001],
  ["1 より大きい", 2],
  ["桁が違う", 1e6],
  ["ちょうど 0", 0],
  ["負", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
];

describe("FakeMemoryStore の strength 値域検査（ADR 0078、Issue #768）", () => {
  it.each(outOfRange)("createMemory は %s（strength=%s）を拒む", async (label, strength) => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, newMemory({ strength }))).rejects.toThrow(
      /strength out of range/,
    );
  });

  it.each(outOfRange)(
    "createMemoryWithOutbox は %s（strength=%s）を拒む",
    async (label, strength) => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.createMemoryWithOutbox(ctx, newMemory({ strength }), []),
      ).rejects.toThrow(/strength out of range/);
    },
  );

  it("値域の内側（境界の 1 を含む）なら createMemory は通す", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    for (const strength of [1, 0.42, 1e-6]) {
      const memory = await memoryStore.createMemory(ctx, newMemory({ strength }));
      expect(memory.strength).toBeCloseTo(strength, 6);
    }
  });
});
