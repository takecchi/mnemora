import { describe, expect, it, vi } from "vitest";
import type { MemoryStore, ObserveResult, RecallResult, Runtime } from "@mnemora/core";
import { runComparison } from "../compare.js";

/** 実 DB では recall が0件の行を作れない。載せる記憶が無い行は報告せず、報告していないと自分で言う（常に true と言わない）ことを、偽の Runtime で見る。 */

function emptyRecall(): RecallResult {
  return {
    recallId: "recall-empty",
    memories: [],
    omitted: [],
    index: { groups: [], totalInScope: 0, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  } as unknown as RecallResult;
}

describe("runComparison: 載せる記憶が0件の行", () => {
  it("使用報告を撃たず、memoryUsageReported は false になる", async () => {
    const observe = vi.fn(
      async (): Promise<ObserveResult> =>
        ({
          observationId: "obs",
          memoryIds: [],
          extraction: "skipped",
          extractionFailure: null,
        }) as unknown as ObserveResult,
    );
    const runtime = {
      observe,
      tick: async () => ({ processed: 0, failed: 0, unsupported: [] }),
      recall: async () => emptyRecall(),
    } as unknown as Runtime;

    const rows = await runComparison(runtime, {
      fillerPairsSequence: [0],
      memoryStore: {} as MemoryStore,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.returnedCount).toBe(0);
    expect(rows[0]?.memoryUsageReported).toBe(false);
    const kinds = observe.mock.calls.map(
      (call) => (call as unknown as [unknown, { kind: string }])[1].kind,
    );
    expect(kinds).not.toContain("memory_usage");
  });
});
