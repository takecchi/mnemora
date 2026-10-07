import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryEventFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

describe("InMemoryMemoryStore.purgeExpiredEvents — events_purged の at は since/until の両端に当たる", () => {
  it("読み戻した at をそのまま until・since に渡すと、どちらでも行自身が返る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
    const ctx: Ctx = { tenantId: "in-memory-events-purged-at" };
    const olderThan = new Date("2026-09-27T00:00:00.000Z");
    await eventStore.append(
      ctx,
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: null,
        kind: "created",
        at: new Date(olderThan.getTime() - 86_400_000),
      }),
    );
    await memoryStore.purgeExpiredEvents(ctx, { olderThan, limit: 100 });

    const [marker] = await eventStore.list(ctx, { kind: "events_purged" });
    expect(marker).toBeDefined();
    const untilHits = await eventStore.list(ctx, { kind: "events_purged", until: marker!.at });
    expect(untilHits.map((e) => e.id)).toEqual([marker!.id]);
    const sinceHits = await eventStore.list(ctx, { kind: "events_purged", since: marker!.at });
    expect(sinceHits.map((e) => e.id)).toEqual([marker!.id]);
  });
});
