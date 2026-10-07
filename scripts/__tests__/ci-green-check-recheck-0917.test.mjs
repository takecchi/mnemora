import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCheckRunNameSets,
  summarizeCheckRuns,
  summarizeRequiredContexts,
  verdict,
} from "../ci-green-check-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "ci-green-check.mjs");

const run = (name, status = "completed", conclusion = "success") => ({ name, status, conclusion });

describe("summarizeCheckRuns / verdict: 未完了と非 success を緑にしない", () => {
  it.each(["queued", "waiting", "pending", "requested", "in_progress"])(
    "G1: status が %s の check は pending に名指しで入り、緑にならない",
    (status) => {
      const runs = [run("a"), { name: "b", status, conclusion: null }];
      const summary = summarizeCheckRuns(runs);
      expect(summary.pending).toEqual(["b"]);
      expect(summary.allCompleted).toBe(false);
      const result = verdict(runs, ["a", "b"]);
      expect(result.status).toBe("pending");
      expect(result.reason).toContain("b");
    },
  );

  it.each(["skipped", "neutral", "cancelled", "timed_out", "action_required", "failure", "stale"])(
    "G2b: completed でも conclusion が %s なら success ではなく、赤で名指しされる",
    (conclusion) => {
      const runs = [run("a"), run("b", "completed", conclusion)];
      expect(summarizeCheckRuns(runs).nonSuccess).toEqual([{ name: "b", conclusion }]);
      const result = verdict(runs, ["a", "b"]);
      expect(result.status).toBe("red");
      expect(result.required.nonSuccess).toEqual([{ name: "b", conclusion }]);
    },
  );

  it("V8: green の reason は『N件すべてが completed かつ success』から1バイトも変えない（ADR 0215。release-v1 §0.1 が逐語で引く）", () => {
    const result = verdict([run("a"), run("b"), run("c")], ["a", "b"]);
    expect(result.status).toBe("green");
    expect(result.reason).toBe("3件すべてが completed かつ success");
  });
});

describe("summarizeRequiredContexts / verdict の reason: 下限の穴を名指しする（ADR 0215）", () => {
  it("S3b: 同名の check が複数在り、2件とも失敗なら、2件とも名指しする（最初の1件だけにしない）", () => {
    const result = summarizeRequiredContexts(
      [run("a", "completed", "failure"), run("a", "completed", "cancelled")],
      ["a"],
    );
    expect(result.nonSuccess).toEqual([
      { name: "a", conclusion: "failure" },
      { name: "a", conclusion: "cancelled" },
    ]);
  });

  it("V4b・V4c: 必須が未登録のとき reason は件数・未登録の名前・走っている最中の必須の名前を出す", () => {
    const runs = [run("a", "in_progress", null), run("b")];
    const result = verdict(runs, ["a", "b", "c", "d"]);
    expect(result.status).toBe("pending");
    expect(result.reason).toContain("必須チェック4件のうち2件が");
    expect(result.reason).toContain("c, d");
    expect(result.reason).toContain("走っている最中のものが在る: a");
    expect(result.required.missing).toEqual(["c", "d"]);
  });

  it("V6・V6b: 必須の失敗は『必須チェックのうち』で始まる reason の赤になる（必須でない失敗の reason と区別できる）", () => {
    const required = verdict([run("a", "completed", "failure"), run("b")], ["a", "b"]);
    expect(required.status).toBe("red");
    expect(required.reason).toMatch(/^必須チェックのうち1件が success でない: /);

    const optional = verdict([run("a"), run("b", "completed", "failure")], ["a"]);
    expect(optional.status).toBe("red");
    expect(optional.reason).not.toContain("必須チェック");
    expect(optional.reason).toMatch(/^1件が success でない: /);
  });
});

