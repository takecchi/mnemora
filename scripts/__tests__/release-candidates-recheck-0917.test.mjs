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
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCommits,
  computeSignals,
  extractChangelogBaseSha,
  groupByType,
  isPackageSrcPath,
  isPublicApiSnapshotPath,
  parseCommitSubject,
  splitBySignal,
} from "../release-candidates-lib.mjs";
import { execFileSyncWithDeadline, spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G6 のうち、PR #474（ADR 0214）の
 * `release-candidates.mjs`（リリース当日に「載せるべき候補」を出す道具）に対して、変異を当てて
 * 見つかった「すり抜け」だけを固定する歯。
 *
 * ⚠ **ADR 0214 追記の `changelog-candidates-summary.mjs`（CI の段）は ADR 0293 が削除した**ので、
 * ここでは測らない。残っているのは道具の本体だけ（CI に配線しない。ADR 0214 決定6）。
 *
 * 既存の `release-candidates-lib.test.mjs`（純関数）が既に守っているものは重ねていない。足したのは次の2つ。
 *
 * 1. 純関数の欠け：信号が立つ条件の境界（パスの前方一致・`packages/` の位置・`files` 省略・
 *    PR 番号は subject の末尾だけ・16進数は7桁以上）と、`type` が無く信号も無い commit が
 *    母集合の『信号なし』側に残ること（ADR 0214 決定2。`c4a3dc7` の族）。
 * 2. **CLI 本体**：既存の歯は CLI を1度も起動していなかった。実物の `release-candidates.mjs` と lib を
 *    一時の git リポジトリへ複写し（`REPO_ROOT` はスクリプトの1つ上なので、その木が対象になる）、
 *    偽の `gh` を PATH の先頭に置いて起動する。確かめるのは、決定2（母集合を落とさない）・
 *    決定4（tag も repo 名も引数・実行時の値から取る）・決定5（CHANGELOG を書き換えず鮮度を名乗る）・
 *    決定6（候補が在っても終了コードは常に 0。実行時エラーだけ 1）。
 *
 * 各 `it` の名前の記号（L1・K3 など）は、Issue #1812 のコメントの変異表の番号である。
 */

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));

