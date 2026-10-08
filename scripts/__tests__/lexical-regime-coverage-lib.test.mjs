import { describe, expect, it } from "vitest";
import {
  EXPECTED_SERVER_ENCODINGS,
  artifactNameForEncoding,
  buildCoverageSummaryMarkdown,
  evaluateCoverage,
} from "../lexical-regime-coverage-lib.mjs";

function present(encoding, measuredEncoding = encoding) {
  return { encoding, present: true, measuredEncoding };
}

function missing(encoding) {
  return { encoding, present: false };
}

describe("EXPECTED_SERVER_ENCODINGS / artifactNameForEncoding", () => {
  it("UTF8 と SQL_ASCII の2つを期待する(LATIN1 は含めない——オーナー未回答、Issue #155 範囲外)", () => {
    expect(EXPECTED_SERVER_ENCODINGS).toEqual(["UTF8", "SQL_ASCII"]);
  });

  it("artifact 名は lexical-regime-<encoding> の形になる", () => {
    expect(artifactNameForEncoding("UTF8")).toBe("lexical-regime-UTF8");
    expect(artifactNameForEncoding("SQL_ASCII")).toBe("lexical-regime-SQL_ASCII");
  });
});

describe("evaluateCoverage", () => {
  it("⭐ 両脚が揃っていて、別々の server_encoding を測っていれば ok(3脚目や追加の一致を要求しない)", () => {
    const result = evaluateCoverage([present("UTF8"), present("SQL_ASCII")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.distinctMeasured.sort()).toEqual(["SQL_ASCII", "UTF8"]);
    }
  });

  it("🔴 片方の artifact が無ければ非ok", () => {
    const result = evaluateCoverage([present("UTF8"), missing("SQL_ASCII")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toContain("lexical-regime-SQL_ASCII");
      expect(result.problems.join(" ")).toContain("artifact が無い");
    }
  });

  it("🔴 JSON が読めない(error 付き)なら非ok", () => {
    const result = evaluateCoverage([
      present("UTF8"),
      { encoding: "SQL_ASCII", present: true, error: "Unexpected token" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toContain("読めない");
    }
  });

  it("🔴 artifact 名が主張する脚と中身の serverEncoding が食い違うと非ok", () => {
    const result = evaluateCoverage([present("UTF8"), present("SQL_ASCII", "UTF8")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toContain("lexical-regime-SQL_ASCII");
      expect(result.problems.join(" ")).toContain("UTF8");
    }
  });

  it("🔴🔴 両方の artifact が揃っていても、実際に測れた server_encoding が1種類しかないと非ok(POSTGRES_INITDB_ARGS が効いていない疑い)", () => {
    const result = evaluateCoverage([present("UTF8", "UTF8"), present("SQL_ASCII", "UTF8")]);
    expect(result.ok).toBe(false);
  });

  it("🔴 名前どおりの脚が2種類とも同じ値を測ってしまう理論上のケース(名前と中身が一致しているのに種類が足りない)でも非ok", () => {
    // 名前と中身の食い違いを偽装できないので、期待エンコーディングが1種類の形で「distinctMeasured が期待数未満」の分岐を直接確かめる。
    const result = evaluateCoverage([present("UTF8"), present("UTF8")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/1 種類|種類しかない/);
    }
  });

  it("⭐ 期待していない3脚目が別の値を測っていても、期待した2脚が揃っていれば ok(種類数は下限であって一致ではない)", () => {
    const result = evaluateCoverage([present("UTF8"), present("SQL_ASCII"), present("LATIN1")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.distinctMeasured.sort()).toEqual(["LATIN1", "SQL_ASCII", "UTF8"]);
    }
  });
});

describe("buildCoverageSummaryMarkdown", () => {
  it("ok のときは ✅ と実際に測れた集合を出す", () => {
    const legs = [present("UTF8"), present("SQL_ASCII")];
    const result = evaluateCoverage(legs);
    const markdown = buildCoverageSummaryMarkdown(legs, result);
    expect(markdown).toContain("✅");
    expect(markdown).toContain("UTF8");
    expect(markdown).toContain("SQL_ASCII");
  });

  it("非 ok のときは 🔴 と理由を出す", () => {
    const legs = [present("UTF8"), missing("SQL_ASCII")];
    const result = evaluateCoverage(legs);
    const markdown = buildCoverageSummaryMarkdown(legs, result);
    expect(markdown).toContain("🔴");
    expect(markdown).toContain("artifact 無し");
  });
});
