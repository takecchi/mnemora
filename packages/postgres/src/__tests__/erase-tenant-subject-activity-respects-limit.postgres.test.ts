import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** subject ごとの活動カウンタの行も、他の表と同じ budget を使う。1回の呼び出しで limit を超えて消さない。 */

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore.eraseTenant: subject ごとの活動カウンタも limit を守る（本物の Postgres）", () => {
  it("他の表で budget を使ったあと、残りより多い行があっても limit を超えて消さない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const tenantId = "erase-subject-activity-limit";
    const ctx: Ctx = { tenantId };
    const SUBJECTS = 30;
    const LIMIT = 40;
    // 1回の recall が recalls に1行と、その subject のカウンタに1行を作る。
    for (let i = 0; i < SUBJECTS; i += 1) {
      await store.createRecall(ctx, {
        tenantId,
        subjectId: null,
        query: { text: `q${i}` },
        budget: null,
        omitted: [],
        usage,
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
        advanceActivityClock: { scope: "subject", subjectId: `subject-${i}` },
      } as never);
    }

    const countRows = async (): Promise<number> => {
      let total = 0;
      for (const table of ["recalls", "tenant_activity", "tenant_subject_activity"]) {
        const r = await pool.query(`SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1`, [
          tenantId,
        ]);
        total += r.rows[0].c as number;
      }
      return total;
    };
    const before = await countRows();
    const subjectRows = await pool.query(
      `SELECT count(*)::int AS c FROM tenant_subject_activity WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(subjectRows.rows[0].c).toBe(SUBJECTS);
    // recalls で budget の大半を使うと、カウンタの行は残りより多い。
    expect(before).toBeGreaterThan(LIMIT);

    const outcome = await store.eraseTenant(ctx, { limit: LIMIT });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");

    expect(outcome.deleted).toBeLessThanOrEqual(LIMIT);
    expect(before - (await countRows())).toBeLessThanOrEqual(LIMIT);
    expect(before - (await countRows())).toBe(outcome.deleted);
    expect(outcome.reachedLimit).toBe(true);
  });
});
