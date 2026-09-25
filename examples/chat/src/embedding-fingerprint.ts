import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
  LocalEmbeddingProvider,
} from "@mnemora/local-embedding";
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
 *
 * ## ランナー間比較への拡張（Issue #565、`.github/workflows/embedding-cross-runner-reproducibility.yml`）
 *
 * 上の4項目の測定を**複数の runner・`numThreads` の脚**へ広げるための最小の追加を
 * 3つ持つ:
 *
 * 1. `MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS`（任意の環境変数）が設定されていれば、
 *    `LocalEmbeddingProvider` の公開オプション `numThreads` へそのまま渡す。**未設定なら
 *    `DEFAULT_LOCAL_EMBEDDING_NUM_THREADS`（既定 `4`）を明示的に渡す**——渡す値は
 *    「渡さなかったとき」と同じ既定値になるため、既存ジョブ（`example-chat` /
 *    `root-gate-db-stage`）の挙動は変わらない。
 * 2. 実行時の node / `onnxruntime-node` / `@huggingface/transformers` の版
 *    （{@link resolveRuntimeVersions}）。
 * 3. `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` 配下の重みファイルすべての sha256
 *    （{@link digestWeightsDirectory}）——**全脚が同じ重みを読んだことを、宣言（cache
 *    key・revision の固定）だけでなく実測で示す**ため。
 *
 * ⛔ **この3つも門ではない。**読めなくても投げない——版が "unknown" になる、
 * `weightsDigest` が `null` になる、というだけで、embed() 本体の測定は続ける。
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

/** 実行時の node / onnxruntime-node / @huggingface/transformers の版。 */
export interface EmbeddingFingerprintRuntimeVersions {
  node: string;
  onnxruntimeNode: string;
  transformersJs: string;
}

/** `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` 配下の重みファイルの sha256 一式。 */
export interface EmbeddingFingerprintWeightsDigest {
  cacheDir: string;
  fileCount: number;
  /** 各ファイルの `{ relPath, sha256 }` を relPath 順に並べ、`\n` 連結した文字列の sha256。 */
  combinedSha256: string;
  files: { relPath: string; sha256: string; bytes: number }[];
}

/** `MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON` が書き出す、生ベクトルを含む中間形式。 */
export interface EmbeddingFingerprintRawJson {
  status: "ok" | "weights_unavailable";
  detail: string;
  embeddingSpace?: { provider: string; model: string; dimensions: number };
  inputs?: string[];
  vectors?: number[][];
  /** Issue #565 ランナー間比較への拡張。`LocalEmbeddingProvider` に実際に渡した numThreads。 */
  numThreads?: number;
  runtimeVersions?: EmbeddingFingerprintRuntimeVersions;
  /** `null` は「`MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` が未指定、または読めなかった」を表す。 */
  weightsDigest?: EmbeddingFingerprintWeightsDigest | null;
}

/** `LocalEmbeddingProvider.embed()` に渡すダミーの `Ctx`。DB を持たないためテナントの実在確認は無い。 */
const FINGERPRINT_CTX: Ctx = { tenantId: "embedding-fingerprint-565" };

/**
 * 実行時の node / `onnxruntime-node` / `@huggingface/transformers` の版を読む。
 *
 * ⚠ **`@huggingface/transformers` は `examples/chat` の直接の依存ではない**
 * （`@mnemora/local-embedding` の依存であり、`onnxruntime-node` はさらにその依存）。
 * ⟹ 標準の node 解決だけを使い、`@mnemora/local-embedding` 自身の `package.json`
 * を起点にする——`localEmbeddingPinnedRevision` が `scripts/` 側のファイルを
 * 相対パスで指すのと同じ形（`import.meta.url` からの相対パス、tsx のパスマッピングに
 * 依存しない）。
 *
 * ⛔ **読めなくても投げない。**この情報は測定の「文脈」であり、無くても embed()
 * の結果そのものは変わらない——読めなければ `"unknown"` を入れる（無いことを隠さない）。
 */
