/**
 * `packages/postgres` の DB テストをファイル並列にするための部品。
 *
 * ## 何のためか
 *
 * `vitest.config.mts` は2つの project に分かれている——大半のファイルを走らせる
 * `PARALLEL_PROJECT_NAME`（既定の worker 並列）と、`pg_stat_activity` /
 * `pg_terminate_backend` / `pg_locks` / `CREATE ROLE` などクラスタ全体に効くものを
 * 使うファイルだけを集めた `SERIAL_PROJECT_NAME`（`fileParallelism: false`）。
 *
 * 並列の project は、`DATABASE_URL` が指す1つの DB を worker ごとに複製した
 * 専用 DB（`<base>_w<N>`）を使う。**「DB ごと」を選んだ理由・「スキーマごと」を
 * 採らなかった理由・直列の群の一覧と根拠は ADR 0371 を見ること**（ここには写さない
 * ——決定の中身は唯一の出所である ADR に置く）。
 *
 * `global-setup-worker-databases.ts`（vitest の `globalSetup`。1回だけ、メインプロセスで
 * 実行される）が worker DB を作り、この `setup-worker-database.ts`（`setupFiles`。
 * worker ごと・テストファイルごとに実行される）が `process.env.DATABASE_URL` を
 * その worker 専用の DB へ書き換える。両方から同じ命名規則を使うために、
 * その計算をこのファイルへ集約する。
 */
import os from "node:os";

/** 並列に走らせる project の名前。`vitest.config.mts` の `test.projects[].test.name` と一致させる。 */
export const PARALLEL_PROJECT_NAME = "postgres-db-parallel";

/** 直列に走らせる project の名前。 */
export const SERIAL_PROJECT_NAME = "postgres-db-serial";

/**
 * 直列 project の worker が `MNEMORA_WORKER_DB_SUFFIX` に持つ値。
 * `setup-worker-database.ts` はこれが在れば `<base>_${suffix}`、無ければ
 * `<base>_w${VITEST_POOL_ID}` を使う。
 */
export const SERIAL_DB_SUFFIX = "serial";

/** 直列 project の worker がどの DB サフィックスを使うかを、`vitest.config.mts` から伝える環境変数名。 */
export const WORKER_DB_SUFFIX_ENV = "MNEMORA_WORKER_DB_SUFFIX";

/**
 * `setup-worker-database.ts` が、書き換える前の `DATABASE_URL`（migrate 済み・
 * worker DB の TEMPLATE そのもの）を保存しておく環境変数名。
 *
 * ⚠ **なぜ要るか**: vitest は既定で `isolate: true`——テストファイルごとに
 * モジュールレジストリが新しくなるため、`setup-worker-database.ts` 自身の
 * トップレベルのコードは**ファイルごとに再実行される**（`test-db.ts` の
 * `sharedClient` がファイルの寿命でしか使い回されないのと同じ理由）。だが
 * `process.env` は同じ worker プロセスの中で共有される実体であり、1つ目のファイルで
 * `DATABASE_URL` を worker 専用 DB へ書き換えたあと、2つ目のファイルが再び
 * `process.env.DATABASE_URL` を読むと、すでに書き換わった後の値を「元の値」だと
 * 誤認して二重にサフィックスを足してしまう。**書き換える前の値をこの別名の
 * 環境変数に一度だけ退避し、以後はそちらを正とする。**
 */
export const BASE_DATABASE_URL_ENV = "MNEMORA_TEST_DATABASE_URL_BASE";

/**
 * 接続文字列の pathname（DB 名）を読む。`postgresql://user:pass@host:port/name?query` の
 * `name` の部分。
 */
export function databaseNameFromUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`接続文字列から DB 名を読めなかった（pathname が空）: ${connectionString}`);
  }
  return name;
}

/** 接続文字列の DB 名だけを差し替えた、新しい接続文字列を返す（クエリ文字列やその他の部分はそのまま）。 */
export function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** worker 専用 DB の名前（`<base>_w<poolId>` または `<base>_serial`）。 */
export function workerDatabaseName(baseDatabaseName: string, suffix: string): string {
  return `${baseDatabaseName}_${suffix}`;
}

/** 並列 project の worker が使うサフィックス（`w<VITEST_POOL_ID>`）。 */
export function parallelWorkerSuffix(poolId: string): string {
  return `w${poolId}`;
}

/**
 * DB サーバーそのものに繋がらないことを示す Node/pg のエラーコード
 * （`global-setup-worker-databases.ts` が、`DATABASE_URL` が根本的に届かないときに
 * worker DB 作成を諦めて「各テストファイル自身の接続が個別に失敗する」旧来の
 * 挙動へ委ねるために使う。`scripts/__tests__/run-db-tests.test.mjs` の
 * 「DATABASE_URL が在って DB テストが落ちるとき」は、届かない接続先で
 * vitest 自身の `Test Files N failed` という要約が出ることを縛っている——
 * globalSetup がここで例外を投げて vitest 自体を1発で落とすと、その要約が
 * 出ないまま「No test files found」になり、歯が赤くなる。ADR 0371 参照）。
 */
const DATABASE_UNREACHABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ENETUNREACH",
]);

/** {@link DATABASE_UNREACHABLE_ERROR_CODES} のいずれかを持つエラーかどうか。 */
export function isDatabaseUnreachableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    DATABASE_UNREACHABLE_ERROR_CODES.has((error as { code: string }).code)
  );
}

/**
 * vitest 5.0.0 の既定の `maxWorkers` 計算式と同じもの（`getDefaultThreadsCount`、
 * non-watch の場合: `Math.max(os.availableParallelism() - 1, 1)`）。
 *
 * ⚠ **なぜ vitest 自身の自動解決に任せず、ここで明示的に計算して `vitest.config.mts` の
 * 並列 project の `maxWorkers` に固定するか**: project の `maxWorkers` を config で
 * 明示しない場合、`project.config.maxWorkers` は `undefined` のままになる——実際に使われる
 * worker 数は、テスト実行時に `resolveMaxWorkers()`（vitest 内部）が別途計算し、
 * `project.config` には書き戻さない。`global-setup-worker-databases.ts` は
 * worker 用 DB を何個作るかを `project.config.maxWorkers` を読んで決めるため、
 * 明示しないと実際より少ない数の DB しか作らず、後から "database ... does not exist" で
 * 落ちる。
 * ⟹ ここで明示的に計算し、`test.maxWorkers` に固定することで、
 * 「project がその値を実際に使う」と「globalSetup がその値を読める」を一致させる。
 */
export function resolveDefaultMaxWorkers(): number {
  const numCpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(numCpus - 1, 1);
}

/**
 * `<base>_w<数字>` または `<base>_serial` に一致する DB 名かどうか
 * （`global-setup-worker-databases.ts` が前回の中断の残骸を見つけて先に落とすために使う）。
 */
export function isWorkerDatabaseName(databaseName: string, baseDatabaseName: string): boolean {
  const escapedBase = baseDatabaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedBase}_(w\\d+|${SERIAL_DB_SUFFIX})$`).test(databaseName);
}
