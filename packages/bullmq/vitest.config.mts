import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Redis を要るテストをここに紛れ込ませない: Redis の無い CI ジョブで赤くなる。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.redis.test.ts"],
  },
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
