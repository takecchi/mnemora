#!/usr/bin/env node
/**
 * ⛔ 判定しない・確定しない。exit code は常に 0(想定外の失敗も最上位の try/catch で拾って Markdown に出す)。
 * 出す一覧が「これで全部」だとは名乗らない。計上(確定と書き込み)は人が行う(AGENTS.md「機械には『検出』まで」)。
 *
 * ⛔ `packages/<pkg>/src` の差分では数えない。`src` を触らない変更(マイグレーションの追加等)を取りこぼす。
 * 公開 API snapshot(`scripts/__snapshots__/public-api/*.d.ts`)の実 diff から数える。
 *
 * ⛔ 期待値や件数を道具・生成物に焼き込まない。`git show <ref>:<path>` をその場で実行する。
 *
 * ⛔ 出力側の union に値が増えたものだけを破壊的として数え、入力側だけで広がったものは非破壊として外す。
 * 決め切れないものは「要人判断」枠に出す。入力/出力の線引きそのものは、この道具が代わりに決めない。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import {
  buildFatalFallbackMarkdown,
  buildFullMarkdownReport,
  buildPackageModel,
  diffPackageModels,
} from "./public-api-breaking-diff-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "v1.0.0";

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, head: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

function snapshotRelPath(dirBasename) {
  return `scripts/__snapshots__/public-api/${dirBasename}.d.ts`;
}

/**
 * `stdio` を明示して `stderr` も `pipe` にする。既定だと `git` の生エラーが親の `stderr` に漏れ、
 * 一覧の「読み取りに失敗したパッケージ」欄に理由が載らない。`error.stderr` の一行目を足して、一覧にも理由を出す。
 */
function readSnapshotAtRef(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderrFirstLine = String(error.stderr ?? "").split("\n")[0];
    const wrapped = new Error(
      `git show ${ref}:${relPath} に失敗した${stderrFirstLine ? `: ${stderrFirstLine}` : ""}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function readSnapshotFromWorkingTree(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function basenameOfDir(dir) {
  return dir.split("/").pop();
}

async function main() {
  let markdown;
  try {
    const args = parseArgs(process.argv.slice(2));
    const headLabel = args.head ?? "作業ツリー";

    const perPackage = PUBLISH_TARGETS.map((target) => {
      const pkgBasename = basenameOfDir(target.dir);
      const relPath = snapshotRelPath(pkgBasename);
      try {
        const baseText = readSnapshotAtRef(args.base, relPath);
        const headText = args.head
          ? readSnapshotAtRef(args.head, relPath)
          : readSnapshotFromWorkingTree(relPath);
        const baseModel = buildPackageModel(baseText, `${args.base}:${relPath}`);
        const headModel = buildPackageModel(headText, `${headLabel}:${relPath}`);
        const diff = diffPackageModels(baseModel, headModel);
        return { pkgName: target.name, diff, error: null };
      } catch (error) {
        return {
          pkgName: target.name,
          diff: null,
          error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        };
      }
    });

    markdown = buildFullMarkdownReport({
      base: args.base,
      head: headLabel,
      perPackage,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    markdown = buildFatalFallbackMarkdown(error);
  }
  console.log(markdown);
}

await main();
// ⛔ 門ではない。exit 0 を明示する。
process.exit(0);
