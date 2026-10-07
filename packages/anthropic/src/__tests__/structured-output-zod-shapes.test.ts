import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";
import { AnthropicLLMProviderError } from "../errors.js";

/** README「`completeStructured` に渡せる zod の形」の歯。偽の client で、送ったかどうかだけを見る（実 API には当てていない）。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

function providerWithSpy() {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ x: "v" }) }],
    stop_reason: "end_turn",
  }));
  return {
    create,
    provider: new AnthropicLLMProvider({ model: "m", client: { messages: { create } } as never }),
  };
}

describe("AnthropicLLMProvider.completeStructured: 送る前に落ちる zod の形", () => {
  it.each([
    [
      "z.tuple",
      z.object({ x: z.tuple([z.string(), z.number()]) }),
      /JSON schema must have a type defined/,
    ],
    ["z.date", z.object({ x: z.date() }), /Date cannot be represented in JSON Schema/],
    [
      "transform",
      z.object({ x: z.string().transform((s) => s.length) }),
      /Transforms cannot be represented in JSON Schema/,
    ],
  ] as const)(
    "%s は create を呼ばず、AnthropicLLMProviderError(kind: schema_unsupported) を cause 付きで投げる",
    async (_label, schema, message) => {
      const { create, provider } = providerWithSpy();
      let caught: unknown;
      try {
        await provider.completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AnthropicLLMProviderError);
      expect((caught as AnthropicLLMProviderError).kind).toBe("schema_unsupported");
      expect((caught as AnthropicLLMProviderError).cause).toBeInstanceOf(Error);
      expect(String((caught as AnthropicLLMProviderError).cause)).toMatch(message);
      expect(create).not.toHaveBeenCalled();
    },
  );

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
  ] as const)("%s は送る前には落ちず、messages.create を1回呼ぶ", async (_label, schema) => {
    const { create, provider } = providerWithSpy();
    await provider
      .completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> })
      .catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // 深さを問わない: object の欄・配列の要素・optional/nullable/default の内側・union の枝・再帰（z.lazy / getter）の先・discriminatedUnion・intersection・キーが enum の record も落ちる。
  const R = z.record(z.string(), z.string());
  const Node = z.object({
    name: z.string(),
    meta: R,
    get children() {
      return z.array(Node);
    },
  });
  it.each([
    ["根の object の欄", z.object({ x: R })],
    ["配列の要素", z.object({ x: z.array(R) })],
    ["optional の内側", z.object({ x: R.optional() })],
    ["nullable の内側", z.object({ x: R.nullable() })],
    ["default の内側", z.object({ x: R.default({}) })],
    ["union の枝", z.object({ x: z.union([z.string(), R]) })],
    ["根が union の枝の中", z.union([z.object({ a: R }), z.object({ b: z.string() })])],
    ["discriminatedUnion の枝", z.discriminatedUnion("k", [z.object({ k: z.literal("a"), r: R })])],
    ["intersection の片側", z.object({ x: z.intersection(z.object({ a: z.string() }), R) })],
    ["z.lazy の先", z.object({ a: z.lazy(() => z.object({ r: R })) })],
    ["再帰スキーマの中（循環しても止まる）", z.object({ root: Node })],
    ["キーが enum の record", z.object({ x: z.record(z.enum(["a", "b"]), z.string()) })],
    ["ネストした object の深い欄", z.object({ a: z.object({ b: z.array(z.object({ c: R })) }) })],
  ] as const)(
    "z.record（%s）は create を呼ばず、AnthropicLLMProviderError(kind: schema_unsupported) を cause 付きで投げる",
    async (_label, schema) => {
      const { create, provider } = providerWithSpy();
      let caught: unknown;
      try {
        await provider.completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AnthropicLLMProviderError);
      expect((caught as AnthropicLLMProviderError).kind).toBe("schema_unsupported");
      const cause = (caught as AnthropicLLMProviderError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(String(cause)).toMatch(/z\.record/);
      expect(String(cause)).toMatch(/\{ key, value \}/);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("z.record を含まない再帰スキーマ・入れ子の object は、今までどおり送る（偽陽性を出さない）", async () => {
    const Tree = z.object({
      name: z.string(),
      get children() {
        return z.array(Tree);
      },
    });
    for (const schema of [
      z.object({ root: Tree }),
      z.object({ x: z.object({ a: z.string() }).optional(), y: z.array(z.string()) }),
      // z.lazy そのものは対象外（z.record を含まない z.lazy は落とさない）。
      z.object({ a: z.lazy(() => z.object({ s: z.string() })) }),
    ]) {
      const { create, provider } = providerWithSpy();
      await provider
        .completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> })
        .catch(() => undefined);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });
});

/** 今の振る舞いの記録であって、約束ではない。変えると決まったら、この歯と README の表を一緒に書き換えること。 */
describe("AnthropicLLMProvider.completeStructured: 上の表に無い形の、今の振る舞い（記録）", () => {
  async function sendAndParse(schema: z.ZodType<unknown>, response: unknown) {
    const create = vi.fn(async (_body: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(response) }],
      stop_reason: "end_turn",
    }));
    const provider = new AnthropicLLMProvider({
      model: "m",
      client: { messages: { create } } as never,
    });
    let result: unknown;
    let error: unknown;
    try {
      result = await provider.completeStructured(ctx, { prompt, schema });
    } catch (e) {
      error = e;
    }
    const body = create.mock.calls[0]?.[0] as
      | { output_config: { format: { schema: { properties: Record<string, unknown> } } } }
      | undefined;
    return { create, result, error, sent: body?.output_config.format.schema };
  }

  it("z.any()・z.unknown() は送る前に schema_unsupported で落ちる（@mnemora/openai は {} で送る）", async () => {
    for (const schema of [z.object({ x: z.any() }), z.object({ x: z.unknown() })]) {
      const { create, error } = await sendAndParse(schema, { x: 1 });
      expect(create).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(AnthropicLLMProviderError);
      expect((error as AnthropicLLMProviderError).kind).toBe("schema_unsupported");
    }
  });

  it(".nullable().optional() は type: [string, null] で送る（null は重ならない）", async () => {
    const { sent } = await sendAndParse(z.object({ x: z.string().nullable().optional() }), {
      x: "v",
    });
    expect(sent?.properties.x).toEqual({ type: ["string", "null"] });
  });

  it(".catchall(T) は additionalProperties: false で送り、T を送らない", async () => {
    const { sent } = await sendAndParse(z.object({ a: z.string() }).catchall(z.number()), {
      a: "v",
    });
    expect((sent as unknown as { additionalProperties: unknown }).additionalProperties).toBe(false);
    expect(Object.keys(sent?.properties ?? {})).toEqual(["a"]);
  });

  it(".nullable().default(v) に null が返ると null のまま（@mnemora/openai は v になる）", async () => {
    const { result } = await sendAndParse(z.object({ a: z.string().nullable().default("x") }), {
      a: null,
    });
    expect(result).toEqual({ a: null });
  });

  it("入力と出力の型が違う pipe は出力側の型で送り、送った形どおりの値は ZodError になる", async () => {
    const schema = z.object({ x: z.string().pipe(z.coerce.number()) });
    const asSent = await sendAndParse(schema, { x: 5 });
    expect(asSent.sent?.properties.x).toEqual({ type: "number" });
    expect((asSent.error as Error | undefined)?.name).toBe("ZodError");
    const asInput = await sendAndParse(schema, { x: "5" });
    expect(asInput.result).toEqual({ x: 5 });
  });
});
