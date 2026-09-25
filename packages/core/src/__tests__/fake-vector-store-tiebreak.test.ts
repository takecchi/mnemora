import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeVectorStore.search` の tie-break（Issue #339 / ADR 0170 の追随。
 * `packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts` と対になる、
 * `packages/core` 専用の `Fake*` 側——`InMemoryVectorStore` だけを直しても
 * `FakeVectorStore` 側の食い違いはどこからも測れないままになる、という
 * ADR 0049 が `reinforce` について踏んだのと同じ形（適合スイートは `InMemory*` だけを
 * 対象にしており、`packages/core` 専用の `Fake*` には届かない）。
 *
 * `PostgresVectorStore.search`（ADR 0170）は 距離 → `recorded_at` DESC → `memory_id` の
 * 3段で tie-break する。`VectorStore.search` の doc（`../interfaces/vector-store.ts`）は
 * 「距離が完全一致する行の順序も adapter の責務である」と明記している。
 */
const TENANT = "vector-search-tiebreak-tenant";
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const QUERY_VECTOR: number[] = [1, 0, 0];
const TIED_VECTOR: number[] = [1, 0, 0];

function fixture(overrides: Partial<NewMemory> & { recordedAt: Date }): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: `fixture-hash-${overrides.recordedAt.getTime()}-${Math.random()}`,
    digest: "テスト用の要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: overrides.recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeVectorStore.search — 距離が完全一致したときの tie-break（Issue #339 / ADR 0170 の追随）", () => {
  it("recorded_at が新しい方を先に返す（PostgresVectorStore.search と同じ契約）", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: TENANT };

    const older = await memoryStore.createMemory(
      ctx,
      fixture({ recordedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    await vectorStore.upsert(ctx, SPACE, older.id, TIED_VECTOR);

    const newer = await memoryStore.createMemory(
      ctx,
      fixture({ recordedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );
    await vectorStore.upsert(ctx, SPACE, newer.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.distance).toBeCloseTo(0, 10);
    expect(hits[1]!.distance).toBeCloseTo(0, 10);
    expect(hits[0]!.memoryId).toBe(newer.id);
    expect(hits[1]!.memoryId).toBe(older.id);
  });

  it("recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: TENANT };
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");

    const a = await memoryStore.createMemory(ctx, fixture({ recordedAt: sameRecordedAt }));
    await vectorStore.upsert(ctx, SPACE, a.id, TIED_VECTOR);
    const b = await memoryStore.createMemory(ctx, fixture({ recordedAt: sameRecordedAt }));
    await vectorStore.upsert(ctx, SPACE, b.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    const [smaller, larger] = [a.id, b.id].sort();
    expect(hits[0]!.memoryId).toBe(smaller);
    expect(hits[1]!.memoryId).toBe(larger);
  });
});
