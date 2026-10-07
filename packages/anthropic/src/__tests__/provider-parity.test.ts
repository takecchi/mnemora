import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { OpenAILLMProvider, OpenAILLMProviderError } from "@mnemora/openai";
import { AnthropicLLMProvider } from "../llm-provider.js";
import { AnthropicLLMProviderError } from "../errors.js";

/**
 * 検査していないこと: どちらの client も手書きの偽物で、実 API の応答が同じ形になることは見ていない。揃えているのは provider が守ると宣言している契約（引数の型・戻り値の形・例外を投げる条件）だけ。
 * `packages/anthropic` の中に在る歯なので、3つ目の provider が来ても自動的には効かない。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

/** `.optional()` を含むことが要点。ここが両 provider の翻訳の差が最も出る箇所（OpenAI 側は optional を required + nullable へ倒して返りを `stripNulls` で戻し、Anthropic 側は optional のまま）。 */
const sharedSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const sharedRequest: StructuredRequest<z.infer<typeof sharedSchema>> = {
  prompt: {
    system: "あなたは抽出器です。",
    messages: [{ role: "user", content: "来月、京都へ出張する。" }],
  },
  schema: sharedSchema,
};

/** `digest` は在り、`tags` は無い。optional の扱いの差を踏ませるため。 */
const sharedJson = { content: "来月、京都へ出張する予定がある。", digest: "京都出張" };

function buildAnthropic(responseText: string | undefined) {
  const create = vi.fn().mockResolvedValue({
    content: responseText === undefined ? [] : [{ type: "text", text: responseText }],
  });
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { provider, create };
}

function buildOpenAI(responseText: string | undefined) {
  const create = vi.fn().mockResolvedValue({
    choices: responseText === undefined ? [] : [{ message: { content: responseText } }],
  });
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, create };
}

describe("provider parity: AnthropicLLMProvider と OpenAILLMProvider", () => {
  it("両方が LLMProvider として同じ変数に入る（型としての差し替え可能性）", () => {
    const { provider: anthropic } = buildAnthropic("{}");
    const { provider: openai } = buildOpenAI("{}");

    // 実行時の assertion ではなく、型検査が通ること自体が主張。片方が `LLMProvider` を満たさなくなれば `pnpm run typecheck` が赤くなる。
    const providers: LLMProvider[] = [anthropic, openai];

    expect(providers).toHaveLength(2);
    for (const provider of providers) {
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.completeStructured).toBe("function");
    }
  });

  it("同じ入力・同じ応答に対して completeStructured が同じ値を返す", async () => {
    const { provider: anthropic } = buildAnthropic(JSON.stringify(sharedJson));
    const { provider: openai } = buildOpenAI(JSON.stringify(sharedJson));

    const fromAnthropic = await anthropic.completeStructured(ctx, sharedRequest);
    const fromOpenAI = await openai.completeStructured(ctx, sharedRequest);

    expect(fromAnthropic).toEqual(fromOpenAI);
    expect(fromAnthropic).toEqual(sharedJson);
    expect("tags" in fromAnthropic).toBe(false);
    expect("tags" in fromOpenAI).toBe(false);
  });

  it("complete も同じ入力・同じ応答に対して同じ値を返す", async () => {
    const { provider: anthropic } = buildAnthropic("こんにちは");
    const { provider: openai } = buildOpenAI("こんにちは");

    const fromAnthropic = await anthropic.complete(ctx, sharedRequest.prompt);
    const fromOpenAI = await openai.complete(ctx, sharedRequest.prompt);

    expect(fromAnthropic).toEqual(fromOpenAI);
    expect(fromAnthropic).toEqual({ content: "こんにちは" });
  });

  it("構造化出力が返らなかったとき、両方が例外を投げる（黙って空を返さない）", async () => {
    const { provider: anthropic } = buildAnthropic(undefined);
    const { provider: openai } = buildOpenAI(undefined);

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(
      /structured completion returned no content/,
    );
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(
      /structured completion returned no content/,
    );
  });

  it("スキーマに適合しない JSON が返ったとき、両方が ZodError を投げる", async () => {
    const invalid = JSON.stringify({ content: 42 });
    const { provider: anthropic } = buildAnthropic(invalid);
    const { provider: openai } = buildOpenAI(invalid);

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(z.ZodError);
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(z.ZodError);
  });

  it("JSON として壊れた応答が返ったとき、両方が SyntaxError を投げる", async () => {
    const { provider: anthropic } = buildAnthropic("{ これは JSON ではない");
    const { provider: openai } = buildOpenAI("{ これは JSON ではない");

    await expect(anthropic.completeStructured(ctx, sharedRequest)).rejects.toThrow(SyntaxError);
    await expect(openai.completeStructured(ctx, sharedRequest)).rejects.toThrow(SyntaxError);
  });

  it("complete のテキストが取れないとき、両方が空文字を返す（契約の非対称を固定する）", async () => {
    // これは望ましい振る舞いではない。`completeStructured` は throw するのに `complete` は黙って空を返す。両 provider が同じように壊れていることを固定する。片方だけ直すと差し替えられなくなるので、直すなら両方同時にする。
    const { provider: anthropic } = buildAnthropic(undefined);
    const { provider: openai } = buildOpenAI(undefined);

    await expect(anthropic.complete(ctx, sharedRequest.prompt)).resolves.toEqual({ content: "" });
    await expect(openai.complete(ctx, sharedRequest.prompt)).resolves.toEqual({ content: "" });
  });

  it("両 provider が、ベンダー固有の型を戻り値に漏らしていない", async () => {
    const { provider: anthropic } = buildAnthropic(JSON.stringify(sharedJson));
    const { provider: openai } = buildOpenAI(JSON.stringify(sharedJson));

    const a = await anthropic.complete(ctx, sharedRequest.prompt);
    const o = await openai.complete(ctx, sharedRequest.prompt);
    expect(Object.keys(a)).toEqual(["content"]);
    expect(Object.keys(o)).toEqual(["content"]);

    const as = await anthropic.completeStructured(ctx, sharedRequest);
    const os = await openai.completeStructured(ctx, sharedRequest);
    expect(Object.keys(as).sort()).toEqual(["content", "digest"]);
    expect(Object.keys(os).sort()).toEqual(["content", "digest"]);
  });
});

