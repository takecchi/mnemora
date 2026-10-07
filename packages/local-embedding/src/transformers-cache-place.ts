/**
 * 既定の `createPipeline` が最後に読み込んだときの `env.cacheDir`。
 * パッケージマネージャの配置で場所が変わるので、決め打ちせず transformers.js が解決した値を持つ。
 */
let lastCacheDir: string | undefined;

/** 既定の `createPipeline` が、transformers.js を読み込んだ直後に呼ぶ。 */
export function recordTransformersCacheDir(cacheDir: unknown): void {
  lastCacheDir = typeof cacheDir === "string" && cacheDir !== "" ? cacheDir : undefined;
}

/** 記録した `env.cacheDir`。まだ読み込んでいない・置き場が無いなら `undefined`。 */
export function lastTransformersCacheDir(): string | undefined {
  return lastCacheDir;
}

/**
 * `revision` を渡したときのキャッシュの根 `<基の根>/<encodeURIComponent(revision)>`。
 *
 * 根を revision ごとに分ける理由: 既定の `createPipeline` は `revision` を `env.remotePathTemplate` へ
 * 埋め込むため、transformers.js はキャッシュを `main` と同じ鍵で引く。分けないと、`revision` 無しで
 * 温めた中身が固定 revision の中身として黙って読まれる。
 * `encodeURIComponent` は枝名の `/` でディレクトリが掘られないようにするため。
 */
export function revisionCacheRoot(baseCacheDir: string, revision: string): string {
  return `${baseCacheDir.replace(/[\\/]+$/, "")}/${encodeURIComponent(revision)}`;
}
