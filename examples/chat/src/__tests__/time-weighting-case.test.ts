import { describe, expect, it } from "vitest";
import type { TimeWeightingCase, TimeWeightingCaseKind } from "../time-weighting-case.js";
import { assertTimeWeightingCaseWellFormed } from "../time-weighting-case.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { TIME_WEIGHTING_CASE_SET_EVAL } from "../time-weighting-case-set.eval.js";

/**
 * `time-weighting-case.ts` の検査関数と、ケース集合そのものの機械的な形の検査。
 * **DB 不要・鍵不要**——純関数のみを対象にする。
 */

const ALL_KINDS: TimeWeightingCaseKind[] = [
  "reinforced-fact-vs-fresh-weak",
  "old-event-not-outrank-new",
  "expired-schedule-not-outrank-current",
];

function makeCase(overrides: Partial<TimeWeightingCase> = {}): TimeWeightingCase {
  const recallAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "case-1",
    kind: "reinforced-fact-vs-fresh-weak",
    memories: [
      {
        localId: "m1",
        content: "テスト用の記憶",
        recordedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ],
    question: "テスト用の質問?",
    expected: { kind: "closed-value", accept: ["ok"], reject: ["ng"] },
    recallAt,
    rationale: "テスト用",
    tuningUse: "development",
    ...overrides,
  };
}

describe("assertTimeWeightingCaseWellFormed", () => {
  it("記憶が0件なら例外", () => {
    expect(() => assertTimeWeightingCaseWellFormed(makeCase({ memories: [] }))).toThrow();
  });

  it("recordedAt が recallAt より後なら例外", () => {
    const c = makeCase({
      memories: [
        {
          localId: "m1",
          content: "x",
          recordedAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });
    expect(() => assertTimeWeightingCaseWellFormed(c)).toThrow();
  });

  it("occurredAt が recallAt より後なら例外", () => {
    const c = makeCase({
      memories: [
        {
          localId: "m1",
          content: "x",
          recordedAt: new Date("2025-01-01T00:00:00.000Z"),
          occurredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });
    expect(() => assertTimeWeightingCaseWellFormed(c)).toThrow();
  });

  it("reinforceAt が recallAt より後なら例外", () => {
    const c = makeCase({
      memories: [
        {
          localId: "m1",
          content: "x",
          recordedAt: new Date("2025-01-01T00:00:00.000Z"),
          reinforceAt: [new Date("2027-01-01T00:00:00.000Z")],
        },
      ],
    });
    expect(() => assertTimeWeightingCaseWellFormed(c)).toThrow();
  });

  it("すべての時刻が recallAt 以前なら例外にならない", () => {
    expect(() => assertTimeWeightingCaseWellFormed(makeCase())).not.toThrow();
  });
});

function checkCaseSet(
  label: string,
  cases: readonly TimeWeightingCase[],
  minPerKind: number,
): void {
  describe(`TIME_WEIGHTING_CASE_SET_${label}`, () => {
    it("id が重複しない", () => {
      const ids = cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("すべてのケースが well-formed である", () => {
      for (const c of cases) {
        expect(() => assertTimeWeightingCaseWellFormed(c)).not.toThrow();
      }
    });

    it(`3類型すべてを最低${minPerKind}件ずつ含む`, () => {
      for (const kind of ALL_KINDS) {
        const count = cases.filter((c) => c.kind === kind).length;
        expect(count).toBeGreaterThanOrEqual(minPerKind);
      }
    });

    it("expected.kind は closed-value（gradeAnswer が文字列一致で判定できる形）", () => {
      for (const c of cases) {
        expect(c.expected.kind).toBe("closed-value");
        expect(c.expected.accept.length).toBeGreaterThan(0);
      }
    });

    it("tuningUse が集合と一致する", () => {
      const expectedTuningUse = label === "DEV" ? "development" : "held-out";
      for (const c of cases) {
        expect(c.tuningUse).toBe(expectedTuningUse);
      }
    });
  });
}

checkCaseSet("DEV", TIME_WEIGHTING_CASE_SET_DEV, 2);
checkCaseSet("EVAL", TIME_WEIGHTING_CASE_SET_EVAL, 2);
