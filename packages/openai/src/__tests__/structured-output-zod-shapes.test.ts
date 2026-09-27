import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 利用者が `completeStructured` に渡す zod の形は、`@mnemora/openai` では送る前には落ちない
 * （今の振る舞い、#1148）。README「`completeStructured` に渡せる zod の形」の歯。偽の client で、
 * 送ったかどうかだけを見る。
 *
 * 【実測 2026-09-27、`gpt-4o-mini`、各1回】`z.record`・`z.tuple`・`z.date`・`transform` は、送った後に
 * OpenAI が HTTP 400（`BadRequestError`、`param: response_format`）で拒んだ。`z.lazy`（再帰）と
 * `default` は通った。`z.date`・`transform` は `openai` SDK の strict 検査（`toStrictJsonSchema`）は
 * 通るが、実 API は拒む——SDK の検査は、実 API が受けることの十分条件ではない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

describe("OpenAILLMProvider.completeStructured: 送る前には落とさない（拒むのはベンダー）", () => {
  it.each([
    ["z.record", z.object({ x: z.record(z.string(), z.string()) })],
    ["z.tuple", z.object({ x: z.tuple([z.string(), z.number()]) })],
    ["z.date", z.object({ x: z.date() })],
    ["transform", z.object({ x: z.string().transform((s) => s.length) })],
  ] as const)("%s は翻訳で投げず、chat.completions.create を1回呼ぶ", async (_label, schema) => {
    const create = vi.fn(async () => {
      throw new Error("偽の client: ベンダーの拒否の代わり");
    });
    const provider = new OpenAILLMProvider({
      model: "m",
      client: { chat: { completions: { create } } } as never,
    });
    await expect(
      provider.completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> }),
    ).rejects.toThrow("偽の client");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
