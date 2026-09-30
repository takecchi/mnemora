import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";
import { AnthropicLLMProviderError } from "../errors.js";

/**
 * 利用者が `completeStructured` に渡す zod の形のうち、どれが送る前に落ちるか
 * （[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
 * [ADR 0360](../../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）。
 * README「`completeStructured` に渡せる zod の形」の歯。偽の client で、送ったかどうかだけを見る
 * （Anthropic の実 API には当てていない——送った後にベンダーが受けるかは確かめていない）。
 *
 * ⚠ **2026-09-29 追記: 振る舞いを変えた。**以前は送る前に落ちる形（`z.tuple`・`z.date`・
 * `transform`）は SDK の `zodOutputFormat`（zod の `toJSONSchema` と SDK の
 * `transformJSONSchema`）が投げる**素の** `Error` がそのまま伝わり、`kind` を持たなかった。
 * **いまはその例外を `AnthropicLLMProviderError`（`kind: "schema_unsupported"`）に包み、
 * 元の例外を `cause` に載せる。**`messages.create` は今までどおり呼ばれない。**
 *
 * ⚠ **2026-09-30 追記: `z.record` も送る前に落ちるようにした**（ADR 0360 の追記、負債3）。
 * 以前は翻訳が通り、空の object しか許さない形で送っていた（中身が黙って空になる）。
 */

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

  // 旧: z.record は「空の object しか許さない形」で送っていた（README の 2026-09-28 追記）。
  // 翻訳が失敗しない代わりに中身が黙って空になるため、送る前に落とす（ADR 0360 の 2026-09-30 追記）。
  // ⚠ 深さを問わない: object の欄・配列の要素・optional/nullable/default の内側・union の枝・
  // 再帰（z.lazy / getter）の先・discriminatedUnion・intersection・キーが enum の record も落ちる。
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
    ]) {
      const { create, provider } = providerWithSpy();
      await provider
        .completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> })
        .catch(() => undefined);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });
});
