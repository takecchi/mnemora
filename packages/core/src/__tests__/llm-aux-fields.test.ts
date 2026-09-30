import { describe, expect, it } from "vitest";
import {
  DROPPED_TAG_INDEXES_MAX,
  MAX_TAG_CODE_POINTS,
  sanitizeCandidateAuxFields,
} from "../llm-aux-fields.js";
import { deriveClaimKeys } from "../claim-key.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";

/** 補助の欄（digest・tags・claim key）の「保存できない値」だけを落とす（ADR 0443）。 */
describe("sanitizeCandidateAuxFields", () => {
  const base = { content: "本文", provenanceKind: "stated" as const };

  it("落とす欄が無ければ、渡した候補そのものを返す", () => {
    const candidate = {
      ...base,
      digest: "要旨",
      tags: [" a ", "a", "😀".repeat(MAX_TAG_CODE_POINTS)],
    };
    const result = sanitizeCandidateAuxFields(candidate);
    expect(result.candidate).toBe(candidate);
    expect(result.dropped).toEqual([]);
  });

  it("digest の NUL: digest を無くす（ほかの欄は残す）", () => {
    const result = sanitizeCandidateAuxFields({ ...base, digest: "a\u0000b", tags: ["x"] });
    expect(result.candidate).toEqual({ ...base, tags: ["x"] });
    expect(result.candidate).not.toHaveProperty("digest");
    expect(result.dropped).toEqual([{ field: "digest", reason: "nul_character" }]);
  });

  it("tags: NUL の要素と上限を1字超える要素だけを、添字つきで捨てる", () => {
    const tooLong = "😀".repeat(MAX_TAG_CODE_POINTS + 1);
    const result = sanitizeCandidateAuxFields({ ...base, tags: ["a", "b\u0000", tooLong, "a"] });
    expect(result.candidate.tags).toEqual(["a", "a"]);
    expect(result.dropped).toEqual([
      { field: "tags", reason: "nul_character", count: 1, tagIndexes: [1] },
      { field: "tags", reason: "too_long", count: 1, tagIndexes: [2] },
    ]);
  });

  it("添字は上限で切り、数は全件を数える", () => {
    const tags = Array.from({ length: DROPPED_TAG_INDEXES_MAX + 5 }, () => "\u0000");
    const { dropped } = sanitizeCandidateAuxFields({ ...base, tags });
    expect(dropped[0]!.count).toBe(DROPPED_TAG_INDEXES_MAX + 5);
    expect(dropped[0]!.tagIndexes).toHaveLength(DROPPED_TAG_INDEXES_MAX);
  });
});

describe("deriveClaimKeys: NUL を含む要素は null（ADR 0443）", () => {
  const llm = (claims: Array<{ subject: string; predicate: string }>): LLMProvider => ({
    complete: async () => ({ content: "" }),
    completeStructured: async (_ctx, req) => req.schema.parse({ claims }),
  });

  it("subject・predicate のどちらかが NUL を含めば null、ほかの鍵は残る", async () => {
    const result = await deriveClaimKeys(
      llm([
        { subject: "user\u0000", predicate: "likes" },
        { subject: "user", predicate: "li\u0000kes" },
        { subject: "user", predicate: "eats" },
      ]),
      { tenantId: "t" },
      ["a", "b", "c"],
    );
    expect(result.claimKeys).toEqual([null, null, { subject: "user", predicate: "eats" }]);
    expect(result.failure).toBeNull();
  });
});
