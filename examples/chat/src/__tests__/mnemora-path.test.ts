import { describe, expect, it, vi } from "vitest";
import type {
  Ctx,
  ObserveInput,
  ObserveResult,
  RecallQuery,
  RecallResult,
  Runtime,
} from "@mnemora/core";
import type { Conversation } from "../scenario.js";
import {
  DEFAULT_MNEMORA_PATH_ASSOCIATION,
  buildMnemoraPrompt,
  queryRecall,
  reportMemoryUsage,
} from "../mnemora-path.js";

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-1",
    memories,
    omitted: [],
    index: { groups: [], totalInScope: memories.length, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

function fakeRuntimeCapturingQuery(captured: { query?: RecallQuery }): Runtime {
  return {
    recall: async (_ctx: Ctx, query: RecallQuery) => {
      captured.query = query;
      return recallWith([]);
    },
  } as unknown as Runtime;
}

const FAKE_CONVERSATION: Conversation = {
  turns: [],
  userUtterances: [],
  query: "テストの質問",
};

describe("queryRecall（Issue #291 / ADR 0168: 既定で association を渡す）", () => {
  // chat の独自既定は core の既定と同じ { maxCount: 10 }（ADR 0337）。ベンチの基準線が静かに動かないよう値を縛る。
  it("DEFAULT_MNEMORA_PATH_ASSOCIATION は { maxCount: 10 }", () => {
    expect(DEFAULT_MNEMORA_PATH_ASSOCIATION).toEqual({ maxCount: 10 });
  });

  it("opts.association を省略すると DEFAULT_MNEMORA_PATH_ASSOCIATION を渡す", async () => {
    const captured: { query?: RecallQuery } = {};
    const runtime = fakeRuntimeCapturingQuery(captured);

    await queryRecall(runtime, { tenantId: "t" }, FAKE_CONVERSATION);

    expect(captured.query?.text).toBe("テストの質問");
    expect(captured.query?.association).toEqual(DEFAULT_MNEMORA_PATH_ASSOCIATION);
  });

  it("opts.association: null を渡すと association: null をそのまま packages/core へ転送する（明示的な off の脱出口。ADR 0337）", async () => {
    const captured: { query?: RecallQuery } = {};
    const runtime = fakeRuntimeCapturingQuery(captured);

    await queryRecall(runtime, { tenantId: "t" }, FAKE_CONVERSATION, { association: null });

    // association を省略せず null を転送させる。core の既定が on なので、省略すると連想が走り off の脱出口が黙って壊れる。
    expect(captured.query?.association).toBeNull();
    expect(captured.query && "association" in captured.query).toBe(true);
  });

  it("opts.association に明示的な値を渡すと、それをそのまま渡す（既定を上書きできる）", async () => {
    const captured: { query?: RecallQuery } = {};
    const runtime = fakeRuntimeCapturingQuery(captured);

    await queryRecall(runtime, { tenantId: "t" }, FAKE_CONVERSATION, {
      association: { maxCount: 3 },
    });

    expect(captured.query?.association).toEqual({ maxCount: 3 });
  });
});

describe("buildMnemoraPrompt", () => {
  it("memories が0件なら index の行だけになる（空の digest 行は filter で落ちる）", () => {
    const prompt = buildMnemoraPrompt(recallWith([]));
    expect(prompt).toBe("(索引: スコープ内 0 件のうち 0 件を提示)");
  });

  it("memories がある場合は digest を箇条書きにし、index 行も出す", () => {
    const prompt = buildMnemoraPrompt(
      recallWith([
        {
          memoryId: "m1",
          digest: "テストの digest",
          retrievedVia: "ann",
          provenanceKind: "stated",
          speaker: null,
          subjectId: null,
          score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
        },
      ]),
    );
    expect(prompt).toContain("テストの digest");
    expect(prompt).toContain("[由来:stated]");
    expect(prompt).toContain("1 件のうち 1 件");
  });
});

describe("reportMemoryUsage", () => {
  function fakeRuntime(): { runtime: Runtime; observe: ReturnType<typeof vi.fn> } {
    const observe = vi.fn(async (): Promise<ObserveResult> => ({
      observationId: "obs-1",
      memoryIds: [],
      extraction: "skipped",
      extractionFailure: null,
    }));
    return { runtime: { observe } as unknown as Runtime, observe };
  }

  const ctx: Ctx = { tenantId: "t1" };

  it("memories が0件なら observe() を呼ばず、reported:false を返す", async () => {
    const { runtime, observe } = fakeRuntime();
    const result = await reportMemoryUsage(runtime, ctx, recallWith([]));
    expect(result).toEqual({ reported: false });
    expect(observe).not.toHaveBeenCalled();
  });

  it("memories が在れば、載せた memoryId 集合そのものを usedMemoryIds として observe() する", async () => {
    const { runtime, observe } = fakeRuntime();
    const memories: RecallResult["memories"] = [
      {
        memoryId: "m1",
        digest: "d1",
        retrievedVia: "ann",
        provenanceKind: "stated",
        score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
      },
      {
        memoryId: "m2",
        digest: "d2",
        retrievedVia: "ann",
        provenanceKind: "stated",
        score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
      },
    ];
    const recall = recallWith(memories);
    const result = await reportMemoryUsage(runtime, ctx, recall);

    expect(result).toEqual({ reported: true, recallId: "recall-1", usedMemoryIds: ["m1", "m2"] });
    expect(observe).toHaveBeenCalledTimes(1);
    const [calledCtx, calledInput] = observe.mock.calls[0] as [Ctx, ObserveInput];
    expect(calledCtx).toBe(ctx);
    expect(calledInput).toEqual({
      kind: "memory_usage",
      recallId: "recall-1",
      usedMemoryIds: ["m1", "m2"],
    });
  });
});
