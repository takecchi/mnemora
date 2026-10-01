import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";
import { OpenAILLMProviderError } from "../errors.js";

/**
 * 利用者が `completeStructured` に渡す zod の形のうち、どれが送る前に落ちるか
 * （[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
 * [ADR 0360](../../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）。
 * README「`completeStructured` に渡せる zod の形」の歯。偽の client で、送ったかどうかだけを見る。
 *
 * ⚠ **2026-09-29 追記: 振る舞いを変えた。**以前は `z.record`・`z.tuple`・`z.date`・`transform` の
 * どれも送ってからベンダーに拒ませていた（【実測 2026-09-27】OpenAI が HTTP 400 で拒む）。
 * **いまは4つとも送る前に `OpenAILLMProviderError`（`kind: "schema_unsupported"`）で落ちる**
 * ——`z.date`・`transform` は zod 自身の既定（throw）が、`z.record`・`z.tuple` は送る直前に
 * 通す `openai` SDK 自身の strict 検査（`toStrictJsonSchema`）が投げる。`z.lazy`（再帰）と
 * `default` は今までどおり通る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

describe("OpenAILLMProvider.completeStructured: 送る前に schema_unsupported で落ちる", () => {
  it.each([
    ["z.record", z.object({ x: z.record(z.string(), z.string()) })],
    ["z.tuple", z.object({ x: z.tuple([z.string(), z.number()]) })],
    ["z.date", z.object({ x: z.date() })],
    ["transform", z.object({ x: z.string().transform((s) => s.length) })],
  ] as const)(
    "%s は create を呼ばず、OpenAILLMProviderError(kind: schema_unsupported) を cause 付きで投げる",
    async (_label, schema) => {
      const create = vi.fn(async () => {
        throw new Error("偽の client: 呼ばれてはいけない");
      });
      const provider = new OpenAILLMProvider({
        model: "m",
        client: { chat: { completions: { create } } } as never,
      });
      let caught: unknown;
      try {
        await provider.completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OpenAILLMProviderError);
      expect((caught as OpenAILLMProviderError).kind).toBe("schema_unsupported");
      // cause には元の例外（zod の Error か、openai SDK の toStrictJsonSchema が投げた Error）が載る。
      expect((caught as OpenAILLMProviderError).cause).toBeInstanceOf(Error);
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
  ] as const)(
    "%s は送る前には落ちず、chat.completions.create を1回呼ぶ",
    async (_label, schema) => {
      const create = vi.fn(async () => ({
        choices: [
          { message: { content: JSON.stringify({ x: "v", root: { name: "n", children: [] } }) } },
        ],
      }));
      const provider = new OpenAILLMProvider({
        model: "m",
        client: { chat: { completions: { create } } } as never,
      });
      await provider
        .completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> })
        .catch(() => undefined);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
});

/**
 * README「上の表に無い形の、今の振る舞い」の歯（[ADR 0471](../../../../docs/decisions/0471-structured-output-zod-shapes-recorded-in-readme.md)）。
 * ⚠ **今の振る舞いの記録であって、約束ではない**——変えるかどうかはオーナーの判断が要る。変えると決まったら、この歯と README の表を一緒に書き換えること。
 */
describe("OpenAILLMProvider.completeStructured: 上の表に無い形の、今の振る舞い（記録）", () => {
  async function sendAndParse(schema: z.ZodType<unknown>, response: unknown) {
    const create = vi.fn(async (_body: unknown) => ({
      choices: [
        { finish_reason: "stop", message: { refusal: null, content: JSON.stringify(response) } },
      ],
    }));
    const provider = new OpenAILLMProvider({
      model: "m",
      client: { chat: { completions: { create } } } as never,
    });
    let result: unknown;
    let error: unknown;
    try {
      result = await provider.completeStructured(ctx, { prompt, schema });
    } catch (e) {
      error = e;
    }
    const body = create.mock.calls[0]?.[0] as
      | { response_format: { json_schema: { schema: { properties: Record<string, unknown> } } } }
      | undefined;
    return { create, result, error, sent: body?.response_format.json_schema.schema };
  }

  it("z.any()・z.unknown() は型の無い {} で送り、どんな値でも通す（@mnemora/anthropic は送る前に落とす）", async () => {
    for (const schema of [z.object({ x: z.any() }), z.object({ x: z.unknown() })]) {
      const { create, result, sent } = await sendAndParse(schema, { x: { k: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(sent?.properties.x).toEqual({});
      expect(result).toEqual({ x: { k: 1 } });
    }
  });

  it(".nullable().optional() は null が2回入る anyOf、z.null().optional() は type: [null, null] で送る", async () => {
    const a = await sendAndParse(z.object({ x: z.string().nullable().optional() }), { x: "v" });
    expect(a.sent?.properties.x).toEqual({
      anyOf: [{ type: ["string", "null"] }, { type: "null" }],
    });
    const b = await sendAndParse(z.object({ x: z.null().optional() }), {});
    expect(b.sent?.properties.x).toEqual({ type: ["null", "null"] });
  });

  it(".catchall(T) は additionalProperties: false で送り、T を送らない", async () => {
    const { sent } = await sendAndParse(z.object({ a: z.string() }).catchall(z.number()), {
      a: "v",
    });
    expect((sent as unknown as { additionalProperties: unknown }).additionalProperties).toBe(false);
    expect(Object.keys(sent?.properties ?? {})).toEqual(["a"]);
  });

  it(".nullable().default(v) に null が返ると v になる（@mnemora/anthropic は null のまま）", async () => {
    const { result } = await sendAndParse(z.object({ a: z.string().nullable().default("x") }), {
      a: null,
    });
    expect(result).toEqual({ a: "x" });
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
