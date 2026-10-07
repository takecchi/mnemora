import { describe, expect, it } from "vitest";
import {
  CORRECTION_ABSTAIN_CASE_SET_EVAL,
  CORRECTION_HIT_CASE_SET_EVAL,
} from "../correction-case-set.eval.js";

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
    for (const kind of ["negation", "vague", "other_person", "other_period"] as const) {
      expect(newCases.filter((c) => c.kind === kind)).toHaveLength(6);
    }
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
