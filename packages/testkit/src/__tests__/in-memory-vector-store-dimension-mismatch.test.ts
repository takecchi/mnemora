import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * Issue #867 / 案B: `query` の長さが保存済みベクトルの長さと違うとき、
 * `InMemoryVectorStore.search` は「比較不能」として `NaN` を返す（候補は落とさない）。
 *
 * 【実測 Issue #867、pgvector 0.8.2 / PostgreSQL 17.9、3次元の空間、保存 `[1,0,0]`】
 * 直す前は、足りない側を `0` で zero-pad してから計算を続けていた
 * （`Math.max(a.length, b.length)`）ため、ノルムが0にならず ADR 0040 の `NaN` 経路に乗らず、
 * 意味の無い実数の類似度を普通のヒットとして返していた——`[1,2]`（短い）で
 * `distance: 0.5527…`、`[1,2,3,4]`（長い、保存側を `[1,0,0,0]` に0埋め）で
 * `distance: 0.8174…`。Postgres は同じ入力で「different vector dimensions」の
 * 未捕捉 `DrizzleQueryError` になっていた（Fake と挙動が割れていた）。
 *
 * 直した後は、`PostgresVectorStore.search`（`packages/postgres/src/vector-store.ts`）が
 * 次元不一致をゼロベクトルへ差し替えて `NaN` にするのと同じ結果になる——
 * どちらの adapter でも `distance` は「どんな `scoreThreshold` とも比較できない」値になる。
 */
const TENANT = "vector-dimension-mismatch-tenant";
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const STORED_VECTOR: number[] = [1, 0, 0]; // Issue #867 本文の保存データと同じ。

async function setup() {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const ctx: Ctx = { tenantId: TENANT };
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId }),
  );
  await vectorStore.upsert(ctx, SPACE, memory.id, STORED_VECTOR);
  return { vectorStore, ctx, memory };
}

describe("InMemoryVectorStore.search — 長さが違うクエリベクトルは比較不能（Issue #867 / 案B）", () => {
  it("短いクエリ（[1,2]）は候補を落とさず distance が NaN になる", async () => {
    const { vectorStore, ctx } = await setup();
    const hits = await vectorStore.search(ctx, SPACE, [1, 2], {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    expect(hits).toHaveLength(1);
    // ADR 0040 の歯と同じ見方: `Number.isNaN` で直接見ず、「どちらの比較も false」で見る。
    expect(hits[0]!.distance >= 0).toBe(false);
    expect(hits[0]!.distance <= 0).toBe(false);
  });

  it("長いクエリ（[1,2,3,4]）も候補を落とさず distance が NaN になる", async () => {
    const { vectorStore, ctx } = await setup();
    const hits = await vectorStore.search(ctx, SPACE, [1, 2, 3, 4], {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distance >= 0).toBe(false);
    expect(hits[0]!.distance <= 0).toBe(false);
  });

  it("⚠ 鳴ってはいけない側: 長さが一致するクエリは普通に実数の distance を返す", async () => {
    const { vectorStore, ctx } = await setup();
    const hits = await vectorStore.search(ctx, SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    expect(hits).toHaveLength(1);
    expect(Number.isNaN(hits[0]!.distance)).toBe(false);
    expect(hits[0]!.distance).toBeCloseTo(0, 10);
  });
});
