import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/testkit/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。
export default defineConfig({
  test: {
    // DB を使うテストは本質的に直列に走らせたほうが安全（同一 DB を使い回すテストがある場合の
    // 競合を避ける）。各テストファイルは自分専用のスキーマ/テーブル接頭辞を使うため、
    // 通常は並列でも安全だが、CI のサービスコンテナの資源制約を考慮してファイル単位は直列にする。
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
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
