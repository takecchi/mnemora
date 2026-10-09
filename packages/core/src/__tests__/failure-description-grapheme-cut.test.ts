import { describe, expect, it } from "vitest";
import { describeFailure } from "../failure-description.js";

const MAX = 4096;
const MARK = /… \(truncated by mnemora, original length (\d+) chars\)$/;
const describeText = (text: string) => describeFailure(new Error(text));
const body = (out: string) => out.replace(MARK, "");

describe("describeFailure: 上限での切り詰めは書記素の境目で止まる（ADR 0470）", () => {
  it("NFD の「が」（か + 結合濁点）を割って「か」にしない", () => {
    const text = "a".repeat(MAX - 1) + "が" + "tail";
    const out = describeText(text);
    expect(body(out)).toBe("a".repeat(MAX - 1));
    expect(out).toMatch(MARK);
  });

  it("ZWJ で繋いだ絵文字を割らない", () => {
    const family = "👨\u200D👩\u200D👧";
    const text = "a".repeat(MAX - 3) + family + "tail";
    expect(body(describeText(text))).toBe("a".repeat(MAX - 3));
  });

  it("国旗（地域指示子の2つ）を割らない", () => {
    const text = "a".repeat(MAX - 2) + "🇯🇵" + "tail";
    expect(body(describeText(text))).toBe("a".repeat(MAX - 2));
  });

  it("ちょうど収まる書記素は残す", () => {
    const family = "👨\u200D👩\u200D👧";
    const text = "a".repeat(MAX - family.length) + family + "tail";
    expect(body(describeText(text))).toBe("a".repeat(MAX - family.length) + family);
  });

  it("元の長さは UTF-16 の長さのまま、切った本体は上限を超えない", () => {
    const text = "a".repeat(MAX - 1) + "が" + "tail";
    const out = describeText(text);
    expect(Number(MARK.exec(out)![1])).toBe(text.length);
    expect(body(out).length).toBeLessThanOrEqual(MAX);
  });

  it("陽性対照: 上限以下はそのまま、素直な長い文字列は上限ちょうどで切る（サロゲートペアは割らない）", () => {
    expect(describeText("short")).toBe("short");
    expect(body(describeText("x".repeat(MAX + 10)))).toBe("x".repeat(MAX));
    expect(body(describeText("a".repeat(MAX - 1) + "😀tail"))).toBe("a".repeat(MAX - 1));
  });

  it("上限は UTF-16 のコードユニットで数える（コードポイントでは上限以下の絵文字の列も、コードユニットで超えるなら切る）", () => {
    // 😀 は2コードユニット。2100個で 4200 コードユニット（コードポイントは 2100 で上限以下）。
    const text = "😀".repeat(2100);
    expect(text.length).toBeGreaterThan(MAX);
    const out = describeText(text);
    expect(out).toMatch(MARK);
    expect(Number(MARK.exec(out)![1])).toBe(text.length);
    expect(body(out)).toBe("😀".repeat(MAX / 2));
  });

  it("最初の書記素だけで上限を超える入力は、本体が空になり、印だけが残る（コードユニットで切り直さない）", () => {
    // e + 結合アクセント5000個は、先頭から1つの書記素。上限（4096）を超える。
    const text = "e" + String.fromCodePoint(0x0301).repeat(5000);
    expect(describeText(text)).toBe(
      `… (truncated by mnemora, original length ${text.length} chars)`,
    );
  });
});
