// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryMemoryStore.listActiveClaimPredicates` は `query.limit` を検査せず
// `Array.prototype.slice(0, limit)` へ渡していた。`slice` の `end` は負数を「末尾から数えた
// 除外」、非整数を切り捨て、`NaN` を 0、`Infinity` を全件として扱うので、例外にならずに
// 違う件数を黙って返していた（実測: 述語3つで `-1` は2件、`1.5` は1件、`NaN` は0件）。
//
// `PostgresMemoryStore.listActiveClaimPredicates` は `limit` を生 SQL の `LIMIT`（bigint の
// パラメータ）へそのまま渡すので、負数・`NaN`・`Infinity`・非整数・2^63 以上では Postgres が
// 例外を投げる（2026-09-27 に自分専用の PostgreSQL 17 で実測。2^63 − 1024 は通る）。
// 他の `limit` を取る口（`requeueEmbedJobs`・`archiveDecayed`・`claimBatch` ほか）と同じく、
// fixture を Postgres に揃える。`*-conformance.ts` には触れない（Issue #809）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

async function storeWithPredicates(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  for (const predicate of ["p_old", "p_mid", "p_new"]) {
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: predicate,
        claimKey: { subject: "user", predicate },
      }),
    );
  }
  return store;
}

describe("InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する", () => {
  for (const limit of [NaN, Infinity, 1.5]) {
    it(`limit=${limit} のとき例外を投げる`, async () => {
      const store = await storeWithPredicates();
      await expect(
        store.listActiveClaimPredicates(ctx, { subjectId: null, limit }),
      ).rejects.toThrow(/limit must be an integer/);
    });
  }

  it("limit が負数のとき例外を投げる", async () => {
    const store = await storeWithPredicates();
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: -1 }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  for (const limit of [-1.5, -Infinity]) {
    it(`limit=${limit}（負かつ整数でない）は、先頭の検査＝整数の文面で拒む（#1157）`, async () => {
      const store = await storeWithPredicates();
      await expect(
        store.listActiveClaimPredicates(ctx, { subjectId: null, limit }),
      ).rejects.toThrow(/limit must be an integer/);
    });
  }

  it("limit=2^53 は通り、全件を返す（#1157）", async () => {
    const store = await storeWithPredicates();
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 2 ** 53 }),
    ).resolves.toHaveLength(3);
  });

  it("limit が 2^63 以上のとき例外を投げ、2^63 未満で最大の double では投げない", async () => {
    const store = await storeWithPredicates();
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 2 ** 63 }),
    ).rejects.toThrow(/limit must fit in a Postgres bigint/);
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 2 ** 63 - 1024 }),
    ).resolves.toHaveLength(3);
  });

  it("limit=0 は空配列、正の整数は今どおり先頭からその件数（回帰確認）", async () => {
    const store = await storeWithPredicates();
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 0 }),
    ).resolves.toEqual([]);
    await expect(
      store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 2 }),
    ).resolves.toHaveLength(2);
  });
});
