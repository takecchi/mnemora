import { describe, expect, it } from "vitest";
import { ExtractedMemoryCandidateSchema } from "../extraction.js";
import { MemorySchema } from "../memory.js";

/** ここではスキーマの段だけを縛る: 候補の `subjectId` の優先順（`resolveCandidateSubjectId`）だけを見る歯では、スキーマの `min(1)` を外しても赤にならない。 */
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