describe("verdict: total===0 の理由は dirty だけを特別扱いする（ADR 0281）", () => {
  it.each(["blocked", "clean", "behind", "unstable", "draft", "has_hooks", ""])(
    "V9c: mergeable_state が %j でも、dirty と同じ『衝突』の理由にしない（従来の理由のまま）",
    (state) => {
      const result = verdict([], ["a"], state);
      expect(result.status).toBe("pending");
      expect(result.reason).not.toContain("衝突");
      expect(result.reason).toContain("まだ登録されていない可能性がある（Issue #228 観測1）");
    },
  );

  it("V10: dirty の理由は衝突を名指しし、待っても来ないことと、次の一手（base を取り込み直す）を言う", () => {
    const result = verdict([], ["a"], "dirty");
    expect(result.reason).toContain("mergeable_state=dirty");
    expect(result.reason).toContain("待っても来ない");
    expect(result.reason).toContain("base を取り込み直して衝突を解くこと");
  });
});

describe("compareCheckRunNameSets: 増えただけ・消えただけでも不安定", () => {
  it("N1b: 名前が増えただけなら stable=false（added に出る）", () => {
    expect(compareCheckRunNameSets([{ name: "a" }], [{ name: "a" }, { name: "b" }])).toEqual({
      stable: false,
      added: ["b"],
      removed: [],
    });
  });

  it("N1: 名前が消えただけなら stable=false（removed に出る）", () => {
    expect(compareCheckRunNameSets([{ name: "a" }, { name: "b" }], [{ name: "a" }])).toEqual({
      stable: false,
      added: [],
      removed: ["b"],
    });
  });
});

