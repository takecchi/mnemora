import { describe, expect, it } from "vitest";
import { groupSupersededCandidatesByOperation } from "../runtime.js";

/**
 * `groupSupersededCandidatesByOperation`（Issue #515 方向①、ADR 0258）の歯。
 *
 * 🔴 これは検出だけの純関数——`previewRestoreSupersededBy?` が返した候補を、
 * 推定される「1回の操作」単位へグルーピングする補助である。書き込みには
 * 一切触れない。`Runtime`/`MemoryStore` には依存しない（入出力とも plain object
 * だけを扱う純粋な関数のため）。
 *
 * 設計の要点（`runtime.ts` の doc コメント参照）:
 * - `"consolidated"` は reason が同じならまとめて1グループ、
 *   `boundaryConfidence: "structural"`。
 * - `"contested_resolved"` は1件ずつ別グループ、`boundaryConfidence: "per_item"`。
 * - それ以外（`"reextract_superseded"` を含む未知の reason、`null`）は
 *   **同じ reason ごとにまとめる**が `boundaryConfidence: "unknown"`——
 *   ⛔ 1件ずつには分割しない（分割すると「1件ずつが別操作」という偽の構造を
 *   与えるため。ADR 0258 決定）。
 */

describe("groupSupersededCandidatesByOperation — consolidated は reason ごとにまとめて structural", () => {
  it("同じ reason の候補は1グループにまとまり、boundaryConfidence は 'structural'", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-a", supersededReason: "consolidated" },
      { memoryId: "mem-b", supersededReason: "consolidated" },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "consolidated",
        memoryIds: ["mem-a", "mem-b"],
        boundaryConfidence: "structural",
      },
    ]);
  });
});

describe("groupSupersededCandidatesByOperation — contested_resolved は1件ずつ per_item", () => {
  it("同じ reason でも、候補ごとに別グループへ分割し boundaryConfidence は 'per_item'", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-x", supersededReason: "contested_resolved" },
      { memoryId: "mem-y", supersededReason: "contested_resolved" },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "contested_resolved",
        memoryIds: ["mem-x"],
        boundaryConfidence: "per_item",
      },
      {
        supersededReason: "contested_resolved",
        memoryIds: ["mem-y"],
        boundaryConfidence: "per_item",
      },
    ]);
  });
});

describe("groupSupersededCandidatesByOperation — reextract_superseded と null は 'unknown'。⛔ 1件ずつに分割しない", () => {
  it("🔴 reextract_superseded は同じ reason ならまとめて返す（分割すると偽の構造を与えるため）", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-6", supersededReason: "reextract_superseded" },
      { memoryId: "mem-9", supersededReason: "reextract_superseded" },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "reextract_superseded",
        memoryIds: ["mem-6", "mem-9"],
        boundaryConfidence: "unknown",
      },
    ]);
  });

  it("由来不明（null）も同様にまとめて 'unknown'", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-1", supersededReason: null },
      { memoryId: "mem-2", supersededReason: null },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: null,
        memoryIds: ["mem-1", "mem-2"],
        boundaryConfidence: "unknown",
      },
    ]);
  });

  it("将来別の書き手が積む未知の reason 文字列も、同じ理由で 'unknown' として扱う（新しい reason を特別扱いしない）", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-a", supersededReason: "some_future_reason" },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "some_future_reason",
        memoryIds: ["mem-a"],
        boundaryConfidence: "unknown",
      },
    ]);
  });
});

describe("groupSupersededCandidatesByOperation — 混在入力・空入力", () => {
  it("reason が異なる候補が混在していても、reason ごとに正しく分かれる", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-a", supersededReason: "consolidated" },
      { memoryId: "mem-x", supersededReason: "contested_resolved" },
      { memoryId: "mem-b", supersededReason: "consolidated" },
      { memoryId: "mem-y", supersededReason: "contested_resolved" },
      { memoryId: "mem-6", supersededReason: "reextract_superseded" },
    ]);

    expect(groups).toEqual([
      {
        supersededReason: "consolidated",
        memoryIds: ["mem-a", "mem-b"],
        boundaryConfidence: "structural",
      },
      {
        supersededReason: "contested_resolved",
        memoryIds: ["mem-x"],
        boundaryConfidence: "per_item",
      },
      {
        supersededReason: "contested_resolved",
        memoryIds: ["mem-y"],
        boundaryConfidence: "per_item",
      },
      {
        supersededReason: "reextract_superseded",
        memoryIds: ["mem-6"],
        boundaryConfidence: "unknown",
      },
    ]);
  });

  it("空配列を渡すと空配列を返す", () => {
    expect(groupSupersededCandidatesByOperation([])).toEqual([]);
  });
});
