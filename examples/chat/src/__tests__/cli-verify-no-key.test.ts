import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `cli.ts verify` を `OPENAI_API_KEY` 無しで呼んだときの出力と終了コードの歯。
 *
 * 前提が足りないことを1行で案内し、stack trace は出さずに exit 1 で終わる。
 * 鍵の確認は DB にも実 API にも触れる前に行うので、`DATABASE_URL` と `OPENAI_API_KEY` は子プロセスから外す
 * （`cli-help.test.ts` と同じく、`cli.ts` は末尾で `main()` を無条件に実行するため子プロセスで観る）。
 */

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 20_000;

function runCli(args: readonly string[]) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.OPENAI_API_KEY;
  return spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: chatDir,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat cli.ts verify（OPENAI_API_KEY 無し）", () => {
  it.each([[["verify", "retrieval"]], [["verify", "compare"]]])(
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
