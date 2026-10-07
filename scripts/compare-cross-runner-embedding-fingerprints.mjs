#!/usr/bin/env node
/**
 * 🔴 常に exit 0(引数の渡し忘れを除く)。⛔ 門ではない。一致・不一致・比較できなかったのどれでも非0にしない。
 * 期待した脚のうち artifact が無いものも、「無かった」として一覧に残す。欠損を暗黙に無視しない。
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
  // ⚠ 比較の結果ではなく CLI の誤用(引数が無い)なので、非0で終わってよい。
  process.exit(1);
}

/**
 * ⭐ 群の要約は実測の `arch` を信じる。`allExpectedCrossRunnerLegs()` の `arch` は意図した値でしかないので、
 * 宣言との食い違いは `archMismatches` に残す。
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

process.exit(0);
