import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `runMigrations` は `statement_timeout` を設定しない——接続の側の値が、migration の本体にそのまま届く
 * （ADR 0552 の問8。`migrate.ts` の `runMigrations` の TSDoc。歯は ADR 0589 の P9）。
 *
 * 接続の `options` で `statement_timeout` を渡し、migration の本体の中で `current_setting` を読んで
 * 表に残す。runner が `SET statement_timeout = …`（`SET LOCAL` を含む）を挟めば、残る値が変わる。
 * 値を読むだけなので、実際に timeout を起こすための待ちは要らない。
 *
 * このファイル専用のスキーマ名で走らせ、`public` の台帳には触れない。
 */
const SCHEMA = "mnemora_statement_timeout_c";
/** 既定（0）とも、ありがちな値とも違う値にする。 */
const CONNECTION_TIMEOUT = "54321ms";

let pool: Pool;

describe("runMigrations: statement_timeout を設定しない（ADR 0552）", () => {
  beforeAll(async () => {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      options: `-c statement_timeout=${CONNECTION_TIMEOUT}`,
    });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  it("接続で渡した statement_timeout が、migration の本体の中でもそのまま見える", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    // 前提: 接続の options が効いている（効いていなければ、下の比較は何も縛らない）。
    const { rows: before } = await pool.query("SELECT current_setting('statement_timeout') AS v");
    expect(before[0].v).toBe(CONNECTION_TIMEOUT);

    const dir = mkdtempSync(join(tmpdir(), "mnemora-statement-timeout-"));
    writeFileSync(
      join(dir, "0001_seen_statement_timeout.sql"),
      "CREATE TABLE seen_statement_timeout AS SELECT current_setting('statement_timeout') AS v;\n",
    );

    const result = await runMigrations(pool, dir, { schema: SCHEMA });

    expect(result.applied).toEqual(["0001_seen_statement_timeout.sql"]);
    const { rows } = await pool.query(`SELECT v FROM "${SCHEMA}".seen_statement_timeout`);
    expect(rows).toEqual([{ v: CONNECTION_TIMEOUT }]);
  });
});
