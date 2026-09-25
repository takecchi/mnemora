import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// 既定の `test`（ルートの `pnpm run test` → `pnpm -r --if-present run test` から
// 呼ばれる。Redis の無い CI ジョブでも走る）は、Redis を要るテスト
// （`src/**/*.redis.test.ts`）を除外する。⛔ ここに Redis を要るテストを紛れ込ませると、
// Redis の無い環境（既存の `typecheck / lint / test / build` ジョブ等）で赤くなる
// （AGENTS.md「手元で Postgres を立てる」節と同じ判断を Redis にも適用したもの——
// 本 PR の決定4。詳細は ADR 0321〔仮番号〕）。
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