describe("provider parity: 送る前に schema_unsupported で落ちる形は2つの provider で揃っている（ADR 0360 の 2026-09-30 追記、負債3）", () => {
  it.each([
    ["z.record", z.object({ x: z.record(z.string(), z.string()) })],
    ["z.record（配列の要素）", z.object({ x: z.array(z.record(z.string(), z.number())) })],
    ["z.record（optional の内側）", z.object({ x: z.record(z.string(), z.string()).optional() })],
    ["z.tuple", z.object({ x: z.tuple([z.string(), z.number()]) })],
    ["z.date", z.object({ x: z.date() })],
    ["transform", z.object({ x: z.string().transform((s) => s.length) })],
  ] as const)(
    "%s は、両方が create を呼ばず kind: schema_unsupported で投げる",
    async (_l, schema) => {
      const a = buildAnthropic("{}");
      const o = buildOpenAI("{}");
      const req = { prompt: sharedRequest.prompt, schema: schema as z.ZodType<unknown> };
      const ea: unknown = await a.provider.completeStructured(ctx, req).catch((e: unknown) => e);
      const eo: unknown = await o.provider.completeStructured(ctx, req).catch((e: unknown) => e);
      expect(ea).toBeInstanceOf(AnthropicLLMProviderError);
      expect(eo).toBeInstanceOf(OpenAILLMProviderError);
      expect((ea as AnthropicLLMProviderError).kind).toBe("schema_unsupported");
      expect((eo as OpenAILLMProviderError).kind).toBe("schema_unsupported");
      expect(a.create).not.toHaveBeenCalled();
      expect(o.create).not.toHaveBeenCalled();
    },
  );
});

