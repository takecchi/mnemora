#!/usr/bin/env node
/**
 * ⛔ `postgres` ジョブ自体が skip されたかは見ない。呼び出し側(ci.yml の `postgres-regime-coverage`)が
 * `needs.postgres.result` で見る。ここが見るのは artifact が両方揃っているかだけ。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_SERVER_ENCODINGS,
  artifactNameForEncoding,
  buildCoverageSummaryMarkdown,
  evaluateCoverage,
} from "./lexical-regime-coverage-lib.mjs";

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
  console.error("使い方: node scripts/lexical-regime-coverage.mjs --artifacts-dir <dir>");
  process.exit(1);
}

const legs = EXPECTED_SERVER_ENCODINGS.map((encoding) => {
  const jsonPath = join(artifactsDir, artifactNameForEncoding(encoding), "lexical-regime.json");
  if (!existsSync(jsonPath)) {
    return { encoding, present: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    return { encoding, present: true, measuredEncoding: parsed.serverEncoding };
  } catch (err) {
    return { encoding, present: true, error: err.message };
  }
});

const result = evaluateCoverage(legs);

// ⭐ 先に Markdown を stdout へ出す。赤くなるときこそ Job Summary に状態が残る必要がある。
console.log(buildCoverageSummaryMarkdown(legs, result));

if (!result.ok) {
  console.error(result.problems.join("\n"));
  process.exit(1);
}

process.exit(0);
