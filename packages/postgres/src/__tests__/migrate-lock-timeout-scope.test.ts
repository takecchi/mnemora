import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `runMigrations` は本体をロックを持つ接続そのもので流す（Issue #1212）。その接続には
 * ロックを待つための `lock_timeout`（`lockTimeoutMs`）を敷くが、本体の DDL・DML には
 * 効かせない——本体を別の接続で流していたころと同じく、本体が他のロックを待つ時間は
 * `lockTimeoutMs` で切られない。
 */
describe("runMigrations: ロックを待つための lock_timeout は本体に効かない", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  beforeEach(async () => {
    const { pool } = await getTestClient();
    await pool.query("DELETE FROM _mnemora_migrations WHERE name = $1", [
      "9405_lock_timeout_scope.sql",
    ]);
  });

  it("本体が lockTimeoutMs より長く別のロックを待っても、時間切れにならずに適用される", async () => {
    const { pool } = await getTestClient();
    const lockKey = 7_190_158_676_462_701_405n;
    const heldKey = 7_190_158_676_462_701_406n;
    const dir = mkdtempSync(join(tmpdir(), "mnemora-migrate-lock-timeout-scope-"));
    writeFileSync(
      join(dir, "9405_lock_timeout_scope.sql"),
      `SELECT pg_advisory_xact_lock(${heldKey.toString()});`,
    );

    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [heldKey.toString()]);
      const migrating = runMigrations(pool, dir, { lockKey, lockTimeoutMs: 300 });
      // 本体が `heldKey` を lockTimeoutMs（300ms）より長く待つようにしてから手放す。
      await sleep(1_000);
      await holder.query("SELECT pg_advisory_unlock($1)", [heldKey.toString()]);
      const result = await migrating;
      expect(result.applied).toEqual(["9405_lock_timeout_scope.sql"]);
    } finally {
      holder.release();
    }
  }, 20_000);
});
