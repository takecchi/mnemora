import { describe, expect, it } from "vitest";
import {
  LEXICAL_QUERY_MAX_DISTINCT_WORDS,
  LEXICAL_QUERY_MAX_WORD_CHARS,
  capLexicalQueryWords,
} from "../lexical-query-cap.js";

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
    // クエリ全体の文字数の上限（LEXICAL_QUERY_MAX_TOTAL_CHARS）には触れない範囲で、
    // 異なる語の数の上限（LEXICAL_QUERY_MAX_DISTINCT_WORDS）よりはるかに多い回数
    // 重複させる。
    const query = Array.from({ length: LEXICAL_QUERY_MAX_DISTINCT_WORDS * 2 }, (_, i) =>
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

  it("1語の文字数がちょうど上限のときは変えない", () => {
    const query = "a".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);
    expect(capLexicalQueryWords(query)).toBe(query);
  });

  it("1語の文字数が上限を1つ超えると、その語を先頭から上限の文字数だけに切り詰める", () => {
    const query = "a".repeat(LEXICAL_QUERY_MAX_WORD_CHARS + 1);
    expect(capLexicalQueryWords(query)).toBe("a".repeat(LEXICAL_QUERY_MAX_WORD_CHARS));
  });

  it("記号を含む、空白を含まない1語も文字数の上限で切り詰められる", () => {
    const longSymbolJoinedWord = Array.from(
      { length: LEXICAL_QUERY_MAX_WORD_CHARS },
      () => "a",
    ).join("-");
    expect(longSymbolJoinedWord.length).toBeGreaterThan(LEXICAL_QUERY_MAX_WORD_CHARS);
    const capped = capLexicalQueryWords(longSymbolJoinedWord);
    expect(capped).toBe(longSymbolJoinedWord.slice(0, LEXICAL_QUERY_MAX_WORD_CHARS));
  });

  it("長すぎる語が複数あっても、それぞれ独立に先頭から切り詰められる", () => {
    const wordA = "a".repeat(LEXICAL_QUERY_MAX_WORD_CHARS + 10);
    const wordB = "b".repeat(LEXICAL_QUERY_MAX_WORD_CHARS + 20);
    const query = `${wordA} ${wordB}`;
    const capped = capLexicalQueryWords(query);
    expect(capped).toBe(
      `${"a".repeat(LEXICAL_QUERY_MAX_WORD_CHARS)} ${"b".repeat(LEXICAL_QUERY_MAX_WORD_CHARS)}`,
    );
  });
});
