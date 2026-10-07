#!/usr/bin/env node
/**
 * 判定ロジックはここに置かない(`check-required-status-checks-lib.mjs` が正本)。
 *
 * ⛔ 読むだけ。GET しか呼ばず、protection にも宣言にも書かない。
 *
 * ⚠ exit `2`(読めなかった)を `0` に丸めない。ADR 0274 が直した腐りを、この道具自身の中に作り直すことになる。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareRequiredStatusChecks,
  contextsFromProtection,
  formatComparisonReport,
} from "./check-required-status-checks-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECLARATION_PATH = join(ROOT, ".github", "required-status-checks.json");

const DEFAULT_REPO = "takecchi/mnemora";
const DEFAULT_BRANCH = "main";

function parseArgs(argv) {
  const args = { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--branch") args.branch = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

/**
 * ⛔ 宣言を読めないときは保留にせず赤(exit 1)。この repo 自身が直せる問題のため。
 *
 * @returns {{ contexts: string[] } | null}
 */
function readDeclaration() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(DECLARATION_PATH, "utf8"));
  } catch (error) {
    console.error(`${DECLARATION_PATH} を読めない: ${error}`);
    return null;
  }
  if (!Array.isArray(raw.contexts) || raw.contexts.some((n) => typeof n !== "string")) {
    console.error(`${DECLARATION_PATH} の contexts が文字列の配列でない`);
    return null;
  }
  return { contexts: raw.contexts };
}

/**
 * ⛔ `-q` で欄を絞らない。生 JSON を丸ごと取り、判定は lib に委ねる
 * (「`required_status_checks` が無い」と「在るが `contexts` が空」を区別するため)。
 * 例外は握り潰すが、読めなかった理由(401/403/404/ネットワーク)は捨てない。
 *
 * @param {string} repo
 * @param {string} branch
 * @returns {{ protection: unknown, error: string | null }}
 */
function fetchProtection(repo, branch) {
  const apiPath = `repos/${repo}/branches/${branch}/protection`;
  let out;
  try {
    out = execFileSync("gh", ["api", apiPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      error !== null && typeof error === "object" && "stderr" in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { protection: null, error: `gh api ${apiPath} が失敗した: ${detail}` };
  }
  try {
    return { protection: JSON.parse(out), error: null };
  } catch (error) {
    return { protection: null, error: `gh api ${apiPath} の応答が JSON として読めない: ${error}` };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const declaration = readDeclaration();
  if (declaration === null) {
    process.exit(1);
    return;
  }

  const { protection, error } = fetchProtection(args.repo, args.branch);
  const live = protection === null ? null : contextsFromProtection(protection);
  const result = compareRequiredStatusChecks(declaration.contexts, live);

  console.log(formatComparisonReport(result));
  if (result.verdict === "undetermined" && error !== null) {
    console.error(`  gh の出力: ${error}`);
  }

  if (args.json) {
    console.log(JSON.stringify({ repo: args.repo, branch: args.branch, ...result }, null, 2));
  }

  if (result.verdict === "match") {
    process.exit(0);
  }
  if (result.verdict === "mismatch") {
    process.exit(1);
  }
  process.exit(2);
}

main();
