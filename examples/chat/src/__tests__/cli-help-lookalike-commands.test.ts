import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #955 の確かめ直し（#1774）。`cli-help.test.ts` の未知のサブコマンドは `no-such-command` だけで、
 * 既知のサブコマンド・使い方の指定に「似ているだけの名前」は見ていない。前方一致で `chat` などに
 * 流れる実装（`startsWith`）は全部の既存の歯をすり抜けた。似た名前も「本当に未知」なので、
 * 理由を stderr に出して exit 1（stdout には何も出さない）。DB には触れない。
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

describe("examples/chat cli.ts: 既知の名前に似ているだけのサブコマンドは未知として断る（#955）", () => {
  it.each(["chatty", "compare-x", "scoped", "helpme", "--helpx"])(
    "%s は未知のサブコマンドとして stderr に理由を出して exit 1",
    (name) => {
      const result = runCli([name]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`未知のサブコマンド: ${name}`);
      expect(result.stdout).toBe("");
    },
    CLI_TIMEOUT_MS,
  );
});
