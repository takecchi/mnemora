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
 * `scripts/` ではなくここにある理由: `scripts/*.mjs` は plain `node` で動き、`@mnemora/local-embedding` の TS ソースを
 * import できない（`exports` は `dist` だけを指す）。`embed()` を呼ぶ部分だけここに置き、モデルに依存しない計算は `scripts/` 側の純関数にある。
 *
 * 門ではない。実測値を書くだけで、読めなくても投げない（版は "unknown"、`weightsDigest` は `null`）。
 * DB には触れない。`revision` は `providers.ts` と同じ `localEmbeddingPinnedRevision()` を渡す。
 * 渡さないと、同じキャッシュディレクトリにフラット配置と revision 配置が同居する。
 */

export const FIXED_EMBEDDING_FINGERPRINT_INPUTS: readonly string[] = Object.freeze([
  "朝食にパンを食べた。",
  "東京タワーは港区にある。",
  "コーヒーより紅茶が好き。",
]);

export interface EmbeddingFingerprintRuntimeVersions {
  node: string;
  onnxruntimeNode: string;
  transformersJs: string;
}

export interface EmbeddingFingerprintWeightsDigest {
  cacheDir: string;
  fileCount: number;
  combinedSha256: string;
  files: { relPath: string; sha256: string; bytes: number }[];
}

export interface EmbeddingFingerprintRawJson {
  status: "ok" | "weights_unavailable";
  detail: string;
  embeddingSpace?: { provider: string; model: string; dimensions: number };
  inputs?: string[];
  vectors?: number[][];
  numThreads?: number;
  runtimeVersions?: EmbeddingFingerprintRuntimeVersions;
  /** `null` は「`MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` が未指定、または読めなかった」を表す。 */
  weightsDigest?: EmbeddingFingerprintWeightsDigest | null;
}

const FINGERPRINT_CTX: Ctx = { tenantId: "embedding-fingerprint-565" };

/**
 * 実行時の node / `onnxruntime-node` / `@huggingface/transformers` の版を読む。
 *
 * `@huggingface/transformers` は `examples/chat` の直接の依存ではないので、`@mnemora/local-embedding` 自身の
 * `package.json` を起点に解決する。読めなくても投げず `"unknown"` を入れる（無いことを隠さない）。
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
 * `cacheDir` 配下の全ファイルの sha256 と、それらをまとめた `combinedSha256` を返す。
 * 未指定・存在しない・読めない場合は `null`（「測っていない」を空のダイジェストで隠さない）。
 * HF の内部レイアウトは知らず、実在するファイルをそのまま拾う（期待パスとの照合はしない）。
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

  // warmup() は推論しない——embed() を明示的に呼ぶ。
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
