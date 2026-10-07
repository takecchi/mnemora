// 録音した結果（fixtures の recorded.json）の再生。3回中0〜1回しか通らないケースは「系統的な未達」として it.fails で明示し、実装を直そうとしない。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { coverageEvalCases } from "./fixtures/extraction-context-eval-coverage-cases.mjs";
import recording from "./fixtures/extraction-context-eval-coverage-recorded.json" with { type: "json" };

// 3回中0〜1回しか通らないことを確認済みのケースID。
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
        // 実装が直って通るようになったら it.fails 自体が失敗としてスイートを赤くする。
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
