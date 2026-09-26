import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `cli.ts` の使い方表示と終了コード・出力先の歯（Issue #944）。
 *
 * - 引数なし / `--help` / `-h` / `help`: 使い方を stdout に出して exit 0。
 * - 未知のサブコマンド: 理由を stderr に1行出し、使い方も stderr に出して exit 1。
 *   stdout には何も出さない。
 *
 * `cli.ts` は末尾で `main()` を無条件に実行するため、子プロセスで起動して観る。
 * どの経路も DB に触れないので、`DATABASE_URL` は子プロセスから外す。
 */

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 20_000;

function runCli(args: readonly string[]) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: chatDir,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat cli.ts の使い方表示（Issue #944）", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j は使い方を stdout に出して exit 0",
    (args) => {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("使い方:");
      expect(result.stderr).not.toContain("使い方:");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "未知のサブコマンドは理由を stderr に出して exit 1（stdout には何も出さない）",
    () => {
      const result = runCli(["no-such-command"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("未知のサブコマンド: no-such-command");
      expect(result.stderr).toContain("使い方:");
      expect(result.stdout).toBe("");
    },
    CLI_TIMEOUT_MS,
  );
});
