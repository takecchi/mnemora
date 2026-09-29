import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/testkit/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。
export default defineConfig({
  test: {
    // ファイル単位は直列にする。並列にすると壊れる——テストファイルは1つの DB（`DATABASE_URL`）を
    // 共有し、多くのファイルが `resetTestDatabase()`（`src/__tests__/test-db.ts`）でドメインの表を
    // `TRUNCATE` する。ファイルごとに専用のスキーマや表の接頭辞は使っていない（互いの行を消す）。
    // ほかに、索引の `DROP`/`CREATE`・`pg_stat_*`・advisory lock・`pg_stat_activity` など、DB や
    // クラスタ全体に効くものを使うファイルもある。並列にするなら DB を分ける仕組みが先に要る
    // （スキーマごと／DB ごとの案と、直列に残すファイルの組: Issue #1277）。
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    setupFiles: [
      // recall() の戻り値の契約の検査（TSDoc の7巡目 B1・B2）。
      "./src/__tests__/setup-recall-output-contract.ts",
      // createPostgresClient の既定の pool error 警告が出たら落とす守り（Issue #1213、ADR 0020 と同じ形）。
      "./src/__tests__/setup-pool-error-warning-guard.ts",
    ],
  },
  resolve: {
    alias: {
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
    },
  },
});
