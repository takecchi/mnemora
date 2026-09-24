#!/usr/bin/env node
/**
 * CI のモデルキャッシュ鍵を、**宣言（repo/dtype）と、固定した revision の宣言から
 * 組み立てて印字する** CLI（Issue #564、ADR 0263、Issue #597 案(a) による ADR 0263 追記）。
 *
 * ## なぜ要るか
 *
 * 【実測 2026-09-21】`.github/workflows/ci.yml` の6箇所すべてが
 * `local-embedding-ruri-v3-30m-q8-v1` という**手で版を振った固定文字列**だった。
 * **revision も hash も入っていなかった。** ⟹ 🔴 **HF の `main` が動いても、CI は誰かが
 * `-v1` を手で上げるまで古い重みを配り続けた。**
 *
 * ⭐ **これは「CI が測っている重み ↔ 利用者が新規に落とす重み」のずれである。**
 * ⛔ `@mnemora/local-embedding` が宣言する `repo`/`modelId` のずれ（Issue #142 ② /
 * ADR 0247）とは別の経路なので、混同しないこと。
 *
 * ## 🔴 2026-09-24 追記: もう Hugging Face に問い合わせない（Issue #597 案(a)）
 *
 * ADR 0263 の初版は、鍵の revision を**毎回 HF の `main` の現在の sha**から作っていた
 * （HF API 1回 + 到達失敗時のリトライ）。**Issue #597 の決定で、CI が使う revision を
 * 「採用時の sha」に固定した**——`scripts/local-embedding-pinned-revision.json` が
 * その唯一の宣言である。⟹ **この CLI はもう Hugging Face に一度も問い合わせない。**
 * 鍵は repo・dtype・固定 revision という**3つのローカル宣言だけ**から組み立てる。
 *
 * ⚠ **この宣言が古くなっていないか（HF の `main` が動いたか）を見張るのは、この CLI では
 * ない。**`scripts/check-local-embedding-fingerprint.mjs` が引き続き `main` を照合する
 * 番犬として残る（ADR 0253 追記）——門が赤くなったら、それがこの宣言を更新せよという
 * 合図になる。
 *
 * ## ⛔ 何も焼き込まない（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）
 *
 * repo 名も dtype も、唯一の出所である
 * `packages/local-embedding/src/local-embedding-provider.ts` の
 * `DEFAULT_LOCAL_EMBEDDING_REPO` / `DEFAULT_LOCAL_EMBEDDING_DTYPE` から読む。
 * revision も、唯一の出所である `scripts/local-embedding-pinned-revision.json` から読む。
 * ⟹ **この CLI は鍵の材料を1つも持たない——3つとも他所の宣言を読むだけである。**
 *
 * `examples/chat/src/providers.ts`（`localEmbeddingPinnedRevision`）が同じ
 * `scripts/local-embedding-pinned-revision.json` を読んでおり、**同じ宣言を見ていることが、
 * 両者が食い違わない根拠である。**
 *
 * ## 🔴 宣言を読めなかったら —— **落とさず、いまの鍵へ落ちる**
 *
 * ⛔ **ここでジョブを赤にしない。** この CLI は6ジョブで走り、**そのうち2つは
 * required な context である**（`examples/chat` と `ルートの test 門の DB 段`）。
 * repo/dtype/revision のどれか1つでも読めなければ、**フォールバック鍵**へ落ちる
 * （`::warning::` は出す。黙って落ちない）。**理由は3つとも同じ**——宣言が読めないのは
 * この CLI の外側（ファイルの書き間違い・削除）の問題であり、この CLI がそれを検知して
 * 赤にする役目は持たない（宣言そのものの異常は将来の別の門の役目）。
 *
 * ## 出力
 *
 * `$GITHUB_OUTPUT` の行形式（`key=<値>`）で**接尾辞**を stdout に出す。ワークフロー側は
 * `>> "$GITHUB_OUTPUT"` で受け、`actions/cache` の `key` に
 * `local-embedding-${{ steps.<id>.outputs.key }}` を渡す（接頭辞は yml 側のリテラル）。
 * ⚠ **`--plain` を付けると値だけを出す**（手元で確かめるため）。
 *
 * ```
 * node scripts/print-local-embedding-cache-key.mjs --plain
 * ```
 *
 * ⚠ **`--declaration-path <path>`** は、固定 revision の宣言ファイルの場所を差し替える
 * 注入点である（`packages/openai` の `client` 注入・`check-local-embedding-fingerprint.mjs`
 * の `--api-base` と同じ役目）。本番の挙動を変える入口ではなく、**「宣言が読めない」を
 * 実際にファイルを壊さずに歯から再現するため**に在る。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCacheKeySuffix } from "./print-local-embedding-cache-key-lib.mjs";

/**
 * 落ちる先。
 *
 * 🔴 **`ci.yml` 側の接頭辞 `local-embedding-` と繋ぐと、revision を入れる前に
 * `ci.yml` が持っていた鍵そのもの（`local-embedding-ruri-v3-30m-q8-v1`）になる。**
 * ⟹ 値を変えないこと。
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
 * 宣言の唯一の出所（`local-embedding-provider.ts`）から、文字列リテラルを1つ取り出す。
 *
 * ⛔ 取れなければフォールバック値を持たずに `null` を返す——呼び出し側が
 * 「宣言が読めない」として扱う。
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
 * 固定した revision（Issue #597 案(a)）の唯一の宣言を読む。
 *
 * ⛔ 取れなければ（ファイルが無い・JSON が壊れている・`sha` が文字列でない）
 * フォールバック値を持たずに `null` を返す——呼び出し側が「宣言が読めない」として扱う。
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
