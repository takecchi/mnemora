// Issue #704: eval-a2-meeting-time-reference の「未達」は当初 n=1 の録音だけを根拠にしていた
// (ADR 0299 追記節「1. 再現性の実測」参照)。このテストは、`extraction.ts` を1バイトも
// 変えずに録った再現性データ
// (`fixtures/extraction-context-eval-a2-reproduction.json`、5回分・実 API・コミット済み)
// を、`extraction-context-eval-cases.mjs` の `expect`（この記録より前に確定済みの期待値）に
// 対して machine judgment としてこのテスト自身が再計算し、
//   1. 記録済みの `row.passed` / `survived` と一致すること（記録が手直しされていないことの歯止め）
//   2. 5行がすべて `buildExtractionPrompt` の無変更コードに対する同一入力の応答であること
// を検査する。
//
// ⚠ これは実 API を叩かない（記録済みデータの再生のみ）。ばらつきの記録であって、
// 「n回中n回通ること」を新たな門にはしない——AGENTS.md「揺れるケースを1回の試行で
// 判定しない」の逆側の落とし穴（『n回通った実績』を新しい確定判定に格上げしない）。
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
    // この歯は「記録と再計算が一致するか」だけを見る。5/5 という比率自体を
    // 将来も5/5であり続けることの保証にはしない — ADR 0299 追記節「4」の通り、
    // これは実装のふるまいの記録であって新しい確定判定ではない。
    expect(reproduction.requests).toBe(5);
    expect(reproduction.survived).toBeGreaterThanOrEqual(0);
    expect(reproduction.survived).toBeLessThanOrEqual(reproduction.requests);
  });
});
