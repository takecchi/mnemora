import { describe, expect, it } from "vitest";
import type { Ctx, TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { describeTenantSettingsStoreConformance } from "../tenant-settings-store-conformance.js";

/** 順序に依存する: `describeTenantSettingsStoreConformance` は module scope で実際の `describe()` を呼び、下の `describe(...)` より前に登録される。vitest は同じファイルのトップレベルの suite を登録順に走らせるので、検証の時点では両方の適合 suite が走り終えている。 */

interface CountingTaxonomyStore {
  store: TenantSettingsStore;
  /** `setDefaultHalfLifeHours` はこのファイルの本題とは無関係だが、`scripts/__tests__/tenant-settings-conformance-hook-wiring.test.mjs` の門（呼ぶ側は必ず渡す）を通すために両方の呼び出しへ渡す。 */
  setDefaultHalfLifeHours: (ctx: Ctx, hours: number) => void;
  counts: () => { get: number; set: number };
}

function countingTaxonomyStore(): CountingTaxonomyStore {
  const inner = new InMemoryTenantSettingsStore();
  let get = 0;
  let set = 0;
  const store: TenantSettingsStore = {
    getDefaultHalfLifeHours: (ctx: Ctx) => inner.getDefaultHalfLifeHours(ctx),
    getEventRetention: (ctx: Ctx) => inner.getEventRetention(ctx),
    setEventRetention: (ctx, retention) => inner.setEventRetention(ctx, retention),
    getTaxonomyMode: (ctx: Ctx) => {
      get += 1;
      return inner.getTaxonomyMode(ctx);
    },
    setTaxonomyMode: (ctx: Ctx, mode) => {
      set += 1;
      return inner.setTaxonomyMode(ctx, mode);
    },
  };
  return {
    store,
    setDefaultHalfLifeHours: (ctx: Ctx, hours: number) =>
      inner.setDefaultHalfLifeHours(ctx.tenantId, hours),
    counts: () => ({ get, set }),
  };
}

const control = countingTaxonomyStore();
describeTenantSettingsStoreConformance({
  name: "taxonomy-mode probe (control, supportsTaxonomyMode: true)",
  createStore: () => control.store,
  setDefaultHalfLifeHours: control.setDefaultHalfLifeHours,
  supportsDecayClock: false,
  supportsTaxonomyMode: true,
  supportsEraseTenant: false,
});

const omitted = countingTaxonomyStore();
describeTenantSettingsStoreConformance({
  name: "taxonomy-mode probe (v1.0.0 call shape, supportsTaxonomyMode omitted)",
  createStore: () => omitted.store,
  setDefaultHalfLifeHours: omitted.setDefaultHalfLifeHours,
  supportsDecayClock: false,
  supportsEraseTenant: false,
});

describe("supportsTaxonomyMode を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、taxonomy 系の適合項目を実行しない", () => {
  it("陽性対照: supportsTaxonomyMode: true では getTaxonomyMode/setTaxonomyMode が実際に呼ばれている", () => {
    const { get, set } = control.counts();
    expect(get).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(0);
  });

  it("supportsTaxonomyMode を省略すると、getTaxonomyMode/setTaxonomyMode は一度も呼ばれない", () => {
    const { get, set } = omitted.counts();
    expect(get).toBe(0);
    expect(set).toBe(0);
  });
});
