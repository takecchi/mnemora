#!/usr/bin/env node
/**
 * `.github/workflows/embedding-cross-runner-reproducibility.yml` の比較ジョブが、
 * 全脚（runner × numThreads × rep）の artifact を集めて、基準脚との突き合わせ・
 * 群ごとの要約を Job Summary 向けの Markdown（stdout）と機械可読な JSON（`--json-out`）
 * へ出す CLI（Issue #565）。
 *
 * 組み立ては `./cross-runner-embedding-fingerprint-lib.mjs` の純関数に委ねる
 * （`compare-embedding-output-fingerprints.mjs` と同じ分担）。ここは
 *
 * 1. `--artifacts-dir <dir>`（必須）・`--json-out <path>`（必須）を読む。
 *    `actions/download-artifact@v6` が `pattern: cross-runner-embedding-fingerprint-*`
 *    でダウンロードした先を渡す想定。
 * 2. `allExpectedCrossRunnerLegs()`（matrix の全量）の各脚について、そのディレクトリ/
 *    ファイルを読む。**期待した脚のうち artifact が無いものも、「無かった」として
 *    明示的に一覧へ残す**——`compare-embedding-output-fingerprints.mjs` と同じ理由
 *    （欠損を暗黙に無視しない）。
 * 3. Markdown を stdout に、JSON を `--json-out` に出す。
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/compare-cross-runner-embedding-fingerprints.mjs \
 *     --artifacts-dir <dir> --json-out <path>
 *
 * 🔴🔴 **このスクリプトは常に exit 0 で終わる（引数を渡し忘れた場合を除く）。**
 * ⛔ これは門ではない——一致・不一致・比較できなかった、のどの結果でも非0にしない
 * （`compare-embedding-output-fingerprints.mjs` と同じ設計。Issue #565 は n が溜まり
 * 偽陽性率が測れるまで値の良し悪しを判定しないと明示している）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_FINGERPRINT_FILENAME } from "./compare-embedding-output-fingerprints-lib.mjs";
import {
  CROSS_RUNNER_BASELINE_LEG_ID,
  allExpectedCrossRunnerLegs,
  buildBaselineComparisons,
  buildCrossRunnerSummaryMarkdown,
  buildGroupSummaries,
} from "./cross-runner-embedding-fingerprint-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const artifactsDir = readArgValue("--artifacts-dir");
const jsonOutPath = readArgValue("--json-out");

if (!artifactsDir || !jsonOutPath) {
  console.error(
    "使い方: node scripts/compare-cross-runner-embedding-fingerprints.mjs " +
      "--artifacts-dir <dir> --json-out <path>",
  );
  // ⚠ これは「比較の結果」ではなく CLI の誤用(引数が無い)なので、非0で終わってよい
  // ——`compare-embedding-output-fingerprints.mjs` と同じ判断。
  process.exit(1);
}

/**
 * ⭐ **群の要約は実測の `arch`（`process.arch`、測定側が書いたもの）を信じる。**
 * `allExpectedCrossRunnerLegs()` の `arch` は「意図した値」でしかない——GitHub 側の
 * runner label と実際の CPU アーキテクチャの対応が変わる可能性を排除しないため、
 * 宣言と実測が食い違っていないかを別途 `archMismatches` に残す（隠さない）。
 *
 * @type {(import("./cross-runner-embedding-fingerprint-lib.mjs").CrossRunnerLeg & { declaredArch: string })[]}
 */
const legs = allExpectedCrossRunnerLegs().map((expected) => {
  const jsonPath = join(artifactsDir, expected.artifactName, EMBEDDING_FINGERPRINT_FILENAME);
  if (!existsSync(jsonPath)) {
    return { ...expected, declaredArch: expected.arch, present: false };
  }
  try {
    const record = JSON.parse(readFileSync(jsonPath, "utf8"));
    const actualArch = typeof record.arch === "string" ? record.arch : expected.arch;
    return { ...expected, declaredArch: expected.arch, present: true, record, arch: actualArch };
  } catch (err) {
    return { ...expected, declaredArch: expected.arch, present: true, error: err.message };
  }
});

const archMismatches = legs
  .filter((leg) => leg.present && !leg.error && leg.arch !== leg.declaredArch)
  .map((leg) => ({ id: leg.id, declaredArch: leg.declaredArch, actualArch: leg.arch }));

const baselineComparisons = buildBaselineComparisons(legs, CROSS_RUNNER_BASELINE_LEG_ID);
const groupSummaries = buildGroupSummaries(legs);

const markdown = buildCrossRunnerSummaryMarkdown({
  legs,
  baselineId: CROSS_RUNNER_BASELINE_LEG_ID,
  baselineComparisons,
  groupSummaries,
});

console.log(markdown);
if (archMismatches.length > 0) {
  console.log(
    "\n⚠ 宣言した arch と実測の arch が食い違う脚がある（runner label と CPU アーキテクチャの" +
      `対応が変わった可能性）: ${JSON.stringify(archMismatches)}`,
  );
}

const jsonOut = {
  generatedAt: new Date().toISOString(),
  baselineLegId: CROSS_RUNNER_BASELINE_LEG_ID,
  archMismatches,
  legs: legs.map((leg) => ({
    id: leg.id,
    runnerLabel: leg.runnerLabel,
    arch: leg.arch,
    numThreads: leg.numThreads,
    rep: leg.rep,
    present: leg.present,
    error: leg.error ?? null,
    status: leg.record?.status ?? null,
    sha256Float32: leg.record?.sha256Float32 ?? null,
    cpuInfo: leg.record?.cpuInfo ?? null,
    runtimeVersions: leg.record?.runtimeVersions ?? null,
    weightsDigest: leg.record?.weightsDigest
      ? {
          combinedSha256: leg.record.weightsDigest.combinedSha256,
          fileCount: leg.record.weightsDigest.fileCount,
        }
      : null,
  })),
  baselineComparisons,
  groupSummaries,
};
writeFileSync(jsonOutPath, `${JSON.stringify(jsonOut, null, 2)}\n`, "utf8");

// 🔴 常に 0。上のコメント参照。
process.exit(0);
