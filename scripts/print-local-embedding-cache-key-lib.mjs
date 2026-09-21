/**
 * `scripts/print-local-embedding-cache-key.mjs`（CI のモデルキャッシュ鍵を決める CLI）の
 * 純関数の側（Issue #564 / ADR 0263）。
 *
 * ファイル I/O・ネットワーク（`fetch`）・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/check-local-embedding-fingerprint-lib.mjs` /
 * `scripts/ci-green-check-lib.mjs` と同じ分担・同じ理由である。
 *
 * 🔴 **この分離は、体裁のためではない。** CLI 側はモジュールの末尾で `main()` を
 * 起動するので、**純関数を取り出すために CLI を `import` すると、その時点で CLI が
 * 走って `process.exit` を呼ぶ。** 【実測 2026-09-21】実際にそうして CI を落とした
 * （`Error: process.exit unexpectedly called with "0"`）。⟹ **歯はこちらを import する。**
 */

/**
 * 鍵に使える形へ均す。`/` を含む repo 名がそのままだと読みにくいので `-` にする。
 *
 * ⚠ **鍵の一意性のためではない**（`a/b` と `a-b` を同じ鍵に潰すが、そのような衝突が
 * 起きる repo 名は実在しない）。**読めるようにするためである。**
 *
 * @param {string} value
 */
export function slugForCacheKey(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * 鍵の**接尾辞**を組み立てる。
 *
 * 🔴 **なぜ鍵全体ではなく接尾辞か。** `ci.yml` 側が
 * `key: local-embedding-${{steps.….outputs.key}}` と書く形にしてある。
 * ⛔ **接頭辞を式の中へ入れてはならない**——
 * `scripts/__tests__/ci-yml-local-embedding-cache-wiring.test.mjs` が逐語で
 * 「**cache 段は `key:` が `local-embedding` で始まることで見分ける。⛔ `path:` では
 * 見分けない**」と宣言しており、**`key:` が式になるとその歯が段を見つけられなくなる**
 * （【実測】実際にそうして6本落とした）。⟹ **接頭辞は yml のリテラルとして残す。**
 *
 * @param {{ repo: string, dtype: string, sha: string }} parts
 */
export function buildCacheKeySuffix({ repo, dtype, sha }) {
  return `${slugForCacheKey(repo)}-${slugForCacheKey(dtype)}-${slugForCacheKey(sha)}`;
}
