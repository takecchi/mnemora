import { describe, expect, it } from "vitest";
import { ExtractedMemoryCandidateSchema } from "../extraction.js";
import { MemorySchema } from "../memory.js";

/**
 * Issue #1778（#612 / ADR 0271 の確かめ直し）: 抽出候補の `subjectId` は、`Memory.subjectId`・`Observation.subjectId` と
 * 同じ規約（`string | null | undefined`、文字列なら空でない）で受ける（PR #612 の本文）。
 * 以前の歯は、候補の `subjectId` の値の優先順（`resolveCandidateSubjectId`）だけを見ていて、スキーマの `min(1)` を外しても
 * どれも赤にならなかった。ここではスキーマの段だけを縛る（空文字を返した LLM の応答が、端から端までどう扱われるかは見ない）。
 */
const base = { content: "本文", provenanceKind: "stated" as const };

describe("ExtractedMemoryCandidateSchema.subjectId は、Memory.subjectId と同じく空文字を受けない", () => {
  it("空文字は断る（Memory の subjectId も断る）", () => {
    expect(ExtractedMemoryCandidateSchema.safeParse({ ...base, subjectId: "" }).success).toBe(
      false,
    );
    expect(MemorySchema.shape.subjectId.safeParse("").success).toBe(false);
  });

  it("陽性対照: 1文字以上の文字列・null・省略は受ける", () => {
    expect(ExtractedMemoryCandidateSchema.safeParse({ ...base, subjectId: "a" }).success).toBe(
      true,
    );
    expect(ExtractedMemoryCandidateSchema.safeParse({ ...base, subjectId: null }).success).toBe(
      true,
    );
    expect(ExtractedMemoryCandidateSchema.safeParse(base).success).toBe(true);
  });
});
