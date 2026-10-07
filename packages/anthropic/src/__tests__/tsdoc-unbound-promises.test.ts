import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";
import { AnthropicLLMProviderError } from "../errors.js";
import { translateForAnthropicStructuredOutput } from "../json-schema.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };
const schema = z.object({ a: z.string() });

function providerWith(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  return {
    create,
    provider: new AnthropicLLMProvider({ model: "m", client: { messages: { create } } as never }),
  };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => expect.fail("例外が投げられなかった"),
    (reason: unknown) => reason,
  );
}

describe("complete: 切り詰めも種類で返す（TSDoc）", () => {
  it.each(["max_tokens", "model_context_window_exceeded"])(
    "stop_reason: '%s' は kind: 'truncated'",
    async (stopReason) => {
      const { provider } = providerWith({
        stop_reason: stopReason,
        content: [{ type: "text", text: "途中" }],
      });
      const error = (await rejection(() =>
        provider.complete(ctx, prompt),
      )) as AnthropicLLMProviderError;
      expect(error.kind).toBe("truncated");
      expect(error.stopReason).toBe(stopReason);
    },
  );
});

describe("鍵が見つからないとき（README「前提」・クラスの TSDoc）", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  });

  it("構築は通り、complete() を呼んだ時点で SDK の素の Error（Could not resolve authentication method）が伝わる", async () => {
    const provider = new AnthropicLLMProvider({ model: "m" });
    const error = await rejection(() => provider.complete(ctx, prompt));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Could not resolve authentication method/);
    expect(error).not.toBeInstanceOf(AnthropicLLMProviderError);
    expect(error).not.toHaveProperty("kind");
  });
});

describe("最初のテキストブロックを使う（thinking 等の他のブロックは無視する）", () => {
  it("先頭が thinking ブロックでも、complete は後ろのテキストブロックを返す", async () => {
    const { provider } = providerWith({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "考え中", signature: "s" },
        { type: "text", text: "答え" },
      ],
    });
    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "答え" });
  });

  it("completeStructured も thinking ブロックを飛ばして JSON を読む", async () => {
    const { provider } = providerWith({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: '{"a":"thinking"}', signature: "s" },
        { type: "text", text: '{"a":"text"}' },
      ],
    });
    await expect(provider.completeStructured(ctx, { prompt, schema })).resolves.toEqual({
      a: "text",
    });
  });
});

describe("翻訳: min・max も制約としては送らず、description へ降格する（README の @mnemora/openai との違いの表）", () => {
  it("z.number().min().max()・z.string().max() の制約は、description に入り、JSON Schema の鍵には残らない", () => {
    const { schema: sent } = translateForAnthropicStructuredOutput(
      z.object({ n: z.number().min(0).max(1), s: z.string().max(5) }),
    );
    const properties = sent["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["n"]).not.toHaveProperty("minimum");
    expect(properties["n"]).not.toHaveProperty("maximum");
    expect(properties["n"]!["description"]).toContain("minimum: 0");
    expect(properties["n"]!["description"]).toContain("maximum: 1");
    expect(properties["s"]).not.toHaveProperty("maxLength");
    expect(properties["s"]!["description"]).toContain("maxLength: 5");
  });
});

describe("応答の形そのものが壊れているとき（Issue #885）: 生の TypeError のまま伝わる", () => {
  it.each([
    ["complete", (p: AnthropicLLMProvider) => p.complete(ctx, prompt)],
    [
      "completeStructured",
      (p: AnthropicLLMProvider) => p.completeStructured(ctx, { prompt, schema }),
    ],
  ] as const)("%s: content の鍵が無い応答", async (_name, run) => {
    const { provider } = providerWith({ stop_reason: "end_turn" });
    const error = await rejection(() => run(provider));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(AnthropicLLMProviderError);
    expect(error).not.toHaveProperty("kind");
  });
});

describe("client を省いたとき、SDK 既定の再試行・timeout が効く（README の Issue #884。SDK の版が上がれば変わりうる）", () => {
  it("maxRetries 2・timeout 600000ms", () => {
    const provider = new AnthropicLLMProvider({ apiKey: "sk-ant-test", model: "m" });
    // `client` は TypeScript の private であり、実行時には読める。
    const client = (provider as unknown as { client: { maxRetries: number; timeout: number } })
      .client;
    expect(client.maxRetries).toBe(2);
    expect(client.timeout).toBe(600000);
  });
});

describe("AnthropicLLMProviderError の既定値", () => {
  it("name は 'AnthropicLLMProviderError'、stopReason・refusalCategory は省けば null", () => {
    const error = new AnthropicLLMProviderError({ kind: "no_content" });
    expect(error.name).toBe("AnthropicLLMProviderError");
    expect(error.stopReason).toBeNull();
    expect(error.refusalCategory).toBeNull();
  });
});
