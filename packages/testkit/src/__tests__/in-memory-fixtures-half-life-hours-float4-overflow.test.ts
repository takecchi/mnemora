import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h1", halfLifeHours: 1e300 }),
      ),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });

  it("Number.MAX_VALUE（float64 の最大値）は例外を投げる", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h2",
          halfLifeHours: Number.MAX_VALUE,
        }),
      ),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });

  it("strength=1e300 は（別の理由=値域外で）引き続き例外を投げる（回帰確認、float4 検査は不要）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h3", strength: 1e300 }),
      ),
    ).rejects.toThrow(/strength out of range/);
  });

  it("3e38（float4 の範囲に収まる）と既定の720はどちらも引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h4", halfLifeHours: 3e38 }),
    );
    expect(a.halfLifeHours).toBe(3e38);
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h5" }),
    );
    expect(b.halfLifeHours).toBe(720);
  });
});
