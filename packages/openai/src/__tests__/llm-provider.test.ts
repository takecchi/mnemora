import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/** `client` は手書きの偽物で、本物の OpenAI API を叩かない。「LLM が実際に良い抽出結果を返すか」はここでは検査できない（live テスト参照）。 */
const ctx: Ctx = { tenantId: "tenant-1" };

const sampleSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

describe("OpenAILLMProvider.complete", () => {
  it("最初の choice の content を返す", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "こんにちは" } }],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { completions: undefined, chat: { completions: { create } } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "こんにちは" });
  });

  it("choice が無ければ空文字を返す（例外にしない）", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "" });
  });

  it("choice が複数あっても、返すのは最初の choice の content", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "最初" } }, { message: { content: "二番目" } }],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "最初" });
  });

  it("prompt.system を1つの system メッセージとして送り、messages は同じ順・同じ役割で送る", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });
    await provider.complete(ctx, {
      system: "基本指示",
      messages: [
        { role: "user", content: "1つ目の発話" },
        { role: "assistant", content: "1つ目の応答" },
        { role: "user", content: "2つ目の発話" },
      ],
    });
    const sent: { role: string; content: string }[] = create.mock.calls[0]![0].messages;
    // system メッセージの位置は約束していないので、system とそれ以外に分けて見る。
    expect(sent.filter((message) => message.role === "system")).toEqual([
      { role: "system", content: "基本指示" },
    ]);
    expect(sent.filter((message) => message.role !== "system")).toEqual([
      { role: "user", content: "1つ目の発話" },
      { role: "assistant", content: "1つ目の応答" },
      { role: "user", content: "2つ目の発話" },
    ]);
  });
});

describe("OpenAILLMProvider.completeStructured", () => {
  it("response_format に翻訳済みの json_schema を渡す", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ content: "本文", digest: null, tags: null }) } },
      ],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.response_format.type).toBe("json_schema");
    expect(callArgs.response_format.json_schema.strict).toBe(true);
    expect(callArgs.response_format.json_schema.schema.required).toEqual(
      expect.arrayContaining(["content", "digest", "tags"]),
    );
  });

  it("OpenAI が null を返した optional フィールドを、core のスキーマでは省略として扱う", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ content: "本文", digest: null, tags: null }) } },
      ],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    const result = await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(result).toEqual({ content: "本文" });
    expect("digest" in result).toBe(false);
  });

  it("content が空文字/欠落なら例外を投げる", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    // 契約は「何らかの例外を投げること」だけで、`kind` までは主張しない。`kind: "no_content"` は `refusal.test.ts` が精密に検証しており、ここで足すと内部表現に結合するだけになる。
    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toThrow();
  });

  it("content が空白だけなら、空ではなく壊れた JSON として SyntaxError を伝播する", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: " " } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("prompt.system を1つの system メッセージとして送り、messages は同じ順・同じ役割で送る", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ content: "本文", digest: null, tags: null }) } },
      ],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });
    await provider.completeStructured(ctx, {
      prompt: {
        system: "基本指示",
        messages: [
          { role: "user", content: "1つ目の発話" },
          { role: "assistant", content: "1つ目の応答" },
          { role: "user", content: "2つ目の発話" },
        ],
      },
      schema: sampleSchema,
    });
    const sent: { role: string; content: string }[] = create.mock.calls[0]![0].messages;
    // system メッセージの位置は約束していないので、system とそれ以外に分けて見る。
    expect(sent.filter((message) => message.role === "system")).toEqual([
      { role: "system", content: "基本指示" },
    ]);
    expect(sent.filter((message) => message.role !== "system")).toEqual([
      { role: "user", content: "1つ目の発話" },
      { role: "assistant", content: "1つ目の応答" },
      { role: "user", content: "2つ目の発話" },
    ]);
  });

  it("返ってきた JSON がスキーマに適合しなければ例外を投げる（必須フィールド欠落）", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ digest: "要旨だけ" }) } }],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    // `req.schema.parse(...)` が投げるのは zod の ZodError であり、別の理由（`no_content` 等）で失敗しても緑になってはいけない。
    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toThrow(ZodError);
  });
});
