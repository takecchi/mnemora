import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STAGES } from "../root-test-gate.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// 擬似の実行器へ差し替えず、本物の run-db-tests.mjs を子プロセスで起動する（差し替えると、門が本当に DB テストを呼ぶかを測れない）。

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../run-db-tests.mjs", import.meta.url));

const UNREACHABLE_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/mnemora_gate_probe";

const DB_TEST_FILE = "src/__tests__/contested-with-index.test.ts";

function envWithout(name) {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function runGate(env, args = []) {
  return spawnSyncWithDeadline(process.execPath, [gate, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    // 出力が既定の maxBuffer（1 MiB）を超えると子が途中で殺され、末尾の「DB テストが落ちました」を捕まえられない。
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("scripts/run-db-tests.mjs（ルートの test 門の DB 段）", () => {
  it("DATABASE_URL が無いとき: 緑のまま通すが、『実行していない』と分かる", () => {
    const result = runGate(envWithout("DATABASE_URL"));
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("DB テストは実行していません");

    expect(output).toContain("@mnemora/postgres");
    expect(output).toContain("@mnemora/example-chat");

    expect(output).not.toContain("通りました");
  });

  it("DATABASE_URL が在って DB テストが落ちるとき: 門が赤くなる", () => {
    // 名指しは DB が無いと走らない本物の DB テスト1本。--bail=1 は vitest 5 が打ち切りの合図を
    // 落ちた結果の報告より先に届けることがあり、歯が揺れた（ADR 0579）。
    expect(existsSync(`${repoRoot}packages/postgres/${DB_TEST_FILE}`)).toBe(true);
    const result = runGate({ ...process.env, DATABASE_URL: UNREACHABLE_DATABASE_URL }, [
      DB_TEST_FILE,
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);

    expect(output).toContain("DB テストを実行します");
    expect(output).toContain("DB テストが落ちました");

    // vitest の集計行・ファイル名だけ・ECONNREFUSED では見ない。どれも DB テストが走らなくても出る
    // （ADR 0465・0579）。FAIL の印と project 名の組で見る（project 名の前後は `|…|` と空白の両形を許す）。
    // 色の符号は外してから見る。
    const escapedFile = DB_TEST_FILE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    // eslint-disable-next-line no-control-regex
    expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
      new RegExp(`FAIL\\s+(?:\\|?[\\w-]+\\|?\\s+)?${escapedFile}`),
    );

    expect(output).not.toContain("DB テストは実行していません");

    expect(output).toContain("版を取得できませんでした");
  });
});

describe("scripts/run-db-tests.mjs の MNEMORA_DB_TESTS_SKIP（CI の root-gate-db-stage だけが使う）", () => {
  it("挙げたパッケージは走らせず、名前を挙げて出す（残りは走らせる）", () => {
    const result = runGate(
      {
        ...process.env,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        MNEMORA_DB_TESTS_SKIP: "@mnemora/postgres",
      },
      ["--bail=1"],
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("この段では実行しないもの:");
    expect(output).toContain("@mnemora/postgres (test:db、MNEMORA_DB_TESTS_SKIP で外した)");
    expect(output).toContain("DB テストが落ちました（@mnemora/example-chat）");
    expect(output).not.toContain("DB テストが落ちました（@mnemora/postgres）");
  });

  it("test:db を持たない名前が混ざっていたら、何も走らせずに赤にする（綴りの誤り・改名の取り残し）", () => {
    const result = runGate({
      ...process.env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      MNEMORA_DB_TESTS_SKIP: "@mnemora/postgress",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain("test:db を持たないパッケージが在ります: @mnemora/postgress");
    expect(output).not.toContain("DB テストを実行します");
  });

  it("全部外したら、何も走らせずに「通りました」を出す代わりに赤にする", () => {
    const result = runGate({
      ...process.env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      MNEMORA_DB_TESTS_SKIP: "@mnemora/postgres,@mnemora/example-chat",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain("全部外しています");
    expect(output).not.toContain("通りました");
  });
});

describe("ルートの test 門の配線", () => {
  it("ルートの test は run-root-test-gate.mjs を呼ぶ", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(manifest.scripts.test).toBe("node scripts/run-root-test-gate.mjs");
  });

  // ソースを文字列で読んで語順を見ない（コードを並べ替えても緑のままになる）。配線の実体 STAGES を測る。
  it("門は、vitest → pnpm -r --no-bail run test → run-db-tests.mjs の順に3段を起動する", () => {
    const commandLines = STAGES.map((stage) => [stage.command, ...stage.args].join(" "));

    expect(commandLines).toEqual([
      "pnpm exec vitest run",
      "pnpm -r --if-present --no-bail run test",
      "node scripts/run-db-tests.mjs",
    ]);
  });

  it("段2には --no-bail が在る（1パッケージ落ちても残りのパッケージを起動し続ける）", () => {
    const packageStage = STAGES.find((stage) => stage.args.includes("-r"));

    expect(packageStage?.args).toContain("--no-bail");
  });
});
