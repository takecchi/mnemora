// 録音した結果の再生。2段の検査: (1) 録音時に送った prompt を、いま同じ観測から `buildExtractionPrompt` で組み直しても同じになること（記録が腐っていないことの検査）。
// (2) 期待語の包含/非包含・日付文字列の有無による機械的な意味判定（LLM 採点だけを正解にしない）。
//
// 未達のケースは `it.skip` で隠さず `it.fails` で「既知の未達である」ことを明示する: 実装が直って通るようになったら it.fails 自体が失敗に転じてスイートが赤くなり、直ったことに気づける。
import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { evalCases } from "./fixtures/extraction-context-eval-cases.mjs";
import recording from "./fixtures/extraction-context-recorded.eval.json" with { type: "json" };

// 機械判定に外れることを確認済みのケースID。この1回の記録の事実を「プロンプトが時刻を系統的に落とす」という結論には広げないこと（再現性データは逆を示している。ADR 0299 追記節）。
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
      it.fails(
        `${evalCase.id} (${evalCase.category}): KNOWN UNMET — ${evalCase.rationale}`,
        runJudgment,
      );
    } else {
      it(`${evalCase.id} (${evalCase.category}): ${evalCase.rationale}`, runJudgment);
    }
  }
});
