import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider, toAnthropicRequest } from "../llm-provider.js";

/** `client` は手書きの偽物で、本物の API を叩かない。ここが測るのは「渡された指定を provider が黙って変えずに送る」ことだけ。 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });

function build(maxTokens: number) {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ content: "x" }) }],
  });
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
    maxTokens,
  });
  return { provider, create };
}

describe("AnthropicLLMProvider: maxTokens はそのまま送る", () => {
  /** TSDoc の約束は「上限は見ない」。モデルごとの上限は provider が知らないので、大きい値も丸めない。 */
  it("complete は、渡した maxTokens をそのまま max_tokens に送る", async () => {
    const { provider, create } = build(64000);

    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(create.mock.calls[0]![0].max_tokens).toBe(64000);
  });

  it("completeStructured も、渡した maxTokens をそのまま max_tokens に送る", async () => {
    const { provider, create } = build(64000);

    await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema,
    });

    expect(create.mock.calls[0]![0].max_tokens).toBe(64000);
  });
});

describe("toAnthropicRequest: system を黙って捨てない", () => {
  it("prompt.system と role: 'system' のメッセージが同じ文字列でも、両方を改行区切りで連結する", () => {
    const result = toAnthropicRequest({
      system: "同じ指示",
      messages: [
        { role: "system", content: "同じ指示" },
        { role: "user", content: "hi" },
      ],
    });

    expect(result.system).toBe("同じ指示\n同じ指示");
  });

  it("role: 'system' のメッセージ同士が同じ文字列でも、重複を畳まず全部連結する", () => {
    const result = toAnthropicRequest({
      messages: [
        { role: "system", content: "同じ指示" },
        { role: "user", content: "hi" },
        { role: "system", content: "同じ指示" },
      ],
    });

    expect(result.system).toBe("同じ指示\n同じ指示");
  });
});
