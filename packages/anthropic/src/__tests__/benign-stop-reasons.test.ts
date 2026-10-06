import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * `assertNotRefusedOrTruncated` の「やりすぎ」側の歯（#603 の確かめ直し）。
 *
 * 断るのは `refusal`・`max_tokens`・`model_context_window_exceeded` だけである。応答が最後まで
 * 書き終わって返った正常な `stop_reason`（`end_turn`・`stop_sequence`）と、`stop_reason` が
 * 無い/null の応答は、断らずに本文を返す。
 *
 * `llm-provider.conformance.test.ts` の足場は `end_turn` の応答しか使わないため、
 * 「`stop_sequence` も断る」変異は、適合 suite にも既存の refusal/truncated の歯にもすり抜けていた。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

function providerReturning(stopReason: string | null, text: string): AnthropicLLMProvider {
  const create = vi.fn().mockResolvedValue({
    stop_reason: stopReason,
    stop_details: null,
    content: [{ type: "text", text }],
  });
  return new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
}

describe("AnthropicLLMProvider: 正常に書き終わった stop_reason は断らない", () => {
  it.each(["end_turn", "stop_sequence", null])(
    "complete: stop_reason=%s でも本文をそのまま返す",
    async (stopReason) => {
      const provider = providerReturning(stopReason, "最後まで書いた本文");

      await expect(
        provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] }),
      ).resolves.toEqual({
        content: "最後まで書いた本文",
      });
    },
  );

  it.each(["end_turn", "stop_sequence", null])(
    "completeStructured: stop_reason=%s でも検証済みの値を返す",
    async (stopReason) => {
      const provider = providerReturning(
        stopReason,
        JSON.stringify({ content: "最後まで書いた本文" }),
      );

      await expect(
        provider.completeStructured(ctx, {
          prompt: { messages: [{ role: "user", content: "hi" }] },
          schema: z.object({ content: z.string() }),
        }),
      ).resolves.toEqual({ content: "最後まで書いた本文" });
    },
  );
});
