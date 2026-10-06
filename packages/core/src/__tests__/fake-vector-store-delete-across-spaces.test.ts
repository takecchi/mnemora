import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * core の `FakeVectorStore.deleteAcrossSpaces` の約束（`InMemoryVectorStore`・`PostgresVectorStore` と同じ）。
 * - 渡した memoryId の行を、全 space から消す。
 * - 渡していない memoryId の行は、同じテナント・同じ space でも残す。
 * - 別のテナントの行は残す。
 * - id の綴り（大文字小文字）は区別しない。
 */

const SPACE_A: EmbeddingSpaceId = { provider: "test", model: "across-a", dimensions: 3 };
const SPACE_B: EmbeddingSpaceId = { provider: "test", model: "across-b", dimensions: 3 };
const ctx: Ctx = { tenantId: "fake-delete-across" };
const otherCtx: Ctx = { tenantId: "fake-delete-across-other" };

function newMemory(tenantId: string): NewMemory {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId,
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
  };
}

async function seed() {
  const { vectorStore, memoryStore } = createFakeRuntimeStores();
  const rows: Record<string, { target: Memory; kept: Memory }> = {};
  for (const c of [ctx, otherCtx]) {
    const target = await memoryStore.createMemory(c, newMemory(c.tenantId));
    const kept = await memoryStore.createMemory(c, newMemory(c.tenantId));
    rows[c.tenantId] = { target, kept };
    for (const space of [SPACE_A, SPACE_B]) {
      await vectorStore.upsert(c, space, target.id, [1, 0, 0]);
      await vectorStore.upsert(c, space, kept.id, [0, 1, 0]);
    }
  }
  const idsOf = async (c: Ctx, space: EmbeddingSpaceId): Promise<MemoryId[]> => {
    const { target, kept } = rows[c.tenantId]!;
    const found = await vectorStore.getVectors!(c, space, [target.id, kept.id]);
    return found.map((v) => v.memoryId).sort();
  };
  return { vectorStore, rows, idsOf };
}

describe("FakeVectorStore.deleteAcrossSpaces", () => {
  it("渡した id の行だけを全 space から消し、渡していない id の行・別テナントの行は残す", async () => {
    const { vectorStore, rows, idsOf } = await seed();

    await vectorStore.deleteAcrossSpaces(ctx, [rows[ctx.tenantId]!.target.id]);

    for (const space of [SPACE_A, SPACE_B]) {
      expect(await idsOf(ctx, space)).toEqual([rows[ctx.tenantId]!.kept.id]);
      expect(await idsOf(otherCtx, space)).toEqual(
        [rows[otherCtx.tenantId]!.target.id, rows[otherCtx.tenantId]!.kept.id].sort(),
      );
    }
  });

  it("大文字で綴った id でも、同じ行が消える", async () => {
    const { vectorStore, rows, idsOf } = await seed();

    await vectorStore.deleteAcrossSpaces(ctx, [
      rows[ctx.tenantId]!.target.id.toUpperCase() as MemoryId,
    ]);

    for (const space of [SPACE_A, SPACE_B]) {
      expect(await idsOf(ctx, space)).toEqual([rows[ctx.tenantId]!.kept.id]);
    }
  });
});
