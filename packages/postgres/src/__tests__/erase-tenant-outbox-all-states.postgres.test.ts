import { afterAll, describe, expect, it } from "vitest";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 既存の歯が行を作る経路（observe → tick）は完了済みと claim 済みの行しか作らないので、失敗した行・一度も claim されていない行は、ここで生 SQL で作る。 */

afterAll(async () => {
  await closeTestClient();
});

const STATES: Array<{ name: string; columns: string }> = [
  { name: "未処理", columns: "NULL, NULL, NULL" },
  { name: "claim 中", columns: "now(), NULL, NULL" },
  { name: "完了", columns: "now(), now(), NULL" },
  { name: "失敗", columns: "now(), NULL, now()" },
];

describe("OutboxStore.eraseTenant は、ジョブの状態を問わずテナントの行を全部消す", () => {
  it("未処理・claim 中・完了・失敗のどれも消え、別テナントの行は1行も変わらない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const T = "erase-outbox-states";
    const OTHER = "erase-outbox-states-other";

    for (const tenantId of [T, OTHER]) {
      for (const state of STATES) {
        await pool.query(
          `INSERT INTO outbox (id, tenant_id, kind, payload, claimed_at, completed_at, failed_at)
           VALUES (gen_random_uuid(), $1, 'embed', $2::jsonb, ${state.columns})`,
          [tenantId, JSON.stringify({ secret: `${tenantId}-${state.name}` })],
        );
      }
    }

    const store = new PostgresOutboxStore(db);
    const result = await store.eraseTenant({ tenantId: T }, { limit: 100 });
    expect(result).toEqual({ deleted: STATES.length, reachedLimit: false });

    const left = await pool.query<{ tenant_id: string; n: number }>(
      "SELECT tenant_id, count(*)::int AS n FROM outbox GROUP BY tenant_id ORDER BY tenant_id",
    );
    expect(left.rows).toEqual([{ tenant_id: OTHER, n: STATES.length }]);
  }, 60_000);

  it("dryRun も、状態を問わず数える（失敗した行も、claim 中の行も、未処理の行も）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const T = "erase-outbox-states-dry";
    for (const state of STATES) {
      await pool.query(
        `INSERT INTO outbox (id, tenant_id, kind, payload, claimed_at, completed_at, failed_at)
         VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, ${state.columns})`,
        [T],
      );
    }
    const store = new PostgresOutboxStore(db);
    expect(await store.eraseTenant({ tenantId: T }, { limit: 100, dryRun: true })).toEqual({
      deleted: STATES.length,
      reachedLimit: false,
    });
  }, 60_000);
});
