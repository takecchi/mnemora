import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * migration の実際の中身をそのまま `pool.query()` に渡し、手で SQL を書き写さない（migration の定義が変わったときにこの歯が追従しなくなるため）。
 *
 * `pg_sleep` を使わない。接続 A で `BEGIN` → migration の `CREATE INDEX` → （`COMMIT` 前）`pg_locks` で自分自身の pid が
 * `memories` に対して持つ mode を読む → 接続 B から `SELECT` が通ることを確かめる → 接続 C から短い `statement_timeout` を敷いた
 * `UPDATE` がキャンセルされることを確かめる → A を `COMMIT`、の順に進める。
 * DROP は別の独立した文で先に済ませる。DROP と CREATE を同じトランザクションに混ぜると、DROP 自身が要求する
 * `AccessExclusiveLock` がトランザクション全体に持ち越され、CREATE INDEX が実際に何を取るかを覆い隠してしまう。
 *
 * 書き込み側に実在の行は要らない。`UPDATE`/`INSERT`/`DELETE` は、対象行が0件でも文の実行開始時に対象テーブルへ
 * `RowExclusiveLock` を要求し、`ShareLock` と衝突するので、`WHERE false` の `UPDATE` でもブロックされる。
 */

interface LockModeCase {
  migrationFile: string;
  indexName: string;
}

const CASES: LockModeCase[] = [
  { migrationFile: "0003_period_ann_stage_index.sql", indexName: "idx_memories_period_ann_stage" },
  { migrationFile: "0004_contested_with_index.sql", indexName: "idx_memories_contested_with" },
];

afterAll(async () => {
  await closeTestClient();
});

/** `p` が `ms` のうちに決着した（resolve/reject どちらでも）か。 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

describe.each(CASES)(
  "$migrationFile の CREATE INDEX が memories に取るロック（ADR 0059/0062 2026-09-29 追記）",
  ({ migrationFile, indexName }) => {
    const migrationSql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, migrationFile), "utf8");

    it("ShareLock を取り、読みは通り、書きは短い statement_timeout で止まる", async () => {
      await resetTestDatabase();
      const { pool } = await getTestClient();

      // 「前」を作る: migrate 済みの DB には既にこの索引がある。DROP は独立した文として実行し、これから開くトランザクションには混ぜない。
      await pool.query(`DROP INDEX ${indexName}`);

      const holder = await pool.connect();
      let committed = false;
      try {
        await holder.query("BEGIN");
        await holder.query(migrationSql);

        const { rows } = await holder.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
           WHERE relation = 'memories'::regclass
             AND pid = pg_backend_pid()
             AND locktype = 'relation'`,
        );
        const modes = rows.map((r) => r.mode);
        expect(modes).toContain("ShareLock");
        expect(modes).not.toContain("AccessExclusiveLock");

        const read = pool.query("SELECT count(*) FROM memories");
        expect(await settlesWithin(read, 2000)).toBe(true);

        const writerClient = createPostgresClient(requireDatabaseUrl(), {
          options: "-c statement_timeout=300",
          max: 1,
        });
        try {
          await expect(
            writerClient.pool.query("UPDATE memories SET tenant_id = tenant_id WHERE false"),
          ).rejects.toMatchObject({ code: "57014" });
        } finally {
          await closePostgresClient(writerClient).catch(() => {});
        }

        await holder.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) {
          await holder.query("ROLLBACK").catch(() => {});
        }
        holder.release();
        // 保険: 索引が復元できていなければ、migration をもう一度流す（同じ worker DB を使う他のテストファイルがこの索引の存在を前提にしているため）。
        const check = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [
          indexName,
        ]);
        if (check.rowCount === 0) {
          await pool.query(migrationSql);
        }
      }
    }, 15_000);
  },
);
