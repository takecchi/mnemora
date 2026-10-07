import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReflectionLLMResultSchema } from "@mnemora/core";
import { translateForOpenAIStructuredOutput } from "../json-schema.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 根が object でないスキーマを包む object（欄 `result` だけを持つ）は、`additionalProperties: false` を付けて送る。
 * OpenAI の strict な Structured Outputs は、object すべてにこれを求める。`openai` SDK 自身の strict 変換
 * （`toStrictJsonSchema`）は欠けた `additionalProperties` を補うので、SDK の検査に通すだけではこの欠落を見逃す。
 * 送る形そのものを見る。
 */

const ctx = { tenantId: "tenant-1" };
const prompt = { system: "s", messages: [{ role: "user" as const, content: "u" }] };

const UNION = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("a"), value: z.string() }),
  z.object({ kind: z.literal("b"), count: z.number() }),
]);

type Tree = { label: string; children: Tree[] };
const TreeSchema: z.ZodType<Tree> = z.lazy(() =>
  z.object({ label: z.string(), children: z.array(TreeSchema) }),
);
const UNION_WITH_DEFS = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("a"), tree: TreeSchema }),
  z.object({ kind: z.literal("b"), trees: z.array(TreeSchema) }),
]);

describe("包みの根は additionalProperties: false を付けて送る", () => {
  it.each([
    ["判別可能ユニオン", UNION],
    ["$defs を持つ判別可能ユニオン", UNION_WITH_DEFS],
    ["core の ReflectionLLMResultSchema", ReflectionLLMResultSchema],
  ] as const)("%s", (_name, schema) => {
    const { schema: sent } = translateForOpenAIStructuredOutput("x", schema as z.ZodType<unknown>);
    expect(sent["type"]).toBe("object");
    expect(sent["required"]).toEqual(["result"]);
    expect(Object.keys(sent["properties"] as object)).toEqual(["result"]);
    expect(sent["additionalProperties"]).toBe(false);
  });

  it("completeStructured が実際に送る response_format の根も、additionalProperties: false である", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            sent.push(body);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ result: { outcome: "nothing" } }),
                    refusal: null,
                  },
                  finish_reason: "stop",
                },
              ],
            };
          },
        },
      },
    } as never;
    const provider = new OpenAILLMProvider({ model: "m", client });
    await provider.completeStructured(ctx, { prompt, schema: ReflectionLLMResultSchema });
    const root = (
      sent[0]!["response_format"] as { json_schema: { schema: Record<string, unknown> } }
    ).json_schema.schema;
    expect(root["additionalProperties"]).toBe(false);
  });

  it("根が object のスキーマは、包まないので根の additionalProperties は元のまま（対照）", () => {
    const { schema: sent } = translateForOpenAIStructuredOutput(
      "x",
      z.object({ content: z.string() }),
    );
    expect(sent["required"]).toEqual(["content"]);
    expect(sent["additionalProperties"]).toBe(false);
  });
});
