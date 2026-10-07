import { describe, expect, it } from "vitest";
import {
  GroupCountSchema,
  OmissionSchema,
  RecalledMemorySchema,
  type GroupCount,
  type Omission,
  type RecalledMemory,
} from "../recall.js";

const recalledMemory: RecalledMemory = {
  memoryId: "00000000-0000-4000-8000-000000000001",
  digest: "d",
  retrievedVia: "ann",
  provenanceKind: "imported",
  score: { affinityMeasured: false, decay: 1, tagMatch: 1, freshness: 1, strength: 1 },
  speaker: null,
  subjectId: null,
  recordedAt: new Date("2026-06-01T00:00:00.000Z"),
  occurredAt: null,
  attributes: {},
};

const stageSkipped: Omission = {
  kind: "stage_skipped",
  stage: "candidate_generation",
  reason: "empty_query_content",
};

const groupCount: GroupCount = { axis: "subject", key: null, count: 1, countKind: "exact" };

describe("recall の公開型: 到達できなかった値は union に無い", () => {
  it("RecalledMemory.retrievedVia は ann・lexical・mandatory_companion・association だけを受ける", () => {
    for (const via of ["ann", "lexical", "mandatory_companion", "association"] as const) {
      expect(RecalledMemorySchema.safeParse({ ...recalledMemory, retrievedVia: via }).success).toBe(
        true,
      );
    }
    for (const dropped of ["tag_match", "recency"]) {
      expect(
        RecalledMemorySchema.safeParse({ ...recalledMemory, retrievedVia: dropped }).success,
      ).toBe(false);
    }
    // @ts-expect-error 落とした値は型でも受けない
    const tagMatch: RecalledMemory = { ...recalledMemory, retrievedVia: "tag_match" };
    // @ts-expect-error 落とした値は型でも受けない
    const recency: RecalledMemory = { ...recalledMemory, retrievedVia: "recency" };
    expect([tagMatch, recency]).toHaveLength(2);
  });

  it("StageSkippedOmission.reason は budget_exhausted を受けず、残りの値は受ける", () => {
    for (const reason of [
      "embedding_provider_unavailable",
      "empty_query_content",
      "vector_store_lacks_get_vectors",
      "no_anchor",
      "relation_store_unavailable",
    ]) {
      expect(OmissionSchema.safeParse({ ...stageSkipped, reason }).success).toBe(true);
    }
    expect(OmissionSchema.safeParse({ ...stageSkipped, reason: "budget_exhausted" }).success).toBe(
      false,
    );
    // @ts-expect-error 落とした値は型でも受けない
    const exhausted: Omission = { ...stageSkipped, reason: "budget_exhausted" };
    expect(exhausted).toBeDefined();
  });

  it("GroupCount.axis は time_window を受けず、subject・taxonomy は受ける", () => {
    for (const axis of ["subject", "taxonomy"]) {
      expect(GroupCountSchema.safeParse({ ...groupCount, axis }).success).toBe(true);
    }
    expect(GroupCountSchema.safeParse({ ...groupCount, axis: "time_window" }).success).toBe(false);
    // @ts-expect-error 落とした値は型でも受けない
    const timeWindow: GroupCount = { ...groupCount, axis: "time_window" };
    expect(timeWindow).toBeDefined();
  });
});