describe("ci-green-check.mjs（偽の gh で CLI 全体を走らせる。ADR 0215 の【実測】の再現）", () => {
  /** @type {string[]} */
  const workDirs = [];
  afterEach(() => {
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const FAKE_GH = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const dir = process.env.FAKE_GH_DIR;",
    'const s = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"));',
    "const a = process.argv.slice(2);",
    'fs.appendFileSync(dir + "/calls.log", JSON.stringify(a) + "\\n");',
    "function count(key) {",
    '  const f = dir + "/count-" + key; let n = 0;',
    '  try { n = Number(fs.readFileSync(f, "utf8")); } catch {}',
    "  fs.writeFileSync(f, String(n + 1)); return n;",
    "}",
    "const pick = (arr, n) => arr[Math.min(n, arr.length - 1)];",
    "const fail = (msg) => { console.error(msg); process.exit(1); };",
    'if (a[0] === "repo" && a[1] === "view") {',
    '  console.log(a.includes("nameWithOwner") ? "o/r" : (s.defaultBranch ?? "main")); process.exit(0);',
    "}",
    'if (a[0] === "pr" && a[1] === "view") {',
    '  if (s.prViewFails) fail("no such pr");',
    '  const h = pick(s.prHeads, count("pr"));',
    '  console.log(JSON.stringify({ headRefOid: h, isDraft: false, mergeStateStatus: "CLEAN", baseRefName: s.prBase ?? "main" }));',
    "  process.exit(0);",
    "}",
    'if (a[0] === "api") {',
    "  const p = a[1];",
    "  if (/\\/branches\\/.+\\/protection$/.test(p)) {",
    '    if (s.protectionFails) fail("HTTP 404: Branch not protected");',
    "    console.log(JSON.stringify(s.protection)); process.exit(0);",
    "  }",
    "  if (/\\/check-runs$/.test(p)) {",
    '    if (s.checkRunsFail) fail("HTTP 500");',
    '    for (const r of pick(s.polls, count("cr"))) console.log(JSON.stringify(r));',
    "    process.exit(0);",
    "  }",
    '  if (/\\/pulls\\/\\d+$/.test(p)) { console.log(s.mergeable ?? "null"); process.exit(0); }',
    "}",
    "process.exit(99);",
  ].join("\n");

  const SHA1 = "1".repeat(40);
  const SHA2 = "2".repeat(40);
  const REQUIRED = ["req-a", "req-b", "req-c"];
  const allGreen = [run("req-a"), run("req-b"), run("req-c"), run("optional-x")];

  /**
   * @param {object} scenario
   * @param {string[]} args
   */
  function runCli(scenario, args) {
    const workDir = mkdtempSync(join(tmpdir(), "ci-green-check-recheck-"));
    workDirs.push(workDir);
    const bin = join(workDir, "bin");
    mkdirSync(bin);
    writeFileSync(join(workDir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    const result = spawnSyncWithDeadline(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH_DIR: workDir },
    });
    let calls = [];
    try {
      calls = readFileSync(join(workDir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // gh が1度も呼ばれなかった。
    }
    return { ...result, calls };
  }

  const base = (overrides = {}) => ({
    prHeads: [SHA1],
    protection: { required_status_checks: { contexts: REQUIRED } },
    polls: [allGreen],
    ...overrides,
  });
  const protectionCalls = (calls) => calls.filter((c) => /\/protection$/.test(c[1] ?? ""));
  const pullsCalls = (calls) => calls.filter((c) => /\/pulls\/\d+$/.test(c[1] ?? ""));

  it("緑: required が全部 success なら exit 0 で、判定した sha を埋めた gh pr merge を印字する（--pr）", () => {
    const result = runCli(base(), ["--pr", "5"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=green");
    expect(result.stdout).toContain(`--match-head-commit ${SHA1}`);
    expect(result.stdout).toContain("gh pr merge 5 --squash --delete-branch");
  });

  it("C9: --sha 直指定の緑は exit 0 だが、PR が無いので gh pr merge は印字しない", () => {
    const result = runCli(base(), ["--sha", SHA1]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("gh pr merge");
  });

  it("C11: check-runs は --paginate で引く（30件を超える check を取りこぼさない）", () => {
    const result = runCli(base(), ["--sha", SHA1]);
    const checkRunsCall = result.calls.find((c) => /\/check-runs$/.test(c[1] ?? ""));
    expect(checkRunsCall).toBeDefined();
    expect(checkRunsCall).toContain("--paginate");
  });

  it("C1・C2・C3・C3b: branch protection が引けなければ（404）、check が全部 success でも緑にせず exit 2、警告を stderr に出す", () => {
    const result = runCli(base({ protectionFails: true }), ["--sha", SHA1]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("status=pending");
    expect(result.stdout).toContain("必須チェックの集合を取得できていない");
    expect(result.stdout).toContain("取得できなかった");
    expect(result.stderr).toContain("branch protection を取得できなかった");
    expect(result.stdout).not.toContain("status=green");
  });

  it("C1: required_status_checks 自体が無い protection の応答でも、緑にせず exit 2", () => {
    const result = runCli(base({ protection: { enforce_admins: { enabled: true } } }), [
      "--sha",
      SHA1,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("contexts が配列でない");
    expect(result.stdout).not.toContain("status=green");
  });

  it("部分登録の窓: required 3件のうち1件が未登録で、残りが全部 success でも exit 2（ADR 0215 の【実測】）", () => {
    const result = runCli(base({ polls: [[run("req-a"), run("req-b")]] }), ["--sha", SHA1]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("req-c");
    expect(result.stdout).not.toContain("status=green");
  });

  it("required が failure なら exit 1、required でない check の failure でも exit 1", () => {
    const requiredRed = runCli(
      base({ polls: [[run("req-a"), run("req-b", "completed", "failure"), run("req-c")]] }),
      ["--sha", SHA1],
    );
    expect(requiredRed.status).toBe(1);
    expect(requiredRed.stdout).toContain("status=red");

    const optionalRed = runCli(
      base({ polls: [[...allGreen.slice(0, 3), run("optional-x", "completed", "failure")]] }),
      ["--sha", SHA1],
    );
    expect(optionalRed.status).toBe(1);
  });

  it("check-runs の取得に失敗したら exit 3（実行時エラー）。pr view に失敗しても exit 3", () => {
    expect(runCli(base({ checkRunsFail: true }), ["--sha", SHA1]).status).toBe(3);
    expect(runCli(base({ prViewFails: true }), ["--pr", "5"]).status).toBe(3);
  });

  it("C4: protection を引く base は --base 明示 > PR の base > 既定ブランチの順", () => {
    const explicit = runCli(base({ prBase: "from-pr" }), ["--pr", "5", "--base", "explicit"]);
    expect(protectionCalls(explicit.calls)[0][1]).toBe("repos/o/r/branches/explicit/protection");

    const fromPr = runCli(base({ prBase: "from-pr" }), ["--pr", "5"]);
    expect(protectionCalls(fromPr.calls)[0][1]).toBe("repos/o/r/branches/from-pr/protection");

    const fallback = runCli(base({ defaultBranch: "trunk" }), ["--sha", SHA1]);
    expect(protectionCalls(fallback.calls)[0][1]).toBe("repos/o/r/branches/trunk/protection");
  });

  it("C5: check-runs が0件で --pr のときだけ mergeable_state を引く。dirty なら衝突を名指しし exit 2（pending のまま）", () => {
    const dirty = runCli(base({ polls: [[]], mergeable: "dirty" }), ["--pr", "5"]);
    expect(dirty.status).toBe(2);
    expect(dirty.stdout).toContain("status=pending");
    expect(dirty.stdout).toContain("衝突");
    expect(pullsCalls(dirty.calls)).toHaveLength(1);

    const bySha = runCli(base({ polls: [[]], mergeable: "dirty" }), ["--sha", SHA1]);
    expect(bySha.status).toBe(2);
    expect(bySha.stdout).not.toContain("衝突");
    expect(pullsCalls(bySha.calls)).toHaveLength(0);

    const running = runCli(
      base({
        polls: [[run("req-a"), run("req-b", "in_progress", null), run("req-c")]],
        mergeable: "dirty",
      }),
      ["--pr", "5"],
    );
    expect(running.status).toBe(2);
    expect(running.stdout).not.toContain("衝突");
    expect(pullsCalls(running.calls)).toHaveLength(0);

    const green = runCli(base({ mergeable: "dirty" }), ["--pr", "5"]);
    expect(green.status).toBe(0);
    expect(pullsCalls(green.calls)).toHaveLength(0);
  });

  it("C6: --recheck-after を渡しても、pending（判定不能）のときは待たず引き直さない（check-runs は1回だけ引く）", () => {
    const result = runCli(base({ protectionFails: true }), ["--sha", SHA1, "--recheck-after", "0"]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("秒待ってから引き直す");
    expect(result.calls.filter((c) => /\/check-runs$/.test(c[1] ?? ""))).toHaveLength(1);
  });

  it("--recheck-after: 2回目も同じ名前集合の緑なら exit 0（stable=true）", () => {
    const result = runCli(base({ polls: [allGreen, allGreen] }), [
      "--sha",
      SHA1,
      "--recheck-after",
      "0",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2nd poll");
    expect(result.stdout).toContain("stable=true");
  });

  it("C8: 2回目で check の名前が増えていたら、2回目が緑でも pending（exit 2）に落とす", () => {
    const result = runCli(base({ polls: [allGreen, [...allGreen, run("late-added")]] }), [
      "--sha",
      SHA1,
      "--recheck-after",
      "0",
      "--json",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("check run の名前集合が変わった");
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("\n{") + 1));
    expect(parsed.verdict.status).toBe("pending");
    expect(parsed.verdict.reason).toContain("名前集合が不安定 stable=false");
    expect(parsed.stability.stable).toBe(false);
    expect(result.stdout).not.toContain("gh pr merge");
  });

  it("C7: 2回目までに head sha が変わったら、1回目の緑を採らず pending（exit 2）。名前集合の比較もしない", () => {
    const result = runCli(base({ prHeads: [SHA1, SHA2], polls: [allGreen, allGreen] }), [
      "--pr",
      "5",
      "--recheck-after",
      "0",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("head sha が変わった");
    expect(result.stdout).not.toContain("2nd poll");
    expect(result.stdout).not.toContain("--match-head-commit");
  });
});
