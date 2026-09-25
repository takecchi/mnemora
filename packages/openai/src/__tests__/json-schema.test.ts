import { describe, expect, it } from "vitest";
import { z } from "zod";
import { translateForOpenAIStructuredOutput } from "../json-schema.js";

/**
 * 「zod スキーマ → OpenAI の JSON Schema への翻訳」だけを直接検査する歯
 * （PR 本文「擬似物の扱い」: 擬似の LLM/EmbeddingProvider では翻訳の壊れに気づけないため、
 * この翻訳結果そのものを見るテストを別に持つ）。
 */
describe("translateForOpenAIStructuredOutput", () => {
  it("name をそのまま返し、strict: true を持つ", () => {
    const schema = z.object({ content: z.string() });
    const result = translateForOpenAIStructuredOutput("my_format", schema);
    expect(result.name).toBe("my_format");
    expect(result.strict).toBe(true);
  });

  it("すべての object に additionalProperties: false が付く", () => {
    const schema = z.object({ content: z.string(), nested: z.object({ a: z.string() }) });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    expect(jsonSchema.additionalProperties).toBe(false);
    const nested = (jsonSchema.properties as Record<string, Record<string, unknown>>).nested!;
    expect(nested.additionalProperties).toBe(false);
  });

  it("z.looseObject（passthrough）でも additionalProperties: false へ強制される", () => {
    // z.object() は zod v4 の既定で additionalProperties: false を出すため、
    // 前のテストだけでは「明示的な強制」が本当に効いているかを検出できない
    // （zod の既定値と偶然一致するだけでも緑になる）。z.looseObject は
    // additionalProperties: {} を出す（実測済み）ため、この歯だけがハードン処理の
    // 上書きを実際に検査する。
    const schema = z.looseObject({ a: z.string() });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    expect(jsonSchema.additionalProperties).toBe(false);
  });

  it("optional なフィールドも required に含まれる（OpenAI strict モードの要求）", () => {
    const schema = z.object({
      content: z.string(),
      digest: z.string().optional(),
    });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    expect(jsonSchema.required).toEqual(expect.arrayContaining(["content", "digest"]));
    expect(jsonSchema.required as string[]).toHaveLength(2);
  });

  it("optional だったフィールドは null を許容する型になる（required に足す代わりの表現）", () => {
    const schema = z.object({
      digest: z.string().optional(),
    });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const digestSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>).digest!;
    // string.optional() は type: "string" を持つノードになるため、type が配列 ["string", "null"]
    // に変換されているはず。
    expect(digestSchema.type).toEqual(["string", "null"]);
  });

  it("必須フィールドは null 許容にしない（type がそのまま）", () => {
    const schema = z.object({
      content: z.string(),
    });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const contentSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .content!;
    expect(contentSchema.type).toBe("string");
  });

  it("配列の要素（items）も再帰的に強化される", () => {
    const schema = z.object({
      memories: z.array(
        z.object({
          content: z.string(),
          digest: z.string().optional(),
        }),
      ),
    });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const memoriesSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .memories!;
    const itemSchema = memoriesSchema.items as Record<string, unknown>;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual(expect.arrayContaining(["content", "digest"]));
    const digestItemSchema = (itemSchema.properties as Record<string, Record<string, unknown>>)
      .digest!;
    expect(digestItemSchema.type).toEqual(["string", "null"]);
  });

  it("z.enum で作った列挙型は enum のまま維持される（型を壊さない）", () => {
    const schema = z.object({
      provenanceKind: z.enum(["stated", "inferred"]),
    });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const kindSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .provenanceKind!;
    expect(kindSchema.enum).toEqual(["stated", "inferred"]);
  });

  // `.optional()` の enum / literal は、null を値として受け付ける形にならなければならない。
  // `type` に "null" を足しただけでは、`enum` / `const` が null を弾くので、strict モードの
  // モデルは「省略」を表せず、列挙のどれかを埋めるしかなくなる（任意の欄が実質必須に化ける）。
  it("省略可能な z.enum は enum に null を含む（type だけでなく）", () => {
    const schema = z.object({ kind: z.enum(["a", "b"]).optional() });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const kindSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>).kind!;
    expect(kindSchema.type).toEqual(["string", "null"]);
    expect(kindSchema.enum).toEqual(["a", "b", null]);
  });

  it("省略可能な z.literal は null も選べる形に包まれる", () => {
    const schema = z.object({ kind: z.literal("x").optional() });
    const { schema: jsonSchema } = translateForOpenAIStructuredOutput("f", schema);
    const kindSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>).kind!;
    expect(kindSchema).toEqual({ anyOf: [{ type: "string", const: "x" }, { type: "null" }] });
  });

  it("実際に extraction.ts と同じ形（ExtractionResultSchema 相当）を翻訳できる", () => {
    const extractedMemoryCandidateSchema = z.object({
      content: z.string().min(1),
      digest: z.string().optional(),
      tags: z.array(z.string()).optional(),
      provenanceKind: z.enum(["stated", "inferred"]),
      confidence: z.number().min(0).max(1).optional(),
    });
    const extractionResultSchema = z.object({
      memories: z.array(extractedMemoryCandidateSchema),
    });

    const { schema: jsonSchema } = translateForOpenAIStructuredOutput(
      "extraction_result",
      extractionResultSchema,
    );

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.required).toEqual(["memories"]);
    const memoriesSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .memories!;
    const itemSchema = memoriesSchema.items as Record<string, unknown>;
    expect(itemSchema.required).toEqual(
      expect.arrayContaining(["content", "digest", "tags", "provenanceKind", "confidence"]),
    );
    expect(itemSchema.required as string[]).toHaveLength(5);
  });
});
