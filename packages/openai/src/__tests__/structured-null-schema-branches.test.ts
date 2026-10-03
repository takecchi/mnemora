import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * `completeStructured` の戻りの `null` を残すかどうかの判定（`llm-provider.ts` の `admitsNull`）が見る
 * 3つの枝の歯。`structured-nullable-roundtrip.test.ts` は `type` に `"null"` を含む形だけを縛っており、
 * 次の3つは外しても赤くならなかった（2026-09-28 マージ分の確かめ直しで見つけた穴）。
 *
 * - `$ref`（`#/$defs/...`）の先が `null` を許す欄: 先を辿らなくなると `null` が消えて `ZodError` になる。
 * - `const: null` の枝（`type` を持たない形）。
 * - `enum` に `null` を含む枝（`type` を持たない形）。
 *
 * `type` が `"null"` を含むと、`const`・`enum` の枝を見なくても結果が変わらない。そこで `const` は
 * `.meta({ type: undefined })` で `type` を外した形で縛る（`enum` は `z.literal([..., null])` が
 * もともと `type` を持たない）。
 * 反対側（`null` を許さない・省略可の欄の `null` は残さない）も同じ欄の形で縛る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

function providerReturning(json: unknown) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: "stop", message: { refusal: null, content: JSON.stringify(json) } }],
  });
  return new OpenAILLMProvider({
    model: "m",
    client: { chat: { completions: { create } } } as never,
  });
}

/** `completeStructured` が元にする JSON Schema（翻訳の前）。 */
function sentSchema(schema: z.ZodType<unknown>) {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as {
    properties: Record<string, unknown>;
    $defs: Record<string, Record<string, unknown>>;
  };
}

async function structured<T>(schema: z.ZodType<T>, json: unknown): Promise<T> {
  return providerReturning(json).completeStructured(ctx, { prompt, schema });
}

describe("$ref の先が null を許す欄の null は残す", () => {
  it("#/$defs/... の先が nullable の必須の欄", async () => {
    const Shared = z.string().nullable().meta({ id: "SharedNullable" });
    const schema = z.object({ a: Shared });
    // 送る形に $defs と $ref が出ること（この歯が $ref を通っている前提）。
    const sent = sentSchema(schema);
    expect(sent.properties.a).toEqual({ $ref: "#/$defs/SharedNullable" });
    expect(sent.$defs.SharedNullable?.type).toEqual(["string", "null"]);

    const result = await structured(schema, { a: null });
    expect(result).toEqual({ a: null });
    expect("a" in result).toBe(true);
  });

  it("#/$defs/... の先が null を許さない欄の null は残さない（ZodError）", async () => {
    const Shared = z.string().meta({ id: "SharedString" });
    const schema = z.object({ a: Shared });
    const sent = sentSchema(schema);
    expect(sent.properties.a).toEqual({ $ref: "#/$defs/SharedString" });

    await expect(structured(schema, { a: null })).rejects.toBeInstanceOf(ZodError);
  });

  it("#/$defs/... の先が nullable でも、省略可の欄の null は省略になる", async () => {
    const Shared = z.string().nullable().meta({ id: "SharedNullableOptional" });
    const schema = z.object({ a: Shared.optional() });
    const result = await structured(schema, { a: null });
    expect(result).toEqual({});
    expect("a" in result).toBe(false);
  });
});

describe("const: null の枝の null は残す", () => {
  const constNull = () => z.literal(null).meta({ type: undefined });

  it("type を持たず const: null だけの必須の欄", async () => {
    const schema = z.object({ a: constNull() });
    const sent = sentSchema(schema);
    expect(sent.properties.a).toEqual({ const: null });

    const result = await structured(schema, { a: null });
    expect(result).toEqual({ a: null });
    expect("a" in result).toBe(true);
  });

  it("省略可の欄の null は省略になる", async () => {
    const result = await structured(z.object({ a: constNull().optional() }), { a: null });
    expect(result).toEqual({});
    expect("a" in result).toBe(false);
  });
});

describe("enum に null を含む枝の null は残す", () => {
  it("type を持たず enum だけの必須の欄", async () => {
    const schema = z.object({ a: z.literal(["x", null]) });
    const sent = sentSchema(schema);
    expect(sent.properties.a).toEqual({ enum: ["x", null] });

    const result = await structured(schema, { a: null });
    expect(result).toEqual({ a: null });
    expect("a" in result).toBe(true);
  });

  it("null 以外の値は、そのまま通る", async () => {
    await expect(structured(z.object({ a: z.literal(["x", null]) }), { a: "x" })).resolves.toEqual({
      a: "x",
    });
  });

  it("enum に null を含まない欄の null は残さない（ZodError）", async () => {
    await expect(
      structured(z.object({ a: z.literal(["x", "y"]) }), { a: null }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("省略可の欄の null は省略になる", async () => {
    const result = await structured(z.object({ a: z.literal(["x", null]).optional() }), {
      a: null,
    });
    expect(result).toEqual({});
    expect("a" in result).toBe(false);
  });
});
