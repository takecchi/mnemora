import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { databaseErrorHint } from "../db-error-hint.js";

// `cli.ts` は末尾で main() を無条件に実行するので、import では呼べない（`cli-verify-no-key.test.ts` と同じく子プロセスで観る）。
// 接続先は接続を断られるポート 9。DB は要らず、実 API にも触れない。

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 60_000;

function runChat(databaseUrl: string | undefined) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.DATABASE_URL;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  return spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", "chat"], {
    cwd: chatDir,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

describe("examples/chat cli.ts: DB のエラーで止まったとき", () => {
  it(
    "元のエラーを消さず、その後ろに README「DB を用意する」を指す一行を stderr に足し、exit 1",
    () => {
      const result = runChat("postgresql://nobody@127.0.0.1:9/x");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ECONNREFUSED");
      const hintLine = result.stderr.split("\n").find((l) => l.startsWith("→ "));
      expect(hintLine, "stderr に「→ 」で始まる一行が無い").toBeDefined();
      expect(hintLine).toContain("DATABASE_URL");
      expect(hintLine).toContain("README.md「DB を用意する」");
      expect(result.stderr.indexOf("ECONNREFUSED")).toBeLessThan(result.stderr.indexOf("→ "));
      expect(result.stdout).not.toContain("→ ");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "DATABASE_URL 未設定の文は、README の「DB を用意する」を指す",
    () => {
      const result = runChat(undefined);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("DATABASE_URL が設定されていません");
      expect(result.stderr).toContain("README.md「DB を用意する」");
    },
    CLI_TIMEOUT_MS,
  );
});

describe("databaseErrorHint — 拡張を作る権限が無いときの一行", () => {
  it("README が先に入れるよう求める3本の拡張を、すべて名指す", () => {
    const hint = databaseErrorHint(
      Object.assign(new Error('permission denied to create extension "vector"'), {
        code: "42501",
      }),
    );
    expect(hint).toContain("vector");
    expect(hint).toContain("btree_gin");
    expect(hint).toContain("pgcrypto");
  });
});
