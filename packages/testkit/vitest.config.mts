import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは @mnemora/core の dist（build 前は存在しない）ではなく src を直接参照する。
// CI は typecheck → lint → test → build の順で走るため、test 実行時点では
// core の dist が無いことを前提にする（packages/testkit/tsconfig.json の
// paths 設定と同じ理由・同じ狙い）。
export default defineConfig({
  test: {
    // recall() の戻り値の契約の検査（src/__tests__/setup-recall-output-contract.ts、TSDoc の7巡目 B1・B2）。
    setupFiles: ["./src/__tests__/setup-recall-output-contract.ts"],
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
