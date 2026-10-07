import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { POOL_ERROR_WARNING_HEAD } from "../pool-error-warning.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * CLI は `createPostgresClient` を使わず自前の `Pool` を作る。pg の `Pool` は、待機中の接続が切られると `error` を emit し、リスナーが無ければ Node のプロセスごと落ちる。
 * 窓は狭い（`runMigrations` が接続を返してから `runAnalyzeMemories`・`pool.end()` までの間だけ）が、DB の再起動・フェイルオーバーがその窓に当たると、終了コードも台帳の状態も報告されずに落ちる。
 * 切り方は `pg_terminate_backend`。直列群に入れてある（`vitest.config.mts`）。
 */
const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const CHILD = path.join("src", "__tests__", "__fixtures__", "migrate-cli-pool-child.ts");

async function runChild(args: string[]): Promise<{ exitCode: number; output: string }> {
  const env = { PATH: process.env.PATH ?? "", DATABASE_URL: requireDatabaseUrl() };
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [CHILD, ...args], {
      cwd: PACKAGE_ROOT,
      env,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: (failure.stdout ?? "") + (failure.stderr ?? ""),
    };
  }
}

describe("mnemora-postgres-migrate の Pool: 待機中の接続が DB 側から切られたとき", () => {
  it("プロセスは落ちず、名乗って続行し、次の問い合わせは新しい接続で通る", async () => {
    const { exitCode, output } = await runChild([]);
    expect(exitCode, output).toBe(0);
    expect(output).toContain(POOL_ERROR_WARNING_HEAD);
    expect(output).toContain("terminating connection due to administrator command");
    expect(output).toContain("next query: 1");
  });

  it("陽性対照: error リスナー無しの素の pg.Pool なら、同じ操作で本当に落ちる", async () => {
    const { exitCode, output } = await runChild(["raw"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("Unhandled 'error' event");
    expect(output).not.toContain("next query:");
  });

  it("bin/migrate.ts は Pool を自分で new せず、createMigrateCliPool を使う", () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, "src", "bin", "migrate.ts"), "utf8");
    expect(source).toContain("createMigrateCliPool(");
    expect(source).not.toMatch(/new Pool\(/);
  });
});
