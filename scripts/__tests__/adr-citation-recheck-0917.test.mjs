import { describe, expect, it } from "vitest";
import {
  anchorExistsInTarget,
  findAdrAnchorCitations,
  findAdrLineNumberCitations,
} from "../adr-citation-lib.mjs";

/**
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G7 のうち、PR #469（ADR 0213）の検出器
 * （`adr-citation-lib.mjs`）に変異を当てて見つかった「すり抜け」だけを固定する歯。
 * 各 `it` の名前の記号（A4・B1b など）は、Issue #1812 のコメントの変異表の番号である。
 *
 * ⚠ 検出器は「見つけたもの全部」を返す純関数なので、ここでも文字列を渡して返り値を見るだけにする
 * （実物の文書は読まない。実物を見る歯は `adr-citation.test.mjs` にある）。
 */

describe("findAdrLineNumberCitations（書き方の一族の取りこぼし・過検出）", () => {
  it("A4: adr-comma-line 形は半角のカンマでも拾う", () => {
    const hits = findAdrLineNumberCitations("詳細は ADR 0067, 124-130行 を見ること。");
    expect(hits.map((h) => [h.kind, h.adrNumber])).toEqual([["adr-comma-line", "0067"]]);
  });

  it.each(["〜", "~"])("A4c: adr-comma-line 形は範囲の記号 %s でも拾う", (dash) => {
    const hits = findAdrLineNumberCitations(`詳細は ADR 0067、124${dash}130行 を見ること。`);
    expect(hits.map((h) => [h.kind, h.adrNumber])).toEqual([["adr-comma-line", "0067"]]);
  });

  it.each([
    ["全角の括弧", "ADR 0030（`:29-37`）"],
    ["半角の括弧", "ADR 0030(`:29-37`)"],
  ])("A5: adr-paren-colon 形は%sでも拾う", (_label, text) => {
    const hits = findAdrLineNumberCitations(text);
    expect(hits.map((h) => [h.kind, h.adrNumber])).toEqual([["adr-paren-colon", "0030"]]);
  });

  it("A5b: 括弧の中がコロンの無い数字だけなら、行番号引用として拾わない", () => {
    expect(findAdrLineNumberCitations("ADR 0030（`12`）の件数")).toEqual([]);
  });

  it("A6b: markdown リンクと `:NN` の間に文が挟まっていれば、md-link-colon 形として拾わない", () => {
    const text =
      "[ADR 0172](./decisions/0172-x.md) は別の話をしていて、ここでは `:249` という値を使う";
    expect(findAdrLineNumberCitations(text)).toEqual([]);
  });

  it("A7: omitted-reference 形は「同ファイル」でも、直前の ADR を指すものとして拾う", () => {
    const hits = findAdrLineNumberCitations(
      "ADR 0067 を読むと、同ファイル `:12-14` に書いてある。",
    );
    expect(hits.map((h) => [h.kind, h.adrNumber])).toEqual([["omitted-reference", "0067"]]);
  });

  it("A9: 間にソースファイルへの言及が挟まれば、その後の「同ファイル」は ADR 引用として数えない", () => {
    const text = "ADR 0067 の説明。`packages/core/src/runtime.ts` では、同ファイル `:12` を見る。";
    expect(findAdrLineNumberCitations(text)).toEqual([]);
  });

  it("A12・A12b: omitted-reference 形は、直前の言及のうち最も近いものを指す（素の「ADR NNNN」も言及に数える）", () => {
    const hits = findAdrLineNumberCitations("ADR 0067 と ADR 0070 を比べると、同 `:12` に在る。");
    expect(hits.map((h) => [h.kind, h.adrNumber])).toEqual([["omitted-reference", "0070"]]);
  });
});

describe("findAdrAnchorCitations / anchorExistsInTarget（線引きと境界）", () => {
  it("B1b: 「ADR NNNN」と「…」の間は30字まで拾い、31字なら拾わない（窓は30字）", () => {
    const gap30 = "あ".repeat(30);
    const gap31 = "あ".repeat(31);
    expect(findAdrAnchorCitations(`ADR 0067${gap30}「アンカー」`)).toHaveLength(1);
    expect(findAdrAnchorCitations(`ADR 0067${gap31}「アンカー」`)).toEqual([]);
  });

  it("B1d: 改行をまたぐ「…」は、窓の内側でも拾わない", () => {
    expect(findAdrAnchorCitations("ADR 0067\n「アンカー」")).toEqual([]);
    expect(findAdrAnchorCitations("ADR 0067 の\n続き「アンカー」")).toEqual([]);
  });

  it("B3: 空の引用は実在しない（空文字列はどの文字列にも含まれるが、実在の証拠にならない）", () => {
    expect(anchorExistsInTarget("", "何かの本文")).toBe(false);
  });

  it("B7: 末尾の索引を外した形は、外した後の全体が引用先に在るときだけ実在とみなす（前方2字の一致では足りない）", () => {
    expect(anchorExistsInTarget("引き受けた負債9", "引き受けたい気持ちの話")).toBe(false);
    expect(anchorExistsInTarget("引き受けた負債9", "## 引き受けた負債\n- 1つ目")).toBe(true);
  });
});
