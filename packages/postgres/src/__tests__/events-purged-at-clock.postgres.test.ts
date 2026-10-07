import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 時計を固定して値を見るのは、「ミリ秒に揃っている」だけを見る歯では、どの時刻を入れても緑のままだから。
 * 固定する時刻は、消す対象の時刻・`olderThan`・実際の現在時刻のどれとも違う値にする。
 * 他の時刻（`olderThan`・消した行の `at`・DB の `now()` を丸めた値）を入れる実装との違いは、
 * ミリ秒に揃っているかどうかでは見えない。`Date` だけを偽装するのは、pg クライアントのタイマーを止めないため。
 */

const OLDER_THAN = new Date("2026-09-27T00:00:00.000Z");
const FROZEN = new Date("2031-05-06T07:08:09.123Z");
const DAY_MS = 86_400_000;

function oldEvent(ctx: Ctx, daysAgo: number): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "created",
    at: new Date(OLDER_THAN.getTime() - daysAgo * DAY_MS),
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

describe("events_purged の at は store のプロセスの時計の値そのまま（Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("時計を固定して消すと、events_purged の at はその固定した時刻（ミリ秒まで）になる", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const eventStore = new PostgresEventStore(db);
    const ctx: Ctx = { tenantId: "events-purged-at-clock" };
    await eventStore.append(ctx, oldEvent(ctx, 100));
    await eventStore.append(ctx, oldEvent(ctx, 50));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN);
    try {
      await memoryStore.purgeExpiredEvents(ctx, { olderThan: OLDER_THAN, limit: 100 });
    } finally {
      vi.useRealTimers();
    }

    const markers = await eventStore.list(ctx, { kind: "events_purged" });
    expect(markers).toHaveLength(1);
    expect(markers[0]!.at).toEqual(FROZEN);
  });
});
