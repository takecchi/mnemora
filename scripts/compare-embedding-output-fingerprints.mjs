#!/usr/bin/env node
/**
 * 🔴 このスクリプトは常に exit 0 で終わる(`--artifacts-dir` を渡し忘れた場合を除く)。
 * ⛔ 門ではない。一致・不一致・比較できなかったのどれでも非0にしない。n が溜まり偽陽性率が測れるまで、値の良し悪しを判定しない(`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMBEDDING_FINGERPRINT_FILENAME,
  EMBEDDING_FINGERPRINT_JOBS,
  buildComparisonSummaryMarkdown,
  compareFingerprints,
} from "./compare-embedding-output-fingerprints-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const artifactsDir = readArgValue("--artifacts-dir");

if (!artifactsDir) {
  console.error(
    "使い方: node scripts/compare-embedding-output-fingerprints.mjs --artifacts-dir <dir>",
  );
  // ⚠ 引数が無いのは比較の結果ではなく CLI の誤用なので、非0でよい。
  process.exit(1);
}

/** @type {import("./compare-embedding-output-fingerprints-lib.mjs").FingerprintLeg[]} */
const legs = EMBEDDING_FINGERPRINT_JOBS.map((job) => {
  const jsonPath = join(artifactsDir, job.artifactName, EMBEDDING_FINGERPRINT_FILENAME);
  if (!existsSync(jsonPath)) {
    return { id: job.id, present: false };
  }
  try {
    const record = JSON.parse(readFileSync(jsonPath, "utf8"));
    return { id: job.id, present: true, record };
  } catch (err) {
    return { id: job.id, present: true, error: err.message };
  }
});

const result = compareFingerprints(legs[0], legs[1]);

console.log(buildComparisonSummaryMarkdown(legs, result));

// 🔴 常に 0。冒頭参照。
process.exit(0);
