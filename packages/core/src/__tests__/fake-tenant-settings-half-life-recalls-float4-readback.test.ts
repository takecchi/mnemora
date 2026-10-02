import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0500（ADR 0479 の引き受けた負債）: `FakeTenantSettingsStore.setDefaultHalfLifeRecalls` は、
 * `tenant_settings.default_half_life_recalls`（Postgres の `real`＝float4）に書いた値を、`PostgresTenantSettingsStore`・
 * `InMemoryTenantSettingsStore` と同じ形で読み戻す。
 *
 * Postgres は float4 を「float4 として一意に決まる最短の10進表記」で文字列にし、ドライバが float64 として読む
 * （実測: `720.1::float8::real::text` は `720.1`、`16777217` は `1.6777216e+07`、`123456.789` は `123456.79`）。
 * だから読み戻す値は `Math.fround(x)` そのものではない（`Math.fround(720.1)` は `720.0999755859375`）。
 *
 * core は testkit に依存しない（`dependency-boundary.test.ts`）ので、Fake の側に同じ最短表記の探索を持つ。
 * 実 DB との一致は `packages/postgres/src/__tests__/testkit-fixture-alignment.postgres.test.ts`（DB が要る）が見る。
 */

const ctx: Ctx = { tenantId: "tenant-a" };

describe("FakeTenantSettingsStore.setDefaultHalfLifeRecalls は float4 の読み戻しの形で保存する", () => {
  it.each([
    [16777217, 16777216],
    [33554431, 33554432],
    [123456.789, 123456.79],
  ])("float4 で値が変わる入力 %s は、%s として読める", async (written, readBack) => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, written);
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(readBack);
  });

  it.each([720.1, 0.1, 3e38, 1e-37, 12, 720])(
    "やりすぎ: 最短表記が元の値のままの入力 %s は、そのまま読める（Math.fround の値にしない）",
    async (value) => {
      const { tenantSettingsStore } = createFakeRuntimeStores();
      await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, value);
      expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(value);
    },
  );

  it("読み戻した値を書き直しても動かない（冪等）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 16777217);
    const once = await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx);
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, once);
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(once);
  });

  it("拒む入力は今までどおり拒み、前の値を残す", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 16777217);
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1e300)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1e-46)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(16777216);
  });
});
