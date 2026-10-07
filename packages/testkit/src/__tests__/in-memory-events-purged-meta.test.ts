import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "events-purged-meta" };

describe("InMemoryMemoryStore.purgeExpiredEvents の events_purged の meta", () => {
  it("oldestPurgedAt・newestPurgedAt・olderThan は ISO 8601 の文字列（戻り値は Date のまま）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "events-purged-meta" }),
    );
    await store.updateStatusWithEvent(
      ctx,
      memory.id,
      "forgotten",
      { expectedStatus: "active" },
      {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "forgotten",
        actor: { type: "system" },
        meta: {},
      },
    );
    const olderThan = new Date(Date.now() + 3_600_000);

    const result = await store.purgeExpiredEvents(ctx, { olderThan, limit: 100 });

    const purgedEvents = store.events.filter((e) => e.kind === "events_purged");
    expect(purgedEvents).toHaveLength(1);
    const meta = purgedEvents[0]!.meta;
    expect(meta).toEqual({
      purgedCount: result.purged,
      oldestPurgedAt: result.oldestPurgedAt!.toISOString(),
      newestPurgedAt: result.newestPurgedAt!.toISOString(),
      olderThan: olderThan.toISOString(),
    });
    expect(result.oldestPurgedAt).toBeInstanceOf(Date);
  });
});
