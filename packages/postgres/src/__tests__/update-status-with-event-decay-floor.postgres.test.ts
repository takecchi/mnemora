import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `updateStatusWithEvent` は `decay_floor_at` を動かさない（ADR 0303 決定1「`supersedeWithNewMemories`・
 * `updateStatusWithEvent` は値を動かさない」。Issue #1775 の #713 の変異A4）。
 *
 * PR の歯は `supersedeWithNewMemories` だけを凍結していた。`updateStatusWithEvent` 側は `restored` の経路を見る
 * 別の歯だけが噛んでいた。`active → archived`・`forgotten` の遷移の後に、入力の `decayFloorAt` のまま残る。
 */

const TENANT = "update-status-decay-floor-tenant";
const ctx: Ctx = { tenantId: TENANT };
const FLOOR = new Date("2030-01-01T00:00:00.000Z");

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore.updateStatusWithEvent — decay_floor_at を動かさない（ADR 0303 決定1）", () => {
  it.each([
    ["archived", "archived"],
    ["forgotten", "forgotten"],
  ] as const)("active → %s の後も decayFloorAt は入力のまま", async (status, kind) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `floor-${status}`,
        decayFloorAt: FLOOR,
      }),
    );
    const event: NewMemoryEvent = {
      tenantId: TENANT,
      memoryId: memory.id,
      kind,
      actor: { type: "system" },
      digestSnapshot: memory.digest,
      sizeBeforeBytes: null,
      meta: {},
    };

    await store.updateStatusWithEvent(ctx, memory.id, status, {}, event);

    expect((await store.get(ctx, memory.id))!.status).toBe(status);
    expect((await store.get(ctx, memory.id))!.decayFloorAt.toISOString()).toBe(FLOOR.toISOString());
  });
});
