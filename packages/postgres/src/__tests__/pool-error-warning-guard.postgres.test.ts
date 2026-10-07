import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { POOL_ERROR_WARNING_PREFIX } from "../pool-error-warning.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `setup-pool-error-warning-guard.ts`（`vitest.config.mts` の `setupFiles`）が、本来 `onPoolError`/`pool.on("error", …)` を持つべきテストが持っていないことを見えない形で通り過ぎさせないことを、本物の vitest を子プロセスで走らせて実測する。
 * `DATABASE_URL` が要る（`onPoolError` を渡さず `createPostgresClient` を作り、待機中の接続を `pg_terminate_backend` で実際に切る必要があるため）。
 *
 * `.tmp/` 配下に使い捨ての vitest 設定 + フィクスチャを書く。設定の `setupFiles` には本物のガードファイル（絶対パス）を指す（コピーではなく実物を参照するので、ガードファイル自身の変更がそのままこの歯に反映される）。
 * フィクスチャは `onPoolError` を渡さず `createPostgresClient` を作り、自分の待機中の接続を切って、既定の警告が出る猶予を待つだけ。本物の `pnpm exec vitest run` を子プロセスとして起動し、exit code が非0になり、出力に unhandled error の報告が含まれることを確かめる。
 *
 * `client.ts` の `pool.listenerCount("error") === 1` の判定を外してもこの歯は赤くならない（このフィクスチャは `pool.on("error", …)` を追加で付けていない）。その分岐は `readme-unbound-promises.postgres.test.ts` の C-1/C-2 が縛る。
 */
describe("setup-pool-error-warning-guard.ts: 既定の pool error 警告が漏れたら vitest を非0で落とす", () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
  });

  it('onPoolError も pool.on("error", …) も付けずに待機中の接続を切ると、守りが例外に変えて exit が非0になる', () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const postgresRoot = fileURLToPath(new URL("../../", import.meta.url));
    const guardSetupFile = join(
      postgresRoot,
      "src",
      "__tests__",
      "setup-pool-error-warning-guard.ts",
    );
    const postgresIndex = join(postgresRoot, "src", "index.ts");
    const coreIndex = join(repoRoot, "packages", "core", "src", "index.ts");

    const tmpRoot = join(postgresRoot, ".tmp");
    mkdirSync(tmpRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(tmpRoot, "pool-error-warning-guard-"));

    writeFileSync(
      join(fixtureDir, "vitest.config.mts"),
      [
        'import { defineConfig } from "vitest/config";',
        "",
        "export default defineConfig({",
        "  test: {",
        '    include: ["*.fixture.test.mjs"],',
        `    setupFiles: [${JSON.stringify(guardSetupFile)}],`,
        "  },",
        "  resolve: {",
        "    alias: {",
        `      "@mnemora/postgres": ${JSON.stringify(postgresIndex)},`,
        `      "@mnemora/core": ${JSON.stringify(coreIndex)},`,
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(fixtureDir, "leak.fixture.test.mjs"),
      [
        'import { randomUUID } from "node:crypto";',
        'import { setTimeout as sleep } from "node:timers/promises";',
        'import { it } from "vitest";',
        'import { createPostgresClient } from "@mnemora/postgres";',
        "",
        'it("onPoolError を持たないテストが、待機中の接続を切られる", async () => {',
        "  const url = process.env.DATABASE_URL;",
        '  if (!url) throw new Error("DATABASE_URL が設定されていません。");',
        "  const applicationName = `pool-error-warning-guard-fixture-${randomUUID().slice(0, 8)}`;",
        "  const client = createPostgresClient(url, { max: 1, application_name: applicationName });",
        "  const admin = createPostgresClient(url, { max: 1 });",
        "  try {",
        '    await client.pool.query("SELECT 1");',
        "    await admin.pool.query(",
        '      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",',
        "      [applicationName],",
        "    );",
        "    await sleep(1500);",
        "  } finally {",
        "    await admin.pool.end();",
        "    await client.pool.end().catch(() => {});",
        "  }",
        "});",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--root",
        fixtureDir,
        "--config",
        join(fixtureDir, "vitest.config.mts"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: requireDatabaseUrl(),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        timeout: 30_000,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("pool-error-warning-guard");
    expect(output).toMatch(/unhandled error/i);
  }, 60_000);
});

/**
 * 上の歯は、自分で生成した設定の中で守りが効くことだけを見る。本物の `vitest.config.mts` から守りを
 * 外しても、`examples/chat` の複製した接頭辞が正本からずれても、上の歯は赤くならない——ここで縛る。
 */
describe("setup-pool-error-warning-guard.ts: 本物の vitest 設定に載っていて、examples/chat の複製が正本と一致する", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  /** `setupFiles` は、トップレベルの `test.setupFiles` と `test.projects[].test.setupFiles` のどちらにも載りうる。両方を合わせて返す（どちらの形で書かれているかは見ない）。 */
  async function setupFilesOf(configPath: string): Promise<string[]> {
    const mod = (await import(configPath)) as {
      default: {
        test?: {
          setupFiles?: string | string[];
          projects?: Array<{ test?: { setupFiles?: string | string[] } }>;
        };
      };
    };
    const toArray = (files: string | string[] | undefined): string[] =>
      files === undefined ? [] : Array.isArray(files) ? files : [files];
    const topLevel = toArray(mod.default.test?.setupFiles);
    const fromProjects = (mod.default.test?.projects ?? []).flatMap((p) =>
      toArray(p.test?.setupFiles),
    );
    return [...topLevel, ...fromProjects];
  }

  it.each([
    ["packages/postgres", join(repoRoot, "packages", "postgres", "vitest.config.mts")],
    ["examples/chat", join(repoRoot, "examples", "chat", "vitest.config.mts")],
  ])("%s の vitest.config.mts の setupFiles に守りが載っている", async (_name, configPath) => {
    expect(await setupFilesOf(configPath)).toContain(
      "./src/__tests__/setup-pool-error-warning-guard.ts",
    );
  });

  it("examples/chat の守りが複製した接頭辞は、正本の POOL_ERROR_WARNING_PREFIX と同じ", () => {
    const mirror = readFileSync(
      join(repoRoot, "examples", "chat", "src", "__tests__", "setup-pool-error-warning-guard.ts"),
      "utf8",
    );
    const match = /const POOL_ERROR_WARNING_PREFIX_MIRROR = "([^"]*)";/.exec(mirror);
    expect(match?.[1], "examples/chat の複製").toBe(POOL_ERROR_WARNING_PREFIX);
  });
});
