import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const FLOAT4_MAX = 3.4028234663852886e38;
// float4 の最大値と、その次の（`Infinity` になる）値の真ん中。これ以上は `Infinity` へ丸まり、これ未満は最大値へ丸まる。
const OVERFLOW_AT = 3.4028235677973366e38;
const JUST_BELOW_OVERFLOW = 3.4028235677973362e38;

const ctxA: Ctx = { tenantId: "half-life-edges-tenant-a" };
const ctxB: Ctx = { tenantId: "half-life-edges-tenant-b" };

describe("FakeTenantSettingsStore.setDefaultHalfLifeRecalls: float4 の最大値まで受け、Infinity に丸まる値から断る", () => {
  it("境目の前提（Math.fround の丸め方）", () => {
    expect(Math.fround(FLOAT4_MAX)).toBe(FLOAT4_MAX);
    expect(Math.fround(JUST_BELOW_OVERFLOW)).toBe(FLOAT4_MAX);
    expect(Math.fround(OVERFLOW_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it("float4 の最大値と、Infinity に丸まる直前の値は受ける", async () => {
    for (const value of [FLOAT4_MAX, JUST_BELOW_OVERFLOW]) {
      const { tenantSettingsStore } = createFakeRuntimeStores();
      await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, value)).resolves.toBe(
        undefined,
      );
      // 読み戻すのは float4 の最大値（の最短表記）。3.4e38 より大きい有限の数。
      const readBack = await tenantSettingsStore.getDefaultHalfLifeRecalls(ctxA);
      expect(Number.isFinite(readBack)).toBe(true);
      expect(readBack).toBeGreaterThan(3.4e38);
    }
  });

  it("Infinity に丸まる値は断り、前の値を残す", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 100);
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, OVERFLOW_AT)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctxA)).toBe(100);
  });
});

describe("FakeTenantSettingsStore.setDefaultHalfLifeRecalls: 書くのは呼んだテナントの行だけ", () => {
  it("別のテナントの値は変えない（行を持つテナントも、持たない既定のテナントも）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxB, 111);

    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 222);

    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctxA)).toBe(222);
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctxB)).toBe(111);
    // 行を持たないテナントは、書く前と同じ既定値（720）のまま。
    expect(
      await tenantSettingsStore.getDefaultHalfLifeRecalls({ tenantId: "half-life-edges-other" }),
    ).toBe(720);
  });
});
