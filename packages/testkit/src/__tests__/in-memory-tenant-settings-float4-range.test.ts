import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_HALF_LIFE_HOURS, DEFAULT_HALF_LIFE_RECALLS } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const REAL = /does not fit in a Postgres "real" \(float4\) column/;

describe("InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 で 0 に丸まる値を拒む", () => {
  it("1e-46 は例外を投げ、値を書き換えない", async () => {
    const store = new InMemoryTenantSettingsStore();
    await expect(store.setDefaultHalfLifeRecalls(ctx, 1e-46)).rejects.toThrow(REAL);
    expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(DEFAULT_HALF_LIFE_RECALLS);
  });

  it("float4 の非正規数に収まる値（1e-40）は、Postgres と同じく受け付ける", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setDefaultHalfLifeRecalls(ctx, 1e-40);
    expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(1e-40);
  });
});

describe("InMemoryTenantSettingsStore.setDefaultHalfLifeHours: float4 に収まらない値を拒む", () => {
  it.each([
    ["1e39（溢れる）", 1e39],
    ["Number.MAX_VALUE（溢れる）", Number.MAX_VALUE],
    ["1e-46（0 に丸まる）", 1e-46],
  ])("%s は例外を投げ、値を書き換えない", async (_label, hours) => {
    const store = new InMemoryTenantSettingsStore();
    expect(() => store.setDefaultHalfLifeHours(ctx.tenantId, hours)).toThrow(REAL);
    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(DEFAULT_HALF_LIFE_HOURS);
  });

  it.each([
    ["1e-40（非正規数に収まる）", 1e-40],
    ["3.4e38", 3.4e38],
    ["0.1", 0.1],
    ["720", 720],
  ])("%s は、Postgres と同じく受け付ける", async (_label, hours) => {
    const store = new InMemoryTenantSettingsStore();
    store.setDefaultHalfLifeHours(ctx.tenantId, hours);
    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(hours);
  });

  it("値域 (0, ∞) の外（0・負・NaN・Infinity）は、今までどおり値域の文面で拒む", () => {
    const store = new InMemoryTenantSettingsStore();
    for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.setDefaultHalfLifeHours(ctx.tenantId, hours)).toThrow(
        /out of range \(0, ∞\)/,
      );
    }
  });
});
