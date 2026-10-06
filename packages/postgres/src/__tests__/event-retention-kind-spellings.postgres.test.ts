import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventRetentionSetting, TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "@mnemora/testkit/fixtures";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `setEventRetention` は、`kind` が `"unlimited"`・`"days"` とちょうど一致するもの以外を、例外で拒み、何も書かない（Issue #1168）。
 * `event-retention-kind-validation.postgres.test.ts` は `bogus`・`Days`・空文字・`kind` 無しを渡す。
 * ここは、それが試していない形を、Postgres と testkit の InMemory に流す。
 *
 * - 前後に空白・改行のある綴り: 空白を落として比べる実装は通す。通ると、後段の `kind === "days"` が偽になり、
 *   `{ kind: " days", days: 7 }` が、黙って無期限（`event_retention_days = NULL`）として書かれる。
 * - 文字列でない `kind`（`null`・数値・オブジェクト）: JSON を素通しする呼び手が渡しうる。
 */

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

const ctx: Ctx = { tenantId: "event-retention-kind-spellings" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeStore] of KITS) {
  describe(`${name}: setEventRetention の kind の綴りと型の検査`, () => {
    it.each([
      ["先頭に空白", { kind: " days", days: 7 }],
      ["末尾に空白", { kind: "days ", days: 7 }],
      ["unlimited の末尾に改行", { kind: "unlimited\n" }],
      ["null", { kind: null, days: 7 }],
      ["数値 0", { kind: 0 }],
      ["空のオブジェクト", { kind: {} }],
    ])("%s の kind は例外を投げ、行を作らない（unset のまま）", async (_label, retention) => {
      const store = await makeStore();
      await expect(
        store.setEventRetention(ctx, retention as unknown as EventRetentionSetting),
      ).rejects.toThrow(KIND_INVALID);
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
    });

    it("既に日数を設定したテナントでも、空白つきの kind は例外を投げ、無期限に書き換えない", async () => {
      const store = await makeStore();
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      await expect(
        store.setEventRetention(ctx, {
          kind: " days",
          days: 7,
        } as unknown as EventRetentionSetting),
      ).rejects.toThrow(KIND_INVALID);
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
    });
  });
}
