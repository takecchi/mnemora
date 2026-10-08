import { describe, expect, it } from "vitest";
import type { Ctx, EventRetention } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

// 設定はテナントごとに1行で、各 setter は自分の列だけを UPSERT する（`TenantSettingsStore` の各 setter の doc）。
// Postgres では、保持期間を日数で設定したあとに別の列を設定しても、`event_retention_days` はそのまま残る。
// 行がすでに在るときに、他の setter が保持期間を無期限（`null`）へ戻さないことを見る。

const ctx: Ctx = { tenantId: "in-memory-tenant-settings-setters-keep-retention" };

const OTHER_SETTERS: ReadonlyArray<
  readonly [name: string, set: (store: InMemoryTenantSettingsStore) => Promise<void> | void]
> = [
  ["setDecayClock", (s) => s.setDecayClock(ctx, "activity")],
  ["setTaxonomyMode", (s) => s.setTaxonomyMode(ctx, "strict")],
  ["setDefaultHalfLifeRecalls", (s) => s.setDefaultHalfLifeRecalls(ctx, 100)],
  ["setDefaultHalfLifeHours（テスト用フック）", (s) => s.setDefaultHalfLifeHours(ctx.tenantId, 48)],
];

const STORES: ReadonlyArray<readonly [label: string, make: () => InMemoryTenantSettingsStore]> = [
  ["自前の Map", () => new InMemoryTenantSettingsStore()],
  [
    "共有の Map を渡した形",
    () => new InMemoryTenantSettingsStore(undefined, undefined, new Map<string, number | null>()),
  ],
];

describe("InMemoryTenantSettingsStore の他の列の setter は、設定済みの保持期間を変えない", () => {
  for (const [storeLabel, make] of STORES) {
    for (const [name, set] of OTHER_SETTERS) {
      it(`${storeLabel}: 日数を設定したあとに ${name} しても、日数のまま`, async () => {
        const store = make();
        await store.setEventRetention(ctx, { kind: "days", days: 30 });
        await set(store);
        const expected: EventRetention = { kind: "days", days: 30 };
        expect(await store.getEventRetention(ctx)).toEqual(expected);
      });
    }
  }

  it("保持期間を設定しても、先に設定した他の列は変えない", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setDecayClock(ctx, "activity");
    await store.setTaxonomyMode(ctx, "strict");
    await store.setDefaultHalfLifeRecalls(ctx, 100);
    store.setDefaultHalfLifeHours(ctx.tenantId, 48);
    await store.setEventRetention(ctx, { kind: "days", days: 30 });
    expect(await store.getDecayClock(ctx)).toBe("activity");
    expect(await store.getTaxonomyMode(ctx)).toBe("strict");
    expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(100);
    expect(await store.getDefaultHalfLifeHours(ctx)).toBe(48);
  });
});
