// 記録済みデータ（`fixtures/extraction-context-eval-a2-reproduction.json`）の再生だけで、実 API は叩かない。
// 記録と再計算が一致することを縛る（記録が手直しされていないことの歯止め）。ばらつきの記録であって、「n回中n回通ること」を新たな門にはしない。
import { describe, expect, it } from "vitest";
import { evalCases } from "./fixtures/extraction-context-eval-cases.mjs";
import reproduction from "./fixtures/extraction-context-eval-a2-reproduction.json" with { type: "json" };

const CASE_ID = "eval-a2-meeting-time-reference";
const evalCase = evalCases.find((c) => c.id === CASE_ID)!;

function includesTarget(memories: { content?: string; digest?: string | null }[]): boolean {
  const text = memories.map((m) => [m.content, m.digest].filter(Boolean).join("\n")).join("\n");
  return evalCase.expect.includes.every((word: string) => text.includes(word));
}

describe("Issue #704: eval-a2 reproducibility recording is not stale", () => {
  it(`recorded case id matches ${CASE_ID}`, () => {
    expect(reproduction.caseId).toBe(CASE_ID);
  });

  it("recomputing pass/fail from the raw recorded memories reproduces row.passed for every run", () => {
    for (const row of reproduction.rows) {
      expect(
        includesTarget(row.memories),
        `run ${row.run}: recomputed judgment should match the recorded row.passed`,
      ).toBe(row.passed);
    }
  });

  it("recomputed survived count matches the recorded top-level `survived` field", () => {
    const recomputedSurvived = reproduction.rows.filter((row) =>
      includesTarget(row.memories),
    ).length;
    expect(recomputedSurvived).toBe(reproduction.survived);
  });

  it(`documents the reproducibility ratio (${reproduction.survived}/${reproduction.requests}) without turning it into a stricter gate`, () => {
    // 5/5 という比率自体を将来も5/5であり続けることの保証にはしない（実装のふるまいの記録であって新しい確定判定ではない）。
    expect(reproduction.requests).toBe(5);
    expect(reproduction.survived).toBeGreaterThanOrEqual(0);
    expect(reproduction.survived).toBeLessThanOrEqual(reproduction.requests);
  });
});
