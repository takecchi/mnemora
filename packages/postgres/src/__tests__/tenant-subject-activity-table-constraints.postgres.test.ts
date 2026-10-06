import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `tenant_subject_activity`（migration 0024）の `activity_seq` は 0 以上である。通常の「+1」の道は負にならないので、
 * 制約を外されても振る舞いのテストは緑のままになる。直に書いて、負の値を DB が断る（23514）ことを縛る。
 */

const TENANT = "subject-activity-constraints";

afterAll(async () => {
  await closeTestClient();
});

describe("tenant_subject_activity の CHECK（activity_seq >= 0）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("負の activity_seq の INSERT は 23514 で断る。0 は通る", async () => {
    const { pool } = await getTestClient();
    await expect(
      pool.query(
        `INSERT INTO tenant_subject_activity (tenant_id, subject_id, activity_seq) VALUES ($1, 'neg', -1)`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `INSERT INTO tenant_subject_activity (tenant_id, subject_id, activity_seq) VALUES ($1, 'zero', 0)`,
      [TENANT],
    );
    const rows = await pool.query(`SELECT 1 FROM tenant_subject_activity WHERE tenant_id = $1`, [
      TENANT,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("UPDATE で activity_seq を負にするのも 23514 で断り、行は元の値のまま", async () => {
    const { pool } = await getTestClient();
    await pool.query(
      `INSERT INTO tenant_subject_activity (tenant_id, subject_id, activity_seq) VALUES ($1, 'u', 3)`,
      [TENANT],
    );
    await expect(
      pool.query(
        `UPDATE tenant_subject_activity SET activity_seq = -1 WHERE tenant_id = $1 AND subject_id = 'u'`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const rows = await pool.query<{ activity_seq: string }>(
      `SELECT activity_seq FROM tenant_subject_activity WHERE tenant_id = $1 AND subject_id = 'u'`,
      [TENANT],
    );
    expect(rows.rows[0]!.activity_seq).toBe("3");
  });
});
