import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, TenantSettingsStore } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "@mnemora/testkit/fixtures";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0499（ADR 0479 の材料）: `setEventRetention` の `days` が int4（`2^31 - 1`）を超えると、以前の
 * `PostgresTenantSettingsStore` は DB の生の例外（`DrizzleQueryError`、SQLSTATE 22003）だった。上限の検査は共有の
 * `assertValidEventRetentionDays`（`@mnemora/core`）にあり、2実装が同じ文面で断る。受け入れる値は変わらない
 * （上限ちょうどは通る）。何も書かない（前の設定が残る）。
 */

const ctx: Ctx = { tenantId: "event-retention-int4" };
const OVER = /^setEventRetention: days does not fit in a Postgres "integer" \(int4\) column \(got \d+\)$/;

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

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeStore] of KITS) {
  describe(`${name}: setEventRetention の日数の上限（ADR 0499）`, () => {
    it.each([2 ** 31, 2 ** 31 + 1, 2 ** 53, Number.MAX_SAFE_INTEGER])(
      "days = %d は名指しの Error で断り、前の設定を変えない",
      async (days) => {
        const store = await makeStore();
        await store.setEventRetention(ctx, { kind: "days", days: 30 });
        const error = await store.setEventRetention(ctx, { kind: "days", days }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).constructor.name).not.toBe("DrizzleQueryError");
        expect((error as Error).message).toMatch(OVER);
        expect((error as Error).message).toContain(`got ${days}`);
        expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
      },
    );

    it("行が無いテナントでも、断ったあとは unset のまま（行を作らない）", async () => {
      const store = await makeStore();
      await expect(store.setEventRetention(ctx, { kind: "days", days: 2 ** 31 })).rejects.toThrow(
        OVER,
      );
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
    });

    it.each([1, 365, 2 ** 31 - 1])("days = %d（上限以下）は今までどおり書ける", async (days) => {
      const store = await makeStore();
      await store.setEventRetention(ctx, { kind: "days", days });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days });
    });

    it("正の整数でない days は、上限の検査より先に、今までの文面で断る", async () => {
      const store = await makeStore();
      for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.setEventRetention(ctx, { kind: "days", days })).rejects.toThrow(
          /event retention days must be a positive integer/,
        );
      }
    });
  });
}
