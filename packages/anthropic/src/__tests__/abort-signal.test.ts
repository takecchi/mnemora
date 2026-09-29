import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md):
 * `opts?.signal` が `messages.create` の request options（`{ signal }`）へ実際に届くこと、
 * そして SDK が signal を尊重する体の偽 client を使ったとき、abort で reject することを
 * 確かめる（`@mnemora/openai` の同名の歯と同じ形・同じ理由）。
 */
const ctx: Ctx = { tenantId: "tenant-abort" };

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("AnthropicLLMProvider — AbortSignal", () => {
  it("complete: opts.signal がそのまま client.messages.create の第2引数（request options）に渡る", async () => {
    const create = vi.fn().mockResolvedValue(textResponse("ok"));
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    const controller = new AbortController();

    await provider.complete(
      ctx,
      { messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    );

    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it("complete: signal を尊重する体の偽 client では、abort で reject する", async () => {
    const create = vi.fn().mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal!.reason);
          });
        }),
    );
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    const controller = new AbortController();

    const promise = provider.complete(
      ctx,
      { messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(promise).rejects.toBe(controller.signal.reason);
  });

  it("completeStructured: opts.signal が渡り、abort で reject する", async () => {
    const create = vi.fn().mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal!.reason);
          });
        }),
    );
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    const controller = new AbortController();

    const promise = provider.completeStructured(
      ctx,
      {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: z.object({ x: z.string() }),
      },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(promise).rejects.toBe(controller.signal.reason);
    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });
});
