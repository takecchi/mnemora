import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventRetentionSetting, TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "@mnemora/testkit/fixtures";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const KIND_INVALID = /event retention kind must be 'unlimited' or 'days'/;

const KITS: Array<[string, () => Promise<TenantSettingsStore>]> = [
  ["testkit の InMemory", async () => new InMemoryTenantSettingsStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresTenantSettingsStore(db);
    },
  ],
];

const ctx: Ctx = { tenantId: "event-retention-kind" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeStore] of KITS) {
  describe(`${name}: setEventRetention の kind の検査（Issue #1168）`, () => {
    it.each([
      ["bogus", { kind: "bogus" }],
      ["綴りの誤り Days", { kind: "Days", days: 30 }],
      ["空文字", { kind: "" }],
      ["kind が無い", { days: 30 }],
    ])(
      "型の外の kind（%s）は例外を投げ、行を作らない（unset のまま）",
      async (_label, retention) => {
        const store = await makeStore();
        await expect(
          store.setEventRetention(ctx, retention as unknown as EventRetentionSetting),
        ).rejects.toThrow(KIND_INVALID);
        expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
      },
    );

    it("既に日数を設定したテナントでも、型の外の kind は例外を投げ、日数を書き換えない", async () => {
      const store = await makeStore();
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      await expect(
        store.setEventRetention(ctx, { kind: "Days", days: 7 } as unknown as EventRetentionSetting),
      ).rejects.toThrow(KIND_INVALID);
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
    });

    it("型の中の kind（unlimited / days）は今までどおり書ける", async () => {
      const store = await makeStore();
      await store.setEventRetention(ctx, { kind: "days", days: 3 });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 3 });
      await store.setEventRetention(ctx, { kind: "unlimited" });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
    });
  });
}
