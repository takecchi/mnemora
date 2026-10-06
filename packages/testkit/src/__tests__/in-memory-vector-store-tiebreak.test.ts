import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * `InMemoryVectorStore.search` の tie-break（Issue #339 / ADR 0170 の追随）。
 *
 * `packages/postgres/src/__tests__/vector-search-tiebreak.test.ts`
 * （`PostgresVectorStore.search` — 距離 → `recorded_at` DESC → `memory_id` の3段）と
 * **同じ入力を同じ順序で**組み立てる。`VectorStore.search` の doc
 * （`packages/core/src/interfaces/vector-store.ts`）は「距離が完全一致する行の順序も
 * adapter の責務である」と明記しており、`PostgresVectorStore` はこれを `recorded_at` DESC で
 * 満たしている。`InMemoryVectorStore` は現状 `hits.sort((a, b) => a.distance - b.distance)`
 * のみで、同点の中身は `Array.prototype.sort` の安定性により**挿入順**（＝`recordedAt` が
 * 古いほうを先に作った通常の呼び出し順）で決まる——`recorded_at` DESC（新しい方が先）とは
 * **逆向き**になる。
 */
const TENANT = "vector-search-tiebreak-tenant";
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const QUERY_VECTOR: number[] = [1, 0, 0];
const TIED_VECTOR: number[] = [1, 0, 0]; // クエリと完全に同一 = 距離0で確実にタイになる。

describe("InMemoryVectorStore.search — 距離が完全一致したときの tie-break（Issue #339 / ADR 0170 の追随）", () => {
  it("recorded_at が新しい方を先に返す（PostgresVectorStore.search と同じ契約）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    // older を先に作る（recordedAt が古い）——通常の呼び出し順どおり。
    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, SPACE, older.id, TIED_VECTOR);

    // newer を後で作る（recordedAt が新しい）。
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, SPACE, newer.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.distance).toBeCloseTo(0, 10);
    expect(hits[1]!.distance).toBeCloseTo(0, 10);

    // ⟹ `PostgresVectorStore.search`（ADR 0170）と同じ契約: recordedAt が新しい方（newer）が
    // 常に先に来る。
    expect(hits[0]!.memoryId).toBe(newer.id);
    expect(hits[1]!.memoryId).toBe(older.id);
  });

  it("recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");

    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
    await vectorStore.upsert(ctx, SPACE, a.id, TIED_VECTOR);
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
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

describe("search の tie-break の追加の歯（ADR 0170 の契約。Issue #1775 の #828）", () => {
  const filter = {
    tenantId: TENANT,
    status: ["active", "contested"] as ("active" | "contested")[],
  };

  it("memory_id の段: upsert を id の降順に打っても、memory_id 昇順で返る（挿入順に依らない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const x = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, ...{ recordedAt: sameRecordedAt } }),
    );
    const y = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, ...{ recordedAt: sameRecordedAt } }),
    );
    const [smaller, larger] = [x.id, y.id].sort();
    // 大きい id を先に upsert する（挿入順は id の降順）。
    await vectorStore.upsert(ctx, SPACE, larger!, TIED_VECTOR);
    await vectorStore.upsert(ctx, SPACE, smaller!, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, { limit: 10, filter });

    expect(hits.map((h) => h.memoryId)).toEqual([smaller, larger]);
  });

  it("近いが違う距離は同点として扱わない: 距離が先で、recordedAt は同点のときだけ", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    // 厳密に距離0の古い行と、わずかに遠い（距離は約5e-5）新しい行。
    const closerButOlder = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...{ recordedAt: new Date("2026-01-01T00:00:00.000Z") },
      }),
    );
    await vectorStore.upsert(ctx, SPACE, closerButOlder.id, TIED_VECTOR);
    const fartherButNewer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...{ recordedAt: new Date("2026-01-02T00:00:00.000Z") },
      }),
    );
    await vectorStore.upsert(ctx, SPACE, fartherButNewer.id, [1, 0.01, 0]);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, { limit: 10, filter });

    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    expect(hits.map((h) => h.memoryId)).toEqual([closerButOlder.id, fartherButNewer.id]);
  });

  it("同点の日時は recordedAt である（occurredAt の順と recordedAt の順が逆の2件）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    // recordedAt は newer のほうが新しいが、occurredAt は older のほうが新しい。
    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...{
          recordedAt: new Date("2026-01-01T00:00:00.000Z"),
          occurredAt: new Date("2026-01-10T00:00:00.000Z"),
        },
      }),
    );
    await vectorStore.upsert(ctx, SPACE, older.id, TIED_VECTOR);
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...{
          recordedAt: new Date("2026-01-02T00:00:00.000Z"),
          occurredAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      }),
    );
    await vectorStore.upsert(ctx, SPACE, newer.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, { limit: 10, filter });

    expect(hits.map((h) => h.memoryId)).toEqual([newer.id, older.id]);
  });

  it("返す形は { memoryId, distance } だけ（tie-break のための recordedAt などが漏れない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...{ recordedAt: new Date("2026-01-01T00:00:00.000Z") },
      }),
    );
    await vectorStore.upsert(ctx, SPACE, memory.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, SPACE, QUERY_VECTOR, { limit: 10, filter });

    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!)).toEqual(["memoryId", "distance"]);
  });
});
