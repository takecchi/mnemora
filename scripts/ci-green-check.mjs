#!/usr/bin/env node
/**
 * ⛔ PR 番号ではなく head sha を明示して引く（push されると head は動く）。
 * ⛔ check-runs（job 単位）だけを見る。run 全体の `conclusion` と `mergeStateStatus` は判定に使わない。
 * ⚠ `--recheck-after` は「もう増えない」ことの証明ではない。2回とも同じだった、という事実を返すだけ。
 * ⚠ required status checks の下限が守るのは required の集合だけ。required でない check が登録されたかは
 * 保証しない（登録された check は required かどうかに関わらず全部 success を要求する）。
 * 取得できなかったときは `pending` に落とす（「従来どおり」には倒さない）。
 * ⚠ 手元の緑は CI の緑を予測しない。常に `gh` 経由で CI 自身に聞く。
 * ⚠ ADR 索引の鮮度の確認は診断のヒントであり、CI 自身の判定を置き換えない。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCheckRunNameSets,
  formatMatchHeadCommitHint,
  verdict,
} from "./ci-green-check-lib.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
} from "./generate-adr-index-lib.mjs";

function parseArgs(argv) {
  const args = { recheckAfter: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") args.pr = argv[++i];
    else if (a === "--sha") args.sha = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--recheck-after") args.recheckAfter = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${cmdArgs.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}`,
    );
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

/** @returns {{ sha: string, isDraft: boolean, mergeStateStatus: string, baseRefName: string }} */
function resolvePrHead(repo, prNumber) {
  const out = run("gh", [
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "headRefOid,isDraft,mergeStateStatus,baseRefName",
  ]);
  const parsed = JSON.parse(out);
  return {
    sha: parsed.headRefOid,
    isDraft: parsed.isDraft,
    mergeStateStatus: parsed.mergeStateStatus,
    baseRefName: parsed.baseRefName,
  };
}

/**
 * @param {string} repo
 * @param {{ base?: string, pr?: string }} args
 * @param {{ baseRefName: string } | null} prMeta
 * @returns {string}
 */
function resolveBase(repo, args, prMeta) {
  if (args.base) return args.base;
  if (prMeta) return prMeta.baseRefName;
  return run("gh", [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
    "-q",
    ".defaultBranchRef.name",
  ]).trim();
}

/**
 * ⛔ `gh api` の出力を `-q` で欄だけ絞らない。「`required_status_checks` 自体が無い」と「contexts が空配列」の
 * 区別がつかなくなる。生 JSON を取り、`required_status_checks?.contexts` の形を見る。
 * 🔴 `contexts: null`（取得できなかった）を「従来どおり判定する」に倒さない。`verdict()` に `null` を渡せば `pending` になる。
 *
 * @returns {{ contexts: string[] | null, warning: string | null }}
 */
