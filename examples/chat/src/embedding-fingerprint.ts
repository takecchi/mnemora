import { writeFileSync } from "node:fs";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import { warmupLocalEmbedding } from "./local-embedding-warmup.js";
import { localEmbeddingPinnedRevision } from "./providers.js";

/**
 * `embedding-fingerprint` サブコマンド（Issue #565、ADR 0253 追記）。
 *
 * [Issue #565](https://github.com/takecchi/mnemora/issues/565) が「採るとしたら何が要るか」
 * として挙げた4項目のうち、**(1) 固定の既知入力に対して `embed()` を呼び、結果ベクトルの
 * `sha256` を出す**を満たす。
 *
 * ⛔ **これは門ではない。** ここが書くのは実測値そのものであり、値の良し悪しを判定しない
 * ——`scripts/measure-embedding-output-fingerprint.mjs`（sha256/次元数/lscpu を合成する側）も
 * `scripts/compare-embedding-output-fingerprints.mjs`（2ジョブ間の突き合わせ）も、
 * 常に exit 0 で終わる設計である。n が溜まり、偽陽性率が測れてから、門にするかどうかを
 * 判断する（ADR 0253 追記、Issue #565 が明示した手前）。
 *
 * ## なぜ examples/chat 側にあるか（`scripts/` に無い理由）
 *
 * `scripts/*.mjs` は plain `node` で実行され、`@mnemora/local-embedding` のような
 * ワークスペースパッケージの TS ソースを直接 import できない
 * （`exports` は `dist/index.js` だけを指しており、この2ジョブは dist をビルドしない——
 * `tsx`/`vitest` が `tsconfig.json`/`vitest.config.mts` の `paths`/`alias` で
 * `src/index.ts` へ解決しているのは `examples/chat` 内だけである）。⟹ **実際に
 * `embed()` を呼ぶ部分は `examples/chat`（tsx 経由）に置き、sha256/lscpu のような
 * モデルに依存しない純粋な計算だけを `scripts/` 側の純関数に切り出す**
 * （`scripts/measure-embedding-output-fingerprint-lib.mjs`。歯は本物のモデルを使わず、
 * 固定のベクトルを直接渡して検査する）。
 *
 * ## 固定入力
 *
 * `FIXED_EMBEDDING_FINGERPRINT_INPUTS` は DB の状態にもタイムスタンプにも依存しない、
 * 決まった文字列の小さい集合である。⛔ **DB へは一切触れない**——`requireDatabaseUrl()`
 * を呼ばない（このコマンドは `DATABASE_URL` を要求しない）。
 *
 * ⚠ **`warmup()` は推論しない**（`local-embedding-provider.ts` の docstring）——
 * ウォームアップの直後に置くだけでは推論は起きない、という Issue #565 が名指しした穴を
 * 避けるため、ここでは `warmup()` の後に明示的に `embed()` を呼ぶ。
 *
 * ⭐ **`revision` も固定する（Issue #597 案(a)、ADR 0253 追記5）。** `providers.ts` の
 * `buildEmbedding` の `local` 分岐と同じ `localEmbeddingPinnedRevision()` を渡す
 * ——**使う側はすべて同じ宣言を見る**という決定の対象に、この経路も含まれる。
 * ⚠ **この修正の前は revision を渡していなかった**——`example-chat` ジョブが
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を `providers.ts`（revision 有り）とこの
 * ファイル（revision 無し＝`main`）とで共有していたため、同じキャッシュディレクトリに
 * フラット配置と revision サブディレクトリ配置が同居していた（ADR 0253 追記5、CI run
 * 35953212055 で発覚）。この修正でその同居は無くなる。
 */

/**
 * 固定の既知入力（Issue #565「採るとしたら何が要るか」1番）。
 *
 * ⛔ **変えるとこの run の sha256 も変わる。** ただしこれは門ではないので、変えても
 * 落ちる歯は無い——変える場合は、Job Summary / artifact に残る値の意味が変わることを
 * 前提にすること（比較段は同一 workflow run 内の2ジョブ同士を突き合わせるだけであり、
 * run をまたいだ値の同一性は主張していない）。
 */
export const FIXED_EMBEDDING_FINGERPRINT_INPUTS: readonly string[] = Object.freeze([
  "朝食にパンを食べた。",
  "東京タワーは港区にある。",
  "コーヒーより紅茶が好き。",
]);

/** `MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON` が書き出す、生ベクトルを含む中間形式。 */
export interface EmbeddingFingerprintRawJson {
  status: "ok" | "weights_unavailable";
  detail: string;
  embeddingSpace?: { provider: string; model: string; dimensions: number };
  inputs?: string[];
  vectors?: number[][];
}

/** `LocalEmbeddingProvider.embed()` に渡すダミーの `Ctx`。DB を持たないためテナントの実在確認は無い。 */
const FINGERPRINT_CTX: Ctx = { tenantId: "embedding-fingerprint-565" };

export async function runEmbeddingFingerprint(): Promise<void> {
  const jsonPath = process.env.MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON;
  if (!jsonPath) {
    console.error("MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON が設定されていない——出力先が無い。");
    process.exitCode = 1;
    return;
  }

  const cacheDir = process.env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
  const provider = new LocalEmbeddingProvider({
    ...(cacheDir ? { cacheDir } : {}),
    revision: localEmbeddingPinnedRevision(),
  });

  console.log(
    "\n[embedding-fingerprint] warmup() でモデルの読み込みを先に済ませる" +
      "（取得に失敗したら、ここでメトリクスを出さずに打ち切る。Issue #565）…",
  );
  const warmup = await warmupLocalEmbedding(provider);
  if (!warmup.ok) {
    console.error(`\n🔴 ${warmup.detail}`);
    const json: EmbeddingFingerprintRawJson = {
      status: "weights_unavailable",
      detail: warmup.detail,
    };
    writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[embedding-fingerprint] 機械可読な結果(取得失敗)を書き出した: ${jsonPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${warmup.detail}`);

  // ⚠ warmup() は推論しない——ここで初めて embed() を呼ぶ(Issue #565 が名指しした穴の回避)。
  const vectors = await provider.embed(FINGERPRINT_CTX, [...FIXED_EMBEDDING_FINGERPRINT_INPUTS]);

  console.log(
    `[embedding-fingerprint] embedding space: provider=${provider.space.provider} ` +
      `model=${provider.space.model} dimensions=${provider.space.dimensions}、` +
      `固定入力 ${FIXED_EMBEDDING_FINGERPRINT_INPUTS.length} 件を embed() した`,
  );

  const json: EmbeddingFingerprintRawJson = {
    status: "ok",
    detail: "embed() に成功した",
    embeddingSpace: { ...provider.space },
    inputs: [...FIXED_EMBEDDING_FINGERPRINT_INPUTS],
    vectors,
  };
  writeFileSync(jsonPath, `${JSON.stringify(json)}\n`, "utf-8");
  console.log(`\n[embedding-fingerprint] 機械可読な結果を書き出した: ${jsonPath}`);
}
