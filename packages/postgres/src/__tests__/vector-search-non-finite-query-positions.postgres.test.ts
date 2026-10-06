import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `vector-search-non-finite-query.postgres.test.ts`（PR #1069）が見ていない側。約束: クエリに有限でない成分が
 * **1つでも**あれば、どの位置でも、その他の成分がどんな値でも、比較不能（距離は NaN・候補は落とさない）。
 * 有限なクエリは、成分が大きくても、そのまま比べる（比較不能にしない）。
 *
 * 既存の歯は `[NaN,0,0]`・`[Infinity,0,0]`・`[0,-Infinity,0]` だけ——最後の成分・他の成分が非ゼロの場合を
 * 見ない（非有限の成分だけを 0 に直して比べる実装、最後の成分を見落とす実装が緑のままだった）。
 */

const ctx: Ctx = { tenantId: `non-finite-positions-${randomUUID()}` };

async function seed() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `non-finite-positions-${randomUUID()}`,
      embeddingStatus: "ready",
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
  return { vectorStore, memory };
}

const NON_FINITE_AT_POSITIONS: [string, number[]][] = [
  ["最後の成分が NaN", [0, 0, NaN]],
  ["最後の成分が Infinity", [1, 1, Infinity]],
  ["真ん中が NaN で、ほかは非ゼロ", [1, NaN, 1]],
  ["先頭が -Infinity で、ほかは非ゼロ", [-Infinity, 1, 1]],
  ["非ゼロの成分と同居する NaN（[1, 0, 0] に一致しうる値）", [1, 0, NaN]],
];

const LARGE_FINITE: [string, number[]][] = [
  ["絶対値の大きな有限の値", [1000, 0, 0]],
  ["さらに大きな有限の値", [1e6, 0, 0]],
];

describe("PostgresVectorStore.search/searchMany: 有限でない成分は位置・他の成分の値によらず比較不能", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it.each(NON_FINITE_AT_POSITIONS)("search（%s）", async (_label, query) => {
    const { vectorStore, memory } = await seed();
    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [...query], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(hits[0]!.distance >= 0).toBe(false);
    expect(hits[0]!.distance <= 0).toBe(false);
  });

  it.each(NON_FINITE_AT_POSITIONS)("searchMany（%s）", async (_label, query) => {
    const { vectorStore, memory } = await seed();
    const result = await vectorStore.searchMany(
      ctx,
      TEST_EMBEDDING_SPACE,
      [
        { key: "bad", vector: [...query] },
        { key: "good", vector: [1, 0, 0] },
      ],
      { limit: 10, filter: { tenantId: ctx.tenantId } },
    );
    const bad = result.get("bad")!;
    expect(bad.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(bad[0]!.distance >= 0).toBe(false);
    expect(bad[0]!.distance <= 0).toBe(false);
    expect(result.get("good")).toEqual([{ memoryId: memory.id, distance: 0 }]);
  });

  it.each(LARGE_FINITE)("有限なクエリは比べる（search・searchMany、%s）", async (_label, query) => {
    const { vectorStore, memory } = await seed();
    const filter = { tenantId: ctx.tenantId };
    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [...query], {
      limit: 10,
      filter,
    });
    expect(hits).toEqual([{ memoryId: memory.id, distance: 0 }]);
    const many = await vectorStore.searchMany(
      ctx,
      TEST_EMBEDDING_SPACE,
      [{ key: "q", vector: [...query] }],
      { limit: 10, filter },
    );
    expect(many.get("q")).toEqual([{ memoryId: memory.id, distance: 0 }]);
  });
});
