/**
 * `process.env.DATABASE_URL` を、この vitest worker 専用の DB へ書き換える
 * （Issue #1277 / ADR 0371）。`vitest.config.mts` の両方の project（並列・直列）の
 * `setupFiles` の先頭に置く——それより後に読み込まれるテストファイルは、
 * `test-db.ts` の `requireDatabaseUrl()` 経由で常にこの worker 専用 DB を見る。
 *
 * DB そのものを作る／migrate する処理は `global-setup-worker-databases.ts`
 * （vitest の `globalSetup`、メインプロセスで1回だけ実行）にある。ここでは
 * 「どの DB を見るか」を決めるだけ——接続はしない。
 *
 * 命名規則・`BASE_DATABASE_URL_ENV` を使う理由は `worker-database.ts` の docstring。
 */
import {
  BASE_DATABASE_URL_ENV,
  databaseNameFromUrl,
  parallelWorkerSuffix,
  withDatabaseName,
  workerDatabaseName,
  WORKER_DB_SUFFIX_ENV,
} from "./worker-database.js";

const baseUrl = process.env[BASE_DATABASE_URL_ENV] ?? process.env.DATABASE_URL;

if (baseUrl) {
  // 2回目以降（同じ worker で2つ目以降のテストファイル）のために、元の値を残す。
  process.env[BASE_DATABASE_URL_ENV] = baseUrl;

  const poolId = process.env.VITEST_POOL_ID ?? "1";
  const suffix = process.env[WORKER_DB_SUFFIX_ENV] ?? parallelWorkerSuffix(poolId);
  const baseDatabaseName = databaseNameFromUrl(baseUrl);
  process.env.DATABASE_URL = withDatabaseName(
    baseUrl,
    workerDatabaseName(baseDatabaseName, suffix),
  );
}
// `baseUrl` が無い（`DATABASE_URL` 未設定）ときは何もしない——
// `test-db.ts` の `requireDatabaseUrl()` が、これまでどおりの分かりやすいエラーで落ちる。
