import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProviderError } from "../errors.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * `packages/testkit` に適合 suite は作らない（契約の切り方が未決のため）。`@mnemora/anthropic` 側に同じ形の歯があるので、片方だけ直さないこと。
 * 測っているのは「この wrapper がリトライしないこと」で、production の経路ではない。`client` を注入しているので、`new OpenAI()` が既定で持つ SDK 内部のリトライはここを通らない。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const sampleSchema = z.object({ content: z.string() });

const prompt = { messages: [{ role: "user" as const, content: "hi" }] };

function providerWithRejecting(error: unknown) {
  const create = vi.fn().mockRejectedValue(error);
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { create, provider };
}

/** レート制限・タイムアウトを模した例外。SDK の本物のエラークラスではない。wrapper は例外の種類で分岐していないので、種類を変えても同じ道を通る。 */
class FakeRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("429 Too Many Requests");
    this.name = "RateLimitError";
  }
}
class FakeTimeoutError extends Error {
  constructor() {
    super("Request timed out.");
    this.name = "APIConnectionTimeoutError";
  }
}

describe("OpenAILLMProvider — 呼び出し自体が失敗したとき（core の interface の契約）", () => {
  it("complete: SDK の呼び出しが reject したら、その例外をそのまま伝播し、リトライしない", async () => {
    const sentinel = new Error("boom");
    const { create, provider } = providerWithRejecting(sentinel);

    // 同一性で見る。`toThrow(/boom/)` だと、wrapper が別の Error へ包み直してもメッセージさえ同じなら通ってしまう。
    await expect(provider.complete(ctx, prompt)).rejects.toBe(sentinel);
    // 「無い」の種類を潰さない。転送の失敗を `no_content` へ化けさせないこと。`complete` は応答が空でも例外にせず空文字を返す形なので、ここが黙って `{ content: "" }` に倒れないことが特に効く。
    await expect(
      providerWithRejecting(sentinel).provider.complete(ctx, prompt),
    ).rejects.not.toBeInstanceOf(OpenAILLMProviderError);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("completeStructured: SDK の呼び出しが reject したら、その例外をそのまま伝播し、リトライしない", async () => {
    const sentinel = new Error("boom");
    const { create, provider } = providerWithRejecting(sentinel);

    await expect(provider.completeStructured(ctx, { prompt, schema: sampleSchema })).rejects.toBe(
      sentinel,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("レート制限・タイムアウトを模した例外でも、種類を問わず同じように伝播する", async () => {
    for (const error of [new FakeRateLimitError(), new FakeTimeoutError()]) {
      const forComplete = providerWithRejecting(error);
      await expect(forComplete.provider.complete(ctx, prompt)).rejects.toBe(error);
      expect(forComplete.create).toHaveBeenCalledTimes(1);

      const forStructured = providerWithRejecting(error);
      await expect(
        forStructured.provider.completeStructured(ctx, { prompt, schema: sampleSchema }),
      ).rejects.toBe(error);
      expect(forStructured.create).toHaveBeenCalledTimes(1);
    }
  });

  it("⭐ 陰性対照: 成功する呼び出しでも create はちょうど1回（回数の主張が空回りしていないこと）", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "ok" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
