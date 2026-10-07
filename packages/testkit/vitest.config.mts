import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @mnemora/core は dist ではなく src を参照する: CI は test を build より前に走らせるので、dist が無い。
export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup-recall-output-contract.ts"],
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
