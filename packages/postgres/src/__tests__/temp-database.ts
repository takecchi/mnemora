import type { Pool } from "pg";

/**
 * `migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` が使い捨てのテスト用
 * データベースを作って捨てるための共有ヘルパ。
 *
 * ## なぜ `DROP DATABASE ... WITH (FORCE)` を使わないか
 *
 * `WITH (FORCE)`（PostgreSQL 13+）は、対象データベースに繋がっている他のセッションを
 * サーバー側が SIGTERM で強制切断してから DROP する。これは「閉じ切れていないコネクションが
 * 残っている」という不具合を検知不能にする——強制切断そのものが正常系として扱われる。
 *
 * さらに、`pg` の `Pool#end()` はソケットが実際に閉じ切るのを**待たずに** resolve する。
 * つまり `await pool.end()` の直後でも、サーバー側の backend はまだ生きていることがある。
 * そこへ FORCE を撃つと、FORCE が「まだ閉じ切っていない自分自身の接続」を SIGTERM し、
 * backend が `57P01`（`FATAL: terminating connection due to administrator command`）を返す。
 * 閉じかけの client には idle リスナーがまだ外れておらず、これが `57P01` を `pool.emit('error', ...)`
 * として発火させる。`Pool` に `'error'` リスナーが無ければ Node の `EventEmitter` がそのまま
 * 投げ、vitest の unhandled error になる。
 *
 * **そこで、落とす前に、自分が開けた接続が本当に0本になったことを実測してから、FORCE 無しで
 * DROP する。** 閉じ切れていないコネクションが残っている場合、`DROP DATABASE`（FORCE 無し）は
 * `55006`（`object_in_use`）で素直に失敗する——黙って握り潰されず、必ず表に出る。
 */

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

const DRAIN_POLL_INTERVAL_MS = 100;

interface ActiveConnectionRow {
  pid: number;
  state: string | null;
  application_name: string | null;
  query: string | null;
}

/**
 * 使い捨てデータベースの DROP を、接続が残ったまま強行しようとしたときに投げる。
 * **黙って `WITH (FORCE)` へフォールバックしないこと。**このエラーが「閉じ切れていないコネクションがある」
 * 不具合の検出であり、握り潰す先が無い。
 */
export class DatabaseDrainTimeoutError extends Error {
  constructor(
    readonly database: string,
    readonly remaining: ActiveConnectionRow[],
    timeoutMs: number,
  ) {
    const detail = remaining
      .map(
        (row) =>
          `pid=${row.pid} state=${row.state ?? "(null)"} ` +
          `application_name=${row.application_name || "(なし)"} query=${JSON.stringify(row.query ?? "")}`,
      )
      .join("; ");
    super(
      `データベース "${database}" への接続が ${timeoutMs}ms 待っても0本にならなかった` +
        `（残り ${remaining.length} 本）。DROP DATABASE を強行しない（WITH (FORCE) は使わない）。` +
        `残っている接続: ${detail || "(詳細なし)"}`,
    );
    this.name = "DatabaseDrainTimeoutError";
  }
}

/**
 * `database` への接続数が0本になるまで `pg_stat_activity` をポーリングする。
 *
 * **`admin` 自身の接続を数えないこと**: `admin` は管理用データベース（テスト全体で共有する接続先。
 * 使い捨ての `database` そのものではない）に繋がっているため、`pg_stat_activity.datname = $1`
 * （`$1` = 使い捨て DB 名）で絞り込めば `admin` 自身の行は元から対象に入らない。
 * `temp-database.test.ts` の正のケース（pool を閉じてから drop する方）が、admin 接続が生きたまま
 * `dropTempDatabase` を呼んでも即座に0本と判定されることを確認する歯になっている。
 */
async function waitForNoConnections(
  admin: Pool,
  database: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<ActiveConnectionRow>(
      `SELECT pid, state, application_name, query
         FROM pg_stat_activity
        WHERE datname = $1`,
      [database],
    );
    if (rows.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new DatabaseDrainTimeoutError(database, rows, timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
  }
}

export interface DropTempDatabaseOptions {
  drainTimeoutMs?: number;
}

/**
 * 使い捨てのテスト用データベースを、`WITH (FORCE)` を使わずに DROP する。
 *
 * 呼び出し前に、そのデータベースを使い終えた自分の pool を `pool.end()` していることが
 * 前提だが、**`pool.end()` が resolve したことは「サーバー側の接続が閉じた」ことを
 * 保証しない**。だからここで実際に `pg_stat_activity` を見て0本になるのを待つ。
 */
export async function dropTempDatabase(
  admin: Pool,
  database: string,
  options: DropTempDatabaseOptions = {},
): Promise<void> {
  await waitForNoConnections(admin, database, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
}
