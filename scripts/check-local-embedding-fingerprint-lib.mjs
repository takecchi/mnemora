/**
 * `scripts/check-local-embedding-fingerprint.mjs`（`@mnemora/local-embedding` が
 * 実際に読み込んだ重みファイルと、宣言された Hugging Face repo が「今まさに」
 * 持っているものを照合する CLI）の純関数の側。
 *
 * ファイル I/O・ネットワーク（`fetch`）・`process.argv`・`process.exit` を
 * 一切持たない——`scripts/ci-green-check-lib.mjs` と同じ分担・同じ理由である。
 * 判定ロジックをここへ切り出すことで、ネットワークもモデル取得も無しに
 * 単体試験できる（`scripts/__tests__/check-local-embedding-fingerprint-lib.test.mjs`）。
 *
 * ⭐ **この道具の設計の核心は「期待値をリポジトリに1つも焼き込まない」ことである。**
 * repo が今日更新されても、明日 CI が別の repo を宣言していても、この道具は
 * 常に「宣言された repo に今まさに問い合わせて」期待値を作る（CLI 側の役目）。
 * ここ（純関数の側）はハッシュそのものを1つも知らない——渡された `actual` /
 * `expectedByPath` を突き合わせるだけである。
 */

import { createHash } from "node:crypto";

/**
 * git の blob hash（`git hash-object` と同じ値）を hex で返す。
 *
 * `node:crypto` の `createHash` はここでは I/O ではなく純粋な計算として使っている
 * ——ネットワークにもファイルシステムにも触れない（Node 組み込みの暗号計算）ので、
 * このファイルが「純関数だけ」であるという前提を破らない。
 *
 * git の blob object は `"blob " + <バイト数の10進数文字列> + "\0" + <中身>` を
 * sha1 したものである（git 自身の object 形式。LFS を使わない小さいテキスト
 * ファイル——`config.json` 等——は Hugging Face の tree API でもこの値を返す）。
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {string} 40桁の hex
 */
export function gitBlobSha1Hex(bytes) {
  const header = `blob ${bytes.length}\0`;
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

/**
 * Hugging Face の tree API（`GET /api/models/<repo>/tree/main?recursive=1&expand=1`）
 * が返す1エントリから、期待される hash を取り出す。
 *
 * - `entry.lfs` が在れば、その実体は Git LFS 経由で管理されている大きいファイルであり、
 *   `entry.lfs.oid` が実体の **sha256** である（`entry.oid` は LFS ポインタファイル
 *   自身の git blob hash であり、実体のハッシュではないので使わない）。
 * - `entry.lfs` が無ければ、`entry.oid` がそのまま実体の **git blob sha1** である
 *   （小さいテキストファイルは LFS を通さず直接コミットされる）。
 * - どちらの oid も取れなければ（tree API の形が変わった等）`null` を返す
 *   ——呼び出し側はこれを「期待値が作れない」として扱う。
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
 * 手元に実在するファイルの hash と、HF の tree から作った期待値を突き合わせる。
 *
 * 🔴 **HF の tree に在るが手元に無いファイルは、不一致にしない。**
 * transformers.js（`@mnemora/local-embedding` が使う読み込み器）は、必要なファイル
 * だけを選んで取得する——たとえば `onnx/model.onnx`（fp32 の完全版）と
 * `onnx/model_quantized.onnx`（q8 量子化版）が両方 tree に在っても、
 * `dtype: "q8"` を指定していれば量子化版しか落ちてこない。**tree 全件が手元に揃う
 * ことは設計上ありえない**——「揃っていない」を「不一致」として扱うと、この道具は
 * 正常な実行のたびに赤くなる歯になってしまう。だから `unknownOnDisk`
 * （逆方向。手元に在るのに tree に無い＝素性の分からないファイル）だけを見る。
 *
 * ⭐ **`verdict` は `"match"` / `"mismatch"` の2値しか持たない（`"undetermined"` は
 * 無い）。** これはこのファイルが純関数だけの側であることの直接の帰結である——
 * 「判定できない」が意味を持つのは、この道具が**ネットワークに問い合わせようとして
 * 失敗した**とき（HF の tree API に3回試しても届かなかった）だけであり、それは
 * I/O の失敗であって、`actual` と `expectedByPath` という**すでに揃ったデータ同士**の
 * 突き合わせの話ではない。⟹ `undetermined` は
 * `scripts/check-local-embedding-fingerprint.mjs`（CLI 側）が HF API 到達失敗の
 * ときにだけ名乗る状態であり、この関数の戻り値には現れない。**この関数に来た時点で
 * 「問い合わせは成功した」ことが前提であり、あとは「一致したか・していないか」の
 * 二択しか無い。**
 *
 * 🔴 **`actual` が空（手元に検査対象のファイルが1本も無い）は `"mismatch"` である。**
 * この道具は CI の門として使う——CI ではモデルのキャッシュ鍵が存在する以上、
 * `<cacheDir>/<repo>/` にファイルが1本も無いこと自体が設定の壊れであり、
 * 「判定を保留する」のではなく「赤」として扱う（依頼者の決定）。
 *
 * @param {{ actual: { path: string, algorithm: string, hex: string }[], expectedByPath: Map<string, { algorithm: string, hex: string }> }} params
 *   `actual` は手元に実在したファイル（`path` は repo 内の相対パス。例
 *   `onnx/model_quantized.onnx`）。`expectedByPath` は HF の tree から作った
 *   `expectedHashOfTreeEntry` の結果の集まり。
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
      // 手元に在るのに HF の tree に無い——素性が分からないファイル。
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

  // `actual` が空＝手元に1本もファイルが無い＝赤（上の docstring 参照）。
  const verdict =
    actual.length === 0 || mismatched.length > 0 || unknownOnDisk.length > 0 ? "mismatch" : "match";

  return { verdict, matched, mismatched, unknownOnDisk };
}

/**
 * `compareFingerprints` の結果を人が読める日本語の報告文字列にする。
 *
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
    // `actual` が空だったケース（`compareFingerprints` の docstring 参照）。
    // 個別の食い違いが無いので、その旨を名指しする。
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
