import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * DB に接続する前に決着するパス（`--help` / `DATABASE_URL` 欠如 / 引数解釈エラー）が、期待どおりの終了コードと出力で終わるかを、CLI を実際に子プロセスとして起動して測る（`main()` の分岐順序を外から実測する）。DB は要らない。
 * 引数・環境変数の解釈そのものは `./cli-options.test.ts` が測るので、ここで同じことをもう一度測らない。
 *
 * `execFile` に渡す `env` は `process.env` をそのまま渡さない。実行環境に `DATABASE_URL` / `MNEMORA_SCHEMA` / `MNEMORA_EXTENSION_SCHEMA` が設定されているかどうかで各テストが測ろうとしている経路がずれてしまうので、必要な変数だけを明示的に組み立てる（`buildEnv`）。
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `env` は「渡したいものだけ」を書く。`PATH` は `tsx` の shebang を解決するのに必須なので常に含める。 */
function buildEnv(overrides: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", ...overrides };
}

async function runCli(
  args: readonly string[],
  overrides: Readonly<Record<string, string>>,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [MIGRATE_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: buildEnv(overrides),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("mnemora-postgres-migrate（子プロセス起動、DB 無し）", () => {
  it("--help: 終了コード0で、--schema / --extension-schema / --analyze-memories / MNEMORA_SCHEMA / 優先順位の説明が出る", async () => {
    const result = await runCli(["--help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--schema");
    expect(result.stdout).toContain("--extension-schema");
    expect(result.stdout).toContain("--analyze-memories");
    expect(result.stdout).toContain("MNEMORA_SCHEMA");
    expect(result.stdout).toContain("MNEMORA_EXTENSION_SCHEMA");
    expect(result.stdout).toContain("MNEMORA_ANALYZE_MEMORIES");
    expect(result.stdout, "優先順位の説明が出ること").toContain(
      "優先順位: コマンドライン引数 > 環境変数 > 未指定。",
    );
  });

  it("DATABASE_URL が無い・引数無し: 終了コード1で、標準エラーに DATABASE_URL が無い旨が出る", async () => {
    const result = await runCli([], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it(
    "--analyze-memories だけを渡し DATABASE_URL が無い: 引数解釈は通るが、接続する前に" +
      "終了コード1で DATABASE_URL 欠如を報告する（ANALYZE を試みる前に決着する）",
    async () => {
      const result = await runCli(["--analyze-memories"], {});

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("DATABASE_URL");
    },
  );

  it("--analyze-memories=true（= 区切り）: 値を取らない真偽フラグなので未知のオプションとしてエラーになる", async () => {
    const result = await runCli(["--analyze-memories=true"], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--analyze-memories=true");
  });

  it(
    "--extension-schema だけ（--schema 無し・MNEMORA_SCHEMA も無し）: " +
      "DATABASE_URL が設定されていても、接続する前に終了コード1で止まる",
    async () => {
      // わざと繋がらない DATABASE_URL を渡す。引数の検査より先に接続を試みる実装なら、別の壊れ方をするはず。ここで素早く exitCode 1 になることが、「引数の検査が接続より前に在る」という順序の実測になる。
      const result = await runCli(["--extension-schema", "public"], {
        DATABASE_URL: "postgresql://cli-process-test-must-not-connect@127.0.0.1:1/nope",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--schema");
    },
  );

  it("MNEMORA_SCHEMA=（空文字）: 未指定には倒さず、DB に繋ぐ前に終了コード1で止まる", async () => {
    const result = await runCli([], { MNEMORA_SCHEMA: "" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsafe SQL identifier");
    expect(result.stderr).not.toContain("DATABASE_URL");
  });

  it("未知の引数（--nope）: 終了コード1", async () => {
    const result = await runCli(["--nope"], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--nope");
  });

  it("`--` がそのまま渡された（pnpm run migrate -- --analyze-memories）: 終了コード1で、標準エラーに `--` を付けない正しい書き方が2行目に出る", async () => {
    const result = await runCli(["--", "--analyze-memories"], {});

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("unknown option: --");
    expect(lines[1]).toContain("run migrate --analyze-memories");
    expect(lines[1]).not.toContain("migrate -- --");
  });
});
