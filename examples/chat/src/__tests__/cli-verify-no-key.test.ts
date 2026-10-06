import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CASSETTE_TARGETS } from "../cassette-io.js";

/**
 * `cli.ts verify` を `OPENAI_API_KEY` 無しで呼んだときの出力と終了コードの歯。
 *
 * 前提が足りないことを1行で案内し、stack trace は出さずに exit 1 で終わる。
 * 鍵の確認は DB にも実 API にも触れる前に行うので、`DATABASE_URL` と `OPENAI_API_KEY` は子プロセスから外す
 * （`cli-help.test.ts` と同じく、`cli.ts` は末尾で `main()` を無条件に実行するため子プロセスで観る）。
 */

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 20_000;

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  Object.assign(env, extraEnv);
  return spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: chatDir,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat cli.ts verify（OPENAI_API_KEY 無し）", () => {
  // `verify` の全 target（`CASSETTE_TARGETS`）。target が増えたときも追従する。
  it.each(CASSETTE_TARGETS.map((target) => [["verify", target]]))(
    "%j は前提が足りないことを stderr に1行だけ出し、stack trace を出さずに exit 1",
    (args) => {
      const result = runCli(args);
      expect(result.status).toBe(1);
      const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("OPENAI_API_KEY");
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.stdout).toBe("");
    },
    CLI_TIMEOUT_MS,
  );
});

describe("examples/chat cli.ts verify（OPENAI_API_KEY あり）", () => {
  // ガードは「鍵が無いとき」だけ発火する。常に発火させると、鍵のある人も照合に進めなくなる。
  // ダミーの鍵を渡し、接続先は fetch が接続を試みる前に断る「bad port」（9）に向けるので、実 API には出ない。
  // 見るのは「案内で止まらず、照合に進んだ（カセットを読んだ旨が stdout に出る）」ことだけで、
  // 照合の結果（ここでは接続エラー）は見ない。
  it.each(CASSETTE_TARGETS.map((target) => [target]))(
    "verify %s は鍵があれば案内で止まらず、カセットの照合に進む",
    (target) => {
      const result = runCli(["verify", target], {
        OPENAI_API_KEY: "dummy-key-for-guard-test",
        OPENAI_BASE_URL: "http://127.0.0.1:9",
      });
      expect(result.stdout).toContain(`照合するカセット（${target}）`);
    },
    CLI_TIMEOUT_MS,
  );
});
