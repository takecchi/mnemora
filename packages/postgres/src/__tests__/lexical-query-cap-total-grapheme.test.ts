import { describe, expect, it } from "vitest";
import { LEXICAL_QUERY_MAX_TOTAL_CHARS, capLexicalQueryTotalChars } from "../lexical-query-cap.js";

const MAX = LEXICAL_QUERY_MAX_TOTAL_CHARS;

const SURROGATE_PAIR = "😀";
const COMBINING_SEQUENCE = "é";
const KANA_WITH_COMBINING_VOICED_MARK = "が";
const FAMILY_ZWJ_SEQUENCE = "👨\u200D👩\u200D👧";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeEnds(text: string): Set<number> {
  const ends = new Set<number>([0]);
  for (const { segment, index } of segmenter.segment(text)) {
    ends.add(index + segment.length);
  }
  return ends;
}

function queryWithUnitStartingAt(unit: string, startOffset: number): string {
  return "a".repeat(startOffset) + unit + "b".repeat(50);
}

const straddlingInputs: ReadonlyArray<readonly [string, string]> = [
  [
    "サロゲートペア（絵文字）が599と600にまたがる",
    queryWithUnitStartingAt(SURROGATE_PAIR, MAX - 1),
  ],
  ["結合文字が基底の直後、境目をまたぐ", queryWithUnitStartingAt(COMBINING_SEQUENCE, MAX - 1)],
  [
    "かな＋結合濁点が境目をまたぐ",
    queryWithUnitStartingAt(KANA_WITH_COMBINING_VOICED_MARK, MAX - 1),
  ],
  ["ZWJ の絵文字列が境目の手前から始まる", queryWithUnitStartingAt(FAMILY_ZWJ_SEQUENCE, MAX - 3)],
  [
    "ZWJ の絵文字列が境目のすぐ内側（先頭の絵文字の途中）で切れる",
    queryWithUnitStartingAt(FAMILY_ZWJ_SEQUENCE, MAX - 1),
  ],
  [
    "ZWJ の絵文字列が境目の少し手前から始まり、ZWJ の直前で切れる",
    queryWithUnitStartingAt(FAMILY_ZWJ_SEQUENCE, MAX - 2),
  ],
];

describe("capLexicalQueryTotalChars: 境目に書記素が来る入力", () => {
  it.each(straddlingInputs)(
    "%s: 前提として、素朴な切り方だと境目で割れる入力である",
    (_name, query) => {
      expect(query.length).toBeGreaterThan(MAX);
      expect(graphemeEnds(query).has(MAX)).toBe(false);
    },
  );

  it.each(straddlingInputs)("%s: 孤立サロゲートを残さない", (_name, query) => {
    expect(capLexicalQueryTotalChars(query)).not.toMatch(/\p{Surrogate}/u);
  });

  it.each(straddlingInputs)("%s: 書記素を割らず、入力の書記素の境界で終わる", (_name, query) => {
    const capped = capLexicalQueryTotalChars(query);
    expect(graphemeEnds(query).has(capped.length)).toBe(true);
  });

  it.each(straddlingInputs)("%s: 上限以下に収まり、入力の先頭部分である", (_name, query) => {
    const capped = capLexicalQueryTotalChars(query);
    expect(capped.length).toBeLessThanOrEqual(MAX);
    expect(query.startsWith(capped)).toBe(true);
  });

  it.each(straddlingInputs)("%s: 境目の手前の書記素は削らない", (_name, query) => {
    const capped = capLexicalQueryTotalChars(query);
    const firstStraddlingStart = [...graphemeEnds(query)].filter((end) => end <= MAX).at(-1) ?? 0;
    expect(capped.length).toBe(firstStraddlingStart);
  });
});

describe("capLexicalQueryTotalChars: 境目に当たらない入力は今までどおり", () => {
  it("絵文字がちょうど上限で終わるなら、そのまま残す", () => {
    const query = "a".repeat(MAX - SURROGATE_PAIR.length) + SURROGATE_PAIR + "b";
    const capped = capLexicalQueryTotalChars(query);
    expect(capped).toBe("a".repeat(MAX - SURROGATE_PAIR.length) + SURROGATE_PAIR);
    expect(capped).toHaveLength(MAX);
  });

  it("ちょうど上限の長さで絵文字を含む入力は1文字も変えない", () => {
    const query = "a".repeat(MAX - SURROGATE_PAIR.length) + SURROGATE_PAIR;
    expect(capLexicalQueryTotalChars(query)).toBe(query);
  });

  it("上限より短い入力は1文字も変えない", () => {
    const query = `検索 ${FAMILY_ZWJ_SEQUENCE} ${COMBINING_SEQUENCE}`;
    expect(capLexicalQueryTotalChars(query)).toBe(query);
  });

  it("結合文字の書記素がちょうど上限で終わるなら、そのまま残す", () => {
    const query = "a".repeat(MAX - COMBINING_SEQUENCE.length) + COMBINING_SEQUENCE + "b";
    expect(capLexicalQueryTotalChars(query)).toBe(
      "a".repeat(MAX - COMBINING_SEQUENCE.length) + COMBINING_SEQUENCE,
    );
  });
});

// 再確かめ（2026-10-07 マージ分、#1870）。先頭の書記素だけで上限を超えるときは、割った断片を残さず空にする
// （core の `sliceAtGraphemeBoundary` の約束。この関数は写し）。上限ちょうどで素朴に切る形へ戻ると、
// 結合記号の途中で割れた断片が残る。
describe("capLexicalQueryTotalChars: 先頭の書記素だけで上限を超える入力", () => {
  it("書記素を割った断片を残さず、空文字列にする", () => {
    const query = "e" + "́".repeat(MAX + 50) + " tail";
    expect(graphemeEnds(query).has(MAX)).toBe(false);
    expect(capLexicalQueryTotalChars(query)).toBe("");
  });
});
