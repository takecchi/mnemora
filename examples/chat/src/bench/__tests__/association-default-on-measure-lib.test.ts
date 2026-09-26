import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_LEVELS,
  buildNumberDiffTable,
  fillMissingKeysWithZero,
  formatNumberDiffCell,
  parsePromptIndexLine,
  redactVolatileFields,
  sameAfterRedactingVolatileFields,
  tallyStrings,
} from "../association-default-on-measure-lib.js";

describe("ASSOCIATION_LEVELS", () => {
  it("4段(off/on5/on10/on20)を持ち、on10 は既定の maxCount(10)と同じ値である", () => {
    expect(ASSOCIATION_LEVELS.map((l) => l.key)).toEqual(["off", "on5", "on10", "on20"]);
    expect(ASSOCIATION_LEVELS.find((l) => l.key === "off")?.association).toBeNull();
    expect(ASSOCIATION_LEVELS.find((l) => l.key === "on5")?.association).toEqual({ maxCount: 5 });
    expect(ASSOCIATION_LEVELS.find((l) => l.key === "on10")?.association).toEqual({
      maxCount: 10,
    });
    expect(ASSOCIATION_LEVELS.find((l) => l.key === "on20")?.association).toEqual({
      maxCount: 20,
    });
  });
});

describe("tallyStrings", () => {
  it("空配列は空オブジェクトを返す", () => {
    expect(tallyStrings([])).toEqual({});
  });

  it("値ごとの出現回数を数える", () => {
    expect(tallyStrings(["not_indexed", "over_limit", "not_indexed"])).toEqual({
      not_indexed: 2,
      over_limit: 1,
    });
  });
});

describe("parsePromptIndexLine", () => {
  it("buildMnemoraPrompt が組む索引行から totalInScope/returned を読む", () => {
    const prompt = [
      "(記録順: 数が大きいほど後に記録された。行は記録の古い順に並べてある)",
      "- [由来:stated] some digest",
      "(索引: スコープ内 42 件のうち 10 件を提示)",
    ].join("\n");
    expect(parsePromptIndexLine(prompt)).toEqual({ totalInScope: 42, returned: 10 });
  });

  it("索引行が無ければ null を返す(推測で埋めない)", () => {
    expect(parsePromptIndexLine("索引行を持たない文字列")).toBeNull();
  });
});

describe("fillMissingKeysWithZero", () => {
  it("挙げた全ての key を(無ければ0で)埋める", () => {
    expect(fillMissingKeysWithZero({ tied: 3 }, ["tied", "collapsed", "neither-returned"])).toEqual(
      { tied: 3, collapsed: 0, "neither-returned": 0 },
    );
  });

  it("off/on20 で出現する値の集合が違っても、埋めた後は同じ欄名になり buildNumberDiffTable が通る", () => {
    const known = ["tied", "newer-ranked-higher", "collapsed"];
    const off = fillMissingKeysWithZero(tallyStrings(["tied", "tied"]), known);
    const on20 = fillMissingKeysWithZero(tallyStrings(["tied", "collapsed"]), known);
    expect(() => buildNumberDiffTable(off, on20)).not.toThrow();
    expect(buildNumberDiffTable(off, on20).collapsed).toEqual({
      baseline: 0,
      variant: 1,
      absoluteDiff: 1,
      percentOfBaseline: null,
    });
  });
});

describe("buildNumberDiffTable", () => {
  it("欄名が完全に一致するとき、絶対差と基準比%を計算する", () => {
    const table = buildNumberDiffTable(
      { hit1Count: 5, mrrOverall: 500 },
      { hit1Count: 7, mrrOverall: 500 },
    );
    expect(table.hit1Count).toEqual({
      baseline: 5,
      variant: 7,
      absoluteDiff: 2,
      percentOfBaseline: 40,
    });
    expect(table.mrrOverall).toEqual({
      baseline: 500,
      variant: 500,
      absoluteDiff: 0,
      percentOfBaseline: 0,
    });
  });

  it("baseline が0の欄は percentOfBaseline を null にする(0除算を0%と偽らない)", () => {
    const table = buildNumberDiffTable({ associationRows: 0 }, { associationRows: 3 });
    expect(table.associationRows).toEqual({
      baseline: 0,
      variant: 3,
      absoluteDiff: 3,
      percentOfBaseline: null,
    });
  });

  it("baseline と variant の欄名が食い違うと例外にする", () => {
    expect(() => buildNumberDiffTable({ a: 1 }, { b: 1 })).toThrow(/欄名が一致しない/);
  });
});

describe("formatNumberDiffCell", () => {
  it("増加を+付きで、基準0のときは(基準0)を出す", () => {
    expect(
      formatNumberDiffCell({ baseline: 5, variant: 7, absoluteDiff: 2, percentOfBaseline: 40 }),
    ).toBe("5 → 7 (+2, +40.0%)");
    expect(
      formatNumberDiffCell({ baseline: 0, variant: 3, absoluteDiff: 3, percentOfBaseline: null }),
    ).toBe("0 → 3 (+3, (基準0))");
  });
});

describe("redactVolatileFields / sameAfterRedactingVolatileFields", () => {
  it("指定した key を再帰的に取り除く", () => {
    const value = { tenantId: "a-1", nested: { tenantId: "b-2", keep: 3 } };
    expect(redactVolatileFields(value, ["tenantId"])).toEqual({ nested: { keep: 3 } });
  });

  it("Date を ISO 文字列へ写す", () => {
    const date = new Date("2026-09-26T00:00:00.000Z");
    expect(redactVolatileFields({ now: date }, [])).toEqual({ now: "2026-09-26T00:00:00.000Z" });
  });

  it("volatile な欄だけが違う2つの値は一致とみなす", () => {
    const a = { tenantId: "run-1", hit1Count: 5 };
    const b = { tenantId: "run-2", hit1Count: 5 };
    expect(sameAfterRedactingVolatileFields(a, b, ["tenantId"])).toBe(true);
  });

  it("volatile でない欄が違えば不一致とみなす(陽性対照——探り棒が生きていることを示す)", () => {
    const a = { tenantId: "run-1", hit1Count: 5 };
    const b = { tenantId: "run-2", hit1Count: 6 };
    expect(sameAfterRedactingVolatileFields(a, b, ["tenantId"])).toBe(false);
  });
});
