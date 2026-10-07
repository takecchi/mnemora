import { describe, expect, it } from "vitest";
import type { Ctx, Runtime, TickResult } from "@mnemora/core";
import { ingestConversation } from "../mnemora-path.js";
import { buildConversation } from "../scenario.js";

const ctx: Ctx = { tenantId: "ingest-conversation-drain-result" };

function tickResult(processed: number, failed: number): TickResult {
  return { processed, failed, unsupported: [], leaseConflicts: [] };
}

function fakeRuntime(processedFirst: number, failedFirst: number): Runtime {
  let ticks = 0;
  let observed = 0;
  return {
    observe: async () => {
      observed += 1;
      return { memoryIds: [`memory-${String(observed)}`] };
    },
    tick: async () => {
      ticks += 1;
      return ticks === 1 ? tickResult(processedFirst, failedFirst) : tickResult(0, 0);
    },
  } as unknown as Runtime;
}

describe("examples/chat: ingestConversation の返り値（drain の結果）", () => {
  it("embed に失敗した件があれば、その件数を totalFailed で返す（捨てない）", async () => {
    const conversation = buildConversation(3);
    const total = conversation.userUtterances.length;
    const result = await ingestConversation(fakeRuntime(total - 2, 2), ctx, conversation);
    expect(result.totalProcessed).toBe(total - 2);
    expect(result.totalFailed).toBe(2);
  });

  it("陽性対照: 失敗が無ければ totalFailed は 0、処理した件数は observe した件数", async () => {
    const conversation = buildConversation(3);
    const total = conversation.userUtterances.length;
    const result = await ingestConversation(fakeRuntime(total, 0), ctx, conversation);
    expect(result.totalProcessed).toBe(total);
    expect(result.totalFailed).toBe(0);
  });
});
