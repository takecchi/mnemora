// Issue #704 のさらに続き。PR #737（`extraction-context-eval-more-cases.mjs` の
// eval-l1/l2/l3）が交絡させたまま残した「件数・位置・言い回しのどれが l3 の
// 2/5（過半数割れ）に効いたか」を切り分けるための評価。
// `packages/core/src/__tests__/fixtures/extraction-context-eval-factors-cases.mjs` に
// 実装より前に確定したケース・期待値・根拠（話題A=集合場所・話題B=締切、各6変種:
// m0基準/m1言い回し/m2件数少/m3件数多/m4位置末尾/m5位置中間、計12件）と、
// `packages/core/src/__tests__/fixtures/extraction-context-eval-factors-recorded.json` に
// 実 API（gpt-4.1-mini-2025-04-14、ケースごとに5回）を叩いて録音した結果を突き合わせる。
//
// マネージャー判断（PR #737 と同じ規律）: 系統的に落ちるケース・runが見つかっても、
// 直そうとせず it.fails で明示するだけに留める（extraction.ts は1バイトも変えていない）。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { factorsEvalCases } from "./fixtures/extraction-context-eval-factors-cases.mjs";
import recording from "./fixtures/extraction-context-eval-factors-recorded.json" with { type: "json" };

// このコミット時点で、5回中どのrunが機械判定で不合格だったかを固定した記録
// （観測した1回きりの録音に対して静的に決めたもの——録音を後から差し替えても、
// この Set 自体は自動追従しない。差し替えられればタリー側のテストが不一致で赤くなる）。
//
// 話題A（集合場所=正面玄関、eval-l3と同じ題材）:
// - m0基準: 1/5（run3のみ合格）。eval-l3（PR #737、同一入力、2/5）とは1/5対2/5で
//   完全には一致しないが、どちらも「過半数割れ」という同じ低い水準にあり、n=5の
//   ばらつきの範囲内として扱う——m0がl3を4〜5/5で再現しなかったわけではない。
// - m1言い回し（疑問形）: 4/5（run2のみ不合格）。
// - m2件数少（提案1件のみ）: 5/5（全合格）。
// - m3件数多（8件、提案は1件目）: 1/5（run3のみ合格）。
// - m4位置末尾（4件目）: 3/5（run2・4が不合格）。
// - m5位置中間（2件目）: 0/5（全不合格）。
//
// 話題B（締切=金曜日）:
// - m0基準: 2/5（run3・4・5が不合格）。
// - m1言い回し: 2/5（run3・4・5が不合格、m0と同じ不合格パターン）。
// - m2件数少: 2/5（run2・3・4が不合格）。
// - m3件数多: 0/5（全不合格）。
// - m4位置末尾: 0/5（全不合格）。
// - m5位置中間: 1/5（run1〜4が不合格）。
//
// 話題間で揃って5/5近くまで回復した要因は無かった——話題Aのm2（5/5）は話題Bのm2
// （2/5、m0と同水準）では再現しておらず、他の要因も同様に話題間で一致した回復を
// 示さなかった。詳細な分析はADR 0299「追記3」とマネージャーへの報告に書く。
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

// 上と同じ観測から静的に固定した、ケースごとの5回中の合格数（summary）。
// 再集計した結果がこれと一致することを below のテストが確かめる——記録の書き換えや
// 判定ロジックの変更に対する歯止め。
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
