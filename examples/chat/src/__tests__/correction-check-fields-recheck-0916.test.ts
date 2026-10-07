import { describe, expect, it } from "vitest";
import type { CorrectionDemoResult } from "../correction-demo.js";
import { checkCorrectionDemo, checkCorrectionOmission } from "../correction-demo.js";

/** 欄ごとに壊した入力を作る。全欄 true の1例と一部の失敗例だけでは、欄を固定の true に替える実装を落とせない。 */

const ORIGINAL = "original-id";
const CORRECTION = "correction-id";

interface MemoryShape {
  memoryId: string;
  retrievedVia: string;
  companionOf: string | null;
}

function memory(
  memoryId: string,
  retrievedVia = "ann",
  companionOf: string | null = null,
): MemoryShape {
  return { memoryId, retrievedVia, companionOf };
}

interface ResultParts {
  markOutcomeKind: string;
  resolveOutcomeKind: string;
  afterMark: MemoryShape[];
  afterResolve: MemoryShape[];
  omitted: unknown[];
}

function healthy(): ResultParts {
  return {
    markOutcomeKind: "contested",
    resolveOutcomeKind: "resolved",
    afterMark: [memory(ORIGINAL), memory(CORRECTION, "mandatory_companion", ORIGINAL)],
    afterResolve: [memory(CORRECTION)],
    omitted: [{ kind: "filtered", condition: "superseded", count: 1 }],
  };
}

function resultFrom(parts: ResultParts): CorrectionDemoResult {
  return {
    outcome: "resolved",
    originalId: ORIGINAL,
    correctionId: CORRECTION,
    markOutcomeKind: parts.markOutcomeKind,
    resolveOutcomeKind: parts.resolveOutcomeKind,
    afterMark: { memories: parts.afterMark, omitted: [] },
    afterResolve: { memories: parts.afterResolve, omitted: parts.omitted },
  } as unknown as CorrectionDemoResult;
}

function falseFields(parts: ResultParts): string[] {
  const check = checkCorrectionDemo(resultFrom(parts));
  return Object.entries(check)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
}

describe("checkCorrectionDemo は、欄ごとに独立して false になる", () => {
  it("健全な一巡では全欄が true", () => {
    expect(falseFields(healthy())).toEqual([]);
  });

  // 対の相手が居ない・同伴取得が無いときは、「同伴先が相手を指している」も成り立たないので、その欄も一緒に false になる。
  const cases: Array<[string, string[], (parts: ResultParts) => void]> = [
    ["markSucceeded", ["markSucceeded"], (p) => (p.markOutcomeKind = "no_change")],
    ["resolveSucceeded", ["resolveSucceeded"], (p) => (p.resolveOutcomeKind = "no_change")],
    [
      "afterMarkBothPresent",
      ["afterMarkBothPresent", "afterMarkCompanionOfOther"],
      (p) => (p.afterMark = [memory(ORIGINAL, "mandatory_companion", CORRECTION)]),
    ],
    [
      "afterMarkCompanionRetrieval",
      ["afterMarkCompanionRetrieval", "afterMarkCompanionOfOther"],
      (p) => (p.afterMark = [memory(ORIGINAL), memory(CORRECTION)]),
    ],
    [
      "afterMarkCompanionOfOther",
      ["afterMarkCompanionOfOther"],
      (p) => (p.afterMark = [memory(ORIGINAL), memory(CORRECTION, "mandatory_companion", "third")]),
    ],
    [
      "afterResolveOriginalAbsent",
      ["afterResolveOriginalAbsent"],
      (p) => (p.afterResolve = [memory(CORRECTION), memory(ORIGINAL)]),
    ],
    [
      "afterResolveCorrectionPresent",
      ["afterResolveCorrectionPresent"],
      (p) => (p.afterResolve = []),
    ],
  ];

  it.each(cases)("%s を壊すと、その欄が false になる", (_field, expected, break_) => {
    const parts = healthy();
    break_(parts);
    expect(falseFields(parts)).toEqual(expected);
  });
});

describe("checkCorrectionOmission は、superseded の記録が無い・数が0・別の理由なら false", () => {
  function omissionCheck(omitted: unknown[]): boolean {
    const parts = healthy();
    parts.omitted = omitted;
    return checkCorrectionOmission(resultFrom(parts)).afterResolveOriginalOmittedAsSuperseded;
  }

  it("superseded が1件以上で true", () => {
    expect(omissionCheck([{ kind: "filtered", condition: "superseded", count: 1 }])).toBe(true);
  });

  it.each([
    ["記録が無い", []],
    ["件数が0", [{ kind: "filtered", condition: "superseded", count: 0 }]],
    ["別の理由(archived)", [{ kind: "filtered", condition: "archived", count: 3 }]],
    ["別の種類(over_limit)", [{ kind: "over_limit", stage: "rescore", count: 3 }]],
  ])("%s なら false", (_label, omitted) => {
    expect(omissionCheck(omitted)).toBe(false);
  });
});
