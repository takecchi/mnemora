import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "../recall-footprint-calibration-samples-summary-lib.mjs";

/**
 * Issue #340 フォローアップ(ADR 0307): `recall-footprint-calibration-samples-summary-lib.mjs`
 * (純関数の側)の歯。DB を要求しない。
 *
 * ⭐ **最重要の検査**: (fillerPairs, recallLimit) をキーに欄を比べること、⛔ 相違があっても
 * 門にはしない(`buildSummaryMarkdown` は常に文字列を返し、CLI 側が exit 0 を明示する
 * ——ここでは lib が `process.exit` を一切呼ばないこと自体を確認する)。
 */

function makeRow(overrides = {}) {
  return {
    fillerPairs: 12,
    recallLimit: 20,
    turnCount: 26,
    totalInScope: 9,
    returnedCount: 9,
    mnemoraChars: 300,
    bandEntryCount: 0,
    rawIndex: { totalInScope: 9, groups: [], countKind: "exact" },
    rawIndexJsonLength: 40,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    llmMode: "recorded",
    embeddingMode: "recorded",
    designDecidedBeforeSeeingHoldOutErrors: true,
    rowCount: 1,
    rows: [makeRow()],
    ...overrides,
  };
}

describe("validateMeasured", () => {
  it("正しい形を受け入れる", () => {
    const result = validateMeasured(makeMeasured());
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ拒否する", () => {
    const result = validateMeasured(null);
    expect(result.ok).toBe(false);
  });

  it("rows が空配列なら拒否する", () => {
    const result = validateMeasured(makeMeasured({ rows: [], rowCount: 0 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rows が空配列");
  });

  it("row の必須数値欄が欠けていれば拒否する", () => {
    const row = makeRow();
    delete row.bandEntryCount;
    const result = validateMeasured(makeMeasured({ rows: [row] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bandEntryCount");
  });

  it("rawIndex がオブジェクトでなければ拒否する", () => {
    const result = validateMeasured(makeMeasured({ rows: [makeRow({ rawIndex: null })] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rawIndex");
  });

  it("(fillerPairs, recallLimit) が重複していれば拒否する", () => {
    const result = validateMeasured(makeMeasured({ rows: [makeRow(), makeRow()], rowCount: 2 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上ある");
  });
});

describe("validateBaseline", () => {
  it("rows 配列を持つオブジェクトを受け入れる", () => {
    const result = validateBaseline({ rows: [makeRow()] });
    expect(result.ok).toBe(true);
  });

  it("rows が無ければ拒否する", () => {
    const result = validateBaseline({});
    expect(result.ok).toBe(false);
  });
});

describe("buildSummaryMarkdown", () => {
  it("--baseline 無しでは、基準値がまだ無いことを明示する", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("fillerPairs");
    expect(markdown).toContain("基準値ファイルが無い");
  });

  it("基準値と一致すれば ✅ を出す", () => {
    const measured = makeMeasured();
    const baseline = { rows: [makeRow()] };
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("✅ 基準値と一致");
  });

  it("基準値と相違すれば、⛔ 門ではないと明示しつつ相違を列挙する", () => {
    const measured = makeMeasured({ rows: [makeRow({ mnemoraChars: 999 })] });
    const baseline = { rows: [makeRow({ mnemoraChars: 300 })] };
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("門ではない");
    expect(markdown).toContain("mnemoraChars");
  });

  it("基準値にだけある設計点(実測に無い)を報告する", () => {
    const measured = makeMeasured({ rows: [], rowCount: 0 });
    const baseline = { rows: [makeRow({ fillerPairs: 29 })] };
    // rows が空だと validateMeasured は拒否するので、ここは buildSummaryMarkdown を直接叩く
    // (lib は validate 済みの値だけを受け取る契約——CLI 側の validateMeasured を経ない
    // 呼び出しでも、この関数自体は落ちないことを確認する)。
    const markdown = buildSummaryMarkdown({ measured: { ...measured, rows: [] }, baseline });
    expect(markdown).toContain("実測に無い");
  });

  it("新しい設計点(基準値に無い)を報告する", () => {
    const measured = makeMeasured({ rows: [makeRow({ fillerPairs: 33 })] });
    const baseline = { rows: [makeRow({ fillerPairs: 12 })] };
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("新しい設計点");
  });
});
