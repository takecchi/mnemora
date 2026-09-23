#!/usr/bin/env node
/**
 * `example-chat` / `root-gate-db-stage` ジョブがそれぞれ残した embedding 出力の指紋
 * （`scripts/measure-embedding-output-fingerprint.mjs` が書いた測定 JSON）を集めて、
 * 一致・不一致・比較できなかったを判定し、Job Summary 向けの Markdown を出す CLI
 * （Issue #565、ADR 0253 追記）。
 *
 * 組み立ては `./compare-embedding-output-fingerprints-lib.mjs` の純関数に委ねる
 * （`lexical-regime-coverage.mjs` と同じ分担）。ここは
 *
 * 1. `--artifacts-dir <dir>`（必須）を読む。`actions/download-artifact@v6` が
 *    `pattern: embedding-output-fingerprint-*` でダウンロードした先を渡す想定
 *    （各 artifact 名のディレクトリの下に `embedding-fingerprint.json` が1個ずつ並ぶ）。
 * 2. `EMBEDDING_FINGERPRINT_JOBS` の各ジョブについて、そのディレクトリ/ファイルを読む。
 * 3. Markdown を stdout に出す。
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/compare-embedding-output-fingerprints.mjs --artifacts-dir <dir>
 *
 * 🔴🔴 **このスクリプトは常に exit 0 で終わる（`--artifacts-dir` を渡し忘れた場合を除く）。**
 * ⛔ **`lexical-regime-coverage.mjs` と違い、これは門ではない。**一致・不一致・
 * 比較できなかった、のどの結果でも非0にしない——Issue #565「採るとしたら何が要るか」
 * 4番の比較段は、n が溜まり偽陽性率が測れるまで、値の良し悪しを判定しない
 * （`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」）。
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
  // ⚠ これは「比較の結果」ではなく CLI の誤用(引数が無い)なので、非0で終わってよい
  // ——Issue #565 の「不一致でもジョブを落とさない」は比較*結果*についての規律であり、
  // このスクリプト自体の呼び出しが壊れている場合まで覆わない。
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

// 🔴 常に 0。上のコメント参照。
process.exit(0);
