import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EventRetentionSetting } from "../interfaces/tenant-settings-store.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-a" };

describe("FakeTenantSettingsStore.setEventRetention の入力検査（ADR 0479）", () => {
  it("kind が範囲外なら拒み、何も書かない（無期限として書かない）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(
      tenantSettingsStore.setEventRetention(ctx, {
        kind: "bogus",
      } as unknown as EventRetentionSetting),
    ).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "unset" });
  });

  it("days が int4 を超えるなら拒む。int4 の上限ちょうどは受ける", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(
      tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 2 ** 31 }),
    ).rejects.toThrow(/int4/);
    expect(await tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "unset" });
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 2 ** 31 - 1 });
    expect(await tenantSettingsStore.getEventRetention(ctx)).toEqual({
      kind: "days",
      days: 2 ** 31 - 1,
    });
  });

  it("正常な unlimited / days は従来どおり受ける", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "unlimited" });
    expect(await tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 1 });
    expect(await tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "days", days: 1 });
  });
});

describe("FakeTenantSettingsStore.setDefaultHalfLifeRecalls の float4 下限（ADR 0479）", () => {
  it("0 でない値が float4 で 0 に丸まるなら拒む。非正規数に収まる 1e-40 は受ける", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1e-46)).rejects.toThrow(
      /float4/,
    );
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls!(ctx)).toBe(720);
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1e-40);
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls!(ctx)).toBe(1e-40);
  });
});
