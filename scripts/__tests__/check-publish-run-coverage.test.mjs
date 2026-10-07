import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** `--run <id>`（`gh` を呼ぶ経路）は検査しない。CI のこのジョブに認証済み `gh` の保証が無く、歯が赤いのか `gh` が届いていないのかを区別できなくなる。 */

const script = fileURLToPath(new URL("../check-publish-run-coverage.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const TIMESTAMP = "2026-09-17T01:14:00.3481028Z ";

/** @type {string | undefined} */
let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function githubGroup(spec, resultLine) {
  return (
    `${TIMESTAMP}##[group]npm publish ${spec}\n` +
    `${TIMESTAMP}${resultLine}\n` +
    `${TIMESTAMP}##[endgroup]\n`
  );
}

function writeLogFile(content) {
  workDir = mkdtempSync(join(tmpdir(), "check-publish-run-coverage-"));
  const logPath = join(workDir, "job.log");
  writeFileSync(logPath, content);
  return logPath;
}

function run(args) {
  return spawnSyncWithDeadline(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("scripts/check-publish-run-coverage.mjs（引数検査）", () => {
  it("--run も --log-file も無ければ使い方を出して exit 3", () => {
    const result = run([]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--run");
    expect(result.stderr).toContain("--log-file");
  });

  it("--run と --log-file を同時に渡すと exit 3", () => {
    const result = run(["--run", "1", "--log-file", "/tmp/does-not-matter"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("同時に渡せない");
  });

  it("未知のフラグは exit 3 で名指しして落ちる", () => {
    const result = run(["--not-a-real-flag"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--not-a-real-flag");
  });

  it("--log-file に存在しないパスを渡すと exit 3", () => {
    const result = run(["--log-file", "/does/not/exist/anywhere.log"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--log-file が読めない");
  });
});

describe("scripts/check-publish-run-coverage.mjs（--log-file 経由。PUBLISH_TARGETS は実物を使う）", () => {
  it("全 PUBLISH_TARGETS が publish した ⟹ exit 0、pass を印字する", () => {
    const log = PUBLISH_TARGETS.map((t) =>
      githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`),
    ).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("判定: pass");
    expect(result.stdout).toContain(`${PUBLISH_TARGETS.length}/${PUBLISH_TARGETS.length}`);
  });

  it("run 35169553262 の実測どおり（先頭4本が飛ばし、後方2本が publish した）を再現すると exit 1、名指しできる", () => {
    const skippedCount = Math.max(1, PUBLISH_TARGETS.length - 2);
    const log = PUBLISH_TARGETS.map((t, i) => {
      if (i < skippedCount) {
        return githubGroup(
          `${t.name}@9.9.9`,
          `✔ ${t.name}@9.9.9 は既に registry に在る（飛ばした）`,
        );
      }
      return githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`);
    }).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("判定: fail");
    expect(result.stdout).toContain(`${PUBLISH_TARGETS[0].name}: 飛ばした`);
  });

  it("publish 段の group が1つも無いログは exit 2（判定不能）で pass に倒さない", () => {
    const logPath = writeLogFile("Set up job\nCheckout\n何も publish していないログ\n");
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("判定: indeterminate");
  });

  it("--json は result を機械可読な形でも出す", () => {
    const log = PUBLISH_TARGETS.map((t) =>
      githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`),
    ).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath, "--json"]);
    expect(result.status).toBe(0);
    const jsonStart = result.stdout.indexOf("{");
    const parsed = JSON.parse(result.stdout.slice(jsonStart));
    expect(parsed.result.verdict).toBe("pass");
  });
});
