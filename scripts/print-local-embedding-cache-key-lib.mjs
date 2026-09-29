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
/**
 * 保存したキャッシュの**中身の形**の版（Issue #1004）。鍵の末尾に足す。
 *
 * 🔴 **revision は鍵に入っている（上の `sha`）のに、これが要る理由。** transformers.js（4.2.0）は、
 * `revision` を `main` 以外にすると、ファイルキャッシュを `<repo>/<revision>/<file>` の形で引く。
 * CI のキャッシュは、`revision` を渡す前（2026-09-21）に `<repo>/<file>` の形で保存されたまま、鍵が
 * 変わらないので保存し直されていなかった（`actions/cache` は鍵が当たると保存しない）。
 * ⟹ **中身の形が変わったら、この値を変えて保存し直させる。**
 *
 * ⚠ 2026-09-29 追記（Issue #1403、ADR 0365）: `revision-layout-1` から `revision-root-2` に上げた。
 * `@mnemora/local-embedding` は `revision` を渡されると、キャッシュの根を
 * `<cacheDir>/<encodeURIComponent(revision)>/` に分けて、その下に `<repo>/<file>` の形で置くようになった。
 * 古い形（`<repo>/<revision>/<file>`）のキャッシュが当たると、新しい形では読まれず、保存もし直されない。
 */
export const CACHE_LAYOUT_TAG = "revision-root-2";

export function buildCacheKeySuffix({ repo, dtype, sha }) {
  return `${slugForCacheKey(repo)}-${slugForCacheKey(dtype)}-${slugForCacheKey(sha)}-${CACHE_LAYOUT_TAG}`;
}
