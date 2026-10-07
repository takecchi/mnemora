#!/usr/bin/env node
/**
 * ⛔ 鍵の材料を1つも持たない。repo 名・dtype は `packages/local-embedding/src/local-embedding-provider.ts` の
 * `DEFAULT_LOCAL_EMBEDDING_REPO` / `DEFAULT_LOCAL_EMBEDDING_DTYPE`、revision は
 * `scripts/local-embedding-pinned-revision.json` から読む。Hugging Face には問い合わせない。
 *
 * ⚠ 固定 revision が古くなっていないかを見張るのはこの CLI ではない。`scripts/check-local-embedding-fingerprint.mjs` が
 * `main` を照合する番犬として残っている。
 *
 * 🔴 宣言を読めなくても、ジョブを落とさずフォールバック鍵へ落ちる(`::warning::` は出す)。6ジョブで走り、
 * うち2つは required な context。宣言が読めないのはこの CLI の外側の問題で、赤にする役目は持たない。
 *
 * ⚠ `--declaration-path` は、「宣言が読めない」を実際にファイルを壊さずに歯から再現するための注入点。
 * 本番の挙動を変える入口ではない。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCacheKeySuffix } from "./print-local-embedding-cache-key-lib.mjs";

/**
 * 🔴 `ci.yml` 側の接頭辞 `local-embedding-` と繋ぐと、revision を入れる前の鍵そのものになる。値を変えないこと。
 */
const FALLBACK_SUFFIX = "ruri-v3-30m-q8-v1";

function parseArgs(argv) {
  const args = { plain: false, declarationPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plain") args.plain = true;
    else if (a === "--declaration-path") args.declarationPath = argv[++i];
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

/**
 * ⛔ 取れなければフォールバック値を持たずに `null` を返す。
 *
 * @param {string} name `export const` の識別子
 * @returns {string | null}
 */
function readDeclared(name) {
  const providerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "packages",
    "local-embedding",
    "src",
    "local-embedding-provider.ts",
  );
  let source;
  try {
    source = readFileSync(providerPath, "utf8");
  } catch {
    return null;
  }
  const matched = new RegExp(`export const ${name}[^=]*=\\s*"([^"]+)"`).exec(source);
  return matched ? matched[1] : null;
}

/**
 * ⛔ 取れなければフォールバック値を持たずに `null` を返す。
 *
 * @param {string} declarationPath
 * @returns {string | null}
 */
function readPinnedRevision(declarationPath) {
  let source;
  try {
    source = readFileSync(declarationPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return typeof parsed?.sha === "string" && parsed.sha.length > 0 ? parsed.sha : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const emit = (key) => {
    console.log(args.plain ? key : `key=${key}`);
    process.exit(0);
  };

  const repo = readDeclared("DEFAULT_LOCAL_EMBEDDING_REPO");
  const dtype = readDeclared("DEFAULT_LOCAL_EMBEDDING_DTYPE");
  if (!repo || !dtype) {
    console.error(
      "::warning::キャッシュ鍵: 宣言（DEFAULT_LOCAL_EMBEDDING_REPO / " +
        "DEFAULT_LOCAL_EMBEDDING_DTYPE）を読めなかった。固定した鍵へ落ちる。",
    );
    emit(FALLBACK_SUFFIX);
    return;
  }

  const declarationPath =
    args.declarationPath ??
    join(dirname(fileURLToPath(import.meta.url)), "local-embedding-pinned-revision.json");
  const revision = readPinnedRevision(declarationPath);
  if (revision === null) {
    console.error(
      `::warning::キャッシュ鍵: 固定した revision の宣言（${declarationPath}）を読めなかった` +
        "（ファイルが無い・JSON が壊れている・sha が無い）。固定した鍵へ落ちる。",
    );
    emit(FALLBACK_SUFFIX);
    return;
  }

  emit(buildCacheKeySuffix({ repo, dtype, sha: revision }));
}

main();
