import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `purgeExpiredEvents` が積む `events_purged` の `at`（[ADR 0427](../../../../docs/decisions/0427-events-purged-at-millisecond.md)）。
 *
 * `EventStore.list` の `since`/`until` は両端を含む（`packages/core/src/interfaces/event-store.ts`）。
 * 読み戻した `at` をそのまま `until` に渡せば、その行自身が返らなければならない。
 * 直す前の `at` は SQL の `now()`（マイクロ秒）で、読み戻すとミリ秒に切り捨てられるため、
 * `until: marker.at` の比較（`at <= until`）にその行自身が当たらなかった。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;

function oldEvent(ctx: Ctx): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "created",
    at: new Date(NOW.getTime() - 100 * DAY_MS),
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

describe("events_purged の at は、読み戻した値で since/until の両端に当たる（Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("until と since に読み戻した at をそのまま渡すと、どちらでも events_purged の行自身が返る", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const eventStore = new PostgresEventStore(db);
    const ctx: Ctx = { tenantId: "events-purged-at-ms" };
    // DB の `now()` の端数がたまたまミリ秒ちょうどになる回で見落とさないよう、何度か積む。
    for (let i = 0; i < 5; i++) {
      await eventStore.append(ctx, oldEvent(ctx));
      await memoryStore.purgeExpiredEvents(ctx, { olderThan: NOW, limit: 100 });
    }

    const markers = await eventStore.list(ctx, { kind: "events_purged" });
    expect(markers).toHaveLength(5);
    for (const marker of markers) {
      const untilHits = await eventStore.list(ctx, { kind: "events_purged", until: marker.at });
      expect(untilHits.map((e) => e.id)).toContain(marker.id);
      const sinceHits = await eventStore.list(ctx, { kind: "events_purged", since: marker.at });
      expect(sinceHits.map((e) => e.id)).toContain(marker.id);
    }

    // 列に入っている値そのものがミリ秒で揃っている（他の書き込みの口と同じ `toPgTimestamp`）。
    const raw = await db.execute(sql`
      SELECT count(*)::int AS n FROM memory_events
      WHERE tenant_id = ${ctx.tenantId} AND kind = 'events_purged'
        AND date_trunc('milliseconds', at) <> at
    `);
    expect((raw.rows[0] as { n: number }).n).toBe(0);
  });
});
