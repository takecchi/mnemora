import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

/**
 * `setEventRetention` の `days` は、Postgres では `tenant_settings.event_retention_days`（`integer`、int4）に書かれる。
 * 2^31 以上は列に収まらず、Postgres は `22003` で拒む。testkit の fixture も同じく拒み、何も書かない
 * （#1165 が半減期を `real` の範囲に揃えたのと同じ形）。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/store-boundary-diff.postgres.test.ts`（DB が要る）。
 */

const ctx: Ctx = { tenantId: "event-retention-days-range" };

describe("testkit の fixture は int4 に収まらない保持日数を拒む", () => {
  it.each([2 ** 31, 2 ** 53])("days = %d は拒み、前の設定を変えない", async (days) => {
    const store = new InMemoryTenantSettingsStore();
    await store.setEventRetention(ctx, { kind: "days", days: 30 });
    await expect(store.setEventRetention(ctx, { kind: "days", days })).rejects.toThrow(
      new RegExp(
        `^setEventRetention: days does not fit in a Postgres "integer" \\(int4\\) column \\(got ${days}\\)$`,
      ),
    );
    expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
  });

  it("int4 の上限ちょうど（2^31 - 1）は受け付ける", async () => {
    const store = new InMemoryTenantSettingsStore();
    await store.setEventRetention(ctx, { kind: "days", days: 2 ** 31 - 1 });
    expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 2 ** 31 - 1 });
  });
});
