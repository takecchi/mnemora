// `VectorStore.upsert` は float4 に収まらない成分だけを断り、収まる成分は保存する。
// float4 の最大値（3.4028234663852886e38）ちょうどは収まるので保存され、その上で float4 への丸めが
// 無限大になる最初の double（最大値と 2^128 の中点 3.4028235677973366e38）は断る。
import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const ctx = { tenantId: "vector-upsert-float4-max" };
const FLOAT4_MAX = 3.4028234663852886e38;
const FIRST_OVER_FLOAT4_MAX = 3.4028235677973366e38;

afterAll(async () => {
  await closeTestClient();
});

async function setup() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const m = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "vf4max" }),
  );
  return { vectorStore, id: m.id };
}

describe("PostgresVectorStore.upsert: float4 の最大値の境界", () => {
  it("境界の前提: 最大値は float4 に収まり、その上の中点は無限大に丸まる", () => {
    expect(Math.fround(FLOAT4_MAX)).toBe(FLOAT4_MAX);
    expect(Math.fround(FIRST_OVER_FLOAT4_MAX)).toBe(Infinity);
  });

  it.each<[string, number[]]>([
    ["最大値", [FLOAT4_MAX, 0, 0]],
    ["負の最大値", [-FLOAT4_MAX, 0, 0]],
  ])("成分が float4 の%sちょうどなら断らず、その値のまま保存する", async (_label, vector) => {
    const { vectorStore, id } = await setup();

    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, vector);

    const stored = await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [id]);
    expect(stored).toHaveLength(1);
    // 読み戻しは float4 の最短表記を double で読んだ値なので、float4 に丸めて比べる。
    expect(stored[0]!.vector.map((x) => Math.fround(x))).toEqual(vector);
  });

  it.each<[string, number[]]>([
    ["最大値の1つ上", [FIRST_OVER_FLOAT4_MAX, 0, 0]],
    ["負の最大値の1つ下", [-FIRST_OVER_FLOAT4_MAX, 0, 0]],
  ])(
    "成分が float4 の%s（無限大に丸まる値）なら RangeError で断り、何も保存しない",
    async (_label, vector) => {
      const { vectorStore, id } = await setup();

      const error = await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, vector).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/vector component \[0\] does not fit in a float4/);
      expect(await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [id])).toEqual([]);
    },
  );
});
