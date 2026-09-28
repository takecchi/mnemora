import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";
import { OpenAILLMProviderError } from "../errors.js";

/**
 * TSDoc・README が約束していて、ほかのどのテストも縛っていなかった振る舞いを縛る
 * （provider の公開の口の棚卸し。今の振る舞いの固定であり、望ましい姿の主張ではない）。
 *
 * どれも偽の client か、`client` を省いて構築するだけで、実 API には繋がない（鍵も使わない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };
const schema = z.object({ a: z.string() });

function llmWith(response: unknown, options: { temperature?: number } = {}) {
  const create = vi.fn().mockResolvedValue(response);
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
    ...options,
  });
  return { create, provider };
}

const okResponse = { choices: [{ finish_reason: "stop", message: { content: '{"a":"x"}' } }] };

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => expect.fail("例外が投げられなかった"),
    (reason: unknown) => reason,
  );
}

describe("OpenAILLMProvider が create へ渡すもの", () => {
  it("model を渡す（complete・completeStructured とも）", async () => {
    const { create, provider } = llmWith(okResponse);
    await provider.complete(ctx, prompt);
    await provider.completeStructured(ctx, { prompt, schema });
    expect(create.mock.calls[0]?.[0].model).toBe("gpt-test");
    expect(create.mock.calls[1]?.[0].model).toBe("gpt-test");
  });

  it("temperature を省くと、temperature の鍵ごと渡さない", async () => {
    const { create, provider } = llmWith(okResponse);
    await provider.complete(ctx, prompt);
    await provider.completeStructured(ctx, { prompt, schema });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty("temperature");
  });

  it("temperature を渡すと、そのまま渡す（0 も落とさない）", async () => {
    const { create, provider } = llmWith(okResponse, { temperature: 0 });
    await provider.complete(ctx, prompt);
    await provider.completeStructured(ctx, { prompt, schema });
    expect(create.mock.calls[0]?.[0].temperature).toBe(0);
    expect(create.mock.calls[1]?.[0].temperature).toBe(0);
  });
});

describe("構築時: client を省き、鍵が見つからないとき（README「前提」）", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
  });
  afterEach(() => {
    if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
  });

  it.each([
    ["OpenAILLMProvider", () => new OpenAILLMProvider({ model: "m" })],
    ["OpenAIEmbeddingProvider", () => new OpenAIEmbeddingProvider({ model: "m", dimensions: 3 })],
  ] as const)(
    "%s は構築の時点で SDK の Missing credentials を投げ、kind を持たない",
    (_name, build) => {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^Missing credentials/);
      expect((thrown as Error).constructor.name).toBe("OpenAIError");
      expect(thrown).not.toHaveProperty("kind");
    },
  );
});

describe("complete: 切り詰め・コンテンツフィルタも種類で返す（TSDoc）", () => {
  it("finish_reason: 'length' は kind: 'truncated'", async () => {
    const { provider } = llmWith({
      choices: [{ finish_reason: "length", message: { content: "途中" } }],
    });
    const error = (await rejection(() => provider.complete(ctx, prompt))) as OpenAILLMProviderError;
    expect(error.kind).toBe("truncated");
    expect(error.finishReason).toBe("length");
  });

  it("finish_reason: 'content_filter' は kind: 'refusal'", async () => {
    const { provider } = llmWith({
      choices: [{ finish_reason: "content_filter", message: { content: "" } }],
    });
    const error = (await rejection(() => provider.complete(ctx, prompt))) as OpenAILLMProviderError;
    expect(error.kind).toBe("refusal");
    expect(error.finishReason).toBe("content_filter");
  });
});

describe("拒否の判定: message.refusal が空文字なら拒否として扱わない（errors.ts の OpenAILLMFailureKind）", () => {
  it("completeStructured は本文を読んで返す", async () => {
    const { provider } = llmWith({
      choices: [{ finish_reason: "stop", message: { refusal: "", content: '{"a":"x"}' } }],
    });
    await expect(provider.completeStructured(ctx, { prompt, schema })).resolves.toEqual({
      a: "x",
    });
  });

  it("complete も本文を返す", async () => {
    const { provider } = llmWith({
      choices: [{ finish_reason: "stop", message: { refusal: "", content: "本文" } }],
    });
    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "本文" });
  });
});

describe("応答の形そのものが壊れているとき（Issue #885）: 生の TypeError のまま伝わる", () => {
  it.each([
    ["complete", (p: OpenAILLMProvider) => p.complete(ctx, prompt)],
    ["completeStructured", (p: OpenAILLMProvider) => p.completeStructured(ctx, { prompt, schema })],
  ] as const)("%s: choices の鍵が無い応答", async (_name, run) => {
    const { provider } = llmWith({});
    const error = await rejection(() => run(provider));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(OpenAILLMProviderError);
    expect(error).not.toHaveProperty("kind");
  });

  it("embed: data の鍵が無い応答", async () => {
    const create = vi.fn().mockResolvedValue({});
    const provider = new OpenAIEmbeddingProvider({
      model: "m",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const error = await rejection(() => provider.embed(ctx, ["a"]));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toHaveProperty("kind");
  });
});

describe("embed: 件数・次元を検査しない（TSDoc、README の Issue #860）", () => {
  it("応答の件数と次元が入力・宣言と食い違っても、例外にせずそのまま返す", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: [1] }] });
    const provider = new OpenAIEmbeddingProvider({
      model: "m",
      dimensions: 3,
      client: { embeddings: { create } } as never,
    });
    // 入力は2件・宣言は3次元なのに、1件・1次元が返る。
    await expect(provider.embed(ctx, ["a", "b"])).resolves.toEqual([[1]]);
  });
});

describe("client を省いたとき、SDK 既定の再試行・timeout が効く（README の Issue #884。SDK の版が上がれば変わりうる）", () => {
  it.each([
    ["OpenAILLMProvider", () => new OpenAILLMProvider({ apiKey: "sk-test", model: "m" })],
    [
      "OpenAIEmbeddingProvider",
      () => new OpenAIEmbeddingProvider({ apiKey: "sk-test", model: "m", dimensions: 3 }),
    ],
  ] as const)("%s: maxRetries 2・timeout 600000ms", (_name, build) => {
    // `client` は TypeScript の private であり、実行時には読める。README の実測値の歯。
    const client = (build() as unknown as { client: { maxRetries: number; timeout: number } })
      .client;
    expect(client.maxRetries).toBe(2);
    expect(client.timeout).toBe(600000);
  });
});

describe("completeStructured: z.lazy・default も送る前には落とさない（README の zod の形の表）", () => {
  it.each([
    [
      "z.lazy（再帰）",
      (() => {
        const Node = z.object({
          name: z.string(),
          get children() {
            return z.array(Node);
          },
        });
        return z.object({ root: Node });
      })(),
    ],
    ["default", z.object({ x: z.string().default("d") })],
  ] as const)("%s は翻訳で投げず、chat.completions.create を1回呼ぶ", async (_label, shape) => {
    const create = vi.fn(async () => {
      throw new Error("偽の client: ベンダーの応答の代わり");
    });
    const provider = new OpenAILLMProvider({
      model: "m",
      client: { chat: { completions: { create } } } as never,
    });
    await expect(
      provider.completeStructured(ctx, { prompt, schema: shape as z.ZodType<unknown> }),
    ).rejects.toThrow("偽の client");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAILLMProviderError の既定値", () => {
  it("name は 'OpenAILLMProviderError'、finishReason・refusalMessage は省けば null", () => {
    const error = new OpenAILLMProviderError({ kind: "no_content" });
    expect(error.name).toBe("OpenAILLMProviderError");
    expect(error.finishReason).toBeNull();
    expect(error.refusalMessage).toBeNull();
  });
});
