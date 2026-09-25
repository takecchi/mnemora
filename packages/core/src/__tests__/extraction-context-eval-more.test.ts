// Issue #704 の続き。PR #709（eval-e1/f1/g1/h1、各3回）の後を継ぎ、
// packages/core/src/__tests__/fixtures/extraction-context-eval-more-cases.mjs に
// 実装より前に確定したケース・期待値・根拠（i: 文脈付き参照4本 / j: 曖昧な参照2本 /
// k: 複雑な日時3本 / l: 長い文脈の変種3本）と、
// packages/core/src/__tests__/fixtures/extraction-context-eval-more-recorded.json に
// 実 API（gpt-4.1-mini-2025-04-14、ケースごとに5回）を叩いて録音した結果を突き合わせる。
//
// マネージャー判断（ADR 0299 追記節「5」）と同じ規律: 系統的に落ちるケース・runが
// 見つかっても、直そうとせず it.fails で明示するだけに留める（extraction.ts は
// 1バイトも変えていない）。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { moreEvalCases } from "./fixtures/extraction-context-eval-more-cases.mjs";
import recording from "./fixtures/extraction-context-eval-more-recorded.json" with { type: "json" };

// このコミット時点で、5回中どのrunが機械判定で不合格だったかを固定した記録
// （観測した1回きりの録音に対して静的に決めたもの——録音を後から差し替えても、
// この Set 自体は自動追従しない。差し替えられればタリー側のテストが不一致で赤くなる）。
//
// - eval-i2-absolute-date-reference: run4のみ不合格（4/5）。eval-a2の教訓と同じ形の
//   単発の外れ値——複数run中1回だけの不一致であり、系統的とは呼ばない。
// - eval-l3-length4-position1-meeting-point: run3・4・5が不合格（2/5、過半数割れ）。
//   件数を8→4、対象位置を2件目→1件目（最も有利なはずの先頭）にしても、それでも
//   過半数のrunで「それでお願いします」を逐語のまま記録するだけに留まり、参照先
//   （正面玄関）へ解決できなかった——eval-l1/l2（件数8、位置3・6件目)がどちらも
//   5/5だったのとは対照的で、「件数が少ない・対象が先頭に近い」ことが必ずしも
//   参照解決を助けないことを示す1つの観測である。
const KNOWN_UNMET_RUNS: Record<string, ReadonlySet<number>> = {
  "eval-i2-absolute-date-reference": new Set([4]),
  "eval-l3-length4-position1-meeting-point": new Set([3, 4, 5]),
};

// 上と同じ観測から静的に固定した、ケースごとの5回中の合格数（summary）。
// 再集計した結果がこれと一致することを below のテストが確かめる——記録の書き換えや
// 判定ロジックの変更に対する歯止め。
const EXPECTED_PASS_COUNTS: Record<string, number> = {
  "eval-i1-time-reference-variant": 5,
  "eval-i2-absolute-date-reference": 4,
  "eval-i3-quantity-reference": 5,
  "eval-i4-location-reference-variant": 5,
  "eval-j1-ambiguous-time-two-candidates": 5,
  "eval-j2-ambiguous-quantity-two-candidates": 5,
  "eval-k1-week-after-next-monday-crossing-month": 5,
  "eval-k2-date-range-across-month": 5,
  "eval-k3-recurring-weekly": 5,
  "eval-l1-length8-position3-budget": 5,
  "eval-l2-length8-position6-product-name": 5,
  "eval-l3-length4-position1-meeting-point": 2,
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
  evalCase: (typeof moreEvalCases)[number],
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
  evalCase: (typeof moreEvalCases)[number],
  memories: { content?: string; digest?: string | null }[],
): boolean {
  try {
    judge(evalCase, memories);
    return true;
  } catch {
    return false;
  }
}

describe("Issue #704 follow-up evaluation: prompt reconstruction matches the recording", () => {
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

describe("Issue #704 follow-up evaluation: mechanical judgment per run (5 runs/case, reproducibility)", () => {
  for (const evalCase of moreEvalCases) {
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
      const title = `${evalCase.id} (${evalCase.category}) run ${run.run}/${recordedCase.runs.length}: ${evalCase.rationale}`;
      if (knownUnmetRuns.has(run.run)) {
        // 個々のrunについて、観測済みの不合格を明示する。直そうとしない
        // （マネージャー判断と同じ規律）。実装が直って通るようになったら、
        // it.fails 自体が「予期せず合格した」として失敗しスイートを赤くする。
        it.fails(`${title} [KNOWN UNMET]`, runJudgment);
      } else {
        it(title, runJudgment);
      }
    }
  }
});

describe("Issue #704 follow-up evaluation: per-case reproducibility tally matches the recorded summary", () => {
  for (const evalCase of moreEvalCases) {
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
    for (const evalCase of moreEvalCases) {
      expect(
        Object.hasOwn(EXPECTED_PASS_COUNTS, evalCase.id),
        `${evalCase.id} is missing from EXPECTED_PASS_COUNTS`,
      ).toBe(true);
    }
    expect(Object.keys(EXPECTED_PASS_COUNTS).length).toBe(moreEvalCases.length);
  });
});
