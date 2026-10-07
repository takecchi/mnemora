import { describe, expect, it } from "vitest";
import type { z } from "zod";
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
import { translateForOpenAIStructuredOutput } from "../json-schema.js";
import { OpenAILLMProvider } from "../llm-provider.js";
import { needsRootWrap, toBaseJsonSchema, WRAPPED_ROOT_KEY } from "../structured-root.js";

/** 射程は送る前の変換・検査まで。利用者が渡す zod の形は `structured-output-zod-shapes.test.ts` が縛り、ここは core が実際に渡す形だけを縛る。 */

describe("core の4つのスキーマは、送る前の変換・検査を通る（schema_unsupported にならない）", () => {
  const cases: Array<[string, z.ZodType<unknown>, "object" | "wrapped"]> = [
    ["ExtractionResultSchema（observe・reextract）", ExtractionResultSchema, "object"],
    ["ClaimKeyBatchResultSchema（claim key）", ClaimKeyBatchResultSchema, "object"],
    ["ConsolidationLLMResultSchema（consolidate）", ConsolidationLLMResultSchema, "object"],
    // 根が判別可能ユニオン。OpenAI は根に object を要求するので、1つの欄 `result` に包んで送る（`structured-root.ts`）。
    ["ReflectionLLMResultSchema（reflect）", ReflectionLLMResultSchema, "wrapped"],
  ];

  for (const [name, schema, rootShape] of cases) {
    it(`${name} は投げずに翻訳・検査でき、根は ${rootShape === "object" ? "object" : "包んだ object"} である`, () => {
      const base = toBaseJsonSchema(schema);
      const wrapped = needsRootWrap(base);
      expect(wrapped).toBe(rootShape === "wrapped");
      const { schema: jsonSchema } = translateForOpenAIStructuredOutput(name, schema);
      expect(jsonSchema["type"]).toBe("object");
      if (wrapped) {
        expect((jsonSchema["required"] as string[]).includes(WRAPPED_ROOT_KEY)).toBe(true);
      }
    });
  }
});

describe("runtime の LLM の口は、偽の client の chat.completions.create まで届く（送る前に落ちない）", () => {
  function fakeClient(sent: Array<Record<string, unknown>>) {
    const reply = (schema: Record<string, unknown>): unknown => {
      const s = JSON.stringify(schema);
      if (s.includes('"memories"')) {
        return {
          memories: [{ content: `東京に住んでいる ${sent.length}`, provenanceKind: "stated" }],
        };
      }
      if (s.includes('"claims"')) return { claims: [{ subject: "user", predicate: "home_city" }] };
      if (s.includes(WRAPPED_ROOT_KEY)) {
        return { [WRAPPED_ROOT_KEY]: { outcome: "reflected", content: "内省した本文" } };
      }
      return { content: "統合した本文" };
    };
    return {
      chat: {
        completions: {
          create: async (body: {
            response_format?: { json_schema?: { schema?: Record<string, unknown> } };
          }) => {
            const schema = body.response_format?.json_schema?.schema;
            if (schema === undefined) throw new Error("response_format.json_schema.schema が無い");
            sent.push(schema);
            return {
              choices: [
                {
                  message: { content: JSON.stringify(reply(schema)), refusal: null },
                  finish_reason: "stop",
                },
              ],
            };
          },
        },
      },
    } as never;
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
      llmProvider: new OpenAILLMProvider({
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

    const second = await runtime.observe(ctx, { kind: "utterance", text: "京都にも家がある" });
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    const targets = [plain.memoryIds[0]!, second.memoryIds[0]!];

    before = sent.length;
    const reflected = await runtime.reflect(ctx, { target: { memoryIds: targets } });
    expect(reflected.llmFailure).toBeNull();
    expect(sent.length - before).toBe(1);
    expect((sent[sent.length - 1]!["required"] as string[]).includes(WRAPPED_ROOT_KEY)).toBe(true);

    before = sent.length;
    const consolidated = await runtime.consolidate(ctx, { target: { memoryIds: targets } });
    expect(consolidated.outcome).toBe("consolidated");
    expect(consolidated.llmFailure).toBeNull();
    expect(sent.length - before).toBe(1);
  });
});
