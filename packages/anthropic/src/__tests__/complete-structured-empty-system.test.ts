import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function providerWithSpy() {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ content: "本文" }) }],
  });
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { create, provider };
}

describe("AnthropicLLMProvider.completeStructured: 空の system", () => {
  it("system がどれも空文字なら、messages.create に system の鍵を渡さない", async () => {
    const { create, provider } = providerWithSpy();
    await provider.completeStructured(ctx, {
      prompt: {
        system: "",
        messages: [
          { role: "system", content: "" },
          { role: "user", content: "hi" },
        ],
      },
      schema: z.object({ content: z.string() }),
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("system");
  });

  it("空文字の system は連結に入れず、残りだけを system に渡す", async () => {
    const { create, provider } = providerWithSpy();
    await provider.completeStructured(ctx, {
      prompt: {
        system: "",
        messages: [
          { role: "system", content: "" },
          { role: "user", content: "hi" },
          { role: "system", content: "追加指示" },
        ],
      },
      schema: z.object({ content: z.string() }),
    });
    expect(create.mock.calls[0]?.[0]).toHaveProperty("system", "追加指示");
  });
});
