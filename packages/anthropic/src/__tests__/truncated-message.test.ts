import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import type { AnthropicLLMProviderError } from "../errors.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * 応答が途中で切れた（`stop_reason: "max_tokens"` / `"model_context_window_exceeded"`）ときの
 * 例外の文面。直し方は `stop_reason` で違う——`max_tokens` なら `maxTokens` を上げれば効くが、
 * `model_context_window_exceeded`（入力が文脈窓を超えた）には効かず、入力を短くするしかない。
 * 起きたこと（途中で切れた・`stop_reason`）も名乗る。プロンプトや応答の本文は文面に載せない。
 * 種類（`name`・`kind`・`stopReason`）は文面とは別に守る。
 */
const ctx: Ctx = { tenantId: "tenant-1" };
const PROMPT_BODY = "秘密の本文-プロンプト-9f3a";
const PARTIAL_CONTENT = '{"content":"途中までの応答-7c1d';

function buildTruncated(stopReason: string) {
  const create = vi.fn().mockResolvedValue({
    stop_reason: stopReason,
    stop_details: null,
    content: [{ type: "text", text: PARTIAL_CONTENT }],
  });
  return new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<AnthropicLLMProviderError> {
  try {
    await run();
  } catch (error) {
    return error as AnthropicLLMProviderError;
  }
  return expect.fail("例外が投げられなかった");
}

describe("AnthropicLLMProvider: truncated の例外の文面", () => {
  const request = {
    prompt: { messages: [{ role: "user" as const, content: PROMPT_BODY }] },
    schema: z.object({ content: z.string() }),
  };

  it.each(["max_tokens", "model_context_window_exceeded"])(
    "起きたこと: 途中で切れたことと stop_reason（%s）を名乗る",
    async (stopReason) => {
      const error = await captureError(() =>
        buildTruncated(stopReason).completeStructured(ctx, request),
      );

      expect(error.message).toContain("AnthropicLLMProvider: the response was cut off");
      expect(error.message).toContain(`(stop_reason: ${stopReason})`);
    },
  );

  it("直し方: stop_reason ごとに違う手を書く（max_tokens は maxTokens を上げる・文脈窓超えは入力を短くする）", async () => {
    const error = await captureError(() =>
      buildTruncated("max_tokens").completeStructured(ctx, request),
    );

    expect(error.message).toContain("raise maxTokens if stop_reason is max_tokens");
    expect(error.message).toContain("shorten the input if it is model_context_window_exceeded");
  });

  it.each(["max_tokens", "model_context_window_exceeded"])(
    "プロンプトの本文も応答の本文も、文面に載せない（%s）",
    async (stopReason) => {
      const error = await captureError(() =>
        buildTruncated(stopReason).completeStructured(ctx, request),
      );

      expect(error.message).not.toContain(PROMPT_BODY);
      expect(error.message).not.toContain(PARTIAL_CONTENT);
    },
  );

  it("種類・名前・フィールドは文面と関係なく変わらない", async () => {
    const error = await captureError(() =>
      buildTruncated("model_context_window_exceeded").completeStructured(ctx, request),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AnthropicLLMProviderError");
    expect(error.kind).toBe("truncated");
    expect(error.stopReason).toBe("model_context_window_exceeded");
  });
});
