import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `test:redis`（本物の Postgres + 本物の Redis を要る。専用の CI job でだけ走る）。
// `**/*.redis.test.ts` だけを対象にする——既定の `test` 側の exclude と対になる。
export default defineConfig({
  test: {
    include: ["src/**/*.redis.test.ts"],
    // 複数の子プロセス（`pnpm exec tsx`）を spawn して同時に tick させる歯であり、
    // 起動・DB 往復・BullMQ の Redis 往復を含めると通常のユニットテストより長くかかる。
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // 同じ outbox / embedding テーブルを共有する複数ファイルを並行で走らせると
    // packages/postgres/src/__tests__/test-db.ts が既に踏んだ「並行 TRUNCATE」の穴
    // （scripts/run-db-tests.mjs の doc コメント）を再現しうる。歯は今のところ1本
    // だけだが、増えたときのために直列を既定にしておく。
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@mnemora/postgres": fileURLToPath(new URL("../postgres/src/index.ts", import.meta.url)),
    },
  },
});
