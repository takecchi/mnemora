import { describe, expect, it } from "vitest";
import {
  assertWellFormedFilter,
  findMalformedIdentifierPart,
  isMalformedIdentifierError,
  MalformedIdentifierError,
} from "../identifier.js";

describe("findMalformedIdentifierPart", () => {
  it("問題の無い値（空文字・ASCII・日本語・対をなすサロゲート〔絵文字〕）は null", () => {
    for (const value of ["", "tenant-1", "テナント", "😀", "a😀b", "\u{10FFFF}", "😀😀"]) {
      expect(findMalformedIdentifierPart(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("NUL は reason: nul と位置", () => {
    expect(findMalformedIdentifierPart("\u0000")).toEqual({ reason: "nul", index: 0 });
    expect(findMalformedIdentifierPart("ab\u0000c")).toEqual({ reason: "nul", index: 2 });
  });

  it("孤立した上位サロゲート（末尾・下位以外が続く）と孤立した下位サロゲート（先頭・上位の直後でない）は lone_surrogate", () => {
    expect(findMalformedIdentifierPart("a\uD800")).toEqual({ reason: "lone_surrogate", index: 1 });
    expect(findMalformedIdentifierPart("\uD800a")).toEqual({ reason: "lone_surrogate", index: 0 });
    expect(findMalformedIdentifierPart("\uD800\uD800")).toEqual({
      reason: "lone_surrogate",
      index: 0,
    });
    expect(findMalformedIdentifierPart("\uDC00")).toEqual({ reason: "lone_surrogate", index: 0 });
    expect(findMalformedIdentifierPart("ab\uDFFF")).toEqual({ reason: "lone_surrogate", index: 2 });
    expect(findMalformedIdentifierPart("\uDE00\uD83D")).toEqual({
      reason: "lone_surrogate",
      index: 0,
    });
    // 下位サロゲートが2つ続いても対にはならない（先頭の下位を上位と読み違えない）。
    expect(findMalformedIdentifierPart("\uDC00\uDC00")).toEqual({
      reason: "lone_surrogate",
      index: 0,
    });
  });

  it("境界: 上位サロゲートの直後が下位の範囲のすぐ外（DBFF・E000）なら、対にならず孤立", () => {
    expect(findMalformedIdentifierPart("\uD800\uDBFF")).toEqual({
      reason: "lone_surrogate",
      index: 0,
    });
    expect(findMalformedIdentifierPart("\uD800")).toEqual({
      reason: "lone_surrogate",
      index: 0,
    });
  });

  it("境界: 上位サロゲートの範囲 D800〜DBFF・下位の範囲 DC00〜DFFF の両端", () => {
    expect(findMalformedIdentifierPart("퟿")).toBeNull();
    expect(findMalformedIdentifierPart("")).toBeNull();
    expect(findMalformedIdentifierPart("\uDBFF")).not.toBeNull();
    expect(findMalformedIdentifierPart("􏰀")).toBeNull();
    expect(findMalformedIdentifierPart("𐏿")).toBeNull();
  });

  it("位置は UTF-16 のコードユニット単位（対のサロゲートは2つ数える）で、返すのは最初の問題", () => {
    expect(findMalformedIdentifierPart("😀\u0000")).toEqual({ reason: "nul", index: 2 });
    expect(findMalformedIdentifierPart("😀😀\uD800")).toEqual({
      reason: "lone_surrogate",
      index: 4,
    });
    expect(findMalformedIdentifierPart("a\u0000\uD800")).toEqual({ reason: "nul", index: 1 });
    expect(findMalformedIdentifierPart("a\uD800\u0000")).toEqual({
      reason: "lone_surrogate",
      index: 1,
    });
  });
});

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("assertWellFormedFilter", () => {
  it("tenantId・subjectId が well-formed（省略・絵文字を含む）なら何も投げない", () => {
    expect(() => assertWellFormedFilter({ tenantId: "t" })).not.toThrow();
    expect(() => assertWellFormedFilter({ tenantId: "t😀", subjectId: "s😀" })).not.toThrow();
    expect(() => assertWellFormedFilter({})).not.toThrow();
  });

  it("tenantId の問題は `<field>.tenantId`、subjectId の問題は `<field>.subjectId` を名指しして MalformedIdentifierError", () => {
    const tenant = thrownBy(() => assertWellFormedFilter({ tenantId: "a\u0000" }));
    expect(tenant).toBeInstanceOf(MalformedIdentifierError);
    expect(tenant).toMatchObject({ field: "filter.tenantId", reason: "nul", index: 1 });
    const subject = thrownBy(() => assertWellFormedFilter({ tenantId: "t", subjectId: "\uD800" }));
    expect(isMalformedIdentifierError(subject)).toBe(true);
    expect(subject).toMatchObject({
      field: "filter.subjectId",
      reason: "lone_surrogate",
      index: 0,
    });
  });

  it("`field` を渡すとその名前で載る", () => {
    const error = thrownBy(() =>
      assertWellFormedFilter({ tenantId: "t", subjectId: "x\u0000" }, "opts.filter"),
    );
    expect(error).toMatchObject({ field: "opts.filter.subjectId" });
  });

  it("両方に問題があれば tenantId が先に報告される", () => {
    const error = thrownBy(() =>
      assertWellFormedFilter({ tenantId: "\u0000", subjectId: "\u0000" }),
    );
    expect(error).toMatchObject({ field: "filter.tenantId" });
  });

  it("例外の message に入力値を載せない", () => {
    const secret = "SECRET-VALUE-9f2";
    const error = thrownBy(() => assertWellFormedFilter({ tenantId: `${secret}\u0000` }));
    expect(error).toBeInstanceOf(MalformedIdentifierError);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("例外の message には、欄の名前と位置が載り、理由（NUL か孤立サロゲートか）で文面が分かれる", () => {
    const nul = thrownBy(() => assertWellFormedFilter({ tenantId: "abc\u0000" }, "opts.filter"));
    const lone = thrownBy(() => assertWellFormedFilter({ tenantId: "abc\uD800" }, "opts.filter"));
    for (const error of [nul, lone]) {
      expect((error as Error).message).toContain("opts.filter.tenantId");
      expect((error as Error).message).toContain("index 3");
    }
    expect((nul as Error).message).not.toBe((lone as Error).message);
  });

  it("文字列でない値と、検索条件が無い（null・undefined・オブジェクトでない）場合は検査しない", () => {
    expect(() => assertWellFormedFilter({ tenantId: undefined, subjectId: null })).not.toThrow();
    expect(() => assertWellFormedFilter({ tenantId: 123, subjectId: {} })).not.toThrow();
    expect(() => assertWellFormedFilter(null)).not.toThrow();
    expect(() => assertWellFormedFilter(undefined)).not.toThrow();
    expect(() => assertWellFormedFilter("a\u0000" as never)).not.toThrow();
  });
});
