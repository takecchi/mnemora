import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

/** `client` は手書きの偽物で、本物の API を叩かない。ここが測るのは「返ってきた本文に provider が手を加えない・送り直さない・分からないを拒否と読まない」ことだけ。 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });
const structuredRequest = {
  prompt: { messages: [{ role: "user" as const, content: "hi" }] },
  schema,
};

function buildWithResponse(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { provider, create };
}

function endTurn(text: string, extra: Record<string, unknown> = {}) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }], ...extra };
}

describe("AnthropicLLMProvider.complete: 本文を加工しない", () => {
  it("前後に空白・改行を含む本文が、そのまま返る", async () => {
    const raw = "  \n本文の先頭と末尾に空白がある\n\n  ";
    const { provider } = buildWithResponse(endTurn(raw));

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe(raw);
  });
});

describe("AnthropicLLMProvider.completeStructured: 壊れた本文を直さない・送り直さない", () => {
  it("```json の囲みに入った本文は、囲みを剥がして救わず SyntaxError を投げる", async () => {
    const fenced = "```json\n" + JSON.stringify({ content: "本文" }) + "\n```";
    const { provider } = buildWithResponse(endTurn(fenced));

    await expect(provider.completeStructured(ctx, structuredRequest)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("本文が JSON として壊れていても、messages.create は1回しか呼ばれず SyntaxError が伝わる", async () => {
    const { provider, create } = buildWithResponse(endTurn("{ 壊れた JSON"));

    await expect(provider.completeStructured(ctx, structuredRequest)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    // core の LLMProvider はリトライを内蔵しない。送り直すかは呼び出し側が決める。
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicLLMProvider: stop_reason が拒否でなければ拒否と読まない", () => {
  /** `kind: "refusal"` は `stop_reason: "refusal"` のときだけ。分からないものを拒否と読まない。 */
  const stopDetails = { type: "refusal", category: "cyber" };

  it("complete は、end_turn なら stop_details.category があっても本文を返す", async () => {
    const { provider } = buildWithResponse(endTurn("答え", { stop_details: stopDetails }));

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("答え");
  });

  it("completeStructured も、end_turn なら stop_details.category があっても本文を返す", async () => {
    const { provider } = buildWithResponse(
      endTurn(JSON.stringify({ content: "答え" }), { stop_details: stopDetails }),
    );

    const result = await provider.completeStructured(ctx, structuredRequest);

    expect(result).toEqual({ content: "答え" });
  });
});
