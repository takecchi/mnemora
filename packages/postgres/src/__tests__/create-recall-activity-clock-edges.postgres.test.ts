import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import * as schema from "../schema.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `createRecall` の活動時計の、鍵と、advance なしの分岐の文の数。
 *
 * - `record.subjectId`（recall の対象）と `advanceActivityClock.subjectId`（進めるカウンタ）を別の値にする。
 *   同じ値だと、カウンタの鍵を取り違えても結果が同じになる。
 * - advance なしの分岐は、撃つ文が `INSERT INTO recalls` の1本だけで、`BEGIN`/`COMMIT` も他の文も伴わない。
 *   結果（行・カウンタ表に触れない）だけを見ると、往復が増えても緑のまま。
 */

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};

const record = (ctx: Ctx, subjectId: string | null, advanceActivityClock: unknown) =>
  ({
    tenantId: ctx.tenantId,
    subjectId,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage,
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock,
  }) as never;

afterAll(async () => {
  await closeTestClient();
});

describe("createRecall: カウンタの鍵と advance なしの文の数", () => {
  it("subject 単位は advanceActivityClock.subjectId のカウンタを進め、record.subjectId のカウンタは進めない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const settings = new PostgresTenantSettingsStore(db);
    const ctx: Ctx = { tenantId: `recall-clock-edges-key-${Date.now()}` };

    await store.createRecall(ctx, record(ctx, "carol", { scope: "subject", subjectId: "alice" }));

    expect(await settings.getSubjectActivitySeqs(ctx, ["alice", "carol"])).toEqual({ alice: 1 });
  });

  it.each([
    ["undefined", undefined],
    ["false", false],
  ])("advance なし（%s）は、撃つ文が recalls の INSERT の1本だけ", async (_label, advance) => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    const logged: string[] = [];
    const db = drizzle(pool, {
      schema,
      logger: { logQuery: (query) => void logged.push(query) },
    });
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `recall-clock-edges-off-${Date.now()}` };

    await store.createRecall(ctx, record(ctx, null, advance));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/insert\s+into\s+"?recalls"?/i);
  });
});
