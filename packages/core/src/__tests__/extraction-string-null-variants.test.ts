import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, sanitizeCandidateSubjectId } from "../extraction.js";
import type { Observation } from "../observation.js";

/**
 * 文字列 `"null"` の特例の「広がり過ぎ」を縛る歯（Issue #608・ADR 0304。Issue #1775 の #712）。
 *
 * ADR 0304 の特例は、一覧に無い **ちょうど `"null"`** だけを明示的な null として扱う。
 * PR 本文は「他の非標準表現は未確認」と書く。拾わない現在の動きを固定する——将来拾うと
 * 決めるなら、この歯が先に赤になって決め直すきっかけになる。
 * あわせて、候補一覧つきのプロンプトが「明示的に null を設定」を指示し、引用符つきの
 * `"null"` を指示しないこと（モデルへ文字列 `"null"` を返すよう教えない）を縛る。
 */

function makeObservation(): Observation {
  return {
    id: "obs-1",
    tenantId: "tenant-1",
    subjectId: "user-1",
    externalId: null,
    kind: "utterance",
    payload: { text: "明日は東京に出張する予定です", speaker: "田中" },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:01.000Z"),
  };
}

describe('sanitizeCandidateSubjectId — 文字列 "null" の特例は、ちょうど "null" だけ', () => {
  it.each(["NULL", "Null", " null ", "nil", "None", "null\n", "ｎｕｌｌ"])(
    "%j は一覧外として弾かれる（未指定へ戻り、rejected: true）",
    (value) => {
      expect(sanitizeCandidateSubjectId(value, ["user:a", "user:b"])).toEqual({
        subjectId: undefined,
        rejected: true,
      });
    },
  );
});

describe("buildExtractionPrompt — 候補一覧つきの指示文（ADR 0304）", () => {
  it('「明示的に null を設定」を含み、引用符つきの "null" を含まない', () => {
    const prompt = buildExtractionPrompt(makeObservation(), ["user:a", "user:b"]);
    expect(prompt.system).toContain("明示的に null を設定してください");
    expect(prompt.system).not.toContain('"null"');
    expect(prompt.system).not.toContain("「null」");
  });
});
