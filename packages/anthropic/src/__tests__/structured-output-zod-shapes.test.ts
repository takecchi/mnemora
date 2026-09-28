import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * 利用者が `completeStructured` に渡す zod の形のうち、どれが送る前に落ちるか（今の振る舞い、#1148）。
 * README「`completeStructured` に渡せる zod の形」の歯。偽の client で、送ったかどうかだけを見る
 * （Anthropic の実 API には当てていない——送った後にベンダーが受けるかは確かめていない）。
 *
 * 送る前に落ちる形は、SDK の `zodOutputFormat`（zod の `toJSONSchema` と SDK の
 * `transformJSONSchema`）が素の `Error` を投げ、`messages.create` は呼ばれない。
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
    "%s は送る前に素の Error を投げ、messages.create を呼ばない",
    async (_label, schema, message) => {
      const { create, provider } = providerWithSpy();
      await expect(
        provider.completeStructured(ctx, { prompt, schema: schema as z.ZodType<unknown> }),
      ).rejects.toThrow(message);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["z.record", z.object({ x: z.record(z.string(), z.string()) })],
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

  // README の 2026-09-28 追記: z.record は送られるが、送る形は空の object しか許さない
  // （キーと値の制約は description へ降格する）。今の振る舞いを縛る。SDK の版上げで形が変われば赤になる。
  it("z.record は、空の object しか許さない形（additionalProperties: false、properties は空）で送る", async () => {
    const { create, provider } = providerWithSpy();
    await provider
      .completeStructured(ctx, {
        prompt,
        schema: z.object({ x: z.record(z.string(), z.string()) }) as z.ZodType<unknown>,
      })
      .catch(() => undefined);
    const sent = (
      create.mock.calls[0] as unknown as [
        { output_config: { format: { schema: { properties: { x: Record<string, unknown> } } } } },
      ]
    )[0];
    const x = sent.output_config.format.schema.properties.x;
    expect(x.type).toBe("object");
    expect(x.properties).toEqual({});
    expect(x.additionalProperties).toBe(false);
    expect(x.description).toContain("propertyNames");
  });
});
