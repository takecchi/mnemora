import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/postgres/vitest.config.mts と同じ理由: dist ではなく各パッケージの src を
// 直接参照する。DB を使うテストがあるためファイル単位は直列にする。
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // createPostgresClient の既定の pool error 警告が出たら落とす守り（Issue #1213）。
    // packages/postgres/vitest.config.mts の同名 setupFile と同じ役割（値は複製——同ファイルの doc 参照）。
    setupFiles: ["./src/__tests__/setup-pool-error-warning-guard.ts"],
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@mnemora/local-embedding": fileURLToPath(
        new URL("../../packages/local-embedding/src/index.ts", import.meta.url),
      ),
      "@mnemora/openai": fileURLToPath(
        new URL("../../packages/openai/src/index.ts", import.meta.url),
      ),
      "@mnemora/postgres": fileURLToPath(
        new URL("../../packages/postgres/src/index.ts", import.meta.url),
      ),
      "@mnemora/testkit": fileURLToPath(
        new URL("../../packages/testkit/src/index.ts", import.meta.url),
      ),
    },
  },
});
