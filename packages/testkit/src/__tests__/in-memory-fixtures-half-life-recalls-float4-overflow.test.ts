import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、値を書き換えない", async () => {
    const store = new InMemoryTenantSettingsStore();
    await expect(store.setDefaultHalfLifeRecalls(ctx, 1e300)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
    const value = await store.getDefaultHalfLifeRecalls(ctx);
    expect(value).toBe(720);
  });

  it("Number.MAX_VALUE（float64 の最大値）は例外を投げる", async () => {
    const store = new InMemoryTenantSettingsStore();
    await expect(store.setDefaultHalfLifeRecalls(ctx, Number.MAX_VALUE)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("3e38（float4 の範囲に収まる、実測で Postgres も受け入れる値）は成功する", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setDefaultHalfLifeRecalls(ctx, 3e38);
    const value = await store.getDefaultHalfLifeRecalls(ctx);
    expect(value).toBe(3e38);
  });

  it("実測の境界: 3.4028235677973362e38 は通り、3.4028235677973366e38 は拒まれる", async () => {
    const store = new InMemoryTenantSettingsStore();
    await expect(
      store.setDefaultHalfLifeRecalls(ctx, 3.4028235677973362e38),
    ).resolves.toBeUndefined();
    await expect(store.setDefaultHalfLifeRecalls(ctx, 3.4028235677973366e38)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it.each([3.5e38, 9e38, 1e39])("float4 の最大値のすぐ外側の %j は拒まれる", async (value) => {
    const store = new InMemoryTenantSettingsStore();
    await expect(store.setDefaultHalfLifeRecalls(ctx, value)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("既定の720は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setDefaultHalfLifeRecalls(ctx, 720);
    const value = await store.getDefaultHalfLifeRecalls(ctx);
    expect(value).toBe(720);
  });
});
