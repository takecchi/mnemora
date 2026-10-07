import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// dist ではなく core/src を直接参照する。CI は test の時点で @mnemora/core の dist を持たない。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@mnemora/postgres": fileURLToPath(new URL("../postgres/src/index.ts", import.meta.url)),
      // `@mnemora/testkit/fixtures` は使わない（使うなら base より前に書く必要がある）。
      "@mnemora/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
    },
  },
});