describe("provider divergence: 翻訳の形は同じではない（そこがベンダーの差である）", () => {
  it("Anthropic は output_config.format、OpenAI は response_format で送る", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicArg = anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const openaiArg = openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    const format = (anthropicArg["output_config"] as { format: Record<string, unknown> }).format;
    expect(format["type"]).toBe("json_schema");
    expect(format).not.toHaveProperty("name");
    expect(format).not.toHaveProperty("strict");
    expect(anthropicArg).not.toHaveProperty("response_format");

    const jsonSchema = (openaiArg["response_format"] as { json_schema: Record<string, unknown> })
      .json_schema;
    expect(jsonSchema["strict"]).toBe(true);
    expect(jsonSchema).toHaveProperty("name");
    expect(openaiArg).not.toHaveProperty("output_config");
  });

  it("optional の扱いが違う: Anthropic は required に足さない、OpenAI は足す", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicSchema = (
      (anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>)["output_config"] as {
        format: { schema: { required?: string[] } };
      }
    ).format.schema;
    const openaiSchema = (
      (openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>)["response_format"] as {
        json_schema: { schema: { required?: string[] } };
      }
    ).json_schema.schema;

    expect(anthropicSchema.required).toEqual(["content"]);
    expect(openaiSchema.required?.slice().sort()).toEqual(["content", "digest", "tags"]);

    expect(anthropicSchema.required).not.toEqual(openaiSchema.required);
  });

  it("enum の扱いが違う: OpenAI は enum キーとして送る、Anthropic は description へ降格する", async () => {
    // 契約の差ではなく強制力の差。OpenAI 側は `enum` を JSON Schema の `enum` として送る（生成時に制約される）が、Anthropic の `transformJSONSchema` は `enum` を `description` に JSON 文字列として埋め込む。列挙から外れた値は Anthropic 側では `req.schema.parse` の ZodError で初めて弾かれる。どちらも黙って通すことはしない。
    const enumSchema = z.object({ provenanceKind: z.enum(["stated", "inferred"]) });
    const enumJson = JSON.stringify({ provenanceKind: "stated" });
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(enumJson);
    const { provider: openai, create: openaiCreate } = buildOpenAI(enumJson);
    const req = { prompt: sharedRequest.prompt, schema: enumSchema };

    await anthropic.completeStructured(ctx, req);
    await openai.completeStructured(ctx, req);

    const aProp = (
      (anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>)["output_config"] as {
        format: {
          schema: { properties: Record<string, { enum?: unknown; description?: string }> };
        };
      }
    ).format.schema.properties["provenanceKind"]!;
    const oProp = (
      (openaiCreate.mock.calls[0]?.[0] as Record<string, unknown>)["response_format"] as {
        json_schema: {
          schema: { properties: Record<string, { enum?: unknown; description?: string }> };
        };
      }
    ).json_schema.schema.properties["provenanceKind"]!;

    expect(oProp.enum).toEqual(["stated", "inferred"]);
    expect(aProp.enum).toBeUndefined();
    expect(aProp.description).toContain("stated");
  });

  it("列挙から外れた値は、どちらの provider でも黙って通らない", async () => {
    const enumSchema = z.object({ provenanceKind: z.enum(["stated", "inferred"]) });
    const bad = JSON.stringify({ provenanceKind: "guessed" });
    const { provider: anthropic } = buildAnthropic(bad);
    const { provider: openai } = buildOpenAI(bad);
    const req = { prompt: sharedRequest.prompt, schema: enumSchema };

    await expect(anthropic.completeStructured(ctx, req)).rejects.toThrow(z.ZodError);
    await expect(openai.completeStructured(ctx, req)).rejects.toThrow(z.ZodError);
  });

  it("Anthropic は max_tokens を必須で送る（OpenAI は送らない）", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    expect(anthropicCreate.mock.calls[0]?.[0]).toHaveProperty("max_tokens");
    expect(openaiCreate.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  it("system の渡し方が違う: Anthropic は top-level、OpenAI は messages の一員", async () => {
    const { provider: anthropic, create: anthropicCreate } = buildAnthropic(
      JSON.stringify(sharedJson),
    );
    const { provider: openai, create: openaiCreate } = buildOpenAI(JSON.stringify(sharedJson));

    await anthropic.completeStructured(ctx, sharedRequest);
    await openai.completeStructured(ctx, sharedRequest);

    const anthropicArg = anthropicCreate.mock.calls[0]?.[0] as {
      system?: string;
      messages: { role: string }[];
    };
    const openaiArg = openaiCreate.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };

    expect(anthropicArg.system).toBe("あなたは抽出器です。");
    expect(anthropicArg.messages.map((m) => m.role)).toEqual(["user"]);

    expect(openaiArg.messages[0]).toEqual({ role: "system", content: "あなたは抽出器です。" });
    expect(openaiArg.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
