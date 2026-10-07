import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `/fixtures` を base より前に書く: vite は「pattern + '/'」の前方一致も見るため、
// base を先に書くと `.../index.ts/fixtures` に化ける。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/testkit/fixtures": fileURLToPath(
        new URL("../testkit/src/fixtures.ts", import.meta.url),
      ),
      "@mnemora/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
