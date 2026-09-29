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
 * Issue #760 / ADR 0059・ADR 0062 の 2026-09-29 追記の決め手。
 *
 * ADR 0059（281〜284・407〜409・429行目）と ADR 0062（231〜242・429・448行目）は、
 * 「`memories` への素の `CREATE INDEX` は `ACCESS EXCLUSIVE` ロックを取る」と記録していた。
 * これは実測ではなく、ADR 0343 が別の索引（埋め込みテーブルの部分索引）について実測して
 * 見つけた「実際は `ShareLock`」という結果を踏まえた再検証で、`memories` 側
 * （`idx_memories_period_ann_stage` / `idx_memories_contested_with`）でも同じ食い違いが
 * あることを確かめたことに由来する（詳細は両 ADR の 2026-09-29 追記）。
 *
 * この歯は、その主張——「ShareLock であり、読み取りは止まらず、書き込みだけ止まる」——を
 * 実行時に固定する。ADR は書き換えない文書なので、将来ロックモードが変わっても
 * ADR の文面は自動更新されない。この歯が赤くなることが、再検証の合図になる。
 *
 * ## 手で SQL を書き写さない
 *
 * `0003_period_ann_stage_index.sql` / `0004_contested_with_index.sql` の実際の中身を
 * そのまま `pool.query()` に渡す（`contested-with-index.test.ts` の `MIGRATION_0004_SQL`
 * と同じ作法）。SQL を手で写すと、migration の定義が変わったときにこの歯が追従しない。
 *
 * ## `pg_sleep` を使わない
 *
 * 接続 A で `BEGIN` → migration の `CREATE INDEX` → （`COMMIT` 前）`pg_locks` で
 * 自分自身の pid が `memories` に対して持つ mode を読む → 接続 B から `SELECT` が
 * 通ることを確かめる → 接続 C から短い `statement_timeout` を敷いた `UPDATE` が
 * キャンセルされることを確かめる → A を `COMMIT`（migration と同じ定義を再現したので、
 * そのまま確定してよい——DROP は別の独立した文で先に済ませてあるので、
 * このトランザクションが最初に取るのは CREATE INDEX 自身の要求するロックだけである。
 * DROP と CREATE を同じトランザクションに混ぜると、DROP 自身が要求する
 * `AccessExclusiveLock` がトランザクションの残り全体に持ち越され、
 * CREATE INDEX が実際に何を取るかを覆い隠してしまう）。
 *
 * ## 書き込み側に実在の行を用意しない理由
 *
 * `UPDATE`/`INSERT`/`DELETE` は、対象行が0件でも文の実行開始時に対象テーブルへ
 * `RowExclusiveLock` を要求する（行の有無を見るより前の段階）。`ShareLock` と
 * `RowExclusiveLock` は衝突するため、`WHERE false` で0件しかマッチしない `UPDATE` でも
 * 同じようにブロックされ、`statement_timeout` でキャンセルされる——実在の行を
 * 事前に仕込む必要が無い。
 *
 * ## 並列群に置いた理由
 *
 * この歯は `pg_locks` を読む（`docs/decisions/0371-db-tests-per-worker-database.md` が
 * 直列群への振り分けに使った4語の1つ）。実際には `pid = pg_backend_pid()` で
 * 自分自身の接続に絞っており、他 worker の DB を巻き込む構造ではない
 * （`analyze-memories-lock.postgres.test.ts` も同じ絞り方をしているが、あちらも
 * 直列群に入っている）。それでも、`vitest.config.mts` の `SERIAL_TEST_FILES` は
 * 「`pg_locks` という文字列が本文にあるかどうか」で機械的に決めている一覧であり、
 * ファイルごとに安全性を判断し直す運用にはなっていない——この歯もその機械的な規約に
 * 合わせて `SERIAL_TEST_FILES` に加えた（`packages/postgres/vitest.config.mts` 参照）。
 * PR 本文にこの判断の理由を書く。
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

/**
 * `p` が `ms` のうちに決着した（resolve/reject どちらでも）か。
 * `analyze-memories-lock.postgres.test.ts` の同名関数と同じ形。
 */
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

      // 「前」を作る: migrate 済みの DB には既にこの索引がある。DROP は独立した文として
      // 実行し、これから開くトランザクションには混ぜない（理由は上の docstring）。
      await pool.query(`DROP INDEX ${indexName}`);

      const holder = await pool.connect();
      let committed = false;
      try {
        await holder.query("BEGIN");
        // migration ファイルの中身をそのまま流す（手で書き写さない）。
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

        // 読み: 別セッションからの SELECT は即座に完了する
        // （ShareLock は AccessShareLock と衝突しない）。
        const read = pool.query("SELECT count(*) FROM memories");
        expect(await settlesWithin(read, 2000)).toBe(true);

        // 書き: 別セッションからの UPDATE は RowExclusiveLock を要求し ShareLock と
        // 衝突するため、短い statement_timeout で必ずキャンセルされる。
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

        // ここまで来れば CREATE INDEX は migration と同じ定義で確定してよい
        // （DROP は既に別の文で確定済みなので、これで「前」の状態に戻る）。
        await holder.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) {
          await holder.query("ROLLBACK").catch(() => {});
        }
        holder.release();
        // 保険: 何らかの理由で索引が復元できていなければ、migration をもう一度流す
        // （同じ worker DB を使う他のテストファイルがこの索引の存在を前提にしているため）。
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
