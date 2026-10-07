import { describe, expect, it } from "vitest";
import { truncateForFallbackDigest } from "../extraction.js";

describe("truncateForFallbackDigest: 書記素の途中で切らない", () => {
  it("NFD の「が」（か + 結合濁点）を割って「か」にしない", () => {
    const nfd = "が"; // が
    expect(truncateForFallbackDigest(`あい${nfd}う`, 3)).toBe("あい…");
    expect(truncateForFallbackDigest(`あい${nfd}う`, 4)).toBe(`あい${nfd}…`);
    expect(truncateForFallbackDigest(`あい${nfd}う`, 5)).toBe(`あい${nfd}う`);
  });

  it("ZWJ で繋いだ絵文字を割らない", () => {
    const family = "👨‍👩‍👧";
    expect(truncateForFallbackDigest(`ab${family}cd`, 5)).toBe("ab…");
    expect(truncateForFallbackDigest(`ab${family}cd`, 7)).toBe("ab…");
    expect(truncateForFallbackDigest(`ab${family}cd`, 2 + family.length)).toBe(`ab${family}…`);
  });

  it("国旗（地域指示子の2つ）を割らない", () => {
    expect(truncateForFallbackDigest("x🇯🇵y", 3)).toBe("x…");
    expect(truncateForFallbackDigest("x🇯🇵y", 5)).toBe("x🇯🇵…");
  });

  it("最初の書記素だけで上限を超えるなら、本文を残さない（上限0と同じ）", () => {
    expect(truncateForFallbackDigest("👨‍👩‍👧x", 3)).toBe("…");
  });

  it("陽性対照: 今までと同じ結果（収まる・サロゲートペア・日本語）", () => {
    expect(truncateForFallbackDigest("短い本文", 200)).toBe("短い本文");
    expect(truncateForFallbackDigest("あ".repeat(10), 5)).toBe(`${"あ".repeat(5)}…`);
    expect(truncateForFallbackDigest("AAAA😀BBBB", 5)).toBe("AAAA…");
    expect(truncateForFallbackDigest("AAAA😀BBBB", 6)).toBe("AAAA😀…");
  });
});

describe("truncateForFallbackDigest: 長さが数として変なとき、今の結果を変えない", () => {
  it.each([
    ["NaN", Number.NaN, "…"],
    ["0", 0, "…"],
    ["-3", -3, "…"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "…"],
    ["2.5", 2.5, "ab…"],
    ["Infinity", Number.POSITIVE_INFINITY, "abcdef"],
  ])("長さ %s", (_n, len, expected) => {
    expect(truncateForFallbackDigest("abcdef", len)).toBe(expected);
  });

  it("本文が空のときの NaN・負（既存の約束）", () => {
    expect(truncateForFallbackDigest("", Number.NaN)).toBe("…");
    expect(truncateForFallbackDigest("  ", -1)).toBe("（内容なし）");
  });

  it("小数の長さがサロゲートペアの内側に落ちても割らない", () => {
    expect(truncateForFallbackDigest("a😀b", 2.5)).toBe("a…");
    expect(truncateForFallbackDigest("a😀b", 3.5)).toBe("a😀…");
  });
});