function fetchRequiredStatusChecks(repo, base) {
  const apiPath = `repos/${repo}/branches/${base}/protection`;
  let out;
  try {
    out = run("gh", ["api", apiPath]);
  } catch (err) {
    return {
      contexts: null,
      warning:
        `branch protection を取得できなかった（${apiPath}）——required status checks の` +
        `下限を判定できないため、判定は pending に落とす。gh のエラー: ${String(err.message ?? err)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    return {
      contexts: null,
      warning: `branch protection の応答が JSON として読めなかった（${apiPath}）: ${String(err.message ?? err)}`,
    };
  }
  const contexts = parsed?.required_status_checks?.contexts;
  if (!Array.isArray(contexts)) {
    return {
      contexts: null,
      warning:
        `branch protection の required_status_checks.contexts が配列でない（${apiPath}）` +
        `——required_status_checks 自体が未設定の可能性がある。実際の値: ` +
        `${JSON.stringify(parsed?.required_status_checks ?? null)}`,
    };
  }
  return { contexts, warning: null };
}

function fetchCheckRuns(repo, sha) {
  const out = run("gh", [
    "api",
    `repos/${repo}/commits/${sha}/check-runs`,
    "--paginate",
    "-q",
    ".check_runs[] | {name, status, conclusion} | @json",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * ⚠ `resolvePrHead` の `mergeStateStatus`（GraphQL の enum）とは別物。こちらは REST の小文字の enum。
 * ⛔ 緑の判定には使わない。`total === 0` の理由の切り分けにだけ使う。取得できなければ `null`。
 *
 * @returns {string | null}
 */
function fetchMergeableState(repo, prNumber) {
  try {
    const out = run("gh", ["api", `repos/${repo}/pulls/${prNumber}`, "-q", ".mergeable_state"]);
    const state = out.trim();
    return state.length > 0 && state !== "null" ? state : null;
  } catch {
    return null;
  }
}

/**
 * 読めない・生成に失敗する等は `null`（判定不能）にして諦める。このツールの主目的（CI の緑判定）を道連れにしない。
 *
 * @returns {boolean | null} true=陳腐化している / false=最新 / null=判定できなかった
 */
function isAdrIndexStaleLocally() {
  try {
    const decisionsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "decisions");
    const filenames = readdirSync(decisionsDir).filter((f) => f !== "README.md");
    const files = filenames.map((filename) => ({
      filename,
      content: readFileSync(join(decisionsDir, filename), "utf8"),
    }));
    const entries = buildAdrEntries(files);
    const expectedTable = buildIndexTable(entries);
    const readmeText = readFileSync(join(decisionsDir, "README.md"), "utf8");
    const actualTable = extractGeneratedIndex(readmeText);
    return expectedTable !== actualTable;
  } catch {
    return null;
  }
}

function printAdrIndexFreshnessHintIfStale() {
  const stale = isAdrIndexStaleLocally();
  if (stale !== true) return;
  console.log(
    "⚠ この作業木の docs/decisions/README.md は docs/decisions/*.md と一致していない" +
      "（ADR 0192）。赤の原因がこれなら、次を実行してからコミット・push し、判定を引き直すこと:\n" +
      "  node scripts/generate-adr-index.mjs\n" +
      "  git add docs/decisions/README.md\n" +
      '  git commit -m "docs(adr-index): regenerate before merging"\n' +
      "  git push\n" +
      "  （手順は ADR 0137「決定」2番。CI の pull_request でも検査する理由は ADR 0192）",
  );
}

function printVerdict(label, v) {
  console.log(`[${label}] status=${v.status} — ${v.reason}`);
  if (v.summary.pending.length > 0) {
    console.log(`  pending: ${v.summary.pending.join(", ")}`);
  }
  if (v.summary.nonSuccess.length > 0) {
    console.log(`  non-success: ${JSON.stringify(v.summary.nonSuccess)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr && !args.sha) {
    console.error(
      "使い方: node scripts/ci-green-check.mjs --pr <number> | --sha <sha> [--repo owner/repo] [--base <branch>] [--recheck-after <seconds>] [--json]",
    );
    process.exit(3);
  }

  let repo;
  let sha;
  let prMeta = null;
  try {
    repo = resolveRepo(args.repo);
    if (args.pr) {
      prMeta = resolvePrHead(repo, args.pr);
      sha = prMeta.sha;
    } else {
      sha = args.sha;
    }
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(3);
    return;
  }

  if (prMeta) {
    console.log(
      `PR #${args.pr} の head sha: ${sha}（参考・判定には使わない: isDraft=${prMeta.isDraft}, mergeStateStatus=${prMeta.mergeStateStatus}）`,
    );
  } else {
    console.log(`sha: ${sha}`);
  }

  let base;
  try {
    base = resolveBase(repo, args, prMeta);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(3);
    return;
  }
  const { contexts: requiredContexts, warning: requiredContextsWarning } =
    fetchRequiredStatusChecks(repo, base);
  if (requiredContextsWarning) {
    console.error(`⚠ ${requiredContextsWarning}`);
  }
  if (requiredContexts) {
    console.log(
      `required status checks（下限。${base} の branch protection）: ${requiredContexts.length}件 — ` +
        `${requiredContexts.join(", ")}`,
    );
  } else {
    console.log(
      `required status checks（下限。${base} の branch protection）: 取得できなかった` +
        "——上の警告を参照。下限が無いので判定は pending に落ちる。",
    );
  }

  let checkRuns1;
  try {
    checkRuns1 = fetchCheckRuns(repo, sha);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(3);
    return;
  }
  let v1 = verdict(checkRuns1, requiredContexts);
  if (v1.status === "pending" && v1.summary.total === 0 && args.pr) {
    // ⛔ 緑の判定には使わない。`total === 0` の理由の文言の切り分けにだけ使う。
    const mergeableState = fetchMergeableState(repo, args.pr);
    v1 = verdict(checkRuns1, requiredContexts, mergeableState);
  }
  printVerdict("1st poll", v1);

  let finalVerdict = v1;
  let stability = null;

  if (args.recheckAfter != null && v1.status !== "pending") {
    console.log(
      `${args.recheckAfter}秒待ってから引き直す（Issue #228 観測1 の対策。証明ではなく再確認）…`,
    );
    const waitSeconds = Math.max(0, args.recheckAfter);
    // 同期的に待つ（`setTimeout` だと CLI 全体を async にする必要がある）。
    spawnSync("sleep", [String(waitSeconds)]);

    let shaNow;
    try {
      shaNow = args.pr ? resolvePrHead(repo, args.pr).sha : sha;
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exit(1);
      return;
    }
    if (shaNow !== sha) {
      console.log(
        `⚠ 2回目の poll までに head sha が変わった（${sha} → ${shaNow}）。新しい push が在ったということであり、` +
          `1回目の判定は古い commit のものになる。名前集合の比較はしない——sha が違う対象を比べても意味が無い。`,
      );
      finalVerdict = {
        ...v1,
        status: "pending",
        reason: `head sha が変わった（${sha} → ${shaNow}）ため再判定が必要`,
      };
    } else {
      let checkRuns2;
      try {
        checkRuns2 = fetchCheckRuns(repo, shaNow);
      } catch (err) {
        console.error(String(err.message ?? err));
        process.exit(3);
        return;
      }
      const v2 = verdict(checkRuns2, requiredContexts);
      printVerdict("2nd poll", v2);
      stability = compareCheckRunNameSets(checkRuns1, checkRuns2);
      if (!stability.stable) {
        console.log(
          `⚠ check run の名前集合が変わった（追加: ${JSON.stringify(stability.added)}, ` +
            `消失: ${JSON.stringify(stability.removed)}）。Issue #228 観測1 のとおり、` +
            `本数はまだ変わりうる。`,
        );
      } else {
        console.log(
          "check run の名前集合は2回とも同じだった（stable=true。増えないことの証明ではない）。",
        );
      }
      if (v2.status === "green" && !stability.stable) {
        // 名前集合が動いたなら、green と報告して安心させず pending に落とす。
        finalVerdict = {
          ...v2,
          status: "pending",
          reason: `${v2.reason}（ただし名前集合が不安定 stable=false）`,
        };
      } else {
        finalVerdict = v2;
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ repo, sha, verdict: finalVerdict, stability }, null, 2));
  }

  if (finalVerdict.status === "red") {
    printAdrIndexFreshnessHintIfStale();
  }

  if (finalVerdict.status === "green" && args.pr) {
    console.log(formatMatchHeadCommitHint(args.pr, sha));
  }

  if (finalVerdict.status === "green") process.exit(0);
  if (finalVerdict.status === "red") process.exit(1);
  process.exit(2);
}

main();
