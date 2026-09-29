/**
 * vitest の `globalSetup`（Issue #1277 / ADR 0371）。
 *
 * `vitest.config.mts` のルートに1回だけ（project ごとではなく）宣言する——
 * `test.projects` を使うとき、ルートの `globalSetup` は「テスト全体で1回だけ」
 * 実行される（project 側で個別に宣言すると project の数だけ実行され、後述の
 * TEMPLATE 元 DB の migrate とクローンが競合する。【実測】このリポジトリの
 * vitest 5.0.0 で、root 宣言と project 個別宣言の両方を試し、実行回数と
 * `setup(project)` に渡る `project` の中身を確認した——詳細は ADR 0371）。
 *
 * ## やること
 *
 * 1. `DATABASE_URL` が指す DB（以下「base DB」）に migrate し、テスト用の
 *    埋め込み空間を登録する（`test-db.ts` の `getTestClient()` と同じ処理）。
 *    この base DB は、以後は直接テストに使わない——worker 用 DB の TEMPLATE
 *    としてだけ使う。
 * 2. 並列 project（{@link PARALLEL_PROJECT_NAME}）の**解決後の** `maxWorkers`
 *    を、`this.vitest.projects` から読む（`project.config.maxWorkers` は
 *    CLI の `--maxWorkers` 等の上書きも織り込んだ、実際にその project が使う
 *    worker 数——このファイルで式を再計算しない。ADR 0371 决定1）。
 * 3. `<base>_w1` .. `<base>_w<N>` と `<base>_serial`
 *    （直列 project 用。`fileParallelism: false` なので worker は常に1つ）を、
 *    base DB を TEMPLATE にして複製する。前回の中断の残骸（同じ命名規則に
 *    一致する DB）は、複製の前にすべて落とす。
 * 4. 返す teardown で、作った worker DB をすべて `dropTempDatabase`
 *    （ADR 0020 と同じ「接続0本を実測してから FORCE 無しで DROP」）で落とす。
 *
 * ## `setup-worker-database.ts` との役割分担
 *
 * ここ（globalSetup、メインプロセスで1回）は DB を**作る**。
 * `setup-worker-database.ts`（`setupFiles`、worker ごと・ファイルごと）は
 * `process.env.DATABASE_URL` をその worker 専用の DB へ**向ける**。
 * 接続を実際に開くのは、これまでどおり `test-db.ts` の `getTestClient()` や
 * 各テストファイルの `requireDatabaseUrl()` 経由。
 */
