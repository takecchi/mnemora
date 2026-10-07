// 録音した結果の再生。系統的に落ちるケース・run が見つかっても直そうとせず、it.fails で明示するだけに留める。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { factorsEvalCases } from "./fixtures/extraction-context-eval-factors-cases.mjs";
import recording from "./fixtures/extraction-context-eval-factors-recorded.json" with { type: "json" };

// 固定した Set は録音した結果に対して静的に決めたもので、録音を差し替えても自動追従しない（差し替えればタリー側のテストが不一致で赤くなる）。
const KNOWN_UNMET_RUNS: Record<string, ReadonlySet<number>> = {
  "eval-m0-topicA-baseline": new Set([1, 2, 4, 5]),
  "eval-m1-topicA-wording-question": new Set([2]),
  "eval-m2-topicA-count-fewer": new Set([]),
  "eval-m3-topicA-count-more": new Set([1, 2, 4, 5]),
  "eval-m4-topicA-position-tail": new Set([2, 4]),
  "eval-m5-topicA-position-middle": new Set([1, 2, 3, 4, 5]),
  "eval-m0-topicB-baseline": new Set([3, 4, 5]),
  "eval-m1-topicB-wording-question": new Set([3, 4, 5]),
  "eval-m2-topicB-count-fewer": new Set([2, 3, 4]),
  "eval-m3-topicB-count-more": new Set([1, 2, 3, 4, 5]),
  "eval-m4-topicB-position-tail": new Set([1, 2, 3, 4, 5]),
  "eval-m5-topicB-position-middle": new Set([1, 2, 3, 4]),
};

// 再集計した結果がこれと一致することを下のテストが確かめる（記録の書き換えや判定ロジックの変更に対する歯止め）。
const EXPECTED_PASS_COUNTS: Record<string, number> = {
  "eval-m0-topicA-baseline": 1,
  "eval-m1-topicA-wording-question": 4,
  "eval-m2-topicA-count-fewer": 5,
  "eval-m3-topicA-count-more": 1,
  "eval-m4-topicA-position-tail": 3,
  "eval-m5-topicA-position-middle": 0,
  "eval-m0-topicB-baseline": 2,
  "eval-m1-topicB-wording-question": 2,
  "eval-m2-topicB-count-fewer": 2,
  "eval-m3-topicB-count-more": 0,
  "eval-m4-topicB-position-tail": 0,
  "eval-m5-topicB-position-middle": 1,
};

function findRecordedCase(id: string) {
  const c = recording.cases.find((c) => c.id === id);
  if (!c) throw new Error(`no recorded case for ${id}`);
  return c;
}

function combinedText(memories: { content?: string; digest?: string | null }[]): string {
  return memories.map((m) => [m.content, m.digest].filter(Boolean).join("\n")).join("\n");
}

function judge(
  evalCase: (typeof factorsEvalCases)[number],
  memories: { content?: string; digest?: string | null }[],
) {
  const text = combinedText(memories);
  for (const word of evalCase.expect.includes) {
    expect(text, `expected "${word}" to be present (${evalCase.rationale})`).toContain(word);
  }
  for (const word of evalCase.expect.excludes) {
    expect(
      text,
      `expected "${word}" to be ABSENT (no fabrication / no premature disambiguation: ${evalCase.rationale})`,
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

function passesJudge(
  evalCase: (typeof factorsEvalCases)[number],
  memories: { content?: string; digest?: string | null }[],
): boolean {
  try {
    judge(evalCase, memories);
    return true;
  } catch {
    return false;
  }
}

describe("Issue #704 factor-isolation evaluation: prompt reconstruction matches the recording", () => {
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

describe("Issue #704 factor-isolation evaluation: mechanical judgment per run (5 runs/case, reproducibility)", () => {
  for (const evalCase of factorsEvalCases) {
    const recordedCase = findRecordedCase(evalCase.id);
    const knownUnmetRuns = KNOWN_UNMET_RUNS[evalCase.id] ?? new Set<number>();
    for (const run of recordedCase.runs) {
      const runJudgment = () => {
        const memories = JSON.parse(run.response.message.content!).memories as {
          content?: string;
          digest?: string | null;
        }[];
        judge(evalCase, memories);
      };
      const title = `${evalCase.id} (${evalCase.topic}/${evalCase.factorVariant}) run ${run.run}/${recordedCase.runs.length}: ${evalCase.rationale}`;
      if (knownUnmetRuns.has(run.run)) {
        // 実装が直って通るようになったら、it.fails 自体が「予期せず合格した」として失敗しスイートを赤くする。
        it.fails(`${title} [KNOWN UNMET]`, runJudgment);
      } else {
        it(title, runJudgment);
      }
    }
  }
});

describe("Issue #704 factor-isolation evaluation: per-case reproducibility tally matches the recorded summary", () => {
  for (const evalCase of factorsEvalCases) {
    const recordedCase = findRecordedCase(evalCase.id);
    it(`${evalCase.id}: recomputed pass count from the raw recorded runs matches the recorded summary (${EXPECTED_PASS_COUNTS[evalCase.id]}/${recordedCase.runs.length})`, () => {
      let passed = 0;
      for (const run of recordedCase.runs) {
        const memories = JSON.parse(run.response.message.content!).memories as {
          content?: string;
          digest?: string | null;
        }[];
        if (passesJudge(evalCase, memories)) passed += 1;
      }
      expect(
        passed,
        `${evalCase.id}: recomputed pass count should match the recorded summary`,
      ).toBe(EXPECTED_PASS_COUNTS[evalCase.id]);
    });
  }

  it("every case defined in the fixture has a recorded summary entry (no case silently unaccounted for)", () => {
    for (const evalCase of factorsEvalCases) {
      expect(
        Object.hasOwn(EXPECTED_PASS_COUNTS, evalCase.id),
        `${evalCase.id} is missing from EXPECTED_PASS_COUNTS`,
      ).toBe(true);
    }
    expect(Object.keys(EXPECTED_PASS_COUNTS).length).toBe(factorsEvalCases.length);
  });
});
