/**
 * 🔴 この分離は体裁のためではない。CLI 側はモジュール末尾で `main()` を起動するので、純関数を取り出すために
 * CLI を `import` すると、その時点で CLI が走って `process.exit` を呼ぶ。歯はこちらを import する。
 */

/**
 * ⚠ 鍵の一意性のためではなく、読めるようにするため。
 *
 * @param {string} value
 */
export function slugForCacheKey(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * 🔴 鍵全体ではなく接尾辞だけを組み立てる。`ci.yml` は `key: local-embedding-${{...}}` と書く。
 * ⛔ 接頭辞を式の中へ入れない。`ci-yml-local-embedding-cache-wiring.test.mjs` が cache 段を
 * `key:` が `local-embedding` で始まることで見分けており、`key:` が式になると段を見つけられなくなる。
 *
 * @param {{ repo: string, dtype: string, sha: string }} parts
 */
/**
 * 🔴 revision は鍵に入っているのに、キャッシュの中身の形の版が別に要る。鍵が当たると `actions/cache` は保存し直さないので、
 * 中身の形が変わったら、この値を変えて保存し直させる。
 */
export const CACHE_LAYOUT_TAG = "revision-root-2";

export function buildCacheKeySuffix({ repo, dtype, sha }) {
  return `${slugForCacheKey(repo)}-${slugForCacheKey(dtype)}-${slugForCacheKey(sha)}-${CACHE_LAYOUT_TAG}`;
}
