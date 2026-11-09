// 応答の `model`（実際に応答したモデル）を `respondedModel` として返すこと（ADR 0701）。注入した偽 client で測り、実 API の値は測らない。

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AnthropicLLMProvider } from "../llm-provider.js";

const ctx = { tenantId: "t" };
const schema = z.object({ content: z.string() });

function providerRespondingWith(model: unknown): AnthropicLLMProvider {
  const create = vi.fn(async (params: { output_config?: unknown }) => ({
    ...(model === undefined ? {} : { model }),
    stop_reason: "end_turn",
    content: [
      { type: "text", text: params.output_config ? JSON.stringify({ content: "x" }) : "x" },
    ],
  }));
  return new AnthropicLLMProvider({
    model: "claude-alias",
    client: { messages: { create } } as never,
  });
}

const prompt = { messages: [{ role: "user" as const, content: "hi" }] };

describe("AnthropicLLMProvider: respondedModel は応答の model であり、要求に使った model ではない", () => {
  it("応答の model を返す（要求の claude-alias ではなく、応答の claude-resolved-20260101）", async () => {
    const provider = providerRespondingWith("claude-resolved-20260101");

    expect(await provider.complete(ctx, prompt)).toEqual({
      content: "x",
      respondedModel: "claude-resolved-20260101",
    });
    expect(await provider.completeStructuredWithMeta(ctx, { prompt, schema })).toEqual({
      value: { content: "x" },
      respondedModel: "claude-resolved-20260101",
    });
  });

  it.each([
    ["model が無い", undefined],
    ["model が空文字", ""],
    ["model が null", null],
  ])("%s応答では、respondedModel をキーごと省く（設定値で埋めない）", async (_label, model) => {
    const provider = providerRespondingWith(model);

    expect(await provider.complete(ctx, prompt)).toEqual({ content: "x" });
    expect(await provider.completeStructuredWithMeta(ctx, { prompt, schema })).toEqual({
      value: { content: "x" },
    });
  });

  it("completeStructured は従来どおり値だけを返す", async () => {
    const provider = providerRespondingWith("claude-resolved-20260101");

    expect(await provider.completeStructured(ctx, { prompt, schema })).toEqual({ content: "x" });
  });
});
