import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

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
