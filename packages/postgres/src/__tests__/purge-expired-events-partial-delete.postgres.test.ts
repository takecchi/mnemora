import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { purgeExpiredEventsForTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 1. 選んだ行の一部だけが実際に消えたとき、件数と期間は実際に消えた行から取る。対象の SELECT は行を掴まないので、選んだ後・DELETE の前に別の接続が選んだ行の一部を消すことがある。
 *    同じ `limit` の同時の掃除（`purge-expired-events-count-and-range`）は全部選ぶか何も選ばないかになり、この「一部だけ」の場面ができない。DELETE を発行する直前に別の接続で最も古い4行を消して、その場面を決定的に作る。
 * 2. 期間の最古・最新は、`RETURNING` が返す順に依らない（順は規定されていない）。行を `at` の新しい順に（主キーは `at` の古い順と逆に）置き、どの実行計画でも新しい順に返るようにする。
 * 3. cutoff が下限より前でない限り、問い合わせて消す。下限（紀元前4714年）と紀元1年の間の cutoff でも消す。極大の保持日数では、cutoff は「`now` − 日数」のままで、表せる範囲に収まる日数を寄せない。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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

/**
 * `DELETE FROM memory_events` を最初に発行する直前に `sideEffect` を実行し、その完了を待ってから本来の文を流す。
 * `sideEffect` の中の文は、このパッチを通っても再入しない（1回だけ発火する）。
 */
async function beforeFirstDelete(sideEffect: () => Promise<void>, run: () => Promise<unknown>) {
  const originalQuery = Client.prototype.query;
  let fired = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config] = args as [string | { text: string }];
    const text = typeof config === "string" ? config : config.text;
    if (!fired && /^\s*DELETE FROM memory_events/i.test(text)) {
      fired = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sideEffect().then(() => (originalQuery as any).apply(this, args));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await run();
  } finally {
    Client.prototype.query = originalQuery;
  }
  expect(fired).toBe(true);
}

describe("purgeExpiredEvents: 選んだ行の一部だけが消えたときの件数・期間と、下限と紀元1年の間の cutoff（Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("選んだ10行のうち最も古い4行が、DELETE の前に別の接続で消えても、purged・meta.purgedCount・期間は実際に消えた6行から取る", async () => {
    const { memoryStore, eventStore } = await stores();
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: "purge-partial" };
    const base = NOW.getTime() - 100 * DAY_MS;
    const ats = Array.from({ length: 10 }, (_, i) => new Date(base + i * MINUTE_MS));
    for (const at of ats) {
      await eventStore.append(ctx, oldEvent(ctx, at));
    }

    let result: Awaited<ReturnType<typeof memoryStore.purgeExpiredEvents>> | undefined;
    await beforeFirstDelete(
      async () => {
        await pool.query(
          `DELETE FROM memory_events WHERE tenant_id = $1 AND at < $2::timestamptz`,
          [ctx.tenantId, ats[4]!.toISOString()],
        );
      },
      async () => {
        result = await memoryStore.purgeExpiredEvents(ctx, { olderThan: NOW, limit: 10 });
      },
    );

    expect(result).toEqual({
      purged: 6,
      reachedLimit: false,
      oldestPurgedAt: ats[4],
      newestPurgedAt: ats[9],
      dryRun: false,
    });
    const events = await eventStore.list(ctx, {});
    expect(events.filter((e) => e.kind === "created")).toHaveLength(0);
    const purgedRows = events.filter((e) => e.kind === "events_purged");
    expect(purgedRows).toHaveLength(1);
    expect(purgedRows[0]!.meta).toMatchObject({
      purgedCount: 6,
      oldestPurgedAt: ats[4]!.toISOString(),
      newestPurgedAt: ats[9]!.toISOString(),
    });
  });

  it("期間の最古・最新は、RETURNING が返す順に依らない（行を at の新しい順に置いても、最古と最新を取り違えない）", async () => {
    const { memoryStore, eventStore } = await stores();
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: "purge-returning-order" };
    const base = NOW.getTime() - 100 * DAY_MS;
    for (let i = 1; i <= 20; i++) {
      await pool.query(
        `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
         VALUES ($1::uuid, $2, NULL, 'created', $3::timestamptz, '{"type":"system"}'::jsonb, '{}'::jsonb)`,
        [
          `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          ctx.tenantId,
          new Date(base - i * MINUTE_MS).toISOString(),
        ],
      );
    }

    const result = await memoryStore.purgeExpiredEvents(ctx, { olderThan: NOW, limit: 100 });

    expect(result.purged).toBe(20);
    expect(result.oldestPurgedAt).toEqual(new Date(base - 20 * MINUTE_MS));
    expect(result.newestPurgedAt).toEqual(new Date(base - 1 * MINUTE_MS));
    const purgedRows = (await eventStore.list(ctx, {})).filter((e) => e.kind === "events_purged");
    expect(purgedRows).toHaveLength(1);
    expect(purgedRows[0]!.meta).toMatchObject({
      purgedCount: 20,
      oldestPurgedAt: new Date(base - 20 * MINUTE_MS).toISOString(),
      newestPurgedAt: new Date(base - 1 * MINUTE_MS).toISOString(),
    });
  });

  for (const dryRun of [false, true]) {
    it(`下限（紀元前4714年）と紀元1年の間の cutoff でも問い合わせる${dryRun ? "（dryRun）" : ""}: 紀元前2000年の行は、cutoff が紀元前1000年なら対象になる`, async () => {
      const { memoryStore, eventStore } = await stores();
      const ctx: Ctx = { tenantId: `purge-bc-range-${dryRun}` };
      const at = new Date(Date.UTC(-1999, 0, 1)); // 紀元前2000年
      await eventStore.append(ctx, oldEvent(ctx, at));
      const olderThan = new Date(Date.UTC(-999, 0, 1)); // 紀元前1000年

      const result = await memoryStore.purgeExpiredEvents(ctx, { olderThan, limit: 10, dryRun });

      expect(result).toEqual({
        purged: 1,
        reachedLimit: false,
        oldestPurgedAt: at,
        newestPurgedAt: at,
        dryRun,
      });
      const kinds = (await eventStore.list(ctx, {})).map((e) => e.kind);
      expect(kinds).toEqual(dryRun ? ["created"] : ["events_purged"]);
    });
  }

  it("保持日数 200万日（cutoff は約紀元前3450年）: 紀元前2000年の行は残り、紀元前4000年の行だけ消える（cutoff を寄せない）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = await stores();
    const ctx: Ctx = { tenantId: "purge-bc-retention-days" };
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 2_000_000 });
    const younger = new Date(Date.UTC(-1999, 0, 1)); // 紀元前2000年: cutoff より新しい
    const older = new Date(Date.UTC(-3999, 0, 1)); // 紀元前4000年: cutoff より古い
    await eventStore.append(ctx, oldEvent(ctx, younger));
    await eventStore.append(ctx, oldEvent(ctx, older));

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: NOW },
    );

    expect(outcome).toEqual({
      kind: "executed",
      result: {
        purged: 1,
        reachedLimit: false,
        oldestPurgedAt: older,
        newestPurgedAt: older,
        dryRun: false,
      },
    });
    const remaining = (await eventStore.list(ctx, {})).filter((e) => e.kind === "created");
    expect(remaining.map((e) => e.at)).toEqual([younger]);
  });
});
