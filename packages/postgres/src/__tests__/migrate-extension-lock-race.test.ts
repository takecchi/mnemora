import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #757 を再現する: schema の違う `runMigrations` を同時にまっさらな DB へ流すと、
 * ADR 0057 決定6により advisory lock のキーが schema ごとに別になるため互いを待たず、
 * `CREATE EXTENSION IF NOT EXISTS` 同士が `pg_extension_name_index`（`extname` 単独の
 * 一意制約——拡張はスキーマではなく DB 全体に1つしか置けない）で衝突する。
 *
 * 前任の測定（Issue #757 コメント、`child_process.spawn` + IPC バリアで別プロセスを揃えた
 * 実測）と同じ組を、`migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` が
 * 既にこのリポジトリで使っている方式（同一プロセス内、`Pool` を分けて `Promise.all` で
 * 本当に並行にクエリを送る——advisory lock はセッション単位の名前空間なので、OS
 * プロセスを分けなくても DB 側では真に並行なセッション競合になる）で確かめる。
 * まっさらな DB でないと拡張の初回作成という条件を満たさないため、**試行ごとに
 * 新しいデータベースを作って捨てる**（`createBlankDatabase` / `dropTempDatabase`、
 * `migrate-concurrency.test.ts` と同じ ADR 0020 の作法）。
 *
 * 試行回数は Issue #757 の25/25という前任の実測ほど多くは取らない——CI 時間を
 * 不当に伸ばさないため（`migrate-concurrency.test.ts` 冒頭のコメントと同じ配慮）。
 * ここでは ADR 0018 追記（Issue #755）が使った N=8 に合わせ、各組8試行とする。
 * 前任の実測が決定的（ほぼ100%失敗）だったため、8試行でも赤を示すには十分なはず
 * ——実際に赤くなるかどうかは、このテストを未修正のコードに当てて実測する
 * （PR 本文に出力を残す）。
 */

const DB_PREFIX = "mnemora_ext_lock_race";
const TRIALS = 8;

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function createBlankDatabase(database: string): Promise<void> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
}

function newPool(database: string): Pool {
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  openedPools.push(pool);
  return pool;
}

interface TrialOutcome {
  readonly ok: boolean;
  /** 失敗した呼び出しのエラーメッセージ（診断用。空なら全員成功）。 */
  readonly errors: string[];
}

/**
 * `database` を作り捨てながら、`callers`（各要素が「1プロセス相当」の `runMigrations` 呼び出し）
 * を本当に並行に(`Promise.allSettled`)撃つ。1回分の試行を1つの結果にまとめて返す。
 */
async function runConcurrentTrial(
  database: string,
  callers: ReadonlyArray<(pool: Pool) => Promise<unknown>>,
): Promise<TrialOutcome> {
  await createBlankDatabase(database);
  const pools = callers.map(() => newPool(database));
  const results = await Promise.allSettled(pools.map((pool, i) => callers[i]!(pool)));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  return { ok: errors.length === 0, errors };
}

async function runTrials(
  dbPrefix: string,
  callers: ReadonlyArray<(pool: Pool) => Promise<unknown>>,
): Promise<{ trials: number; failedTrials: number; failures: string[][] }> {
  const failures: string[][] = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    const database = `${dbPrefix}_${trial}`;
    const { ok, errors } = await runConcurrentTrial(database, callers);
    if (!ok) {
      failures.push(errors);
    }
  }
  return { trials: TRIALS, failedTrials: failures.length, failures };
}

describe("runMigrations: schema が違う同時呼び出しでの CREATE EXTENSION 競合（Issue #757）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  // Issue #757 の表「未指定 + 指定 s1」（前任の実測: 25/25 失敗）。
  it("未指定 + 指定 s1 を同時に migrate しても、CREATE EXTENSION が競合しない", async () => {
    const { failedTrials, failures } = await runTrials(`${DB_PREFIX}_unspec_s1`, [
      (pool) => runMigrations(pool),
      (pool) => runMigrations(pool, undefined, { schema: "s1" }),
    ]);
    expect(
      failedTrials,
      `${TRIALS}試行中${failedTrials}試行が失敗した:\n${JSON.stringify(failures, null, 2)}`,
    ).toBe(0);
  }, 180_000);

  // Issue #757 の表「指定 s1 ＋ 指定 s2」（前任の実測: 25/25 失敗）。
  it("指定 s1 + 指定 s2 を同時に migrate しても、CREATE EXTENSION が競合しない", async () => {
    const { failedTrials, failures } = await runTrials(`${DB_PREFIX}_s1_s2`, [
      (pool) => runMigrations(pool, undefined, { schema: "s1" }),
      (pool) => runMigrations(pool, undefined, { schema: "s2" }),
    ]);
    expect(
      failedTrials,
      `${TRIALS}試行中${failedTrials}試行が失敗した:\n${JSON.stringify(failures, null, 2)}`,
    ).toBe(0);
  }, 180_000);
});
