import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryEventFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * インメモリ実装の `events_purged` の `at` も、store を動かすプロセスの時計の値そのまま。
 * 時計を固定して値を見るのは、「読み戻した `at` が `since`/`until` の端に当たる」だけを見る歯では、
 * どの時刻を入れても緑のままだから。固定する時刻は、消す対象の時刻・`olderThan` と違う値にする。
 */

const OLDER_THAN = new Date("2026-09-27T00:00:00.000Z");
const FROZEN = new Date("2031-05-06T07:08:09.123Z");

describe("InMemoryMemoryStore.purgeExpiredEvents — events_purged の at はプロセスの時計の値そのまま", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("時計を固定して消すと、events_purged の at はその固定した時刻になる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
    const ctx: Ctx = { tenantId: "in-memory-events-purged-at-clock" };
    await eventStore.append(
      ctx,
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: null,
        kind: "created",
        at: new Date(OLDER_THAN.getTime() - 86_400_000),
      }),
    );

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
