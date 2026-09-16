import { describe, expect, it } from "vitest";
import type { Ctx, RecallQuery, RecallResult, Runtime } from "@mnemora/core";
import type { Conversation } from "../scenario.js";
import {
  DEFAULT_MNEMORA_PATH_ASSOCIATION,
  buildMnemoraPrompt,
  queryRecall,
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

/** `queryRecall` が `runtime.recall` に実際に渡した `RecallQuery` を捕まえるだけの fake。 */
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
  it("opts.association を省略すると DEFAULT_MNEMORA_PATH_ASSOCIATION を渡す", async () => {
    const captured: { query?: RecallQuery } = {};
    const runtime = fakeRuntimeCapturingQuery(captured);

    await queryRecall(runtime, { tenantId: "t" }, FAKE_CONVERSATION);

    expect(captured.query?.text).toBe("テストの質問");
    expect(captured.query?.association).toEqual(DEFAULT_MNEMORA_PATH_ASSOCIATION);
  });

  it("opts.association: null を渡すと association を渡さない（packages/core 既定の off のまま呼ぶ脱出口）", async () => {
    const captured: { query?: RecallQuery } = {};
    const runtime = fakeRuntimeCapturingQuery(captured);

    await queryRecall(runtime, { tenantId: "t" }, FAKE_CONVERSATION, { association: null });

    expect(captured.query?.association).toBeUndefined();
    expect(captured.query && "association" in captured.query).toBe(false);
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
    // 空の digest 行を落とさずに join すると先頭に無駄な改行が付く。
    // ここでは「index の行そのものと完全に一致する」ことまで確認する。
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
          score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
        },
      ]),
    );
    expect(prompt).toContain("- テストの digest");
    expect(prompt).toContain("1 件のうち 1 件");
  });
});
