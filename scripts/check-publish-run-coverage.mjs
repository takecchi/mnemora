#!/usr/bin/env node
/**
 * ⛔ `.github/workflows/publish.yml` の挙動を変えない。読むだけ。
 *
 * ⛔ 判定不能(終了コード 2)を pass に倒さない。`process.exit(0)` はしない。
 *
 * ⚠ 段は step 番号ではなく `publish.yml` の step 名で見つける。Checks UI の段番号は「Set up job」を数えるかどうかで揺れる。
 *
 * ⚠ ログに印字された文言を読んでいるだけで、`npm publish` が registry へ何を送ったかは見ていない。
 * 文言と実体のずれは、この外側(`npm view` との突き合わせ)でしか確かめられない。
 *
 * 終了コード: 0 = pass、1 = fail、2 = 判定不能、3 = 実行時エラー。
 * 3 は run の状態が読めないのではなく、この CLI 自身が使えない状態(引数の誤り・`gh` の認証切れ・`publish.yml` から段の目印が見つからない等)。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePublishRunCoverage, findPublishStepName } from "./publish-run-coverage-lib.mjs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") args.run = argv[++i];
    else if (a === "--log-file") args.logFile = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
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

/**
 * 見つからなければ `null`。呼び出し側が実行時エラーとして扱う(run の状態の話ではない)。
 */
function resolvePublishStepName() {
  const workflowPath = join(repoRoot, ".github", "workflows", "publish.yml");
  const text = readFileSync(workflowPath, "utf8");
  return findPublishStepName(text);
}

function printResult(result) {
  console.log(`判定: ${result.verdict}`);
  console.log(`理由: ${result.reason}`);
  if (result.isDryRun === null) {
    console.log("予行/本番: 不明（publish 段のログが見つからなかった）");
  } else if (result.isDryRun) {
    console.log("予行/本番: 予行（--dry-run）——registry へは何も上がっていない前提のログである。");
  } else {
    console.log("予行/本番: 本番（release）。");
  }
  console.log(`publish 経路を通った本数: ${result.publishedCount}/${result.totalTargets}`);
  for (const t of result.perTarget) {
    const label =
      t.outcome === "published"
        ? "publish した"
        : t.outcome === "skipped"
          ? "飛ばした（既に registry に在った）"
          : t.outcome === "failed"
            ? "失敗した"
            : t.outcome === "unknown"
              ? "未知の文言（既知の3文言に一致しない）"
              : "ログに無い";
    console.log(`  - ${t.name}: ${label}`);
  }
  if (result.unexpectedNames.length > 0) {
    console.log(`  ⚠ PUBLISH_TARGETS に無い名前がログに在る: ${result.unexpectedNames.join(", ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.run && !args.logFile) {
    console.error(
      "使い方: node scripts/check-publish-run-coverage.mjs --run <run id> | --log-file <path> [--repo owner/repo] [--json]",
    );
    process.exit(3);
  }
  if (args.run && args.logFile) {
    console.error("--run と --log-file は同時に渡せない。");
    process.exit(3);
  }

  let logText;
  let meta = {};

  if (args.logFile) {
    try {
      logText = readFileSync(args.logFile, "utf8");
    } catch (err) {
      console.error(`--log-file が読めない: ${String(err.message ?? err)}`);
      process.exit(3);
      return;
    }
  } else {
    let stepName;
    try {
      stepName = resolvePublishStepName();
    } catch (err) {
      console.error(
        `手元の .github/workflows/publish.yml が読めない: ${String(err.message ?? err)}`,
      );
      process.exit(3);
      return;
    }
    if (!stepName) {
      console.error(
        "手元の .github/workflows/publish.yml から、::group::npm publish を出す step 名が" +
          "見つからなかった（findPublishStepName が null を返した）。ワークフローの形が" +
          "変わった可能性がある——この CLI 側の対応が必要。",
      );
      process.exit(3);
      return;
    }

    let repo;
    try {
      repo = resolveRepo(args.repo);
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exit(3);
      return;
    }

    let runInfo;
    try {
      const out = run("gh", [
        "run",
        "view",
        args.run,
        "--repo",
        repo,
        "--json",
        "status,conclusion,event,jobs,url",
      ]);
      runInfo = JSON.parse(out);
    } catch (err) {
      // run が見つからない・gh の認証切れ等は、この CLI の使い方に起因しうるので、判定不能ではなく実行時エラーとして扱う。
      console.error(String(err.message ?? err));
      process.exit(3);
      return;
    }

    console.log(`run: ${runInfo.url ?? args.run}（event=${runInfo.event}）`);

    if (runInfo.status !== "completed") {
      console.log(
        `判定不能: run がまだ走っている（status=${runInfo.status}）。完了してから引き直すこと。`,
      );
      process.exit(2);
      return;
    }

    const job = (runInfo.jobs ?? []).find((j) => (j.steps ?? []).some((s) => s.name === stepName));
    if (!job) {
      console.log(
        `判定不能: publish 段（step 名 "${stepName}"）を持つ job が、この run の中に` +
          "見つからなかった。この run のワークフローが現在の publish.yml と形が違う可能性がある。",
      );
      process.exit(2);
      return;
    }

    meta = { repo, jobId: job.databaseId, jobName: job.name };

    try {
      logText = run("gh", [
        "api",
        `repos/${repo}/actions/jobs/${job.databaseId}/logs`,
        "--allow-escape-sequences",
      ]);
    } catch (err) {
      // ログが期限切れ等で取れないのは、run 自体は特定できているので、判定不能であって実行時エラーではない。
      console.log(
        `判定不能: job "${job.name}"（id=${job.databaseId}）のログが取得できなかった: ` +
          `${String(err.stderr ?? err.message ?? err)}`,
      );
      process.exit(2);
      return;
    }
  }

  const result = evaluatePublishRunCoverage(logText, PUBLISH_TARGETS);
  printResult(result);

  if (args.json) {
    console.log(JSON.stringify({ ...meta, result }, null, 2));
  }

  if (result.verdict === "pass") process.exit(0);
  if (result.verdict === "fail") process.exit(1);
  process.exit(2);
}

main();
