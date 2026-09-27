// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// core の `FakeMemoryStore.listActiveClaimPredicates` も、testkit の
// `InMemoryMemoryStore.listActiveClaimPredicates` と同じく `query.limit` を検査せず
// `slice(0, limit)` へ渡していた。Postgres（生 SQL の `LIMIT`）に揃えて、負数・`NaN`・
// `Infinity`・非整数・2^63 以上を例外にする（歯の対は
// `packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts`）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("FakeMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する", () => {
  const cases: [number, RegExp][] = [
    [NaN, /limit must be an integer/],
    [Infinity, /limit must be an integer/],
    [1.5, /limit must be an integer/],
    [-1, /limit must not be negative/],
    [2 ** 63, /limit must fit in a Postgres bigint/],
  ];
  for (const [limit, message] of cases) {
    it(`limit=${limit} のとき例外を投げる`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.listActiveClaimPredicates!(ctx, { subjectId: null, limit }),
      ).rejects.toThrow(message);
    });
  }

  it("limit=0 は空配列を返す（回帰確認）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: null, limit: 0 }),
    ).resolves.toEqual([]);
  });
});
