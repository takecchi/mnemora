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
