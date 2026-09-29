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
