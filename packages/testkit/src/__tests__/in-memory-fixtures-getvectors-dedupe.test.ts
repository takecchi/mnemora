// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// PR #812（`InMemoryMemoryStore.getMany` の重複 id 対応）と同じ形の不一致を
// `InMemoryVectorStore.getVectors` に見つけた。
//
// `InMemoryVectorStore.getVectors`（`packages/testkit/src/__fixtures__/in-memory-vector-store.ts`）は
// 渡された `memoryIds` をそのまま for-of して `results.push` していた。同じ id が
// `memoryIds` に複数回含まれていると、同じ `VectorEntry` を重複して返す。
//
// `PostgresVectorStore.getVectors` は `memory_id = ANY(...)` という集合演算で引くため、
// 同じ id を複数回渡しても一致する行は主キーの性質上1回しか無い（実測: `getVectors([id,id,id])`
// に対し Postgres は1件、修正前の素朴な for-of 実装は3件を返す——本物の Postgres 17 +
// pgvector を手元に立てて確認した）。
//
// このテストは Fake を直接呼ぶだけで、`vector-store-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const SPACE = { provider: "test", model: "fixture-model", dimensions: 3 };

describe("InMemoryVectorStore.getVectors: memoryIds に重複があっても一意な id の集合しか返さない", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const x = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x" }),
    );
    await vectorStore.upsert(ctx, SPACE, x.id, [1, 0, 0]);

    const entries = await vectorStore.getVectors(ctx, SPACE, [x.id, x.id, x.id]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.memoryId).toBe(x.id);
  });

  it("複数の異なる id を混ぜても、それぞれ1回だけ結果に現れる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const x = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x2" }),
    );
    const y = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-y2" }),
    );
    await vectorStore.upsert(ctx, SPACE, x.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, SPACE, y.id, [0, 1, 0]);

    const entries = await vectorStore.getVectors(ctx, SPACE, [x.id, x.id, y.id]);

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.memoryId))).toEqual(new Set([x.id, y.id]));
  });
});