import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import { assertSafeIdentifier } from "../embedding-space-table.js";
import { createPostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { requireDatabaseUrl, TEST_EMBEDDING_SPACE } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";
import {
  databaseNameFromUrl,
  isDatabaseUnreachableError,
  isWorkerDatabaseName,
  parallelWorkerSuffix,
  PARALLEL_PROJECT_NAME,
  SERIAL_DB_SUFFIX,
  withDatabaseName,
  workerDatabaseName,
} from "./worker-database.js";

/** `postgres` は initdb が必ず作る保守用 DB（AGENTS.md の手順・CI の service container のどちらにも在る）。 */
const MAINTENANCE_DATABASE = "postgres";

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = requireDatabaseUrl();
  const baseDatabaseName = databaseNameFromUrl(baseUrl);
  assertSafeIdentifier(baseDatabaseName);

  // 1. base DB を migrate し、TEMPLATE として使えるようにする。
  //    TEMPLATE 元は「他のセッションが繋がっていない」ことが要る（PostgreSQL の制約）ので、
  //    ここで使う接続は必ず閉じてから次へ進む。
  //
  //    ⚠ DB サーバーそのものに繋がらない（`DATABASE_URL` が根本的に届かない）ときは、
  //    ここで例外にして vitest 全体を1発で落とさない。worker DB を作らずに抜け、
  //    各テストファイル自身の `getTestClient()`/`requireDatabaseUrl()` 経由の接続が
  //    個別に失敗する——旧来（このファイルが無かったとき）と同じ挙動。理由は
  //    `isDatabaseUnreachableError` の docstring。
  const baseClient = createPostgresClient(baseUrl);
  try {
    await runMigrations(baseClient.pool);
    await registerEmbeddingSpace(baseClient.pool, TEST_EMBEDDING_SPACE);
  } catch (error) {
    if (isDatabaseUnreachableError(error)) {
      await baseClient.pool.end().catch(() => {});
      return async () => {};
    }
    throw error;
  }
  await baseClient.pool.end();

  // 2. 並列 project の解決後の maxWorkers を読む。ここで黙って 1 に倒すと、
  //    「作った DB の数より多くの worker が実際に走る」という壊れ方（Issue #1277 の
  //    実装中に48コアの手元環境で実際に踏んだ——"database ... does not exist"）を
  //    再発させかねないので、project が見つからない・maxWorkers が数値でないときは
  //    ここで例外にして止める（黙って安全側の既定に倒さない）。
  const allProjects = project.vitest.projects;
  const parallelProject = allProjects.find((p) => p.config.name === PARALLEL_PROJECT_NAME);
  if (parallelProject === undefined) {
    throw new Error(
      `globalSetup: "${PARALLEL_PROJECT_NAME}" という名前の project が見つからない ` +
        `（vitest.config.mts の test.projects[].test.name を確認すること）。` +
        `見つかった project 名: ${allProjects.map((p) => p.config.name).join(", ") || "(なし)"}`,
    );
  }
  const parallelMaxWorkers = parallelProject.config.maxWorkers;
  if (
    typeof parallelMaxWorkers !== "number" ||
    !Number.isInteger(parallelMaxWorkers) ||
    parallelMaxWorkers < 1
  ) {
    throw new Error(
      `globalSetup: "${PARALLEL_PROJECT_NAME}" project の maxWorkers が正の整数ではない ` +
        `(${String(parallelMaxWorkers)})。vitest.config.mts で明示的に固定しているはず ` +
        `（resolveDefaultMaxWorkers()）——config が変わっていないか確認すること。`,
    );
  }

  const workerDatabaseNames = Array.from({ length: parallelMaxWorkers }, (_, index) =>
    workerDatabaseName(baseDatabaseName, parallelWorkerSuffix(String(index + 1))),
  );
  const allWorkerDatabaseNames = [
    ...workerDatabaseNames,
    workerDatabaseName(baseDatabaseName, SERIAL_DB_SUFFIX),
  ];
  for (const name of allWorkerDatabaseNames) {
    assertSafeIdentifier(name);
  }

  // 3. admin 接続は base DB そのものではなく保守用 DB へ——base DB を TEMPLATE に
  //    使うには、base DB に他のセッションが繋がっていてはいけない。
  const maintenanceUrl = withDatabaseName(baseUrl, MAINTENANCE_DATABASE);
  const adminPool = new Pool({ connectionString: maintenanceUrl, max: 1 });

  // 4. 前回の中断の残骸を先に落とす。命名規則に一致する DB を全部拾う——
  //    今回作ろうとしている N とは無関係に、過去の別の N の残骸も含めて落とす。
  const { rows: existingDatabases } = await adminPool.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE $1",
    [`${baseDatabaseName}\\_%`],
  );
  const leftovers = existingDatabases
    .map((row) => row.datname)
    .filter((name) => isWorkerDatabaseName(name, baseDatabaseName));
  for (const name of leftovers) {
    await dropTempDatabase(adminPool, name);
  }

  // 5. base DB を TEMPLATE にして複製する。
  for (const name of allWorkerDatabaseNames) {
    await adminPool.query(`CREATE DATABASE ${name} TEMPLATE ${baseDatabaseName}`);
  }

  return async function teardown(): Promise<void> {
    for (const name of allWorkerDatabaseNames) {
      await dropTempDatabase(adminPool, name);
    }
    await adminPool.end();
  };
}
