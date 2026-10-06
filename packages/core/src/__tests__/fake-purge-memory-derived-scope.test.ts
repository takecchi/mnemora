import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * core の `FakeMemoryStore.purgeMemory` が、本文の派生物（label の紐付け・`recalls.index_band` の目次帯）に
 * 触れる範囲。`InMemoryMemoryStore`・`PostgresMemoryStore` と同じ。
 * - `registered` の label は触らない（`proposedCount` も `status` も動かさない）。
 * - 目次帯のこの Memory のエントリは `{ memoryId, digest: 墓石 }` だけになる（`truncated` は落ちる）。
 */

const ctx: Ctx = { tenantId: "fake-purge-derived-scope" };

function newMemory(overrides: Partial<NewMemory>): NewMemory {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${randomUUID()}`,
    digest: "要旨",
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
    status: "forgotten",
    ...overrides,
  };
}

function purgeEvent(memoryId: string) {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "purged" as const,
    actor: { type: "system" as const },
    meta: {},
  };
}

describe("FakeMemoryStore.purgeMemory が本文の派生物に触れる範囲", () => {
  it("registered の label は、proposedCount も status も動かない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const tag = `promoted-${randomUUID()}`;
    const memory = await memoryStore.createMemory(ctx, newMemory({ tags: [tag] }));
    const registered = await memoryStore.registerLabel!(ctx, tag);
    expect(registered).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });

    await memoryStore.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(memory.id),
    );

    const after = (await memoryStore.listLabels!(ctx)).find((l) => l.name === tag);
    expect(after).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });
  });

  it("目次帯のエントリが truncated: true だったとき、墓石へ書き換えたあとの形は { memoryId, digest } だけ", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ digest: "長さで切られた秘密の要旨" }),
    );
    const recallId = await memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: {
        groups: [],
        totalInScope: 1,
        countKind: "exact",
        digestBand: [{ memoryId: memory.id, digest: memory.digest, truncated: true }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });

    await memoryStore.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(memory.id),
    );

    const record = await memoryStore.getRecall(ctx, recallId);
    expect(record?.indexBand.digestBand).toEqual([{ memoryId: memory.id, digest: "[purged]" }]);
  });
});
