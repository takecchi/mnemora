import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { purgeExpiredEventsForTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.purgeExpiredEvents`（ADR 0115）と `purgeExpiredEventsForTenant` の歯。
 *
 * 1. **同時に走った掃除が、消していない行を消したと名乗らない。** `PurgeExpiredEventsResult.purged`
 *    は「実際に削除された行数」であり、`events_purged` の `meta.purgedCount` は `docs/memory-model.md`
 *    §9 の「件数と期間」の記録である。対象の SELECT は行を掴まないので、同時に走った掃除は同じ行を
 *    対象に選ぶ。先に消した側だけが実際に消し、後の側の DELETE は0行になる——後の側がそれでも
 *    選んだ件数を名乗ると、監査ログが起きなかった削除を記録する（修正前の実測: 8本同時・対象400件・
 *    limit 300 で、名乗りの合計 2400、実際の削除 300）。
 * 2. **受け付けた保持日数で、掃除が例外にならない。** `setEventRetention` は正の整数を受け付け、
 *    Postgres の列は `integer`（2^31 − 1 まで）である。日数が大きいと cutoff が
 *    PostgreSQL の timestamptz の下限（4714-11-24 BC）より前になり（約247万日から）、さらに
 *    大きいと JS の `Date` の範囲を越えて Invalid Date になる（約1億日から）。どちらも
 *    「cutoff より古い行は1件も無い」ので、結果は0件の削除であり、testkit の fixture もそう返す。
 *    修正前の Postgres は `timestamp out of range` などの例外で、そのテナントの掃除が毎回落ちていた。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;

function oldEvent(ctx: Ctx, at: Date): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "created",
    at,
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

async function stores() {
  const { db } = await getTestClient();
  return {
    memoryStore: new PostgresMemoryStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  };
}

describe("purgeExpiredEvents: 同時に走った掃除の件数と、極大の保持日数（Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("8本同時に掃除しても、名乗った件数の合計と events_purged の件数の合計が、実際に消えた行数に等しい", async () => {
    const { memoryStore, eventStore } = await stores();
    const ctx: Ctx = { tenantId: "purge-concurrency" };
    const total = 400;
    for (let i = 0; i < total; i++) {
      await eventStore.append(ctx, oldEvent(ctx, new Date(NOW.getTime() - 100 * DAY_MS + i)));
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        memoryStore.purgeExpiredEvents(ctx, { olderThan: NOW, limit: 300 }),
      ),
    );

    const events = await eventStore.list(ctx, {});
    const purgedRows = events.filter((e) => e.kind === "events_purged");
    const actuallyDeleted = total - (events.length - purgedRows.length);
    const claimed = results.reduce((sum, r) => sum + r.purged, 0);
    const recorded = purgedRows.reduce((sum, e) => sum + (e.meta.purgedCount as number), 0);

    expect(actuallyDeleted).toBeGreaterThan(0);
    expect(claimed).toBe(actuallyDeleted);
    expect(recorded).toBe(actuallyDeleted);
    // 1行も消さなかった呼び出しは events_purged を積まない（ADR 0115: purged === 0 なら追記しない）。
    expect(purgedRows.length).toBe(results.filter((r) => r.purged > 0).length);
  }, 60_000);

  for (const days of [2_470_000, 2 ** 31 - 1]) {
    for (const dryRun of [false, true]) {
      it(`保持日数 ${days}${dryRun ? "（dryRun）" : ""}: 例外にならず0件の削除を返し、何も消さず、何も積まない`, async () => {
        const { memoryStore, eventStore, tenantSettingsStore } = await stores();
        const ctx: Ctx = { tenantId: `purge-range-${days}-${dryRun}` };
        await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days });
        await eventStore.append(ctx, oldEvent(ctx, new Date("1970-01-01T00:00:00.000Z")));

        const outcome = await purgeExpiredEventsForTenant(
          ctx,
          { memoryStore, tenantSettingsStore },
          { limit: 10, now: NOW, dryRun },
        );

        expect(outcome).toEqual({
          kind: "executed",
          result: {
            purged: 0,
            reachedLimit: false,
            oldestPurgedAt: null,
            newestPurgedAt: null,
            dryRun,
          },
        });
        expect((await eventStore.list(ctx, {})).map((e) => e.kind)).toEqual(["created"]);
      });
    }
  }

  it("cutoff が timestamptz の下限ちょうどなら今どおり問い合わせる（下限より前の行は存在しえないので0件）", async () => {
    const { memoryStore, eventStore } = await stores();
    const ctx: Ctx = { tenantId: "purge-range-edge" };
    await eventStore.append(ctx, oldEvent(ctx, new Date("1970-01-01T00:00:00.000Z")));
    // 4714-11-24 BC 00:00:00 UTC（天文学的年 -4713）。PostgreSQL の timestamptz の下限。
    const pgMin = new Date(Date.UTC(-4713, 10, 24));
    const result = await memoryStore.purgeExpiredEvents(ctx, { olderThan: pgMin, limit: 10 });
    expect(result.purged).toBe(0);
    expect((await eventStore.list(ctx, {})).length).toBe(1);
  });
});
