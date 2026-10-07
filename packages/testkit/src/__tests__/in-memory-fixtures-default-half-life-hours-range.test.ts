import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

const ctx: Ctx = { tenantId: "default-half-life-range" };

describe("InMemoryTenantSettingsStore.setDefaultHalfLifeHours は (0, ∞) の有限の値を通し、外を拒む", () => {
  it.each([
    ["1 未満の小数", 0.5],
    ["1", 1],
    ["大きい有限の値（上限は無い）", 1e9],
  ])("%s は書けて、そのまま読める", async (_label, hours) => {
    const store = new InMemoryTenantSettingsStore();

    store.setDefaultHalfLifeHours(ctx.tenantId, hours);

    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(hours);
  });

  it.each([
    ["ちょうど 0", 0],
    ["負", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("%s は拒まれ、既定のまま変わらない", async (_label, hours) => {
    const store = new InMemoryTenantSettingsStore();

    expect(() => store.setDefaultHalfLifeHours(ctx.tenantId, hours)).toThrow();

    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(720);
  });
});
