#!/usr/bin/env node
/**
 * CI のモデルキャッシュ鍵を、**宣言と HF の現在の revision から組み立てて印字する** CLI
 * （Issue #564、ADR 0263）。
 *
 * ## なぜ要るか
 *
 * 【実測 2026-09-21】`.github/workflows/ci.yml` の6箇所すべてが
 * `local-embedding-ruri-v3-30m-q8-v1` という**手で版を振った固定文字列**だった。
 * **revision も hash も入っていない。** ⟹ 🔴 **HF の `main` が動いても、CI は誰かが
 * `-v1` を手で上げるまで古い重みを配り続ける。**
 *
 * ⭐ **これは「CI が測っている重み ↔ 利用者が新規に落とす重み」のずれである。**
 * ⛔ `@mnemora/local-embedding` が宣言する `repo`/`modelId` のずれ（Issue #142 ② /
 * ADR 0247）とは別の経路なので、混同しないこと。
 *
 * ## ⛔ 何も焼き込まない（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）
 *
 * repo 名も dtype も、唯一の出所である
 * `packages/local-embedding/src/local-embedding-provider.ts` の
 * `DEFAULT_LOCAL_EMBEDDING_REPO` / `DEFAULT_LOCAL_EMBEDDING_DTYPE` から読む。
 * revision は毎回 HF に問い合わせる。⟹ **この CLI は鍵の材料を1つも持たない。**
 *
 * `scripts/check-local-embedding-fingerprint.mjs` が同じ2つを同じやり方で読んでおり、
 * **同じ宣言を見ていることが、両者が食い違わない根拠である。**
 *
 * ## 🔴 HF に届かなかったら —— **落とさず、いまの鍵へ落ちる**
 *
 * ⛔ **ここでジョブを赤にしない。** この CLI は6ジョブで走り、**そのうち2つは
 * required な context である**（`examples/chat` と `ルートの test 門の DB 段`）。
 * ⟹ HF の一過性の不調で必須の門が止まるのは、この変更が引き受けてよい代償ではない。
 *
 * ⭐ **落ちる先は「revision を入れる前の鍵」そのものである**（{@link FALLBACK_KEY}）。
 * ⟹ **HF 障害中の振る舞いは、この変更の前と完全に同じになる**——温かいキャッシュから
 * 復元され、ジョブは進む。**退化はしても、新しい壊れ方は作らない。**
 *
 * ⚠ **黙って落ちない。** `::warning::` を出し、鍵にも `-fallback` を付けない
 * （付けるとキャッシュを外してしまい、HF が落ちている最中に 4ファイル計42MB のモデル一式を取りに行かせる）。
 *
 * ## 出力
 *
 * `$GITHUB_OUTPUT` の行形式（`key=<値>`）で**接尾辞**を stdout に出す。ワークフロー側は
 * `>> "$GITHUB_OUTPUT"` で受け、`actions/cache` の `key` に
 * `local-embedding-${{ steps.<id>.outputs.key }}` を渡す（接頭辞は yml 側のリテラル）。⚠ **`--plain` を付けると値だけを出す**（手元で確かめるため）。
 *
 * ```
 * node scripts/print-local-embedding-cache-key.mjs --plain
 * node scripts/print-local-embedding-cache-key.mjs --api-base http://127.0.0.1:1 --plain
 * ```
 *
 * ⚠ `--api-base` は `check-local-embedding-fingerprint.mjs` と同じ役目の注入点である
 * ——本番の挙動を変える入口ではなく、**到達失敗とフォールバックを、実際のネットワーク
 * 障害を待たずに決定的に再現するため**に在る。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCacheKeySuffix } from "./print-local-embedding-cache-key-lib.mjs";

/** HF の既定の問い合わせ先。`--api-base` で差し替えない限りこれを使う。 */
const DEFAULT_HF_API_BASE = "https://huggingface.co";

/**
 * HF に届かなかったときに落ちる先。
 *
 * 🔴 **`ci.yml` 側の接頭辞 `local-embedding-` と繋ぐと、revision を入れる前に
 * `ci.yml` が持っていた鍵そのもの（`local-embedding-ruri-v3-30m-q8-v1`）になる。**
 * ⟹ 値を変えないこと。変えると、HF 障害中に温かいキャッシュを外すことになる。
 */
const FALLBACK_SUFFIX = "ruri-v3-30m-q8-v1";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

function parseArgs(argv) {
  const args = { apiBase: undefined, plain: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-base") args.apiBase = argv[++i];
    else if (a === "--plain") args.plain = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

/**
 * 宣言の唯一の出所から、文字列リテラルを1つ取り出す。
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
 * HF のモデル情報 API から `sha`（`main` の現在の commit）を引く。
 *
 * ⛔ **失敗しても投げない。** `null` を返し、呼び出し側がフォールバックへ落ちる。
 *
 * @param {string} apiBase
 * @param {string} repo
 * @returns {Promise<{ sha: string } | { sha: null, reason: string }>}
 */
async function fetchRevision(apiBase, repo) {
  const url = `${apiBase}/api/models/${repo}`;
  let lastReason = "";
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastReason = `HTTP ${response.status} ${response.statusText}`;
      } else {
        const body = await response.json();
        if (typeof body?.sha === "string" && body.sha.length > 0) {
          return { sha: body.sha };
        }
        lastReason = "応答に sha が無かった（HF の API の形が変わった可能性がある）";
      }
    } catch (error) {
      lastReason = String(error?.message ?? error);
    }
    if (attempt < RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return { sha: null, reason: lastReason };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const emit = (key) => {
    console.log(args.plain ? key : `key=${key}`);
    process.exit(0);
  };

  const repo = readDeclared("DEFAULT_LOCAL_EMBEDDING_REPO");
  const dtype = readDeclared("DEFAULT_LOCAL_EMBEDDING_DTYPE");
  if (!repo || !dtype) {
    // ⛔ ここも落とさない。宣言が読めないのは別の門（指紋門）が赤にする責務である
    // ——この CLI はキャッシュ鍵を決めるだけで、門ではない。
    console.error(
      "::warning::キャッシュ鍵: 宣言（DEFAULT_LOCAL_EMBEDDING_REPO / " +
        "DEFAULT_LOCAL_EMBEDDING_DTYPE）を読めなかった。revision を入れない鍵へ落ちる。" +
        "⚠ 宣言そのものの異常は check-local-embedding-fingerprint.mjs が赤にする。",
    );
    emit(FALLBACK_SUFFIX);
    return;
  }

  const apiBase = args.apiBase ?? DEFAULT_HF_API_BASE;
  const revision = await fetchRevision(apiBase, repo);
  if (revision.sha === null) {
    console.error(
      `::warning::キャッシュ鍵: Hugging Face から ${repo} の revision を引けなかった` +
        `（${RETRY_ATTEMPTS} 回試行。最後の失敗理由: ${revision.reason}）。` +
        "⟹ revision を入れない鍵へ落ちる——**この変更の前と同じ振る舞いになる**" +
        "（温かいキャッシュから復元され、ジョブは進む）。⛔ 新しい壊れ方は作らない。",
    );
    emit(FALLBACK_SUFFIX);
    return;
  }

  emit(buildCacheKeySuffix({ repo, dtype, sha: revision.sha }));
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(3);
});
