#!/usr/bin/env node
/**
 * ⛔ 歯ではなく道具。CI ワークフローには配線せず、当日に人が叩く。
 *
 * ⛔ 判定ではなく候補の一覧。機械的な信号だけを根拠に「破壊的変更はこれだけ」と結論しない。
 * 信号が付かなかった側(`withoutSignals`)も必ず人が読むこと(信号が1つも付かない破壊的変更が実在した)。
 *
 * ⛔ 数字も tag 名も焼き込まない(ADR 0070)。起点の tag は引数か `gh release view`/`git describe` からその場で取る。
 * repo 名も同様。焼き込んだ数字は次のリリースで腐る。
 * `gh` が失敗して `git describe` へ落ちたことは、出力に明記する。
 *
 * ⛔ `CHANGELOG.md` を書き換えない(ADR 0169。手で書く)。この道具は書き忘れを確認する材料を出すだけ。
 *
 * ⛔ 門ではない。常に exit 0(候補が0件でも、信号なし commit が在っても)。実行時エラーのときだけ 1。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCommits,
  extractChangelogBaseSha,
  groupByType,
  splitBySignal,
} from "./release-candidates-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { since: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", cwd: REPO_ROOT });
}

/** @returns {string} */
function resolveRepo() {
  try {
    return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  } catch {
    const url = run("git", ["remote", "get-url", "origin"]).trim();
    const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (!match) {
      throw new Error(`origin の URL から owner/repo を読み取れなかった: ${url}`);
    }
    return match[1];
  }
}

/**
 * @param {string | null} explicitSince
 * @param {string} repo
 * @returns {{ tag: string, source: string }}
 */
function resolveSinceTag(explicitSince, repo) {
  if (explicitSince) {
    return { tag: explicitSince, source: "--since で指定" };
  }
  try {
    const tag = run("gh", [
      "release",
      "view",
      "--repo",
      repo,
      "--json",
      "tagName",
      "-q",
      ".tagName",
    ]).trim();
    return { tag, source: `gh release view --repo ${repo} から取得（最新リリース）` };
  } catch (err) {
    const tag = run("git", ["describe", "--tags", "--abbrev=0"]).trim();
    return {
      tag,
      source:
        `⚠ gh release view が失敗したため git describe --tags --abbrev=0 へ落ちた` +
        `（gh のエラー: ${String(err.message ?? err).split("\n")[0]}）`,
    };
  }
}

/**
 * ⭐ 候補だけを探さず、母集合をまず落としてから印を当てる。
 */
function collectRawCommits(since) {
  const shas = run("git", ["log", `${since}..HEAD`, "--format=%H"])
    .split("\n")
    .filter((s) => s.trim().length > 0);

  return shas.map((sha) => {
    const [subject, ...bodyParts] = run("git", ["log", "-1", "--format=%s%x1f%b", sha]).split(
      "\x1f",
    );
    const body = bodyParts.join("\x1f");
    const files = run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n")
      .filter((f) => f.trim().length > 0);
    return { sha, subject, body, files };
  });
}

function describeChangelogFreshness() {
  const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return { baseSha: null, note: "CHANGELOG.md が見当たらない" };
  }
  const text = readFileSync(changelogPath, "utf8");
  const baseSha = extractChangelogBaseSha(text);
  if (!baseSha) {
    return {
      baseSha: null,
      note:
        "CHANGELOG.md から基準 sha を読み取れなかった" +
        "（「…の範囲を数えたものである」という記述、またはその直前のバッククォート付き16進数が見当たらない）",
    };
  }
  try {
    const commitsAhead = Number(run("git", ["rev-list", "--count", `${baseSha}..HEAD`]).trim());
    return { baseSha, commitsAhead, note: null };
  } catch (err) {
    return {
      baseSha,
      note: `基準 sha ${baseSha} は読み取れたが、rev-list に失敗した（${String(err.message ?? err).split("\n")[0]}）`,
    };
  }
}

const WARNING = [
  "⛔ これは判定ではなく候補の一覧である。信号は「読む順番」であって「破壊的かどうか」ではない。",
  "",
  "【実測 2026-09-17】v0.2.0..HEAD の確定的な破壊的変更4件に、信号は一様には付かなかった:",
  "  ・取りこぼす側（高い）: c4a3dc7 は CHANGELOG.md の「変更（破壊的）」節に載っているが、",
  "    `!` も本文の「破壊的」も公開 API snapshot の変更も持たない",
  "    ——粗い src にしか掛からない。⛔ 信号が src だけの commit を「印が無いから安全」と読まないこと。",
  "  ・余計に拾う側（安い）: e1c0793 は本文が逐語で「破壊的変更ではない。」と書いているのに",
  "    body-breaking が立つ——語を見ているだけで、否定文を読み分けない。",
  "",
  "⟹ 信号が付かなかった側も人が読むこと。この道具が減らすのは読む手間であって、読む責任ではない。",
].join("\n");

function formatCommitLine(commit) {
  const scope = commit.scope ? `(${commit.scope})` : "";
  const type = commit.type ?? "type無し";
  const bang = commit.bang ? "!" : "";
  const pr = commit.prNumber != null ? `#${commit.prNumber}` : "-";
  const signals = commit.signals.length > 0 ? commit.signals.join(",") : "-";
  return `  ${commit.sha.slice(0, 7)}  ${type}${scope}${bang}  PR=${pr}  signals=[${signals}]\n    ${commit.subject}`;
}

function printHuman({
  repo,
  since,
  sinceSource,
  totalCommits,
  freshness,
  withSignals,
  withoutSignals,
}) {
  console.log(`repo: ${repo}`);
  console.log(`起点 tag: ${since}（${sinceSource}）`);
  console.log(`範囲: ${since}..HEAD`);
  console.log(`範囲内の commit 総数: ${totalCommits}`);
  console.log("");
  console.log("--- CHANGELOG.md の鮮度（読むだけ・書き換えない） ---");
  if (freshness.baseSha && freshness.commitsAhead != null) {
    console.log(`CHANGELOG.md はここまで数えている: ${freshness.baseSha}`);
    console.log(
      `HEAD はそこから ${freshness.commitsAhead} commit 先（git rev-list --count ${freshness.baseSha}..HEAD）`,
    );
  } else {
    console.log(freshness.note);
  }
  console.log("");
  console.log(`--- 信号が付いた commit（${withSignals.length}件） ---`);
  for (const c of withSignals) console.log(formatCommitLine(c));
  console.log("");
  console.log(`--- 信号が付かなかった commit（${withoutSignals.length}件、type別） ---`);
  const groups = groupByType(withoutSignals);
  for (const [type, commits] of groups) {
    console.log(`[${type}]（${commits.length}件）`);
    for (const c of commits) console.log(formatCommitLine(c));
  }
  console.log("");
  console.log(WARNING);
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repo = resolveRepo();
  const { tag: since, source: sinceSource } = resolveSinceTag(args.since, repo);
  const rawCommits = collectRawCommits(since);
  const classified = classifyCommits(rawCommits);
  const { withSignals, withoutSignals } = splitBySignal(classified);
  const freshness = describeChangelogFreshness();

  const payload = {
    repo,
    since,
    sinceSource,
    totalCommits: classified.length,
    changelogFreshness: freshness,
    withSignals,
    withoutSignals,
    warning: WARNING,
  };

  if (args.json) {
    printJson(payload);
  } else {
    printHuman({
      repo,
      since,
      sinceSource,
      totalCommits: classified.length,
      freshness,
      withSignals,
      withoutSignals,
    });
  }

  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(String(err.stack ?? err.message ?? err));
  process.exit(1);
}
