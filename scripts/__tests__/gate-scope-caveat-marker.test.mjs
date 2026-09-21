import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/check-publish-pack.mjs` と `scripts/check-pr-adr-reference.mjs` は、
 * ADR 0255「名乗れないものを道具に名乗らせない」への反例として ADR 0255 自身が
 * 名指しした2本である（決定5「測ったこと」2節）。ADR 0259 が両方の実行時出力へ
 * 断りを焼いたが、**2本のあいだで共有モジュールは作らない**（`scripts/check-publish-pack.mjs`
 * の冒頭バナー — `docs/release-v1.md:1119` が行番号で引用している 109〜131行目 — より
 * 上に import を1行も足せないため。ADR 0259「決定D」）。
 *
 * その代わりに、**マーカー行だけを逐語で揃える**（`grep` で横断できるように。
 * ADR 0259「決定C」）。この歯は、2本のソースにそれぞれ持たせた
 * `SCOPE_CAVEAT_MARKER` 定数の行が、実際に文字単位で一致していることを固定する
 * ——揃える約束をコードのコメントだけに置くと、どちらか一方だけを直したときに
 * 気づけない。
 *
 * ⚠ ここでは各スクリプトのソーステキストを読むだけで、実行時出力そのものは見ていない
 * ——実行時出力に実際にこのマーカーが出ることは
 * `scripts/__tests__/check-publish-pack.test.mjs` と
 * `scripts/__tests__/check-pr-adr-reference.test.mjs` が別途、本物の起動で測っている。
 * この歯が測るのは「2本の*文言*が揃っているか」だけである。
 */

const MARKER_LINE_RE = /^const SCOPE_CAVEAT_MARKER = (".*");$/m;

function extractMarkerLiteral(scriptRelativePath) {
  const text = readFileSync(
    fileURLToPath(new URL(`../${scriptRelativePath}`, import.meta.url)),
    "utf8",
  );
  const match = text.match(MARKER_LINE_RE);
  if (!match) {
    throw new Error(`${scriptRelativePath} に SCOPE_CAVEAT_MARKER の定義が見つかりません`);
  }
  // ソースから取り出した文字列リテラルは二重引用符のみで特殊なエスケープを含まないので、
  // JSON の文字列としてそのままパースできる（`eval` を避ける）。
  return JSON.parse(match[1]);
}

describe("check-publish-pack.mjs と check-pr-adr-reference.mjs の SCOPE_CAVEAT_MARKER が逐語で一致する", () => {
  it("マーカー文字列が完全に同一である", () => {
    const publishPackMarker = extractMarkerLiteral("check-publish-pack.mjs");
    const prAdrReferenceMarker = extractMarkerLiteral("check-pr-adr-reference.mjs");

    expect(publishPackMarker).toBe("⚠ この門が見ていない範囲:");
    expect(prAdrReferenceMarker).toBe("⚠ この門が見ていない範囲:");
    expect(publishPackMarker).toBe(prAdrReferenceMarker);
  });
});
