import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `ArchiveDecayedResult.archived` は `decay_floor_at` の昇順で、**同着は `id` の昇順**で返す（interface の doc）。
 * 既存の試験は `decay_floor_at` がどれも違う行で掃いていて、同着の並びを逆にする形が緑のまま通っていた。
 */

const ctx: Ctx = { tenantId: "archive-decayed-ties-returned-in-id-order" };
const FLOOR = new Date("2026-02-01T00:00:00.000Z");

describe("archiveDecayed は、decay_floor_at が同着の行を id の昇順で返す", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("同着の5行が、id の昇順に並ぶ", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const m = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `h-${n}`,
          decayFloorAt: FLOOR,
        }),
      );
      ids.push(m.id);
    }

    const result = await store.archiveDecayed(ctx, {
      now: new Date("2026-06-01T00:00:00.000Z"),
      limit: 10,
      clock: "wall",
    });
    // 前提: 5行とも同じ decay_floor_at で掃かれている。
    expect(result.archived.map((a) => a.decayFloorAt.toISOString())).toEqual(
      Array(5).fill(FLOOR.toISOString()),
    );
    expect(result.archived.map((a) => a.memoryId)).toEqual([...ids].sort());
  });
});
