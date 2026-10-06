import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/**
 * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md):
 * `opts?.signal` が `chat.completions.create`/`embeddings.create` の request options
 * （`{ signal }`）へ実際に届くこと、そして SDK が signal を尊重する体の偽 client を
 * 使ったとき、abort で reject することを確かめる。
 *
 * **正直に書く**: ここでの `create` は手書きの偽物であり、本物の OpenAI SDK の
 * `AbortSignal` 対応の実装そのものは検査していない（OpenAI SDK 自身がその契約を
 * 守るかどうかは、この repo の外側の話である）。ここで検査しているのは
 * 「`@mnemora/openai` が signal を渡し忘れていないか」「渡した signal が abort
 * されたときに reject する経路そのものは壊れていないか」だけである。
 */
const ctx: Ctx = { tenantId: "tenant-abort" };

describe("OpenAILLMProvider — AbortSignal", () => {
  it("complete: opts.signal がそのまま client.chat.completions.create の第2引数（request options）に渡る", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
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
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
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
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
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

describe("OpenAIEmbeddingProvider — AbortSignal", () => {
  it("embed: opts.signal がそのまま client.embeddings.create の第2引数に渡る", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const controller = new AbortController();

    await provider.embed(ctx, ["a"], { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it("embed: 既に abort 済みなら、空配列でも [] を返さず reject する（API も呼ばない）", async () => {
    const create = vi.fn();
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.embed(ctx, [], { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("embed: abort していない signal なら、空配列は [] を返す（API は呼ばない）", async () => {
    const create = vi.fn();
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const controller = new AbortController();

    await expect(provider.embed(ctx, [], { signal: controller.signal })).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("embed: signal を尊重する体の偽 client では、abort で reject する", async () => {
    const create = vi.fn().mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(options.signal!.reason);
          });
        }),
    );
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const controller = new AbortController();

    const promise = provider.embed(ctx, ["a"], { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toBe(controller.signal.reason);
  });
});
