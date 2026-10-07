import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeCheckRuns, summarizeRequiredContexts, verdict } from "../ci-green-check-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(new URL("../ci-green-check.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const check = (name, status = "completed", conclusion = "success") => ({
  name,
  status,
  conclusion,
});

describe("summarizeCheckRuns / summarizeRequiredContexts: 判定不能・走行中を success に数えない", () => {
  it("completed でも conclusion が無い（null）check は success に数えず、nonSuccess に名指しする", () => {
    const summary = summarizeCheckRuns([check("build"), check("test", "completed", null)]);
    expect(summary.nonSuccess).toEqual([{ name: "test", conclusion: null }]);
    expect(summary.allSuccess).toBe(false);
  });

  it("走っている最中の check が在れば、他が全部 success でも allSuccess は false", () => {
    const summary = summarizeCheckRuns([check("build"), check("test", "in_progress", null)]);
    expect(summary.allCompleted).toBe(false);
    expect(summary.allSuccess).toBe(false);
  });

  it("required が同名で複数在り、走っている最中のものが先頭でも pending に入る", () => {
    const result = summarizeRequiredContexts(
      [check("build", "in_progress", null), check("build")],
      ["build"],
    );
    expect(result.pending).toEqual(["build"]);
    expect(result.nonSuccess).toEqual([]);
  });

  it("completed で conclusion が null の required は、緑ではなく赤", () => {
    const v = verdict([check("build", "completed", null)], ["build"], null);
    expect(v.status).toBe("red");
  });
});

describe("ci-green-check.mjs（偽の gh）: PR の参考欄と2回目の取得", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const REQUIRED = { required_status_checks: { contexts: ["build", "test"] } };
  const GREEN = [check("build"), check("test")];

  const FAKE_GH = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const dir = process.env.FAKE_GH_DIR;",
    'const s = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"));',
    "const a = process.argv.slice(2);",
    "function count(key) {",
    '  const f = dir + "/count-" + key; let n = 0;',
    '  try { n = Number(fs.readFileSync(f, "utf8")); } catch {}',
    "  fs.writeFileSync(f, String(n + 1)); return n;",
    "}",
    "const pick = (arr, n) => arr[Math.min(n, arr.length - 1)];",
    "const fail = (msg) => { console.error(msg); process.exit(1); };",
    'if (a[0] === "repo" && a[1] === "view") {',
    '  console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0);',
    "}",
    'if (a[0] === "pr" && a[1] === "view") {',
    '  const n = count("pr");',
    '  if (n >= (s.prViewFailsFrom ?? Infinity)) fail("pr view failed");',
    "  console.log(JSON.stringify({",
    "    headRefOid: pick(s.prHeads, n),",
    "    isDraft: s.isDraft ?? false,",
    '    mergeStateStatus: s.mergeStateStatus ?? "CLEAN",',
    '    baseRefName: "main",',
    "  }));",
    "  process.exit(0);",
    "}",
    'if (a[0] === "api" && a[1].endsWith("/protection")) {',
    "  console.log(JSON.stringify(s.protection)); process.exit(0);",
    "}",
    'if (a[0] === "api" && a[1].endsWith("/check-runs")) {',
    '  const n = count("cr");',
    '  if (n >= (s.checkRunsFailFrom ?? Infinity)) fail("HTTP 500");',
    "  for (const r of pick(s.polls, n)) console.log(JSON.stringify(r));",
    "  process.exit(0);",
    "}",
    'if (a[0] === "api" && /\\/pulls\\/\\d+$/.test(a[1])) { console.log("null"); process.exit(0); }',
    "process.exit(99);",
  ].join("\n");

  /** @type {string[]} */
  const workDirs = [];
  afterEach(() => {
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runCli(scenario, args) {
    const workDir = mkdtempSync(join(tmpdir(), "ci-green-check-boundaries-"));
    workDirs.push(workDir);
    const bin = join(workDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(workDir, "scenario.json"),
      JSON.stringify({ prHeads: [SHA], protection: REQUIRED, polls: [GREEN], ...scenario }),
    );
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    return spawnSyncWithDeadline(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH_DIR: workDir },
    });
  }

  describe.each([
    { isDraft: true, mergeStateStatus: "CLEAN" },
    { isDraft: false, mergeStateStatus: "DIRTY" },
    { isDraft: false, mergeStateStatus: "BLOCKED" },
    { isDraft: false, mergeStateStatus: "BEHIND" },
    { isDraft: false, mergeStateStatus: "UNSTABLE" },
    { isDraft: true, mergeStateStatus: "UNKNOWN" },
  ])(
    "PR が isDraft=$isDraft・mergeStateStatus=$mergeStateStatus でも、判定は check-runs だけで決まる",
    (pr) => {
      it("check が全部 success なら green（exit 0）で、判定した sha を埋めたマージコマンドを出す", () => {
        const r = runCli(pr, ["--pr", "5"]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`--match-head-commit ${SHA}`);
      });

      it("1件が failure なら red（exit 1）", () => {
        const r = runCli(
          { ...pr, polls: [[check("build"), check("test", "completed", "failure")]] },
          ["--pr", "5"],
        );
        expect(r.status).toBe(1);
      });

      it("走っている最中の check が在れば pending（exit 2）", () => {
        const r = runCli({ ...pr, polls: [[check("build"), check("test", "queued", null)]] }, [
          "--pr",
          "5",
        ]);
        expect(r.status).toBe(2);
      });
    },
  );

  it("2回目の check-runs の取得に失敗したら、1回目の緑を採らず exit 3（実行時エラー）", () => {
    const r = runCli({ polls: [GREEN], checkRunsFailFrom: 1 }, [
      "--pr",
      "5",
      "--recheck-after",
      "0",
    ]);
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("2回目の PR の head の取得に失敗したら、1回目の緑を採らず exit 3（実行時エラー）", () => {
    const r = runCli({ prViewFailsFrom: 1 }, ["--pr", "5", "--recheck-after", "0"]);
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("2回目が red で、名前集合も動いていたら、pending に落とさず red（exit 1）のまま", () => {
    const r = runCli(
      {
        polls: [GREEN, [check("build"), check("test", "completed", "failure"), check("late")]],
      },
      ["--pr", "5", "--recheck-after", "0"],
    );
    expect(r.status).toBe(1);
  });

  it("2回目で check が1つ消えていたら、2回目が緑でも pending（exit 2）で、マージコマンドを出さない", () => {
    const r = runCli({ polls: [[...GREEN, check("optional")], GREEN] }, [
      "--pr",
      "5",
      "--recheck-after",
      "0",
    ]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("名前集合が変わった");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("required_status_checks 自体が無い応答は、『取得できていない』を理由に pending（『0件』とは言わない）", () => {
    const r = runCli({ protection: {} }, ["--sha", SHA, "--json"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("必須チェックの集合を取得できていない");
    expect(r.stdout).not.toContain("必須チェックが0件");
  });

  it("required_status_checks.contexts が空配列の応答は、『0件』を理由に pending", () => {
    const r = runCli({ protection: { required_status_checks: { contexts: [] } } }, ["--sha", SHA]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("必須チェックが0件");
  });
});
