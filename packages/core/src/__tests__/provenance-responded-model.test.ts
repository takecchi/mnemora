import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredResponse } from "../interfaces/llm-provider.js";
import { ProvenanceSchema } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 抽出の応答を実際に返したモデル（`respondedModel`）が、inferred の provenance に「確かめたときだけ」載ること（ADR 0701）。

const ctx: Ctx = { tenantId: "provenance-responded-model" };

/** 抽出を1回させて、inferred の候補を `content` で1件返す provider。`withMeta` を渡すと任意の口も実装する。 */
function extractingProvider(
  content: () => string,
  withMeta?: () => Omit<StructuredResponse<unknown>, "value">,
): LLMProvider {
  const respond = <T>(schema: { parse(v: unknown): T }): T =>
    schema.parse({ memories: [{ content: content(), provenanceKind: "inferred" }] });
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_c, req) => respond(req.schema),
    ...(withMeta !== undefined
      ? {
          completeStructuredWithMeta: async (_c, req) => ({
            value: respond(req.schema),
            ...withMeta(),
          }),
        }
      : {}),
  } as LLMProvider;
}

async function observeOnce(llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider,
    hashContent: (c: string) => `h:${c}`,
    config: { llmModelId: "configured-model" },
  });
  const observed = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
  const memory = (await stores.memoryStore.get(ctx, observed.memoryIds[0]!))!;
  return { stores, runtime, observed, memory };
}

describe("inferred の provenance: model は設定値、respondedModel は応答の値（ADR 0701）", () => {
  it("provider が応答のモデル名を返すと、respondedModel に載り、model は設定値のまま", async () => {
    const { memory } = await observeOnce(
      extractingProvider(
        () => "推論した事実",
        () => ({ respondedModel: "responded-model-2026-01-01" }),
      ),
    );

    expect(memory.provenance).toMatchObject({
      kind: "inferred",
      model: "configured-model",
      respondedModel: "responded-model-2026-01-01",
    });
    expect(ProvenanceSchema.safeParse(memory.provenance).success).toBe(true);
  });

  it("任意の口を実装しない provider では、respondedModel をキーごと残さない（確かめていない）", async () => {
    const { memory } = await observeOnce(extractingProvider(() => "推論した事実"));

    expect(memory.provenance.kind).toBe("inferred");
    expect("respondedModel" in memory.provenance).toBe(false);
  });

  it.each([
    ["respondedModel を省いた", () => ({})],
    ["respondedModel が空文字の", () => ({ respondedModel: "" })],
  ])(
    "%s応答では、respondedModel を残さない（空文字で確かめた顔をさせない）",
    async (_label, meta) => {
      const { memory } = await observeOnce(extractingProvider(() => "推論した事実", meta));

      expect("respondedModel" in memory.provenance).toBe(false);
    },
  );

  it("フォールバックで別のモデルが応答したら、そのモデル名が残る（包む provider は中の値を通す契約）", async () => {
    let responder = "primary-model";
    const { memory, runtime, observed, stores } = await observeOnce(
      extractingProvider(
        () => `事実(${responder})`,
        () => ({ respondedModel: responder }),
      ),
    );
    expect(memory.provenance).toMatchObject({ respondedModel: "primary-model" });

    responder = "fallback-model";
    const reextracted = await runtime.reextract(ctx, observed.observationId);
    const rewritten = (await stores.memoryStore.get(ctx, reextracted.memoryIds[0]!))!;

    expect(rewritten.provenance).toMatchObject({
      kind: "inferred",
      model: "configured-model",
      respondedModel: "fallback-model",
    });
  });

  it("抽出の LLM 呼び出しが失敗した全文フォールバックの記憶（stated）には、モデル名を残さない", async () => {
    const { memory } = await observeOnce({
      complete: async () => ({ content: "unused" }),
      completeStructured: async () => {
        throw new Error("LLM 失敗（テストの注入）");
      },
      completeStructuredWithMeta: async () => {
        throw new Error("LLM 失敗（テストの注入）");
      },
    });

    expect(memory.provenance.kind).toBe("stated");
    expect("respondedModel" in memory.provenance).toBe(false);
  });

  it("schema は空文字の respondedModel を拒む", () => {
    expect(
      ProvenanceSchema.safeParse({
        kind: "inferred",
        model: "m",
        respondedModel: "",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["o"] },
        confidence: 0.5,
      }).success,
    ).toBe(false);
  });
});
