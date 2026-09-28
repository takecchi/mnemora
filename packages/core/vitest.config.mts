import { defineConfig } from "vitest/config";

/**
 * `src/__tests__/setup-recall-output-contract.ts` を、core のすべてのテストの前に読み込む
 * ——`createRuntime` が返す `recall` を包み、戻り値が出力の側の契約を守っているかを、
 * どのテストの中でも確かめる（TSDoc の7巡目 B1・B2）。
 */
export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup-recall-output-contract.ts"],
  },
});