describe("release-candidates-lib: 信号と母集合の境界", () => {
  it("L9: files を渡さなくても（省略可の引数）、bang・body-breaking は立つ", () => {
    expect(computeSignals({ subject: "feat(core)!: x" })).toEqual(["bang"]);
    expect(computeSignals({ subject: "fix: x", body: "BREAKING な変更" })).toEqual([
      "body-breaking",
    ]);
  });

  it("L1: PR 番号は subject の末尾の `(#N)` だけを読む（途中の `(#N)` は取らない）", () => {
    expect(parseCommitSubject("fix: a (#1) b (#2)").prNumber).toBe(2);
    expect(parseCommitSubject("fix: a (#1) 末尾に続きが在る").prNumber).toBeNull();
    expect(parseCommitSubject("fix: a (#7)  ").prNumber).toBe(7);
  });

  it("L2: type は大文字を含んでも読む（`Feat: x` は type=Feat。type 無しの母集合に落とさない）", () => {
    expect(parseCommitSubject("Feat(Core)!: x (#3)")).toMatchObject({
      type: "Feat",
      scope: "Core",
      bang: true,
      prNumber: 3,
    });
  });

  it("L5・L5b: 公開 API snapshot のパスは `scripts/__snapshots__/public-api/` の前方一致だけ", () => {
    expect(isPublicApiSnapshotPath("scripts/__snapshots__/public-api/core.d.ts")).toBe(true);
    expect(isPublicApiSnapshotPath("scripts/__snapshots__/other/core.d.ts")).toBe(false);
    expect(isPublicApiSnapshotPath("packages/x/scripts/__snapshots__/public-api/a.ts")).toBe(false);
    expect(isPublicApiSnapshotPath("scripts/__snapshots__/public-api")).toBe(false);
  });

  it("L6b: src のパスは `packages/<name>/src/` で始まるものだけ（入れ子の別の木・パッケージ直下は含めない）", () => {
    expect(isPackageSrcPath("packages/core/src/a.ts")).toBe(true);
    expect(isPackageSrcPath("examples/chat/packages/core/src/a.ts")).toBe(false);
    expect(isPackageSrcPath("docs/packages/core/src/a.ts")).toBe(false);
    expect(isPackageSrcPath("packages/core/package.json")).toBe(false);
  });

  it("L10: type が無く信号も無い commit は、母集合の『信号なし』側に残り、『(type無し)』に集まる（ADR 0214 決定2）", () => {
    const classified = classifyCommits([
      {
        sha: "aaa1111",
        subject: "PRタイトルが conventional でない (#466)",
        body: "",
        files: ["README.md"],
      },
      { sha: "bbb2222", subject: "docs: 誤字 (#2)", body: "", files: ["README.md"] },
      { sha: "ccc3333", subject: "feat(core)!: x (#3)", body: "", files: [] },
    ]);
    const { withSignals, withoutSignals } = splitBySignal(classified);
    expect(withSignals.map((c) => c.sha)).toEqual(["ccc3333"]);
    expect(withoutSignals.map((c) => c.sha)).toEqual(["aaa1111", "bbb2222"]);
    expect(withSignals.length + withoutSignals.length).toBe(classified.length);
    expect(
      groupByType(withoutSignals)
        .get("(type無し)")
        .map((c) => c.sha),
    ).toEqual(["aaa1111"]);
  });

  it("L14: 基準 sha は7桁以上の16進数だけ（6桁以下の語を sha と読まない）", () => {
    expect(
      extractChangelogBaseSha("この節は `4b92134` の後の `abc123` の範囲を数えたものである。"),
    ).toBe("4b92134");
  });
});

