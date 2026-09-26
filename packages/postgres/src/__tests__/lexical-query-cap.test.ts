import { describe, expect, it } from "vitest";
import { LEXICAL_QUERY_MAX_DISTINCT_WORDS, capLexicalQueryWords } from "../lexical-query-cap.js";

/**
 * `capLexicalQueryWords`（Issue #878、2026-09-26、クローン miku の判断）の純粋な単体テスト。
 * DB を要らない——`packages/postgres/src/__tests__/lexical-store-query-word-cap.test.ts`
 * （本物の Postgres に対する結果ベースの歯）とは別に、関数そのものの境界値を見る。
 */

function fillerWords(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `filler${i}`);
}

describe("capLexicalQueryWords", () => {
  it("上限に触れないクエリは1バイトも変えない（前後の空白の崩れも含めて）", () => {
    const query = "  obsidian   shards  ";
    expect(capLexicalQueryWords(query)).toBe(query);
  });

  it("異なる語がちょうど上限のときは変えない", () => {
    const query = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" ");
    expect(capLexicalQueryWords(query)).toBe(query);
  });

  it("異なる語が上限を1つ超えると、先頭から上限の数だけに切り詰める", () => {
    const words = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS + 1);
    const query = words.join(" ");
    const capped = capLexicalQueryWords(query);
    expect(capped).toBe(words.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" "));
  });

  it("大文字小文字だけが違う語は同じ語として重複を数える", () => {
    // 上限+1個の「大文字小文字違い」だけの重複語のペアを作る。重複をまとめれば
    // 異なる語は (上限+1) 個のままなので、なお切り詰められる。
    const distinctBase = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS + 1);
    const withCaseDuplicates = distinctBase.flatMap((w) => [w, w.toUpperCase()]);
    const query = withCaseDuplicates.join(" ");
    const capped = capLexicalQueryWords(query);
    expect(capped).toBe(distinctBase.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" "));
  });

  it("重複語をいくら増やしても、異なる語が上限以内なら変えない", () => {
    const query = Array.from({ length: LEXICAL_QUERY_MAX_DISTINCT_WORDS * 5 }, (_, i) =>
      i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma",
    ).join(" ");
    expect(capLexicalQueryWords(query)).toBe(query);
  });

  it("非 ASCII の連なりは空白として扱われる（mnemora_lexical_query_terms と同じ向き）", () => {
    const words = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS + 1);
    // 各語の間に日本語を挟んでも、上限判定は ASCII の語だけを数える。
    const query = words.join("という語の次には");
    const capped = capLexicalQueryWords(query);
    expect(capped).toBe(words.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" "));
  });

  it("空文字列・空白だけの文字列はそのまま返す", () => {
    expect(capLexicalQueryWords("")).toBe("");
    expect(capLexicalQueryWords("   ")).toBe("   ");
  });
});
