import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Anthropic } from "@anthropic-ai/sdk";
import {
  ClaimKeyBatchResultSchema,
  ConsolidationLLMResultSchema,
  createRuntime,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
} from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { translateForAnthropicStructuredOutput } from "../json-schema.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * 射程は送る前の変換まで。実 API が送った JSON Schema を受けるかは確かめていない（鍵が無い）。
 * 利用者が渡す zod の形は `structured-output-zod-shapes.test.ts` が縛り、ここは core が実際に渡す形だけを縛る。
 */

describe("core の4つのスキーマは、送る前の変換を通る", () => {
  const cases: Array<[string, z.ZodType<unknown>, "object" | "anyOf"]> = [
    ["ExtractionResultSchema（observe・reextract）", ExtractionResultSchema, "object"],
    ["ClaimKeyBatchResultSchema（claim key）", ClaimKeyBatchResultSchema, "object"],
    ["ConsolidationLLMResultSchema（consolidate）", ConsolidationLLMResultSchema, "object"],
    // 根が判別可能ユニオン。`@mnemora/openai` と違い、包まずに anyOf のまま送る。
    ["ReflectionLLMResultSchema（reflect）", ReflectionLLMResultSchema, "anyOf"],
  ];

  for (const [name, schema, root] of cases) {
    it(`${name} は投げずに翻訳でき、根は ${root} である`, () => {
      const { schema: jsonSchema } = translateForAnthropicStructuredOutput(schema);
      if (root === "object") {
        expect(jsonSchema.type).toBe("object");
      } else {
        expect(jsonSchema.type).toBeUndefined();
        expect(Array.isArray(jsonSchema.anyOf)).toBe(true);
        for (const branch of jsonSchema.anyOf as Array<Record<string, unknown>>) {
          expect(branch.type).toBe("object");
        }
      }
      expect(JSON.parse(JSON.stringify(jsonSchema))).toEqual(jsonSchema);
    });
  }
});

describe("runtime の LLM の口は、偽の client の messages.create まで届く（送る前に落ちない）", () => {
  function fakeClient(sent: Array<Record<string, unknown>>): Pick<Anthropic, "messages"> {
    const reply = (schema: Record<string, unknown>): unknown => {
      const s = JSON.stringify(schema);
      if (s.includes('"memories"')) {
        return {
          memories: [{ content: `東京に住んでいる ${sent.length}`, provenanceKind: "stated" }],
        };
      }
      if (s.includes('"claims"')) return { claims: [{ subject: "user", predicate: "home_city" }] };
      if (s.includes('"outcome"')) return { outcome: "reflected", content: "内省した本文" };
      return { content: "統合した本文" };
    };
    return {
      messages: {
        create: async (body: {
          output_config?: { format?: { schema?: Record<string, unknown> } };
        }) => {
          const schema = body.output_config?.format?.schema;
          if (schema === undefined) throw new Error("output_config.format.schema が無い");
          sent.push(schema);
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(reply(schema)) }],
          };
        },
      },
    } as unknown as Pick<Anthropic, "messages">;
  }

  function build() {
    const sent: Array<Record<string, unknown>> = [];
    const memoryStore = new InMemoryMemoryStore();
    const runtime = createRuntime({
      memoryStore,
      vectorStore: new InMemoryVectorStore(memoryStore),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      tenantSettingsStore: new InMemoryTenantSettingsStore(),
      llmProvider: new AnthropicLLMProvider({
        apiKey: "sk-test",
        model: "m",
        client: fakeClient(sent),
      }),
      embeddingProvider: {
        space: { provider: "p", model: "m", dimensions: 3 },
        embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content) => `h(${content})`,
    });
    return { runtime, sent };
  }

  const ctx: Ctx = { tenantId: "core-schemas-send-shape" };

  it("observe（抽出）・claim key 付きの observe・reextract・reflect・consolidate が、それぞれ JSON Schema を送って成功する", async () => {
    const { runtime, sent } = build();

    let before = sent.length;
    const plain = await runtime.observe(ctx, { kind: "utterance", text: "東京に住んでいる" });
    expect(plain.extraction).toBe("ok");
    expect(sent.length - before).toBe(1);

    before = sent.length;
    const withClaimKey = await runtime.observe(ctx, {
      kind: "utterance",
      text: "大阪に引っ越した",
      claimKey: { enabled: true },
    });
    expect(withClaimKey.extraction).toBe("ok");
    expect(sent.length - before).toBe(2);

    before = sent.length;
    await runtime.reextract(ctx, withClaimKey.observationId);
    expect(sent.length - before).toBe(1);

    // 統合・内省の対象は、まだ superseded になっていない2件（reextract は元の候補を置き換えるので、その後に新しく作る）。
    const second = await runtime.observe(ctx, { kind: "utterance", text: "京都にも家がある" });
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    const targets = [plain.memoryIds[0]!, second.memoryIds[0]!];

    // reflect を先に当てる（consolidate で元の記憶が superseded になると、内省の対象にならないため）。
    before = sent.length;
    const reflected = await runtime.reflect(ctx, { target: { memoryIds: targets } });
    expect(reflected.llmFailure).toBeNull();
    expect(sent.length - before).toBe(1);
    expect(sent[sent.length - 1]!.anyOf).toBeDefined();

    before = sent.length;
    const consolidated = await runtime.consolidate(ctx, { target: { memoryIds: targets } });
    expect(consolidated.outcome).toBe("consolidated");
    expect(consolidated.llmFailure).toBeNull();
    expect(sent.length - before).toBe(1);
  });
});
