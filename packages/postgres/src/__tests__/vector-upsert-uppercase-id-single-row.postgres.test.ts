/* eslint-disable @typescript-eslint/no-explicit-any -- 3 実装の store を同じ形で突き合わせる試験 */
// 確かめ直し（Issue #1759、B 群 #1615 / ADR 0521）の歯。
//
// ADR 0521: 記憶の id を取る口は、大文字で渡されても同じ記憶として扱う。`VectorStore.upsert` に大文字の id を渡すと、
// Postgres は同じ行を上書きする（`memory_id` は uuid 型の列）。fixture の入口の小文字化を外すと、別の鍵で
// 2本目のベクトルが積まれる。既存の「vs.upsert」の突き合わせは返り値（void）と記憶・イベントの状態だけを比べ、
// 保存されたベクトルは見ていなかったので、入口の小文字化を外しても赤にならなかった。
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryMemoryStore, InMemoryVectorStore } from "@mnemora/testkit/fixtures";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const ctx = { tenantId: "vector-upsert-uppercase" };

afterAll(async () => {
  await closeTestClient();
});

const backends: Array<[string, () => Promise<{ memoryStore: any; vectorStore: any }>]> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memoryStore: new PostgresMemoryStore(db), vectorStore: new PostgresVectorStore(db) };
    },
  ],
  [
    "testkit の fixture",
    async () => {
      const m = new InMemoryMemoryStore();
      return { memoryStore: m, vectorStore: new InMemoryVectorStore(m) };
    },
  ],
  ["core の Fake", async () => createFakeRuntimeStores() as any],
];

describe.each(backends)("VectorStore.upsert に大文字の id: 同じ行を上書きする: %s", (_n, build) => {
  it("小文字で入れたあと大文字で入れ直すと、ベクトルは1本で、新しい値になる", async () => {
    const st = await build();
    const m = await st.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "vup-1" }),
    );
    const lower: string = m.id;
    const upper = lower.toUpperCase();
    await st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, lower, [1, 0, 0]);
    await st.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, upper, [0, 1, 0]);
    const vectors = await st.vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, [lower]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0].memoryId).toBe(lower);
    expect(vectors[0].vector).toEqual([0, 1, 0]);
    const hits = await st.vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [0, 1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits.map((h: any) => h.memoryId)).toEqual([lower]);
  });
});
