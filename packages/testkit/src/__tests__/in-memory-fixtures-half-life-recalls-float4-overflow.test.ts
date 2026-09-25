// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（packages/testkit/src/__fixtures__/in-memory-tenant-settings-store.ts）は
// `assertValidHalfLifeRecalls`（core 共有）で `(0, ∞)`（有限の正の実数、JS の float64）
// を検査するが、`tenant_settings.default_half_life_recalls` の実体は Postgres の
// `real`（IEEE 754 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い
// （migrations/0015_decay_activity_clock.sql の CHECK 制約）。
//
// float64 では有限だが float4 の範囲を超える値（例: `1e300`）を
// `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` へ渡すと、Postgres は
// real への変換で Infinity に丸まり CHECK 制約違反の例外を投げる（実測: 本物の
// Postgres 17 を手元に立てて確認した）。修正前の Fake はこれを検査せず、
// float4 に収まらない値をそのまま静かに保存していた。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812 の作法を踏襲）。

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
    // 既定値のまま変わっていないこと（書き込みが実際に起きていないこと）を確認する。
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

  it("既定の720は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setDefaultHalfLifeRecalls(ctx, 720);
    const value = await store.getDefaultHalfLifeRecalls(ctx);
    expect(value).toBe(720);
  });
});
