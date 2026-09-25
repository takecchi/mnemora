import { describe, expect, it } from "vitest";
import type { Ctx, TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { describeTenantSettingsStoreConformance } from "../tenant-settings-store-conformance.js";

/**
 * [Issue #818](https://github.com/takecchi/mnemora/issues/818): PR #717 (`ba6e5dd`) made
 * `TenantSettingsStoreConformanceOptions.supportsTaxonomyMode` a *required* field. The
 * v1.0.0 caller shape — `describeTenantSettingsStoreConformance({ name, createStore,
 * supportsDecayClock })`, the exact `supportsDecayClock` example from
 * `docs/migration-v1.md` §6 (valid against v1.0.0, which predates `supportsTaxonomyMode`
 * entirely) — stopped compiling as a result.
 *
 * This file fixes two teeth in one place:
 *
 * 1. **型**: the `describeTenantSettingsStoreConformance({ name, createStore,
 *    supportsDecayClock: false })` call below (`omitted`) never mentions
 *    `supportsTaxonomyMode` — it mirrors the v1.0.0 call shape exactly. If
 *    `supportsTaxonomyMode` were required again, `tsc -p tsconfig.json`
 *    (`pnpm --filter @mnemora/testkit run typecheck`; `packages/testkit/tsconfig.json`
 *    has `include: ["src"]`, so this `__tests__` file is in scope) would fail to compile
 *    this file — that's the type-level tooth.
 * 2. **挙動**: when `supportsTaxonomyMode` is omitted, no taxonomy conformance `it()`
 *    should run — proven below by counting calls to `getTaxonomyMode`/`setTaxonomyMode`
 *    on a wrapped store. A positive control (`supportsTaxonomyMode: true`, `control`)
 *    proves the counting probe itself actually detects calls when they happen —
 *    `AGENTS.md`「『出なかった』を、事象が無いことの証明にしない——先に陽性対照を示す」。
 *
 * ⚠ **順序に依存する**: `describeTenantSettingsStoreConformance` calls the real `describe()`
 * at module scope, registering the conformance suites into this file's root suite before
 * the closing `describe(...)` block below is registered. Vitest runs a file's top-level
 * suites sequentially in registration order by default (no `.concurrent`), so both
 * conformance suites finish running before the assertions below execute.
 */

interface CountingTaxonomyStore {
  store: TenantSettingsStore;
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
  return { store, counts: () => ({ get, set }) };
}

// --- 陽性対照: supportsTaxonomyMode: true では getTaxonomyMode/setTaxonomyMode が呼ばれる ---
const control = countingTaxonomyStore();
describeTenantSettingsStoreConformance({
  name: "taxonomy-mode probe (control, supportsTaxonomyMode: true)",
  createStore: () => control.store,
  supportsDecayClock: false,
  supportsTaxonomyMode: true,
});

// --- 本題: v1.0.0 の呼び出し形そのもの。supportsTaxonomyMode を渡さない ---
const omitted = countingTaxonomyStore();
describeTenantSettingsStoreConformance({
  name: "taxonomy-mode probe (v1.0.0 call shape, supportsTaxonomyMode omitted)",
  createStore: () => omitted.store,
  supportsDecayClock: false,
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
