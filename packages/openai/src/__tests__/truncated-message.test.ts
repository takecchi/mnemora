import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import type { OpenAILLMProviderError } from "../errors.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 出力が途中で切れた（`finish_reason: "length"`）ときの例外の文面。
 *
 * この provider は `max_tokens` を送らない（設定が無い）ので、「`max_tokens` を上げよ」とは
 * 勧められない。起きたこと（途中で切れた・`finish_reason`）と、直し方（入力を短くする。上限は
 * モデル側にある）を書く。プロンプトや応答の本文は文面に載せない。種類（`name`・`kind`・
 * `finishReason`）は文面とは別に守る。
 */
const ctx: Ctx = { tenantId: "tenant-1" };
const PROMPT_BODY = "秘密の本文-プロンプト-9f3a";
const PARTIAL_CONTENT = '{"content":"途中までの応答-7c1d';

function buildTruncated() {
  const create = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: "length", message: { refusal: null, content: PARTIAL_CONTENT } }],
  });
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return provider;
}

async function captureError(run: () => Promise<unknown>): Promise<OpenAILLMProviderError> {
  try {
    await run();
  } catch (error) {
    return error as OpenAILLMProviderError;
  }
  return expect.fail("例外が投げられなかった");
}

describe("OpenAILLMProvider: truncated の例外の文面", () => {
  const request = {
    prompt: { messages: [{ role: "user" as const, content: PROMPT_BODY }] },
    schema: z.object({ content: z.string() }),
  };

  it("起きたこと: 途中で切れたことと finish_reason を名乗る", async () => {
    const error = await captureError(() => buildTruncated().completeStructured(ctx, request));

    expect(error.message).toContain("OpenAILLMProvider: the response was cut off");
    expect(error.message).toContain("(finish_reason: length)");
  });

  it("直し方: 入力を短くするよう書き、設定の無い max_tokens を上げるよう勧めない", async () => {
    const error = await captureError(() => buildTruncated().completeStructured(ctx, request));

    expect(error.message).toContain("shorten the input");
    expect(error.message).toContain("does not set max_tokens");
    expect(error.message).not.toContain("raise max_tokens");
  });

  it("プロンプトの本文も応答の本文も、文面に載せない", async () => {
    const error = await captureError(() => buildTruncated().completeStructured(ctx, request));

    expect(error.message).not.toContain(PROMPT_BODY);
    expect(error.message).not.toContain(PARTIAL_CONTENT);
  });

  it("種類・名前・フィールドは文面と関係なく変わらない", async () => {
    const error = await captureError(() => buildTruncated().completeStructured(ctx, request));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OpenAILLMProviderError");
    expect(error.kind).toBe("truncated");
    expect(error.finishReason).toBe("length");
  });
});
