#!/usr/bin/env node
/**
 * `.github/required-status-checks.json`（main のブランチ保護 — branch protection —
 * が required にしている status check の文脈名の宣言・写し）と、いまの
 * branch protection の実物を突き合わせる CLI。
 *
 * **判定ロジックはここに置かない。** `scripts/check-required-status-checks-lib.mjs`
 * が正本で、なぜ3値で答えるのか・なぜ空の宣言を素通りさせないのかもあちらの
 * doc に書いてある。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 宣言と protection の required contexts が一致しているか。
 *   食い違っていれば、両側の値を並べて出す。
 * - **言えないこと**: **どちらが正しいか。** 宣言が古いのか protection が意図せず
 *   変わったのかは、この道具からは分からない（`docs/autonomy.md` §3 —— branch
 *   protection の設定変更はオーナー領分）。
 * - **書き換えない。** 読むだけである。GET しか呼ばない——`gh api` を
 *   `-X PATCH`/`-X PUT`/`-X DELETE` 付きで呼ぶことは無い。protection にも
 *   宣言にも1バイトも書かない。
 *
 * ## 終了コード（`check-local-embedding-fingerprint.mjs` / `ci-green-check.mjs` と同じ形）
 *
 * | 終了コード | 意味 |
 * |---|---|
 * | `0` | match —— 宣言と protection が一致した |
 * | `1` | mismatch —— ずれている（空の宣言を含む。ADR 0277） |
 * | `2` | undetermined —— protection を読めなかった（権限・ネットワーク） |
 * | `3` | この CLI 自身のバグ・想定していない例外・不明な引数 |
 *
 * ⚠ **`2` を `0` に丸めないこと。** 読めなかったことを「一致した」の顔で
 * 握りつぶすと、ADR 0274 が直した腐り（required check の文脈名が中身と
 * 食い違ったまま誰にも気づかれない）を、この道具自身の中に作り直すことになる。
 *
 * ## 使い方
 *
 * ```
 * node scripts/check-required-status-checks.mjs
 * node scripts/check-required-status-checks.mjs --json
 * node scripts/check-required-status-checks.mjs --repo takecchi/mnemora --branch main
 * ```
 *
 * `--repo` / `--branch` は既定では `takecchi/mnemora` / `main`
 * （`.github/required-status-checks.json` が守っている対象そのもの）。
 * 変異試験・単体試験から別対象へ差し替えるための注入点である。
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
 * `.github/required-status-checks.json` を読み、`contexts` を取り出す。
 *
 * 読めない・`contexts` が文字列の配列でない場合は `null` を返す——これは
 * **この repo 自身が直せる問題**なので、呼び出し側はこれを赤（exit 1）として
 * 扱う（保留にしない。`check-local-embedding-fingerprint.mjs` が「宣言を読み
 * 取れない」を赤にしているのと同じ判断）。
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
 * branch protection を `gh api` で読む。読めなければ `{ protection: null, error }` を返す。
 *
 * ⛔ **`-q` で欄を絞らない。** 生 JSON を丸ごと取り、判定は
 * `contextsFromProtection`（lib 側）に委ねる——`ci-green-check.mjs` の
 * `fetchRequiredStatusChecks` と同じ理由（「required_status_checks 自体が無い」と
 * 「在るが contexts が空」を区別するため）。
 *
 * **例外を握り潰すが、握り潰した中身は捨てない**——読めなかった理由
 * （401/403/404/ネットワーク）は、次の一手を決める材料そのものである。
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
