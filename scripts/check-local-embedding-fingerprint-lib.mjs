/**
 * ⛔ 期待値をリポジトリに焼き込まない。この純関数の側はハッシュそのものを1つも知らず、渡された `actual` / `expectedByPath` を突き合わせるだけ。
 * 期待値は CLI 側が、宣言された repo に今問い合わせて作る。
 * ファイル I/O・ネットワーク・`process.argv`・`process.exit` を持たない(モデル取得無しに単体試験できる)。
 */

import { createHash } from "node:crypto";

/**
 * `node:crypto` の `createHash` は純粋な計算で、I/O ではない。
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {string}
 */
export function gitBlobSha1Hex(bytes) {
  const header = `blob ${bytes.length}\0`;
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

/**
 * ⚠ `entry.lfs` が在れば `entry.lfs.oid`(実体の sha256)を使う。`entry.oid` は LFS ポインタファイル自身の blob hash なので使わない。
 * 無ければ `entry.oid`(git blob sha1)。どちらも取れなければ `null`(呼び出し側が「期待値が作れない」として扱う)。
 *
 * @param {{ oid?: string, lfs?: { oid?: string } }} entry
 * @returns {{ algorithm: "sha256" | "git-blob-sha1", hex: string } | null}
 */
export function expectedHashOfTreeEntry(entry) {
  if (entry?.lfs?.oid) {
    return { algorithm: "sha256", hex: entry.lfs.oid };
  }
  if (entry?.oid) {
    return { algorithm: "git-blob-sha1", hex: entry.oid };
  }
  return null;
}

/**
 * 🔴 `revision` が `"main"` 以外だと、`@huggingface/transformers` の `FileCache` は `<repo>/<revision>/<filename>` とサブディレクトリに置く。
 * 正規化しないと、手元にファイルが在るのに「素性不明」として不一致になる。
 * 🔴 照合する対象は変えない(`main` の tree と照合し続ける)。変えるのは、手元のファイルと tree のパスの対応という解釈だけ。
 * ⚠ `pinnedRevision` が無い(宣言が読めない)ときは何もしない。追加のフォールバックで、無くても動く形を壊さない。
 *
 * @param {string} relPath
 * @param {string | null} pinnedRevision
 * @returns {string}
 */
export function normalizeActualPath(relPath, pinnedRevision) {
  if (!pinnedRevision) {
    return relPath;
  }
  const prefix = `${pinnedRevision}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

/**
 * ⚠ CI では `revision` を渡すステップと渡さないステップが同じキャッシュを使うので、両方が並ぶ。`pinnedRevision` が無いなら前者だけを返す。
 * `<cacheDir>/<encodeURIComponent(revision)>/<repo>` の形は mnemora が決めたもので、transformers.js の内部の鍵の形ではない(`transformers-cache-place.ts` の `revisionCacheRoot`)。
 *
 * @param {string} cacheDir
 * @param {string} repo
 * @param {string | null} pinnedRevision
 * @returns {string[]}
 */
export function cacheRepoDirs(cacheDir, repo, pinnedRevision) {
  const base = cacheDir.replace(/[\\/]+$/, "");
  const dirs = [`${base}/${repo}`];
  if (pinnedRevision) {
    dirs.push(`${base}/${encodeURIComponent(pinnedRevision)}/${repo}`);
  }
  return dirs;
}

/**
 * 🔴 HF の tree に在って手元に無いファイルは不一致にしない。読み込み器は必要なファイルだけを取得する(例: `dtype: "q8"` なら量子化版しか落ちてこない)ので、tree 全件が手元に揃うことは無い。
 * 不一致にすると、正常な実行のたびに赤くなる。見るのは `unknownOnDisk`(手元に在るのに tree に無い)だけ。
 *
 * ⛔ `verdict` は `"match"` / `"mismatch"` の2値で、`"undetermined"` は無い。判定不能は HF API に届かなかったときに CLI 側だけが名乗る。
 *
 * 🔴 `actual` が空(手元に検査対象が1本も無い)は `"mismatch"`。CI の門で、キャッシュ鍵が在るのにファイルが無いのは設定の壊れなので、保留ではなく赤にする。
 *
 * @param {{ actual: { path: string, algorithm: string, hex: string }[], expectedByPath: Map<string, { algorithm: string, hex: string }> }} params
 * @returns {{
 *   verdict: "match" | "mismatch",
 *   matched: string[],
 *   mismatched: { path: string, expected: { algorithm: string, hex: string }, actual: { algorithm: string, hex: string } }[],
 *   unknownOnDisk: string[],
 * }}
 */
export function compareFingerprints({ actual, expectedByPath }) {
  const matched = [];
  const mismatched = [];
  const unknownOnDisk = [];

  for (const file of actual) {
    const expected = expectedByPath.get(file.path);
    if (!expected) {
      unknownOnDisk.push(file.path);
      continue;
    }
    if (expected.algorithm === file.algorithm && expected.hex === file.hex) {
      matched.push(file.path);
    } else {
      mismatched.push({
        path: file.path,
        expected: { algorithm: expected.algorithm, hex: expected.hex },
        actual: { algorithm: file.algorithm, hex: file.hex },
      });
    }
  }

  const verdict =
    actual.length === 0 || mismatched.length > 0 || unknownOnDisk.length > 0 ? "mismatch" : "match";

  return { verdict, matched, mismatched, unknownOnDisk };
}

/**
 * @param {ReturnType<typeof compareFingerprints>} result
 * @returns {string}
 */
export function formatFingerprintReport(result) {
  const lines = [];

  if (result.verdict === "match") {
    lines.push(
      `一致: 手元の ${result.matched.length} 本すべてが宣言された repo の内容と一致した。`,
    );
    return lines.join("\n");
  }

  if (
    result.matched.length === 0 &&
    result.mismatched.length === 0 &&
    result.unknownOnDisk.length === 0
  ) {
    lines.push(
      "不一致: 手元に検査対象のファイルが1本も無い——" +
        "キャッシュの場所やモデル未取得を疑うこと。",
    );
    return lines.join("\n");
  }

  lines.push(
    `不一致: 一致 ${result.matched.length} 本 / hash 食い違い ${result.mismatched.length} 本 / ` +
      `素性不明 ${result.unknownOnDisk.length} 本。`,
  );
  for (const item of result.mismatched) {
    lines.push(
      `  hash 食い違い: ${item.path}\n` +
        `    期待 (${item.expected.algorithm}): ${item.expected.hex}\n` +
        `    実物 (${item.actual.algorithm}): ${item.actual.hex}`,
    );
  }
  for (const path of result.unknownOnDisk) {
    lines.push(`  素性不明（HF の tree に無い）: ${path}`);
  }
  return lines.join("\n");
}
