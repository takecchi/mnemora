import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

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
