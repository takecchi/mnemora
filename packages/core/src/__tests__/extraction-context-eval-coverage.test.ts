// Issue #704「未評価の範囲」（曖昧な参照・複雑な日時・3人以上の会話・長い文脈）の再生テスト。
//
// packages/core/src/__tests__/fixtures/extraction-context-eval-coverage-cases.mjs に
// 実装より前に確定したケース・期待値・根拠と、
// packages/core/src/__tests__/fixtures/extraction-context-eval-coverage-recorded.json に
// 実 API（gpt-4.1-mini-2025-04-14、ケースごとに3回）を叩いて録音した結果を突き合わせる。
//
// マネージャー判断（ADR 0299 追記節「5」参照）: 3回中0〜1回しか通らないケースは
// 「系統的な未達」として it.fails で明示し、実装（extraction.ts）を直そうとしない。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { coverageEvalCases } from "./fixtures/extraction-context-eval-coverage-cases.mjs";
import recording from "./fixtures/extraction-context-eval-coverage-recorded.json" with { type: "json" };

// このコミット時点で3回中0〜1回しか通らないことを確認済みのケースID
// （マネージャー判断により、直そうとせず it.fails で明示するだけに留める）。
//
// eval-h1-long-context-distant-reference: 8件（schema上限）の context の中で、対象の提案
// （2件目「会議室Bで確定します」）が直近の発話ではないとき、3回とも memories が空配列で
// 返った——「会議室B」を対象話者の記憶として拾えなかった（0/3）。捏造ではなく「何も
// 拾わない」側の失敗であり、d系（文脈なし）で見た保守的な挙動と同じ形だが、ここでは
// 拾うべき情報（田中が同意した会議室）が文脈中に実在するため、d系とは違って「未達」である。
const KNOWN_SYSTEMATIC_UNMET_CASE_IDS = new Set(["eval-h1-long-context-distant-reference"]);

function findRecordedCase(id: string) {
  const c = recording.cases.find((c) => c.id === id);
  if (!c) throw new Error(`no recorded case for ${id}`);
  return c;
}

function combinedText(memories: { content?: string; digest?: string | null }[]): string {
  return memories.map((m) => [m.content, m.digest].filter(Boolean).join("\n")).join("\n");
}

function judge(
  evalCase: (typeof coverageEvalCases)[number],
  memories: { content?: string; digest?: string | null }[],
) {
  const text = combinedText(memories);
  for (const word of evalCase.expect.includes) {
    expect(text, `expected "${word}" to be present (${evalCase.rationale})`).toContain(word);
  }
  for (const word of evalCase.expect.excludes) {
    expect(
      text,
      `expected "${word}" to be ABSENT (no fabrication / no cross-speaker attribution: ${evalCase.rationale})`,
    ).not.toContain(word);
  }
  if (evalCase.expect.dateMatch) {
    expect(text, `expected resolved date to match ${evalCase.expect.dateMatch}`).toMatch(
      evalCase.expect.dateMatch,
    );
  }
  if (evalCase.expect.dateMustNotMatch) {
    expect(
      text,
      `expected NO fabricated calendar date matching ${evalCase.expect.dateMustNotMatch}`,
    ).not.toMatch(evalCase.expect.dateMustNotMatch);
  }
}

describe("Issue #704 coverage evaluation: prompt reconstruction matches the recording", () => {
  for (const recordedCase of recording.cases) {
    it(`${recordedCase.id}: rebuilding the prompt from the recorded observation reproduces the recorded prompt (checked once; shared by all ${recordedCase.runs.length} runs)`, () => {
      const observation = {
        id: recordedCase.observation.id,
        tenantId: recordedCase.observation.tenantId,
        kind: recordedCase.observation.kind,
        subjectId: recordedCase.observation.subjectId,
        recordedAt: new Date(recordedCase.observation.recordedAt),
        occurredAt: recordedCase.observation.occurredAt
          ? new Date(recordedCase.observation.occurredAt)
          : undefined,
        payload: recordedCase.observation.payload,
      };
      expect(buildExtractionPrompt(observation)).toEqual(recordedCase.prompt);
    });
  }
});

describe("Issue #704 coverage evaluation: mechanical judgment per run (3 runs/case, reproducibility)", () => {
  for (const evalCase of coverageEvalCases) {
    const recordedCase = findRecordedCase(evalCase.id);
    const known = KNOWN_SYSTEMATIC_UNMET_CASE_IDS.has(evalCase.id);
    for (const run of recordedCase.runs) {
      const runJudgment = () => {
        const memories = JSON.parse(run.response.message.content!).memories as {
          content?: string;
          digest?: string | null;
        }[];
        judge(evalCase, memories);
      };
      const title = `${evalCase.id} (${evalCase.category}) run ${run.run}/${recordedCase.runs.length}: ${evalCase.rationale}`;
      if (known) {
        // 系統的な未達として明示する。直そうとしない（マネージャー判断）。実装が直って
        // 通るようになったら it.fails 自体が失敗としてテストスイートを赤くする。
        it.fails(`${title} [KNOWN SYSTEMATIC UNMET]`, runJudgment);
      } else {
        it(title, runJudgment);
      }
    }
  }
});

describe("Issue #704 coverage evaluation: per-case reproducibility tally", () => {
  for (const evalCase of coverageEvalCases) {
    const recordedCase = findRecordedCase(evalCase.id);
    it(`${evalCase.id}: documents how many of ${recordedCase.runs.length} runs passed, without gating on a stricter threshold`, () => {
      let passed = 0;
      for (const run of recordedCase.runs) {
        const memories = JSON.parse(run.response.message.content!).memories as {
          content?: string;
          digest?: string | null;
        }[];
        try {
          judge(evalCase, memories);
          passed += 1;
        } catch {
          // カウントするだけ。ここでは投げない — 個々の run の合否は上の describe が検査する。
        }
      }
      const known = KNOWN_SYSTEMATIC_UNMET_CASE_IDS.has(evalCase.id);
      if (known) {
        // マネージャー判断の閾値（3回中0〜1回）に収まっていることだけを確認する
        // （閾値そのものを動かす判断はしない）。
        expect(
          passed,
          `${evalCase.id} was marked known-systematic-unmet; expected 0 or 1 of ${recordedCase.runs.length} to pass`,
        ).toBeLessThanOrEqual(1);
      } else {
        expect(
          passed,
          `${evalCase.id} is not marked known-unmet; expected at least 2 of ${recordedCase.runs.length} to pass`,
        ).toBeGreaterThanOrEqual(2);
      }
    });
  }
});
