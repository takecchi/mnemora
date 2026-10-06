import { describe, expect, it } from "vitest";
import { groupSupersededCandidatesByOperation } from "../runtime.js";

/**
 * `groupSupersededCandidatesByOperation`（ADR 0258）の "unknown" 側の歯——
 * 「同じ `supersededReason` の値ごとにまとめる」の *ごと* を固定する。
 *
 * `superseded-operation-grouping.test.ts` は "unknown" の候補を、1入力につき1種類の reason
 * （`reextract_superseded` だけ、または `null` だけ）でしか試していない。
 * ⟹ 「"unknown" をすべて1グループに潰す」変異（group key を reason でなく boundaryConfidence にする）が
 * すり抜ける。潰すと、グループの `supersededReason` が一部の候補について嘘になる。
 */
describe("groupSupersededCandidatesByOperation — unknown 側は reason の値ごとに分ける", () => {
  it("reextract_superseded・null・未知の文字列が混在しても、値ごとに別グループ（各グループ内はまとめ、1件ずつには分割しない）", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-1", supersededReason: "reextract_superseded" },
      { memoryId: "mem-2", supersededReason: null },
      { memoryId: "mem-3", supersededReason: "some_future_reason" },
      { memoryId: "mem-4", supersededReason: "reextract_superseded" },
      { memoryId: "mem-5", supersededReason: null },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "reextract_superseded",
        memoryIds: ["mem-1", "mem-4"],
        boundaryConfidence: "unknown",
      },
      { supersededReason: null, memoryIds: ["mem-2", "mem-5"], boundaryConfidence: "unknown" },
      {
        supersededReason: "some_future_reason",
        memoryIds: ["mem-3"],
        boundaryConfidence: "unknown",
      },
    ]);
  });
});
