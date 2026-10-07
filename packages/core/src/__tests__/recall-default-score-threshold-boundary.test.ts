import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { assertAffinityMeasured, createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段2の既定の `scoreThreshold` が 0.1 であることを、境目の両側すれすれの `total` で縛る。
 * 離れた値だけを置くと、0.1 から外れた既定でも同じ集合が返り、値の違いが見えない。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "recall-default-score-threshold-boundary" };

async function seedWithStrengths(strengths: number[]) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const halfLifeHours = 24 * 365 * 10;
  const decayFloorAt = new Date(NOW.getTime() + 365 * 24 * 3_600_000);
  for (const [i, strength] of strengths.entries()) {
    const overrides: Partial<NewMemory> = { strength, halfLifeHours, decayFloorAt };
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${i}`,
      contentHash: `hash-${i}`,
      digest: "d",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: NOW,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
      ...overrides,
    });
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
  }
  return runtime;
}

describe("recall() の段2の既定の scoreThreshold は 0.1（境目の両側すれすれ）", () => {
  it("total が 0.1 を挟んで近い候補は、0.1 以上だけが返り、未満は below_threshold に落ちる", async () => {
    const runtime = await seedWithStrengths([0.08, 0.095, 0.105, 0.12]);
    const byDefault = await runtime.recall(ctx, { vector: [1, 0], limit: 50, association: null });
    const totals = byDefault.memories.map((r) => {
      assertAffinityMeasured(r.score);
      return r.score.total;
    });
    expect(totals).toEqual([0.12, 0.105]);
    const below = byDefault.omitted.find((o) => o.kind === "below_threshold");
    expect(below).toMatchObject({ kind: "below_threshold", count: 2 });
  });
});
