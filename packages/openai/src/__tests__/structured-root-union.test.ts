import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import {
  ClaimKeyBatchResultSchema,
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
} from "@mnemora/core";
import { DeterministicEmbeddingProvider, buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { translateForOpenAIStructuredOutput } from "../json-schema.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 根が object でないスキーマ（判別可能ユニオンなど）を、OpenAI の strict な Structured Outputs が
 * 受け付ける形で送り、返った値を元の形へ戻す。
 *
 * OpenAI の strict は、根が `type: "object"` であること・`oneOf` を使わないことを求める
 * （`openai` SDK 自身の strict 変換 `lib/transform.js` の `toStrictJsonSchema` が
 * `Root schema must have type: 'object'` / `Root schema must not use anyOf` で投げ、
 * `helpers/standard-schema.js` は「OpenAI strict schemas do not support `oneOf`」と書く）。
 *
 * 【実測 2026-09-27、`openai@7.10.0`】core の4つのスキーマの翻訳を SDK の `toStrictJsonSchema` に
 * 通すと、`ReflectionLLMResultSchema`（`outcome` を判別子にする判別可能ユニオン、ADR 0091）
 * だけが `Root schema must have type: 'object' but got type: undefined` で落ちた——
 * `runtime.reflect()` を OpenAI の provider で呼ぶと、実 API に拒まれる形を送っていた
 * （実 API には当てていない。当てたのは SDK 自身の検査だけ）。
 */

const require = createRequire(import.meta.url);
const { toStrictJsonSchema } = require("openai/lib/transform") as {
  toStrictJsonSchema: (schema: Record<string, unknown>) => Record<string, unknown>;
};

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { system: "s", messages: [{ role: "user" as const, content: "u" }] };

function collectKeys(node: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((child) => collectKeys(child, keys));
  } else if (typeof node === "object" && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function clientReturning(content: string) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    client: {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            sent.push(body);
            return { choices: [{ message: { content, refusal: null }, finish_reason: "stop" }] };
          },
        },
      },
    } as never,
  };
}

describe("OpenAI の strict が受け付ける形で送る（SDK 自身の strict 検査に通す）", () => {
  it.each([
    ["ExtractionResultSchema", ExtractionResultSchema],
    ["ConsolidationLLMResultSchema", ConsolidationLLMResultSchema],
    ["ReflectionLLMResultSchema", ReflectionLLMResultSchema],
    ["ClaimKeyBatchResultSchema", ClaimKeyBatchResultSchema],
  ] as const)("core の %s", (_name, schema) => {
    const { schema: sent } = translateForOpenAIStructuredOutput("x", schema as z.ZodType<unknown>);
    expect(sent["type"]).toBe("object");
    expect(() => toStrictJsonSchema(structuredClone(sent))).not.toThrow();
    expect(collectKeys(sent).has("oneOf")).toBe(false);
  });

  it("根が object のスキーマは、包まずにそのまま送る（今までと同じ形）", () => {
    const schema = z.object({ content: z.string() });
    const { schema: sent } = translateForOpenAIStructuredOutput("x", schema);
    expect(sent).toEqual({
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    });
  });

  // `structured-root.ts` の `wrapRootSchema` の doc・README の表の注: 根そのものを指す `$ref: "#"` は
  // 書き換えないので、根が再帰する union を包むと、子の参照は包みの object を指す（今の振る舞いを縛る）。
  it("根が再帰する union は、子の $ref: '#' が包みの object（{ result }）を指したまま送る", () => {
    type Node = { kind: "leaf" } | { kind: "node"; children: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("leaf") }),
        z.object({ kind: z.literal("node"), children: z.array(NodeSchema) }),
      ]),
    );
    const { schema: sent } = translateForOpenAIStructuredOutput("x", NodeSchema);
    // 根は包みの object で、その唯一の欄が元の union。
    expect(sent["type"]).toBe("object");
    expect(sent["required"]).toEqual(["result"]);
    const union = (sent["properties"] as { result: { anyOf: Array<Record<string, unknown>> } })
      .result;
    const nodeBranch = union.anyOf.find(
      (branch) => (branch["properties"] as { kind: { const: string } }).kind.const === "node",
    )!;
    const children = (nodeBranch["properties"] as { children: { items: unknown } }).children;
    // 子は根（＝包みの object）を指す。元の union を指す `$defs` の参照にはなっていない。
    expect(children.items).toEqual({ $ref: "#" });
    expect(sent["$defs"]).toBeUndefined();
  });
});

describe("completeStructured: 根が object でないスキーマの往復", () => {
  it("判別可能ユニオン（ReflectionLLMResultSchema）の各枝の値が、元の形で返る", async () => {
    for (const value of [
      { outcome: "nothing" },
      { outcome: "reflected", content: "内省した本文", digest: null, tags: null },
    ]) {
      const { client, sent } = clientReturning(JSON.stringify({ result: value }));
      const provider = new OpenAILLMProvider({ model: "m", client });
      const result = await provider.completeStructured(ctx, {
        prompt,
        schema: ReflectionLLMResultSchema,
      });
      expect(result).toEqual(
        value.outcome === "nothing"
          ? { outcome: "nothing" }
          : { outcome: "reflected", content: "内省した本文" },
      );
      const format = (
        sent[0]!["response_format"] as { json_schema: { schema: Record<string, unknown> } }
      ).json_schema.schema;
      expect(format["type"]).toBe("object");
    }
  });

  it("包んだ欄が欠けた応答は、ほかのスキーマ不一致と同じく ZodError になる（黙って通らない）", async () => {
    const { client } = clientReturning(JSON.stringify({ outcome: "nothing" }));
    const provider = new OpenAILLMProvider({ model: "m", client });
    await expect(
      provider.completeStructured(ctx, { prompt, schema: ReflectionLLMResultSchema }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("根が object のスキーマの応答は、今までどおり包まずに読む", async () => {
    const { client } = clientReturning(JSON.stringify({ content: "c", result: "x" }));
    const provider = new OpenAILLMProvider({ model: "m", client });
    const result = await provider.completeStructured(ctx, {
      prompt,
      schema: z.object({ content: z.string() }),
    });
    expect(result).toEqual({ content: "c" });
  });
});

describe("runtime.reflect() を OpenAILLMProvider で通す（判別可能ユニオンの往復）", () => {
  it("LLM が包みの欄に reflected を返すと、内省の Memory が書かれる（llm_failed にならない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const { client, sent } = clientReturning(
      JSON.stringify({
        result: { outcome: "reflected", content: "二人とも朝型である", digest: null, tags: null },
      }),
    );
    const runtime = createRuntime({
      memoryStore,
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      vectorStore: new InMemoryVectorStore(memoryStore),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      llmProvider: new OpenAILLMProvider({ model: "gpt-test", client }),
      embeddingProvider: new DeterministicEmbeddingProvider(),
      hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    });
    const ids = [];
    for (const content of ["A さんは朝6時に起きる", "B さんは朝5時に走る"]) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, content, contentHash: content }),
      );
      ids.push(memory.id);
    }

    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });

    expect(result.llmFailure).toBeNull();
    expect(result.outcome).toBe("reflected");
    expect((await memoryStore.get(ctx, result.reflectedMemoryId!))?.content).toBe(
      "二人とも朝型である",
    );
    const format = (
      sent[0]!["response_format"] as { json_schema: { schema: Record<string, unknown> } }
    ).json_schema.schema;
    expect(() => toStrictJsonSchema(structuredClone(format))).not.toThrow();
  });
});
