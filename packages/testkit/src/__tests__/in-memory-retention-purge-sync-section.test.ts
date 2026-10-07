import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/** 保持期間を読んでから消し終えるまでを、`await` を挟まない1つの同期区間で行う（本物のトランザクションが無い in-memory で、割り込む余地を作らない唯一の手段）。呼び出しを `await` する前に消し終わっていることで見る。 */

const ctx: Ctx = { tenantId: "retention-purge-sync-section" };

describe("InMemoryMemoryStore.purgeExpiredEventsByRetention の同期区間", () => {
  it("呼び出しを await する前に、削除と events_purged の追記まで終わっている", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "retention-purge-sync" }),
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
    const before = store.events.filter((e) => e.kind !== "events_purged").length;
    expect(before).toBeGreaterThan(0);
    store.eventRetentionDays.set(ctx.tenantId, 1);

    const pending = store.purgeExpiredEventsByRetention(ctx, {
      now: new Date(Date.now() + 10 * 24 * 3_600_000),
      limit: 100,
    });

    // まだ await していない。ここで見える状態が、同期区間の中で起きたことの全部。
    expect(store.events.filter((e) => e.kind !== "events_purged")).toHaveLength(0);
    expect(store.events.filter((e) => e.kind === "events_purged")).toHaveLength(1);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "executed", result: { purged: before } });
  });
});
