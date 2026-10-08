import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/** `client` は手書きの偽物で、本物の API を叩かない。ここが測るのは「返ってきた本文に provider が手を加えない・送り直さない」ことだけで、LLM の出力の質は見ない（live テスト参照）。 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });
const structuredRequest = {
  prompt: { messages: [{ role: "user" as const, content: "hi" }] },
  schema,
};

function buildWithReply(content: string) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, create };
}

describe("OpenAILLMProvider.complete: 本文を加工しない", () => {
  it("前後に空白・改行を含む本文が、そのまま返る", async () => {
    const raw = "  \n本文の先頭と末尾に空白がある\n\n  ";
    const { provider } = buildWithReply(raw);

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe(raw);
  });
});

describe("OpenAILLMProvider.completeStructured: 壊れた本文を直さない・送り直さない", () => {
  it("```json の囲みに入った本文は、囲みを剥がして救わず SyntaxError を投げる", async () => {
    const fenced = "```json\n" + JSON.stringify({ content: "本文" }) + "\n```";
    const { provider } = buildWithReply(fenced);

    await expect(provider.completeStructured(ctx, structuredRequest)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("本文が JSON として壊れていても、create は1回しか呼ばれず SyntaxError が伝わる", async () => {
    const { provider, create } = buildWithReply("{ 壊れた JSON");

    await expect(provider.completeStructured(ctx, structuredRequest)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    // core の LLMProvider はリトライを内蔵しない。送り直すかは呼び出し側が決める。
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("スキーマに合わない JSON でも、create は1回しか呼ばれず ZodError が伝わる", async () => {
    const { provider, create } = buildWithReply(JSON.stringify({ content: 123 }));

    await expect(provider.completeStructured(ctx, structuredRequest)).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