export function resolveRuntimeVersions(): EmbeddingFingerprintRuntimeVersions {
  const node = process.version;
  let transformersJs = "unknown";
  let onnxruntimeNode = "unknown";
  try {
    const localEmbeddingPackageJsonPath = fileURLToPath(
      new URL("../../../packages/local-embedding/package.json", import.meta.url),
    );
    const localEmbeddingReq = createRequire(localEmbeddingPackageJsonPath);
    const transformersEntry = localEmbeddingReq.resolve("@huggingface/transformers");
    const transformersReq = createRequire(transformersEntry);
    transformersJs = (transformersReq("../package.json") as { version: string }).version;
    onnxruntimeNode = (transformersReq("onnxruntime-node/package.json") as { version: string })
      .version;
  } catch (error) {
    console.error(
      "[embedding-fingerprint] 版の解決に失敗した（測定は続ける。'unknown' のままにする）: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { node, onnxruntimeNode, transformersJs };
}

/**
 * `cacheDir` 配下の全ファイルを再帰的に列挙し、各ファイルの sha256 と、それらをまとめた
 * `combinedSha256` を返す（Issue #565「全脚が同じ重みを読んだか」を実測で示すため）。
 *
 * ⛔ **`cacheDir` が未指定・存在しない・読めない場合は `null`。**「測っていない」を
 * 空のダイジェストで隠さない。
 *
 * ⭐ **HF の revision サブディレクトリの有無など、内部レイアウトの知識を持たない。**
 * `cacheDir` 以下に実在するファイルをそのまま全部拾う——`check-local-embedding-fingerprint.mjs`
 * の `collectActualFiles` と違い、期待されるパス空間との対応づけはしない（あちらは
 * Hugging Face の tree と照合する門、こちらは「同じ runner 間で同じバイト列だったか」
 * を見るだけの測定であり、パスの意味づけは要らない）。
 */
export function digestWeightsDirectory(
  cacheDir: string | undefined,
): EmbeddingFingerprintWeightsDigest | null {
  if (!cacheDir) {
    return null;
  }
  let entries: string[];
  try {
    entries = readdirSync(cacheDir, { recursive: true }) as string[];
  } catch (error) {
    console.error(
      `[embedding-fingerprint] weightsDigest: ${cacheDir} を読めなかった（測定は続ける）: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const files: { relPath: string; sha256: string; bytes: number }[] = [];
  for (const relPath of entries) {
    const absPath = `${cacheDir}/${relPath}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath);
    } catch {
      // ディレクトリ自体も readdirSync の結果に混ざる——読めなければファイルではない。
      continue;
    }
    files.push({
      relPath: relPath.split("\\").join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const combined = createHash("sha256");
  for (const file of files) {
    combined.update(`${file.relPath}\n${file.sha256}\n`);
  }
  return {
    cacheDir,
    fileCount: files.length,
    combinedSha256: combined.digest("hex"),
    files,
  };
}

export async function runEmbeddingFingerprint(): Promise<void> {
  const jsonPath = process.env.MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON;
  if (!jsonPath) {
    console.error("MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON が設定されていない——出力先が無い。");
    process.exitCode = 1;
    return;
  }

  const cacheDir = process.env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
  const numThreadsRaw = process.env.MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS;
  // ⚠ 未設定なら DEFAULT_LOCAL_EMBEDDING_NUM_THREADS を明示的に渡す——「渡さなかった
  // とき」と同じ既定値なので、既存ジョブの挙動は変わらない（Issue #565 拡張、上の
  // docstring 参照）。
  const numThreads = numThreadsRaw ? Number(numThreadsRaw) : DEFAULT_LOCAL_EMBEDDING_NUM_THREADS;
  if (numThreadsRaw !== undefined && (!Number.isInteger(numThreads) || numThreads < 1)) {
    console.error(
      `MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS が正の整数ではない: ${JSON.stringify(numThreadsRaw)}`,
    );
    process.exitCode = 1;
    return;
  }
  const provider = new LocalEmbeddingProvider({
    ...(cacheDir ? { cacheDir } : {}),
    revision: localEmbeddingPinnedRevision(),
    numThreads,
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
    numThreads,
    runtimeVersions: resolveRuntimeVersions(),
    weightsDigest: digestWeightsDirectory(cacheDir),
  };
  writeFileSync(jsonPath, `${JSON.stringify(json)}\n`, "utf-8");
  console.log(`\n[embedding-fingerprint] 機械可読な結果を書き出した: ${jsonPath}`);
}
