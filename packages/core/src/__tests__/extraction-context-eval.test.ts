// Issue #689 の独立意味評価（開発ケースではない）の再生テスト。
//
// packages/core/src/__tests__/fixtures/extraction-context-eval-cases.mjs に
// 実装を読む前に commit したケース・期待値・根拠と、
// packages/core/src/__tests__/fixtures/extraction-context-recorded.eval.json に
// その後1回だけ実 API（gpt-4.1-mini-2025-04-14）を叩いて録音した結果を突き合わせる。
//
// 2段の検査:
//   1. プロンプト再構築の一致 —— 録音時に送った prompt を、いま同じ観測から
//      buildExtractionPrompt で組み直しても同じになること（記録が腐っていないことの検査）。
//   2. 機械的な意味判定 —— 期待語の包含/非包含・日付文字列の有無を一次の判定にする
//      （LLM 採点だけを正解にしない）。
//
// 未達の扱い: 判定に外れたケースが1件ある（eval-a2、下記参照）。期待値は
// 録音後に一切変更していない。it.skip で隠さず、vitest の `it.fails` を使って
// 「既知の未達である」ことをテスト結果そのものに明示する —— この特定の assertion が
// 失敗することを期待しており、もし実装が直って通るようになったら it.fails 自体が
// 失敗に転じてテストスイートが赤くなる（＝直ったことに気づける）。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { evalCases } from "./fixtures/extraction-context-eval-cases.mjs";
import recording from "./fixtures/extraction-context-recorded.eval.json" with { type: "json" };

// このコミット時点で機械判定に外れることを確認済みのケースID。
// eval-a2-meeting-time-reference: 「それで大丈夫です」への同意を stated として拾えているが
// (subjectId=tanaka, provenanceKind=stated)、digest/content のどちらにも具体的な対象
// （"19時"）が残っていない。eval-a1（場所の参照解決）は通っているが、時刻の参照解決は
// この録音では未達だった。ADR 0295「未評価の範囲」・PR #694 本文に明記する。
const KNOWN_UNMET_CASE_IDS = new Set(["eval-a2-meeting-time-reference"]);

function rowFor(id: string) {
  const row = recording.rows.find((r) => r.id === id);
  if (!row) throw new Error(`no recorded row for ${id}`);
  return row;
}

function combinedText(memories: { content?: string; digest?: string | null }[]): string {
  return memories.map((m) => [m.content, m.digest].filter(Boolean).join("\n")).join("\n");
}

describe("Issue #689 independent semantic evaluation: prompt reconstruction matches the recording", () => {
  for (const row of recording.rows) {
    it(`${row.id}: rebuilding the prompt from the recorded observation reproduces the recorded prompt`, () => {
      const observation = {
        id: row.observation.id,
        tenantId: row.observation.tenantId,
        kind: row.observation.kind,
        subjectId: row.observation.subjectId,
        recordedAt: new Date(row.observation.recordedAt),
        occurredAt: row.observation.occurredAt ? new Date(row.observation.occurredAt) : undefined,
        payload: row.observation.payload,
      };
      expect(buildExtractionPrompt(observation)).toEqual(row.prompt);
    });
  }
});

describe("Issue #689 independent semantic evaluation: mechanical judgment of the recorded answers", () => {
  for (const evalCase of evalCases) {
    const row = rowFor(evalCase.id);
    const runJudgment = () => {
      const memories = JSON.parse(row.response.message.content!).memories as {
        content?: string;
        digest?: string | null;
      }[];
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
    };

    if (KNOWN_UNMET_CASE_IDS.has(evalCase.id)) {
      // 既知の未達: このケースは録音の時点で機械判定に外れた（上のコメント参照）。
      // it.fails は「このテストは失敗することを期待する」という明示であり、
      // it.skip のように検査そのものを消すのではない —— 実装が直って判定に
      // 通るようになったら、it.fails 自体が失敗としてテストスイートを赤くする。
      it.fails(`${evalCase.id} (${evalCase.category}): KNOWN UNMET — ${evalCase.rationale}`, runJudgment);
    } else {
      it(`${evalCase.id} (${evalCase.category}): ${evalCase.rationale}`, runJudgment);
    }
  }
});
