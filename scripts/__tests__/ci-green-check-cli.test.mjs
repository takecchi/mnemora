import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  spliceGeneratedIndex,
  GENERATED_START_MARKER,
  GENERATED_END_MARKER,
} from "../generate-adr-index-lib.mjs";

/**
 * `scripts/ci-green-check.mjs` の、`gh` を呼んだ後の経路（Issue #294・ADR 0191、Issue #1815 の確かめ直し）。
 *
 * 既存の `ci-green-check.test.mjs` は「`gh` を呼ぶ前に決着する引数検査」だけを見ており、判定の配線
 * （どの `gh` を呼び、結果を `verdict()` へ渡し、exit code と `--match-head-commit` のコマンドへ落とすか）は
 * 誰も走らせて見ていなかった。実 `gh` に依存すると「歯が赤い」のか「`gh` が届かない」のか区別がつかない
 * ので、**偽の `gh`（node スクリプト）を PATH の先頭に置く**——ネットワーク・認証に依存しない。
 * 偽の `gh` は呼ばれた引数を記録し、設定（JSON）に沿った応答を返す。
 *
 * **これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

const script = fileURLToPath(new URL("../ci-green-check.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tmpRoots = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const ok = (name) => ({ name, status: "completed", conclusion: "success" });

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(cfg.log, JSON.stringify(args) + "\\n");
const n = (key) => {
  const f = cfg.log + "." + key;
  const c = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  fs.writeFileSync(f, String(c + 1));
  return c;
};
const pick = (v, c) => (Array.isArray(v) && v.__seq ? v.items[Math.min(c, v.items.length - 1)] : v);
const fail = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
const j = args.join(" ");
if (args[0] === "repo" && j.includes("nameWithOwner")) { console.log("o/r"); process.exit(0); }
if (args[0] === "repo" && j.includes("defaultBranchRef")) { console.log(cfg.defaultBranch ?? "main"); process.exit(0); }
if (args[0] === "pr" && args[1] === "view") {
  if (cfg.prViewFails) fail("pr view failed");
  const c = n("prview");
  const sha = cfg.prShas ? cfg.prShas[Math.min(c, cfg.prShas.length - 1)] : cfg.sha;
  console.log(JSON.stringify({ headRefOid: sha, isDraft: false, mergeStateStatus: "CLEAN", baseRefName: cfg.prBase ?? "main" }));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/protection")) {
  if (cfg.protection === null) fail("404");
  console.log(typeof cfg.protection === "string" ? cfg.protection : JSON.stringify(cfg.protection));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("/check-runs")) {
  const c = n("checkruns");
  const runs = cfg.checkRunsSeq[Math.min(c, cfg.checkRunsSeq.length - 1)];
  for (const r of runs) console.log(JSON.stringify(r));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("/pulls/")) {
  if (cfg.mergeableState === undefined) fail("no state");
  console.log(cfg.mergeableState);
  process.exit(0);
}
fail("unexpected gh call: " + j);
`;

function run(args, cfg, { sandbox = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-green-cli-"));
  tmpRoots.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "cfg.json"), JSON.stringify({ log, sha: SHA, ...cfg }));
  let scriptPath = script;
  if (sandbox) {
    // 道具を一時ディレクトリへ写し、その `docs/decisions` を「呼び出し側の作業木」にする（索引の鮮度の相乗りを見るため）
    const sdir = join(dir, "sandbox");
    mkdirSync(join(sdir, "scripts"), { recursive: true });
    mkdirSync(join(sdir, "docs/decisions"), { recursive: true });
    for (const f of [
      "ci-green-check.mjs",
      "ci-green-check-lib.mjs",
      "generate-adr-index-lib.mjs",
    ]) {
      copyFileSync(
        join(fileURLToPath(new URL("..", import.meta.url)), f),
        join(sdir, "scripts", f),
      );
    }
    sandbox(join(sdir, "docs/decisions"));
    scriptPath = join(sdir, "scripts/ci-green-check.mjs");
  }
  const r = spawnSyncWithDeadline(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_CONFIG: join(dir, "cfg.json"),
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // 1回も呼ばれていない
  }
  return { ...r, calls };
}

const REQUIRED = { required_status_checks: { contexts: ["build", "test"] } };
const GREEN = [ok("build"), ok("test")];
const HINT = `gh pr merge 5 --squash --delete-branch --match-head-commit ${SHA}`;

describe("ci-green-check.mjs の判定の配線（偽の gh）", () => {
  it("--pr で green なら、判定した sha を --match-head-commit に埋めたコマンドを出して exit 0", () => {
    const r = run(["--pr", "5"], { protection: REQUIRED, checkRunsSeq: [GREEN] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(HINT);
    expect(r.stdout).toContain(`PR #5 の head sha: ${SHA}`);
  });

  it("--sha だけ（PR 無し）の green は exit 0 だが、マージコマンドは出さない", () => {
    const r = run(["--sha", SHA], { protection: REQUIRED, checkRunsSeq: [GREEN] });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("red（1件が failure）は exit 1 で、マージコマンドを出さない", () => {
    const r = run(["--pr", "5"], {
      protection: REQUIRED,
      checkRunsSeq: [[ok("build"), { name: "test", status: "completed", conclusion: "failure" }]],
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("status=red");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("走っている最中のものが在れば pending（exit 2）で、マージコマンドを出さない", () => {
    const r = run(["--pr", "5"], {
      protection: REQUIRED,
      checkRunsSeq: [[ok("build"), { name: "test", status: "in_progress", conclusion: null }]],
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("pending: test");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("required status checks を取得できなければ、従来どおりに倒さず pending（exit 2）で警告する（ADR 0215）", () => {
    const r = run(["--pr", "5"], { protection: null, checkRunsSeq: [GREEN] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("branch protection を取得できなかった");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("branch protection の応答が JSON でなければ、同じく pending", () => {
    const r = run(["--pr", "5"], { protection: "not json", checkRunsSeq: [GREEN] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("JSON として読めなかった");
  });

  it("required_status_checks が無い応答（contexts が配列でない）は pending", () => {
    const r = run(["--pr", "5"], { protection: {}, checkRunsSeq: [GREEN] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("contexts が配列でない");
  });

  it("required が全部揃っていなければ（部分登録の窓）green にしない", () => {
    const r = run(["--pr", "5"], { protection: REQUIRED, checkRunsSeq: [[ok("build")]] });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("test");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("下限を引く先は、PR の base branch（--base が明示されればそちら）", () => {
    const a = run(["--pr", "5"], {
      prBase: "release",
      protection: REQUIRED,
      checkRunsSeq: [GREEN],
    });
    expect(a.calls.some((c) => c.includes("repos/o/r/branches/release/protection"))).toBe(true);
    const b = run(["--pr", "5", "--base", "dev"], {
      prBase: "release",
      protection: REQUIRED,
      checkRunsSeq: [GREEN],
    });
    expect(b.calls.some((c) => c.includes("repos/o/r/branches/dev/protection"))).toBe(true);
    expect(b.calls.some((c) => c.includes("repos/o/r/branches/release/protection"))).toBe(false);
  });

  it("--sha のみで --base も無ければ、既定ブランチの下限を引く", () => {
    const r = run(["--sha", SHA], {
      defaultBranch: "trunk",
      protection: REQUIRED,
      checkRunsSeq: [GREEN],
    });
    expect(r.calls.some((c) => c.includes("repos/o/r/branches/trunk/protection"))).toBe(true);
  });

  it("--repo が明示されれば `gh repo view` で引かない", () => {
    const r = run(["--sha", SHA, "--repo", "x/y"], { protection: REQUIRED, checkRunsSeq: [GREEN] });
    expect(r.calls.some((c) => c[0] === "repo" && c.includes("nameWithOwner"))).toBe(false);
    expect(r.calls.some((c) => c.includes("repos/x/y/branches/main/protection"))).toBe(true);
  });

  it("check-runs が0件で --pr かつ mergeable_state=dirty なら、衝突を名指しする（exit 2 のまま）", () => {
    const r = run(["--pr", "5"], {
      protection: REQUIRED,
      checkRunsSeq: [[]],
      mergeableState: "dirty",
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("mergeable_state=dirty");
  });

  it("check-runs が0件で mergeable_state を取れなければ、衝突と決めつけない", () => {
    const r = run(["--pr", "5"], { protection: REQUIRED, checkRunsSeq: [[]] });
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("mergeable_state=dirty");
    expect(r.stdout).toContain("まだ登録されていない可能性");
  });

  it("0件でも --sha だけなら mergeable_state を引かない（PR が無い）", () => {
    const r = run(["--sha", SHA], {
      protection: REQUIRED,
      checkRunsSeq: [[]],
      mergeableState: "dirty",
    });
    expect(r.calls.some((c) => c[1]?.includes("/pulls/"))).toBe(false);
    expect(r.stdout).not.toContain("mergeable_state=dirty");
  });

  it("PR の head を引けなければ exit 3", () => {
    const r = run(["--pr", "5"], {
      prViewFails: true,
      protection: REQUIRED,
      checkRunsSeq: [GREEN],
    });
    expect(r.status).toBe(3);
  });

  it("--json は判定と sha を JSON で出す", () => {
    const r = run(["--sha", SHA, "--json"], { protection: REQUIRED, checkRunsSeq: [GREEN] });
    const jsonText = r.stdout.slice(r.stdout.indexOf("{\n"));
    const parsed = JSON.parse(jsonText);
    expect(parsed.sha).toBe(SHA);
    expect(parsed.repo).toBe("o/r");
    expect(parsed.verdict.status).toBe("green");
  });
});

describe("ci-green-check.mjs --recheck-after（偽の gh）", () => {
  it("2回の名前集合が同じなら green のまま（exit 0）で、stable を名乗る", () => {
    const r = run(["--pr", "5", "--recheck-after", "0"], {
      protection: REQUIRED,
      checkRunsSeq: [GREEN, GREEN],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[2nd poll]");
    expect(r.stdout).toContain("stable=true");
    expect(r.stdout).toContain(HINT);
  });

  it("2回目に名前集合が増えていたら、green でも pending に落とす（exit 2）", () => {
    const r = run(["--pr", "5", "--recheck-after", "0"], {
      protection: REQUIRED,
      checkRunsSeq: [GREEN, [...GREEN, ok("late")]],
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("名前集合が変わった");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("2回目までに head sha が変わったら、比べずに pending（exit 2）で、古い sha のコマンドを出さない", () => {
    const r = run(["--pr", "5", "--recheck-after", "0"], {
      protection: REQUIRED,
      checkRunsSeq: [GREEN, GREEN],
      prShas: [SHA, SHA2],
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("head sha が変わった");
    expect(r.stdout).not.toContain("gh pr merge");
  });

  it("1回目が pending なら引き直さない", () => {
    const r = run(["--pr", "5", "--recheck-after", "0"], {
      protection: REQUIRED,
      checkRunsSeq: [[ok("build")]],
    });
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("[2nd poll]");
  });

  it("2回目が red に変わっていたら red（exit 1）", () => {
    const r = run(["--pr", "5", "--recheck-after", "0"], {
      protection: REQUIRED,
      checkRunsSeq: [
        GREEN,
        [ok("build"), { name: "test", status: "completed", conclusion: "failure" }],
      ],
    });
    expect(r.status).toBe(1);
  });
});

const ADR_FILE = "# ADR 0001: a\n\n- **状態**: 採用 (2026-10)\n- **日付**: 2026-10-07\n";
const README_SHELL = `# index\n\n${GENERATED_START_MARKER}\n${GENERATED_END_MARKER}\n`;
const freshReadme = () =>
  spliceGeneratedIndex(
    README_SHELL,
    buildIndexTable(buildAdrEntries([{ filename: "0001-a.md", content: ADR_FILE }])),
  );
const RED_RUNS = [ok("build"), { name: "test", status: "completed", conclusion: "failure" }];
const STALE_HINT = "docs/decisions/README.md は docs/decisions/*.md と一致していない";

describe("ci-green-check.mjs の ADR 索引の鮮度の相乗り（ADR 0192。赤のときだけ、作業木を見る）", () => {
  const sandboxWith = (readme) => (decisionsDir) => {
    writeFileSync(join(decisionsDir, "0001-a.md"), ADR_FILE);
    if (readme !== null) writeFileSync(join(decisionsDir, "README.md"), readme);
  };

  it("赤で、作業木の索引が陳腐化していれば、再生成の手順を名指しする", () => {
    const r = run(
      ["--pr", "5"],
      { protection: REQUIRED, checkRunsSeq: [RED_RUNS] },
      {
        sandbox: sandboxWith(README_SHELL),
      },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(STALE_HINT);
    expect(r.stdout).toContain("node scripts/generate-adr-index.mjs");
  });

  it("赤でも、索引が新鮮なら言わない", () => {
    const r = run(
      ["--pr", "5"],
      { protection: REQUIRED, checkRunsSeq: [RED_RUNS] },
      {
        sandbox: sandboxWith(freshReadme()),
      },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(STALE_HINT);
  });

  it("赤でも、索引を読めなければ（判定不能）言わない——主目的の判定を道連れにしない", () => {
    const r = run(
      ["--pr", "5"],
      { protection: REQUIRED, checkRunsSeq: [RED_RUNS] },
      {
        sandbox: sandboxWith(null),
      },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(STALE_HINT);
  });

  it("赤でなければ（pending でも green でも）、陳腐化していても言わない", () => {
    const pending = run(
      ["--pr", "5"],
      {
        protection: REQUIRED,
        checkRunsSeq: [[ok("build")]],
      },
      { sandbox: sandboxWith(README_SHELL) },
    );
    expect(pending.status).toBe(2);
    expect(pending.stdout).not.toContain(STALE_HINT);
    const green = run(
      ["--pr", "5"],
      { protection: REQUIRED, checkRunsSeq: [GREEN] },
      {
        sandbox: sandboxWith(README_SHELL),
      },
    );
    expect(green.status).toBe(0);
    expect(green.stdout).not.toContain(STALE_HINT);
  });
});

describe("ci-green-check.mjs が gh に渡す形", () => {
  it("check-runs は --paginate で全頁を引く（30件を超えても数え落とさない）", () => {
    const r = run(["--sha", SHA], { protection: REQUIRED, checkRunsSeq: [GREEN] });
    const call = r.calls.find((c) => c[1]?.includes("/check-runs"));
    expect(call).toContain("--paginate");
  });

  it("下限が取れなかったときの理由は「取得できていない」であって「0件」ではない（ADR 0215）", () => {
    const r = run(["--pr", "5"], { protection: null, checkRunsSeq: [GREEN] });
    expect(r.stdout).toContain("必須チェックの集合を取得できていない");
  });
});
