import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0517 の「空白だけの `title` は前置きにしない」を、純関数ではなく `observe()` を実際に通る経路で縛る。
 * `extraction.ts` の2つの呼び出し箇所（抽出に渡る本文・LLM 失敗時の全文フォールバックの Memory の本文）と、
 * `runtime.ts` が保存する payload の `title`（trim せず元の文字列のまま）。
 * core 自身のテストなので `@mnemora/testkit` には依存しない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2099-01-01T00:00:00.000Z");

function buildRuntime(opts: { llmFails: boolean }) {
  const stores = createFakeRuntimeStores();
  const prompts: string[] = [];
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        for (const m of req.prompt.messages) prompts.push(m.content);
        if (opts.llmFails) {
          throw new Error("simulated llm failure");
        }
        return req.schema.parse({
          memories: [{ content: "抽出結果", provenanceKind: "stated" }],
        }) as T;
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores, prompts };
}

const BLANK_TITLES = ["   ", "\n\t", "　", " "];

describe("observe(): extractTitle: true で空白だけの title は前置きにならない（ADR 0517、実際に通る経路）", () => {
  it.each(BLANK_TITLES)("抽出に渡る本文は content だけ: %j", async (title) => {
    const { runtime, prompts } = buildRuntime({ llmFails: false });
    await runtime.observe(ctx, {
      kind: "document",
      title,
      content: "本文C",
      extractTitle: true,
    });
    expect(prompts).toEqual(["本文C"]);
  });

  it.each(BLANK_TITLES)(
    "LLM 失敗時の全文フォールバックの Memory の本文は content だけ: %j",
    async (title) => {
      const { runtime, stores } = buildRuntime({ llmFails: true });
      const result = await runtime.observe(ctx, {
        kind: "document",
        title,
        content: "本文C",
        extractTitle: true,
      });
      expect(result.memoryIds.length).toBe(1);
      const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
      expect(memory?.content).toBe("本文C");
    },
  );

  it("実質のある title は、抽出に渡る本文でも全文フォールバックでも前置きになる（対照）", async () => {
    const ok = buildRuntime({ llmFails: false });
    await ok.runtime.observe(ctx, {
      kind: "document",
      title: "題",
      content: "本文C",
      extractTitle: true,
    });
    expect(ok.prompts).toEqual(["題\n\n本文C"]);

    const ng = buildRuntime({ llmFails: true });
    const result = await ng.runtime.observe(ctx, {
      kind: "document",
      title: "題",
      content: "本文C",
      extractTitle: true,
    });
    const memory = await ng.stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe("題\n\n本文C");
  });

  it.each(["   ", " 題 ", "　"])(
    "保存される payload の title は元の文字列のまま（trim しない）: %j",
    async (title) => {
      const { runtime, stores } = buildRuntime({ llmFails: false });
      const result = await runtime.observe(ctx, {
        kind: "document",
        title,
        content: "本文C",
        extractTitle: true,
      });
      const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
      const payload = observation?.payload as Record<string, unknown>;
      expect(payload.title).toBe(title);
    },
  );
});
