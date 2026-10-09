import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtractionResultSchema } from "@mnemora/core";
import type { Ctx, StructuredRequest } from "@mnemora/core";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";

const ctx: Ctx = { tenantId: "deterministic-providers-tsdoc-edges" };

function structured<T>(schema: z.ZodType<T>, userText: string): StructuredRequest<T> {
  return { prompt: { messages: [{ role: "user", content: userText }] }, schema };
}

describe("DeterministicEmbeddingProvider: texts と同じ件数・同じ順で返す", () => {
  it("空文字・空白だけのテキストも捨てず、1件ずつベクトルを返す", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const texts = ["a", " ", "", "\n\t"];
    const vectors = await provider.embed(ctx, texts);
    expect(vectors).toHaveLength(texts.length);
    for (const vector of vectors) {
      expect(vector).toHaveLength(provider.space.dimensions);
    }
    expect(vectors[0]).toEqual((await provider.embed(ctx, ["a"]))[0]);
  });
});

describe("DeterministicLLMProvider: 知っている3つのスキーマだけに答え、それ以外は投げる", () => {
  it("抽出・統合・内省のどの形でもないスキーマには、例外を投げる（黙って何か返さない）", async () => {
    const provider = new DeterministicLLMProvider();
    const unknownSchema = z.object({ answer: z.number() });
    await expect(
      provider.completeStructured(ctx, structured(unknownSchema, "発話")),
    ).rejects.toThrow(/未対応のスキーマ/);
  });

  it("空白だけの発話でも、抽出のスキーマには投げずに答える", async () => {
    const provider = new DeterministicLLMProvider();
    const result = await provider.completeStructured(ctx, structured(ExtractionResultSchema, " "));
    expect(result.memories.map((m) => m.content)).toEqual([" "]);
  });
});