describe("release-candidates.mjs（実物を一時の git リポジトリで起動する）", () => {
  /** @type {string[]} */
  const workDirs = [];
  afterEach(() => {
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd, ...args) =>
    execFileSyncWithDeadline(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();

  /** `fakeGh`: "fail" = gh は常に失敗する。"ok" = repo は o2/r2、最新リリースは v0 を返す。 */
  function setup({ fakeGh = "fail", changelog = "withMarker" } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), "release-candidates-recheck-"));
    workDirs.push(workDir);
    const repo = join(workDir, "repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    for (const f of ["release-candidates.mjs", "release-candidates-lib.mjs"]) {
      copyFileSync(join(scriptsDir, f), join(repo, "scripts", f));
    }
    const bin = join(workDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      fakeGh === "fail"
        ? `#!/bin/sh\necho "gh: not authenticated" >&2\nexit 1\n`
        : `#!/bin/sh\ncase "$1" in\n  repo) echo "o2/r2";;\n  release) echo "v0";;\n  *) exit 99;;\nesac\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);

    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    writeFileSync(join(repo, "README.md"), "v0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: 起点");
    git(repo, "tag", "v0");
    const baseSha = git(repo, "rev-parse", "--short=7", "HEAD");

    const commit = (subject, body, files) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
      return git(repo, "rev-parse", "HEAD");
    };
    const shas = {
      bang: commit("feat(core)!: 破壊的に変える (#11)", "", { "packages/core/src/a.ts": "1" }),
      plain: commit("docs: 誤字 (#12)", "", { "README.md": "typo\n" }),
      noType: commit("PRタイトルに type が無い形 (#13)", "", { "docs/x.md": "x\n" }),
      body: commit("fix(core): 直す (#14)", "これは BREAKING な変更", {
        "packages/core/src/b.ts": "2",
      }),
      snapshot: commit("chore: snapshot (#15)", "", {
        "scripts/__snapshots__/public-api/core.d.ts": "3",
      }),
    };
    if (changelog === "withMarker") {
      shas.changelog = commit("docs: changelog", "", {
        "CHANGELOG.md": `## [x]\n\nこの節の数字は **\`${baseSha}\`** の範囲を数えたものである。\n`,
      });
    } else if (changelog === "noMarker") {
      shas.changelog = commit("docs: changelog", "", {
        "CHANGELOG.md": "## [x]\n\n基準の記述は無い\n",
      });
    }
    return { repo, bin, baseSha, shas };
  }

  function runCli(ctx, args) {
    return spawnSyncWithDeadline(
      process.execPath,
      [join(ctx.repo, "scripts", "release-candidates.mjs"), ...args],
      {
        cwd: ctx.repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${ctx.bin}${delimiter}${process.env.PATH}` },
      },
    );
  }

  it("K1・K2・K3: 母集合は範囲内の全 commit。信号の有る・無いに分け、type 無しの commit も落とさず、候補が在っても exit 0", () => {
    const ctx = setup();
    const result = runCli(ctx, ["--since", "v0", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const total = Object.keys(ctx.shas).length;
    expect(payload.totalCommits).toBe(total);
    expect(payload.withSignals.length + payload.withoutSignals.length).toBe(total);
    const signalsBySha = Object.fromEntries(
      [...payload.withSignals, ...payload.withoutSignals].map((c) => [c.sha, c.signals]),
    );
    expect(signalsBySha[ctx.shas.bang]).toEqual(["bang", "src"]);
    expect(signalsBySha[ctx.shas.body]).toEqual(["body-breaking", "src"]);
    expect(signalsBySha[ctx.shas.snapshot]).toEqual(["public-api"]);
    expect(signalsBySha[ctx.shas.plain]).toEqual([]);
    // type が無く信号も無い commit は『信号なし』側に残る（ADR 0214 決定2）。
    const noType = payload.withoutSignals.find((c) => c.sha === ctx.shas.noType);
    expect(noType).toMatchObject({ type: null, prNumber: 13, signals: [] });
    // body の読み取り：`%s%x1f%b` を subject と body に分けている。
    expect(payload.withoutSignals.map((c) => c.subject)).toContain("docs: 誤字 (#12)");
  });

  it("K4: tag・repo は引数と実行時の値から取る。--since は明示を使い、repo は gh が失敗すれば origin の URL から導く", () => {
    const ctx = setup();
    const payload = JSON.parse(runCli(ctx, ["--since", "v0", "--json"]).stdout);
    expect(payload.since).toBe("v0");
    expect(payload.sinceSource).toContain("--since で指定");
    expect(payload.repo).toBe("o/r");
  });

  it("K5: --since を省くと最新リリースの tag を gh から取り、repo も gh から取る", () => {
    const ctx = setup({ fakeGh: "ok" });
    const payload = JSON.parse(runCli(ctx, ["--json"]).stdout);
    expect(payload.repo).toBe("o2/r2");
    expect(payload.since).toBe("v0");
    expect(payload.sinceSource).toContain("gh release view");
    expect(payload.sinceSource).not.toContain("⚠");
  });

  it("K6: gh が失敗したら git describe へ落ち、落ちたことを出力に明記する（ADR 0214 決定4）", () => {
    const ctx = setup({ fakeGh: "fail" });
    const result = runCli(ctx, ["--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.since).toBe("v0");
    expect(payload.sinceSource).toContain("⚠ gh release view が失敗したため git describe");
  });

  it("K7: CHANGELOG の鮮度は、基準 sha と『HEAD はそこから N commit 先』を名乗り、CHANGELOG.md を書き換えない（決定5）", () => {
    const ctx = setup();
    const before = readFileSync(join(ctx.repo, "CHANGELOG.md"), "utf8");
    const result = runCli(ctx, ["--since", "v0", "--json"]);
    const payload = JSON.parse(result.stdout);
    expect(payload.changelogFreshness.baseSha).toBe(ctx.baseSha);
    expect(payload.changelogFreshness.commitsAhead).toBe(Object.keys(ctx.shas).length);
    expect(readFileSync(join(ctx.repo, "CHANGELOG.md"), "utf8")).toBe(before);
    expect(git(ctx.repo, "status", "--porcelain")).toBe("");

    const human = runCli(ctx, ["--since", "v0"]);
    expect(human.stdout).toContain(`CHANGELOG.md はここまで数えている: ${ctx.baseSha}`);
    expect(human.stdout).toContain(`HEAD はそこから ${Object.keys(ctx.shas).length} commit 先`);
  });

  it("K8: CHANGELOG が無い・基準の記述が無いときは、例外にせず『読み取れなかった』を申告して exit 0", () => {
    const missing = runCli(setup({ changelog: "none" }), ["--since", "v0", "--json"]);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).changelogFreshness).toMatchObject({
      baseSha: null,
      note: "CHANGELOG.md が見当たらない",
    });

    const noMarker = runCli(setup({ changelog: "noMarker" }), ["--since", "v0", "--json"]);
    expect(noMarker.status).toBe(0);
    expect(JSON.parse(noMarker.stdout).changelogFreshness.note).toContain(
      "基準 sha を読み取れなかった",
    );
  });

  it("K9: 人が読む出力は、範囲・総数・2群の件数を出し、信号の外し方を両方向とも sha 付きで名指しする（決定3）", () => {
    const ctx = setup();
    const result = runCli(ctx, ["--since", "v0"]);
    const total = Object.keys(ctx.shas).length;
    expect(result.stdout).toContain("範囲: v0..HEAD");
    expect(result.stdout).toContain(`範囲内の commit 総数: ${total}`);
    expect(result.stdout).toContain("信号が付いた commit（3件）");
    expect(result.stdout).toContain(`信号が付かなかった commit（${total - 3}件、type別）`);
    expect(result.stdout).toContain("[(type無し)]");
    expect(result.stdout).toContain("取りこぼす側");
    expect(result.stdout).toContain("c4a3dc7");
    expect(result.stdout).toContain("余計に拾う側");
    expect(result.stdout).toContain("e1c0793");
  });

  it("M2: 範囲は `<since>..HEAD`（tag より後の、HEAD から辿れる commit だけ）。tag が別の枝に在っても、その枝の commit は混ぜない", () => {
    const ctx = setup();
    git(ctx.repo, "checkout", "-q", "-b", "side", "v0");
    writeFileSync(join(ctx.repo, "side.txt"), "side\\n");
    git(ctx.repo, "add", "-A");
    git(ctx.repo, "commit", "-q", "-m", "chore: 別の枝にだけ在る commit");
    const sideSha = git(ctx.repo, "rev-parse", "HEAD");
    git(ctx.repo, "tag", "vside");
    git(ctx.repo, "checkout", "-q", "main");
    const payload = JSON.parse(runCli(ctx, ["--since", "vside", "--json"]).stdout);
    const listed = [...payload.withSignals, ...payload.withoutSignals].map((c) => c.sha);
    expect(listed).not.toContain(sideSha);
    expect(payload.totalCommits).toBe(Object.keys(ctx.shas).length);
  });

  it("K10: 範囲が空でも exit 0。実行時エラー（存在しない tag・不明な引数）だけが exit 1", () => {
    const ctx = setup();
    const empty = runCli(ctx, ["--since", "HEAD", "--json"]);
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      totalCommits: 0,
      withSignals: [],
      withoutSignals: [],
    });

    const badTag = runCli(ctx, ["--since", "no-such-tag"]);
    expect(badTag.status).toBe(1);
    expect(badTag.stderr).not.toBe("");

    const badArg = runCli(ctx, ["--nope"]);
    expect(badArg.status).toBe(1);
    expect(badArg.stderr).toContain("--nope");
  });
});
