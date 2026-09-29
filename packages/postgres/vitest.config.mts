import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";
import {
  PARALLEL_PROJECT_NAME,
  resolveDefaultMaxWorkers,
  SERIAL_DB_SUFFIX,
  SERIAL_PROJECT_NAME,
  WORKER_DB_SUFFIX_ENV,
} from "./src/__tests__/worker-database.js";

// packages/testkit/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。

/**
 * `pg_stat_activity` / `pg_terminate_backend` / `pg_locks` / `CREATE ROLE` など、
 * DB ごとの分離では塞がらない・クラスタ全体に効くものを使うファイル
 * （直列に残す理由・各ファイルを入れた grep の語は ADR 0371）。
 *
 * ⚠ ここに無いファイルはすべて {@link PARALLEL_PROJECT_NAME} project が worker 並列で走らせる
 * ——worker ごとの専用 DB を使うので、`resetTestDatabase()` の `TRUNCATE` は互いに干渉しない
 * （Issue #1277）。
 */
const SERIAL_TEST_FILES = [
  "src/__tests__/archive-decayed-concurrency.postgres.test.ts",
  "src/__tests__/db-transaction-connection-loss.test.ts",
  "src/__tests__/drizzle-pool-proxy.test.ts",
  "src/__tests__/migrate-connection-loss.test.ts",
  "src/__tests__/outbox-claim-statement-failure-recovery.postgres.test.ts",
  "src/__tests__/pool-error-warning-guard.postgres.test.ts",
  "src/__tests__/pool-idle-connection-loss.test.ts",
  "src/__tests__/purge-expired-events-by-retention-concurrency.postgres.test.ts",
  "src/__tests__/restore-superseded-concurrent-forget.postgres.test.ts",
  "src/__tests__/scale-bench-close-on-throw.postgres.test.ts",
  "src/__tests__/temp-database.test.ts",
  "src/__tests__/analyze-memories-lock.postgres.test.ts",
  "src/__tests__/advisory-lock-cleanup.postgres.test.ts",
  // Issue #760 / ADR 0059・0062 の 2026-09-29 追記の決め手。pg_locks を読むので、
  // ADR 0371 と同じ機械的な規約（この4語に当たるファイルは直列群）に合わせて足した
  // （PR 本文に理由を書く）。
  "src/__tests__/create-index-lock-mode.postgres.test.ts",
  "src/__tests__/extension-mode.postgres.test.ts",
  "src/__tests__/migrate-concurrency.test.ts",
  "src/__tests__/vector-space-concurrency.test.ts",
  // worker 専用 DB の `memories` に `ANALYZE` を明示的に打ち、同じ DB を後から使う
  // ファイルのプランの見積もりを変えうるもの（Issue #1415、ADR 0374）。
  "src/__tests__/recall-roundtrip-count.postgres.test.ts",
  "src/__tests__/search-many-primary-key-lookup.postgres.test.ts",
  "src/__tests__/search-primary-key-lookup.postgres.test.ts",
  "src/__tests__/search-stats-presence-result-equivalence.postgres.test.ts",
];

const SHARED_SETUP_FILES = [
  // worker 専用 DB へ DATABASE_URL を向ける（Issue #1277）。他の setupFile より先に置く。
  "./src/__tests__/setup-worker-database.ts",
  // recall() の戻り値の契約の検査(TSDoc の7巡目 B1・B2)。
  "./src/__tests__/setup-recall-output-contract.ts",
  // createPostgresClient の既定の pool error 警告が出たら落とす守り(Issue #1213、ADR 0020 と同じ形)。
  "./src/__tests__/setup-pool-error-warning-guard.ts",
];

const ALIAS = {
  // `@mnemora/testkit/fixtures` は base の `@mnemora/testkit` より前に書く——
  // vite のエイリアス解決は文字列一致に加えて「pattern + '/'」の前方一致も見るため、
  // base を先に書くと `@mnemora/testkit/fixtures` が base 側にマッチして
  // 壊れたパス（`.../testkit/src/index.ts/fixtures`）に化ける
  // （packages/openai/vitest.config.mts と同じ理由・同じ並び）。
  "@mnemora/testkit/fixtures": fileURLToPath(
    new URL("../testkit/src/fixtures.ts", import.meta.url),
  ),
  "@mnemora/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
  "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
};

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // ルートに1回だけ宣言する（project ごとに宣言すると project の数だけ実行され、
    // TEMPLATE 元 DB の migrate とクローンが競合する。理由は
    // global-setup-worker-databases.ts の docstring、実測は ADR 0371）。
    globalSetup: ["./src/__tests__/global-setup-worker-databases.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: PARALLEL_PROJECT_NAME,
          // 直列の群を除いた全ファイル。既定の exclude（node_modules 等）は
          // 引き継がれない（project の exclude は既定を丸ごと置き換える）ので明示する。
          exclude: [...defaultExclude, ...SERIAL_TEST_FILES],
          setupFiles: SHARED_SETUP_FILES,
          // 明示的に固定する理由は resolveDefaultMaxWorkers() の docstring
          // （globalSetup が worker DB の数を決めるのに、解決後の値を読めないと困る）。
          maxWorkers: resolveDefaultMaxWorkers(),
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: SERIAL_PROJECT_NAME,
          include: SERIAL_TEST_FILES,
          fileParallelism: false,
          setupFiles: SHARED_SETUP_FILES,
          // 並列の群がすべて終わってから走る（同じ groupOrder は並行、異なる groupOrder は
          // 低い方から高い方へ順に。並列 project は既定の groupOrder 0 のまま）。
          sequence: { groupOrder: 1 },
          env: { [WORKER_DB_SUFFIX_ENV]: SERIAL_DB_SUFFIX },
        },
      },
    ],
  },
  resolve: {
    alias: ALIAS,
  },
});
