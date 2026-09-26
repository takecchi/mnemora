// PR #806（クローン miku の委譲先が書いた）から、Fake（in-memory）の直しだけを
// 切り出した回帰テスト。#806 は同じ回帰を `memory-store-conformance.ts`（適合テスト。
// 外部の store 実装者も走らせる公開面）へ足していたが、レビュー（Issue #809）により
// 「適合テストへ it を足すのは契約の追加であり、外部実装の CI を落としうる」と指摘され、
// オーナー判断に回された。ここでは代わりに、Fake を直接呼ぶだけの、
// `packages/testkit` 内だけで完結するテストにしてある——`memory-store-conformance.ts`
// には一切触れていない。
//
// 対象: `InMemoryMemoryStore.getMany`（packages/testkit/src/__fixtures__/in-memory-memory-store.ts）。
// 渡された `ids` をそのままループして push していたため、同じ id が複数回含まれていると
// 同じ Memory を重複して返していた。`PostgresMemoryStore.getMany` は `WHERE id = ANY(...)`
// という集合演算で引くため、同じ id を複数回渡しても一致する行は主キーの性質上1回しか
// 無い——Fake は「一意な id の集合」に揃えるべきところを揃えられていなかった。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.getMany: ids に重複があっても一意な id の集合しか返さない", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）", async () => {
    const store = new InMemoryMemoryStore();
    const x = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x" }),
    );
    const y = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-y" }),
    );

    const results = await store.getMany(ctx, [x.id, x.id, y.id]);

    // Postgres 側に ORDER BY が無く順序は契約に無いため、集合として比較する
    // （#806 本文と同じ理由）。
    expect(results).toHaveLength(2);
    expect(new Set(results.map((m) => m.id))).toEqual(new Set([x.id, y.id]));
  });
});

// テナント分離の棚卸し（Issue #854）で気づいた歯の欠落: `get`/`getMany`/`updateStatus`/
// `setEmbeddingStatus`/`purgeMemory`/`markContestedPair` 等には他テナント対象外の歯が
// `memory-store-conformance.ts` に既にあるが、`reinforce` には無かった。この歯は
// `InMemoryMemoryStore` 自身（このファイルが既に import している）を対象にする——
// `memory-store-conformance.ts` へは足さない（このファイル冒頭の #806/Issue #809 と
// 同じ理由: 適合テストへの要件追加は外部の store 実装者の CI を落としうる）。
// この describe は上の getMany の話とは無関係の別トピックだが、
// 「Fake を直接テストしている既存ファイルに足す・新しいファイルは作らない」という
// 同じ方針をそのまま踏襲している。
describe("InMemoryMemoryStore.reinforce: 他テナントの Memory を対象にしない", () => {
  it("他テナントの id を渡すと memory not found を投げ、対象の行は無傷のまま", async () => {
    const store = new InMemoryMemoryStore();
    const ctxA: Ctx = { tenantId: "tenant-a" };
    const ctxB: Ctx = { tenantId: "tenant-b" };
    const memoryA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: "tenant-a", contentHash: "reinforce-tenant-a" }),
    );

    await expect(
      store.reinforce(ctxB, memoryA.id, new Date(memoryA.recordedAt.getTime() + 1000)),
    ).rejects.toThrow(/memory not found for tenant/);

    const afterA = await store.get(ctxA, memoryA.id);
    expect(afterA?.lastReinforcedAt ?? null).toBe(memoryA.lastReinforcedAt ?? null);
    expect(afterA?.updatedAt.getTime()).toBe(memoryA.updatedAt.getTime());
  });
});
