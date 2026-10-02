import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeTenantSettingsStore` の「新しい行の保持期間の既定」の歯（ADR 0564、Issue #768）。
 *
 * Postgres の `tenant_settings` は、どの設定を書いても行を upsert し、`event_retention_days` は `NULL`
 * ⟹ `unlimited` になる。`InMemoryTenantSettingsStore` は `ensureRow` で同じにしている。以前の Fake は
 * 保持期間の Map にキーを立てず、行ができたのに `unset` のままだった。
 *
 * **testkit の conformance の対象ではない**（Issue #768 コメント2）。直したものはここで押さえる。
 */

const ctxA: Ctx = { tenantId: "tenant-a" };
const ctxB: Ctx = { tenantId: "tenant-b" };

describe("FakeTenantSettingsStore: 行が無いテナントに書くと、保持期間は unlimited の行ができる（ADR 0564）", () => {
  it("setDefaultHalfLifeRecalls: unset → unlimited", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });

    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 100);

    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unlimited" });
  });

  it("setDecayClock: unset → unlimited", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDecayClock!(ctxA, "activity");
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unlimited" });
  });

  it("setTaxonomyMode: unset → unlimited", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setTaxonomyMode!(ctxA, "strict");
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unlimited" });
  });

  it("対照: 既に days の行があるテナントの保持期間は、他の設定を書いても変わらない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctxA, { kind: "days", days: 7 });

    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 100);
    await tenantSettingsStore.setDecayClock!(ctxA, "activity");
    await tenantSettingsStore.setTaxonomyMode!(ctxA, "strict");

    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "days", days: 7 });
  });

  it("対照: 書いたのは別のテナント——行の無いテナントは unset のまま", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 100);
    expect(await tenantSettingsStore.getEventRetention(ctxB)).toEqual({ kind: "unset" });
  });

  it("対照: 何も書かなければ unset のまま。書けずに断られた書き込みも行を作らない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, -1)).rejects.toThrow();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 1e300)).rejects.toThrow();
    await expect(
      tenantSettingsStore.setDecayClock!(ctxA, "bogus" as unknown as "wall"),
    ).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("対照: 明示的に unlimited から days に変えれば days（既定が上書きを妨げない）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 100);
    await tenantSettingsStore.setEventRetention(ctxA, { kind: "days", days: 3 });
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "days", days: 3 });
  });
});
