import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.redis.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // 並行すると同じテーブルへの TRUNCATE が競合しうるため直列にする。
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@mnemora/postgres": fileURLToPath(new URL("../postgres/src/index.ts", import.meta.url)),
    },
  },
});
