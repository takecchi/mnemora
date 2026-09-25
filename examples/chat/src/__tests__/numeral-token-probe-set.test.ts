import { describe, expect, it } from "vitest";
import {
  DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE,
  NUMERAL_TOKEN_PROBES,
  NUMERAL_TOKEN_TOPIC_KEYWORDS,
  buildNumeralTokenProbeSetConversation,
  findNumeralTokenTopicKeywordViolations,
} from "../numeral-token-probe-set.js";

/**
 * 数詞・記号索引 probe set 自体の整合性(DB もネットワークも要らない)。ADR 0135。
 *
 * ⚠ **これらの歯は「引けること」を一切要求していない**(`japanese-name-probe-set.test.ts`
 * と同じ理由)。この集合は「文字種×共有前置長でmarginがどう分布するかを観測する」ために
 * 置いたものであり、順位を主張する歯を置くと実測が悪かったときに `main` が恒久的に
 * 赤くなる。ここで測るのは**集合の形**(件数・行列の被覆・重複・衝突・query の形)だけ。
 * 順位・margin は `numeral-token-probes` が値として記録し、基準値との差は Job Summary に
 * 出る——⛔ 門にはしない。
 */
describe("numeral-token-probe-set", () => {
  it("文字種3×共有前置長3=9セルを、セルあたり2件(合計18件)で覆っている(ADR 0135 §5.1・§5.4)", () => {
    expect(NUMERAL_TOKEN_PROBES).toHaveLength(18);
    const cellCounts = new Map<string, number>();
    for (const probe of NUMERAL_TOKEN_PROBES) {
      cellCounts.set(probe.category, (cellCounts.get(probe.category) ?? 0) + 1);
    }
    const expectedCells = [
      "kanji-long",
      "kanji-medium",
      "kanji-short",
      "arabic-long",
      "arabic-medium",
      "arabic-short",
      "alpha-long",
      "alpha-medium",
      "alpha-short",
    ];
    expect(new Set(cellCounts.keys())).toEqual(new Set(expectedCells));
    for (const cell of expectedCells) {
      expect(cellCounts.get(cell), `セル${cell}の件数`).toBe(2);
    }
  });

  it("category は charKind と prefixLength から機械的に決まる", () => {
    for (const probe of NUMERAL_TOKEN_PROBES) {
      expect(probe.category).toBe(`${probe.charKind}-${probe.prefixLength}`);
    }
  });

  it("probe id は重複しない", () => {
    const ids = NUMERAL_TOKEN_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は索引そのものを含む(識別子集合・日本語固有名詞集合と同じ狙い)", () => {
    for (const probe of NUMERAL_TOKEN_PROBES) {
      const keywords = NUMERAL_TOKEN_TOPIC_KEYWORDS[probe.id] ?? [];
      const [goldKeyword] = keywords;
      expect(goldKeyword, `${probe.id} の gold keyword`).toBeDefined();
      expect(probe.query.includes(goldKeyword!)).toBe(true);
      expect(probe.fact.includes(goldKeyword!)).toBe(true);
    }
  });

  it("distractor は gold と語幹を共有し、索引だけが違う", () => {
    for (const probe of NUMERAL_TOKEN_PROBES) {
      const keywords = NUMERAL_TOKEN_TOPIC_KEYWORDS[probe.id] ?? [];
      const [, distractorKeyword] = keywords;
      expect(distractorKeyword, `${probe.id} の distractor keyword`).toBeDefined();
      expect(probe.distractor.includes(distractorKeyword!)).toBe(true);
    }
  });

  it("密 haystack の密度は 90/18 = 5:1 である(識別子ベンチの初期設計と同じ密度、ADR 0135 §5.4)", () => {
    expect(DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE / NUMERAL_TOKEN_PROBES.length).toBe(5);
  });

  it("haystack は probe の索引を1つも含まない(疎・密の両方)", () => {
    for (const kind of ["sparse", "dense"] as const) {
      const utterances = buildNumeralTokenProbeSetConversation(undefined, kind);
      const haystack = utterances.filter((u) => u.kind === "haystack").map((u) => u.text);
      expect(findNumeralTokenTopicKeywordViolations(haystack)).toEqual([]);
    }
  });

  it("gold と distractor が両方とも会話に現れる", () => {
    const utterances = buildNumeralTokenProbeSetConversation(undefined, "sparse");
    expect(utterances.filter((u) => u.kind === "gold")).toHaveLength(18);
    expect(utterances.filter((u) => u.kind === "distractor")).toHaveLength(18);
  });

  it("疎/密のどちらでも haystack の既定件数が変わる(sparse=60, dense=90)", () => {
    const sparse = buildNumeralTokenProbeSetConversation(undefined, "sparse");
    const dense = buildNumeralTokenProbeSetConversation(undefined, "dense");
    expect(sparse.filter((u) => u.kind === "haystack")).toHaveLength(60);
    expect(dense.filter((u) => u.kind === "haystack")).toHaveLength(90);
  });
});
