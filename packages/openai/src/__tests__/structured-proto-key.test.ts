import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { ExtractionResultSchema } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/** `stripNulls` / `keepSchemaNulls` は応答を新しい object へ写す。`result[key] = ...` で写すと、`JSON.parse` が自分自身の欄として作った `"__proto__"` が欄ではなくプロトタイプの差し替えになり、zod の `object` が継承された値を読む。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

function providerReturningRaw(raw: string) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: "stop", message: { refusal: null, content: raw } }],
  });
  return new OpenAILLMProvider({
    model: "m",
    client: { chat: { completions: { create } } } as never,
  });
}

describe("応答の余分な __proto__ の欄は、継承された値として読まれない", () => {
  it("陽性対照: JSON.parse は __proto__ を自分自身の欄として作り、zod はそれを読まない（素の parse の結果）", () => {
    const raw = '{"content":"x","provenanceKind":"stated","__proto__":{"subjectId":"victim"}}';
    const parsed = JSON.parse(raw) as object;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect("subjectId" in ExtractionResultSchema.shape.memories.element.parse(parsed)).toBe(false);
  });

  it("抽出: 候補の subjectId は、__proto__ の中の値では埋まらない", async () => {
    const raw =
      '{"memories":[{"content":"x","provenanceKind":"stated","__proto__":{"subjectId":"victim"}}]}';
    const result = await providerReturningRaw(raw).completeStructured(ctx, {
      prompt,
      schema: ExtractionResultSchema,
    });
    expect(result.memories[0]).toEqual({ content: "x", provenanceKind: "stated" });
    expect(result.memories[0]!.subjectId).toBeUndefined();
  });

  it("2段目（スキーマが許す null を残して検査し直す経路）でも同じ", async () => {
    const schema = z.object({ a: z.string().nullable(), b: z.string().optional() });
    const raw = '{"a":null,"__proto__":{"b":"inherited"}}';
    const result = await providerReturningRaw(raw).completeStructured(ctx, { prompt, schema });
    expect(result).toEqual({ a: null });
    expect(result.b).toBeUndefined();
  });
});
