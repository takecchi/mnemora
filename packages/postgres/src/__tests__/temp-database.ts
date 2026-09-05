import type { Pool } from "pg";

/**
 * `migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` が使い捨てのテスト用
 * データベースを作って捨てるための共有ヘルパ（ADR 0020）。
 *
 * ## なぜ `DROP DATABASE ... WITH (FORCE)` を使わないか
 *
 * `WITH (FORCE)`（PostgreSQL 13+）は、対象データベースに繋がっている他のセッションを
 * サーバー側が SIGTERM で強制切断してから DROP する。これは「閉じ切れていないコネクションが
 * 残っている」という不具合を検知不能にする——強制切断そのものが正常系として扱われる。
 *
 * 実際にこれが CI の間欠障害を起こしていた（ADR 0020 に機構を詳述）。要約すると:
 *
 * - `pg` の `Pool#end()`（`pg-pool@3.14.0/index.js` の `end()` 488-499行）は
 *   `ending=true` にして `_pulseQueue()` を呼ぶだけで、ソケットが実際に閉じ切るのを
 *   **待たずに** resolve する（`_pulseQueue()` 133-143行の `ending` 分岐は、
 *   idle client を `_remove()` した直後、`client.end()` の完了コールバックを待たず
 *   `this._clients.length === 0` を見た時点で `_endCallback()` を呼ぶ。`_remove()`
 *   172-186行は `this._clients` を同期的に空にしてから `client.end(cb)` を呼ぶだけで、
 *   `cb` の完了は待たれない）。
 * - つまり `await pool.end()` の直後でも、サーバー側の backend はまだ生きていることがある。
 * - そこへ `DROP DATABASE ... WITH (FORCE)` を撃つと、FORCE が「まだ閉じ切っていない
 *   自分自身の接続」を SIGTERM し、backend が `57P01`
 *   （`FATAL: terminating connection due to administrator command`）を返す。
 * - 閉じかけの client には `_release()`（389行）が付けた `idleListener` がまだ外れておらず
 *   （`_remove()` は idle リスナーを外さない）、これが `57P01` を `pool.emit('error', ...)`
 *   として発火させる（`makeIdleListener` 53-64行）。`Pool` に `'error'` リスナーが
 *   無ければ Node の `EventEmitter` がそのまま投げ、vitest の unhandled error になる。
 *
 * **根で直す方法は「落とす前に、自分が開けた接続が本当に0本になったことを実測してから、
 * FORCE 無しで DROP する」こと。** FORCE を外すと、閉じ切れていないコネクションが
 * 残っている場合 `DROP DATABASE`（FORCE 無し）は `55006`
 * （`object_in_use`）で素直に失敗する——黙って握り潰されず、必ず表に出る。
 */

/** drain 待ちの上限（ミリ秒）の既定値。 */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * `pg_stat_activity` をポーリングする間隔（ミリ秒）。
 * 短すぎるとサーバーへの問い合わせ頻度が上がるだけで、テストの体感速度への寄与は
 * 誤差程度（このデータベースは他のワークロードを持たない使い捨てのものなので、
 * 100ms 間隔での問い合わせがボトルネックになったことは無い）。
 */
const DRAIN_POLL_INTERVAL_MS = 100;

interface ActiveConnectionRow {
  pid: number;
  state: string | null;
  application_name: string | null;
  query: string | null;
}

/**
 * 使い捨てデータベースの DROP を、接続が残ったまま強行しようとしたときに投げる。
 *
 * **黙って `WITH (FORCE)` へフォールバックしないこと。** このエラーが投げられること
 * そのものが「閉じ切れていないコネクションがある」という不具合の検出であり、
 * 握り潰す先が無い。
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
 * **`admin` 自身の接続を数えないこと**: `admin` は `requireDatabaseUrl()` が指す
 * 管理用データベース（テスト全体で共有する接続先。使い捨ての `database` そのものではない）
 * に繋がっているため、`pg_stat_activity.datname = $1`（`$1` = 使い捨て DB 名）で絞り込めば
 * `admin` 自身の行は元から対象に入らない。**実測して確認した**:
 * `temp-database.test.ts` の正のケース（pool を閉じてから drop する方）が、
 * まさに「admin 接続が生きたまま `dropTempDatabase` を呼んでも即座に0本と判定され、
 * 例外にならない」ことを確認する歯になっている。
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
  /** 接続が0本になるのを待つ上限（ミリ秒）。既定は {@link DEFAULT_DRAIN_TIMEOUT_MS}。 */
  drainTimeoutMs?: number;
}

/**
 * 使い捨てのテスト用データベースを、`WITH (FORCE)` を使わずに DROP する。
 *
 * 呼び出し前に、そのデータベースを使い終えた自分の pool を `pool.end()` していることが
 * 前提だが、**`pool.end()` が resolve したことは「サーバー側の接続が閉じた」ことを
 * 保証しない**（このファイル冒頭のコメント参照）。だからここで実際に
 * `pg_stat_activity` を見て0本になるのを待つ。
 *
 * データベースがそもそも存在しない場合（初回作成前の掃除など）は
 * `pg_stat_activity` に該当行が無いため即座に進み、`DROP DATABASE IF EXISTS` は
 * no-op になる。
 */
export async function dropTempDatabase(
  admin: Pool,
  database: string,
  options: DropTempDatabaseOptions = {},
): Promise<void> {
  await waitForNoConnections(admin, database, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
}
