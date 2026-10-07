import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI_TIMEOUT_MS = 180_000;

// `cli.ts` は末尾で main() を無条件に実行するので、import では呼べない。表示の関数そのものは answer-display-details.test.ts と chat-summary-rows.test.ts が見る。ここは cli.ts がそれを呼んでいることだけを、子プロセスの出力で見る。
function run(
  script: "chat" | "answer",
  extra: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: requireDatabaseUrl(),
    ...extra,
  };
  // 実 API に倒れない。実行環境から紛れ込む指定は、測りたい形を変えるので落とす。
  delete env.OPENAI_API_KEY;
  for (const key of ["MNEMORA_LLM", "MNEMORA_EMBEDDING", "MNEMORA_PROVIDER_SOURCE"]) {
    if (!(key in extra)) delete env[key];
  }
  const result = spawnSync("pnpm", ["--filter", "@mnemora/example-chat", "run", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
  expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
  return result;
}

describe("examples/chat: 表示の関数が cli.ts から呼ばれている（子プロセス）", () => {
  it(
    "chat のまとめに、budget 無し・ありの内訳（予算の対象 + 予算の外の目次帯）と注記が出る",
    () => {
      const out = run("chat", {}).stdout;
      const summary = out.slice(out.indexOf("=== まとめ ==="));
      expect(summary).toMatch(
        /mnemora chars \(budget 無し\)\s*: \d+（予算の対象 \d+ \+ 予算の外の目次帯 indexChars=\d+）/,
      );
      expect(summary).toMatch(
        /mnemora chars \(budget あり\)\s*: \d+（予算の対象 \d+ \+ 予算の外の目次帯 indexChars=\d+）/,
      );
      expect(summary).toContain("目次帯は予算の対象外");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "answer（記録の再生）は、品質を主張できるモードの導入文を出し、入力量を差の向きつきで出す",
    () => {
      const out = run("answer", {}).stdout;
      expect(out).toContain("llmMode=recorded: 記録した時点の実 API の回答の再生");
      expect(out).not.toContain("回答品質は測っていない（llmMode=recorded）");
      expect(out).toContain("入力量の mnemora − 全文の差（負なら mnemora が少ない");
      expect(out).toContain("追加費用(別ブロック。⛔ 下の入力量の差には含めない)");
      expect(out).not.toContain("削減率");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "answer（deterministic を明示）は、配線の検査だという導入文を、llmMode つきで出す",
    () => {
      const out = run("answer", {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      }).stdout;
      expect(out).toContain("回答品質は測っていない（llmMode=deterministic）。");
      expect(out).not.toContain("一般的な回答品質の保証ではない");
    },
    CLI_TIMEOUT_MS,
  );
});
