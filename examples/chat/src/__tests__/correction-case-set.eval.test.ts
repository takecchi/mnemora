import { describe, expect, it } from "vitest";
import {
  CORRECTION_ABSTAIN_CASE_SET_EVAL,
  CORRECTION_HIT_CASE_SET_EVAL,
} from "../correction-case-set.eval.js";

/**
 * `correction-case-set.eval.ts` に追加した30件（ADR 0291 §5.4、ADR 0321）の構造整合性。
 * DB もネットワークも要らない——配列の中身だけを検査する。
 *
 * ⚠ **この歯は判定の正しさ（gold/distractor の意味）までは検査できない**——それは
 * `grounds` フィールドと ADR 0321 の表が担う。ここで検査するのは、§5.4 の行列
 * （索引型3 × A群2インスタンス／索引型3 × kind4 × B群2インスタンス）を
 * 実際に満たしているか、という機械的に確認できる部分だけである。
 */
describe("correction-case-set.eval: ADR 0291/0321 が追加した30件の行列", () => {
  it("A群は21件（既存15件 + 新規6件）、id は重複しない", () => {
    expect(CORRECTION_HIT_CASE_SET_EVAL).toHaveLength(21);
    const ids = CORRECTION_HIT_CASE_SET_EVAL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("A群の新規6件は ascii/jpname/numeral の3索引型 × 2インスタンスである", () => {
    const newIds = ["ascii-a", "ascii-b", "jpname-a", "jpname-b", "numeral-a", "numeral-b"];
    for (const id of newIds) {
      expect(CORRECTION_HIT_CASE_SET_EVAL.some((c) => c.id === id)).toBe(true);
    }
    for (const prefix of ["ascii", "jpname", "numeral"]) {
      const count = CORRECTION_HIT_CASE_SET_EVAL.filter((c) =>
        c.id.startsWith(`${prefix}-`),
      ).length;
      expect(count).toBe(2);
    }
  });

  it("A群の新規6件は、すべて tuningUse: held-out（調整に使っていない）", () => {
    for (const prefix of ["ascii-", "jpname-", "numeral-"]) {
      for (const c of CORRECTION_HIT_CASE_SET_EVAL.filter((x) => x.id.startsWith(prefix))) {
        expect(c.tuningUse).toBe("held-out");
      }
    }
  });

  it("A群の新規6件は、訂正の発話が訂正前の値を名指ししている（既存15件と同じ様式）", () => {
    for (const prefix of ["ascii-", "jpname-", "numeral-"]) {
      for (const c of CORRECTION_HIT_CASE_SET_EVAL.filter((x) => x.id.startsWith(prefix))) {
        // 既存様式:「訂正します」「訂正です」を含む逐語の訂正表現（ADR 0291 §5.2、
        // 明示的な訂正表現を変えない、という決定の機械的な裏付け）。
        expect(c.correction).toMatch(/訂正/);
      }
    }
  });

  it("B群は32件（既存8件 + 新規24件）、id は重複しない", () => {
    expect(CORRECTION_ABSTAIN_CASE_SET_EVAL).toHaveLength(32);
    const ids = CORRECTION_ABSTAIN_CASE_SET_EVAL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("B群の新規24件は ascii/jpname/numeral の3索引型 × kind4 × 2インスタンスである", () => {
    const newAbstainIds = new Set([
      "neg-ticket-1",
      "neg-proj-1",
      "vague-ascii-1",
      "vague-ascii-2",
      "person-ticket-1",
      "person-proj-1",
      "period-ticket-1",
      "period-proj-1",
      "neg-jpname-1",
      "neg-jpname-2",
      "vague-jpname-1",
      "vague-jpname-2",
      "person-jpname-1",
      "person-jpname-2",
      "period-jpname-1",
      "period-jpname-2",
      "neg-numeral-1",
      "neg-numeral-2",
      "vague-numeral-1",
      "vague-numeral-2",
      "person-numeral-1",
      "person-numeral-2",
      "period-numeral-1",
      "period-numeral-2",
    ]);
    expect(newAbstainIds.size).toBe(24);
    for (const id of newAbstainIds) {
      expect(CORRECTION_ABSTAIN_CASE_SET_EVAL.some((c) => c.id === id)).toBe(true);
    }
    const newCases = CORRECTION_ABSTAIN_CASE_SET_EVAL.filter((c) => newAbstainIds.has(c.id));
    // kind4 それぞれに、新規6件（索引型3 × 2インスタンス）が付いている。
    for (const kind of ["negation", "vague", "other_person", "other_period"] as const) {
      expect(newCases.filter((c) => c.kind === kind)).toHaveLength(6);
    }
    // 索引型ごとに kind4 × 2インスタンス = 8件。ASCII は id が ticket/proj のどちらか、
    // 日本語固有名詞は jpname、数詞は numeral を含む——3型で新規24件を分割する。
    const asciiCount = newCases.filter((c) => /ticket|proj|ascii/i.test(c.id)).length;
    const jpnameCount = newCases.filter((c) => c.id.includes("jpname")).length;
    const numeralCount = newCases.filter((c) => c.id.includes("numeral")).length;
    expect(asciiCount).toBe(8);
    expect(jpnameCount).toBe(8);
    expect(numeralCount).toBe(8);
  });

  it("kind=vague は（既存・新規とも）protectedFacts が空配列（守るべき相手が記憶に無い）", () => {
    for (const c of CORRECTION_ABSTAIN_CASE_SET_EVAL) {
      if (c.kind === "vague") {
        expect(c.protectedFacts).toEqual([]);
      }
    }
  });

  it("B群の新規24件のうち kind!=vague は protectedFacts を1件以上持つ", () => {
    const newAbstainIds = new Set([
      "neg-ticket-1",
      "neg-proj-1",
      "person-ticket-1",
      "person-proj-1",
      "period-ticket-1",
      "period-proj-1",
      "neg-jpname-1",
      "neg-jpname-2",
      "person-jpname-1",
      "person-jpname-2",
      "period-jpname-1",
      "period-jpname-2",
      "neg-numeral-1",
      "neg-numeral-2",
      "person-numeral-1",
      "person-numeral-2",
      "period-numeral-1",
      "period-numeral-2",
    ]);
    for (const c of CORRECTION_ABSTAIN_CASE_SET_EVAL) {
      if (newAbstainIds.has(c.id)) {
        expect(c.protectedFacts.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("すべてのケースが grounds（否定できる具体的な根拠）を持つ", () => {
    for (const c of [...CORRECTION_HIT_CASE_SET_EVAL, ...CORRECTION_ABSTAIN_CASE_SET_EVAL]) {
      expect(c.grounds.length).toBeGreaterThan(0);
    }
  });
});
