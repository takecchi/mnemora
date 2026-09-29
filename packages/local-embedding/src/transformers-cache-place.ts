/**
 * 既定の `createPipeline`（`createLocalEmbeddingPipeline`）が、最後に transformers.js を読み込んだときの
 * `env.cacheDir`——`cacheDir` を省いたときに、重みが実際に置かれる場所。
 *
 * 読み込みに失敗したときのメッセージが、消せば取り直す場所を名指すために使う。場所は
 * パッケージマネージャの配置で変わる（npm なら `node_modules/@huggingface/transformers/.cache/`、
 * pnpm なら `node_modules/.pnpm/@huggingface+transformers@<版>/node_modules/@huggingface/transformers/.cache/`）
 * ので、決め打ちせず transformers.js が解決した値を持つ。
 *
 * ⚠ **公開 API ではない。**`index.ts` から export しないこと。
 */
let lastCacheDir: string | undefined;

/** 既定の `createPipeline` が、transformers.js を読み込んだ直後に呼ぶ。 */
export function recordTransformersCacheDir(cacheDir: unknown): void {
  // `env.cacheDir` は、ファイルの置き場を持たない環境では `null` になる（transformers.js の `env.js`）。
  lastCacheDir = typeof cacheDir === "string" && cacheDir !== "" ? cacheDir : undefined;
}

/** 記録した `env.cacheDir`。まだ読み込んでいない・置き場が無いなら `undefined`。 */
export function lastTransformersCacheDir(): string | undefined {
  return lastCacheDir;
}

/**
 * `revision` を渡したときのキャッシュの根——`<基の根>/<encodeURIComponent(revision)>`（Issue #1403・ADR 0365）。
 *
 * 基の根は、`cacheDir` を渡していればそれ、渡していなければ transformers.js の既定のキャッシュ
 * （`env.cacheDir`）である。`cacheDir` の有無で振る舞いを分けない。
 *
 * 🔴 **なぜ根を revision ごとに分けるか。**既定の `createPipeline` は、`revision` を `pipeline()` に渡す
 * 代わりに `env.remotePathTemplate` へ埋め込む（`pipeline.ts`）。そのため transformers.js はキャッシュを
 * `main` と同じ `<repo>/<file>` の鍵で引く。根を分けないと、`revision` 無しで温めた中身が、固定した
 * revision の中身として黙って読まれる。
 *
 * ⚠ この根の形は mnemora が決めたものであり、transformers.js の内部の鍵の形ではない。
 * `encodeURIComponent` にするのは、枝名の `/` などでディレクトリが掘られないようにするため。
 */
export function revisionCacheRoot(baseCacheDir: string, revision: string): string {
  return `${baseCacheDir.replace(/[\\/]+$/, "")}/${encodeURIComponent(revision)}`;
}
