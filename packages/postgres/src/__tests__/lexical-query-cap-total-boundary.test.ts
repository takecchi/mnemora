import { describe, expect, it } from "vitest";
import {
  LEXICAL_QUERY_MAX_TOTAL_CHARS,
  LEXICAL_QUERY_MAX_WORD_CHARS,
  capLexicalQueryTotalChars,
  capLexicalQueryWords,
} from "../lexical-query-cap.js";

/**
 * #919 の確かめ直し（#1774）。クエリ全体の文字数の上限（{@link LEXICAL_QUERY_MAX_TOTAL_CHARS}）の
 * 境界と、「全体の上限だけが効く」入力（語数も1語の文字数も上限に触れない）を、DB を使わずに縛る。
 * `lexical-query-cap.test.ts` は語数・1語の文字数の境界を見ていて、全体の文字数の境界は
 * DB の結果ベースの歯（`lexical-store-query-total-chars-cap.test.ts`）しか見ていなかった。
 */

describe("capLexicalQueryTotalChars の境界", () => {
  it("ちょうど上限の文字数は1文字も変えない", () => {
    const query = "a".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    expect(capLexicalQueryTotalChars(query)).toBe(query);
  });

  it("上限を1文字超えると、先頭から上限の文字数だけに切り詰める", () => {
    const query = "a".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS) + "b";
    const capped = capLexicalQueryTotalChars(query);
    expect(capped).toHaveLength(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    expect(capped).toBe("a".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS));
  });
});

describe("capLexicalQueryWords: 全体の文字数の上限だけが効く入力", () => {
  // 40文字の語を空白でつなぐ。語数は上限（32）以下、1語は上限（64）以下なので、
  // 語数・1語の文字数の上限には触れない。全体は 600 を超える。
  const words = Array.from(
    { length: 20 },
    (_, i) => `w${String(i).padStart(2, "0")}${"x".repeat(37)}`,
  );
  const query = words.join(" ");

  it("前提：語数・1語の文字数の上限には触れず、全体だけが上限を超える", () => {
    expect(words.length).toBeLessThanOrEqual(32);
    expect(words.every((w) => w.length <= LEXICAL_QUERY_MAX_WORD_CHARS)).toBe(true);
    expect(query.length).toBeGreaterThan(LEXICAL_QUERY_MAX_TOTAL_CHARS);
  });

  it("全体の上限を超えた分は、語数・1語の文字数に触れなくても切り落とされる（元の文字列を返さない）", () => {
    const capped = capLexicalQueryWords(query);
    expect(capped.length).toBeLessThanOrEqual(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    // 先頭から 600 文字を語に分けたもの（末尾の語は途中で切れる）
    expect(capped).toBe(query.slice(0, LEXICAL_QUERY_MAX_TOTAL_CHARS));
    expect(capped).not.toContain(words[19]);
  });
});
