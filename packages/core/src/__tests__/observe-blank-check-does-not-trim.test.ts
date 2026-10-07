import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import { ObserveInputSchema } from "../observation.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 空白だけを断る検査（`NonBlankTextSchema`）が、通した値を trim して返す形（zod の `.transform`/`.trim()`）にすり替わっても、
 * 通る／断るだけを見る歯や、`.trim()` してから比べる歯は緑のままなので、ここではスキーマが返す値と、保存される
 * Observation の payload・LLM 失敗時の全文フォールバックの本文が、渡した文字列と1文字も違わないことを見る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
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
      completeStructured: async <T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> => {
        throw new Error("simulated llm failure");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

const PADDED = "　 hello world \n";

const INPUTS = [
  ["utterance.text", { kind: "utterance", text: PADDED }, "text"],
  ["event.name", { kind: "event", name: PADDED }, "name"],
  ["document.content", { kind: "document", content: PADDED }, "content"],
] as const;

describe("空白だけを断る検査は、通した値を trim しない（ADR 0502 決めたこと3）", () => {
  it.each(INPUTS)("%s: ObserveInputSchema が返す値は渡した文字列のまま", (_label, input, field) => {
    const parsed = ObserveInputSchema.parse(input) as Record<string, unknown>;
    expect(parsed[field]).toBe(PADDED);
  });

  it.each(INPUTS)(
    "%s: 保存される Observation の payload は渡した文字列のまま",
    async (_label, input, field) => {
      const { runtime, stores } = buildRuntime();
      const result = await runtime.observe(ctx, input);
      const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
      expect((observation?.payload as Record<string, unknown>)[field]).toBe(PADDED);
    },
  );

  it("utterance.text: LLM 失敗時の全文フォールバックの Memory の本文も渡した文字列のまま", async () => {
    const { runtime, stores } = buildRuntime();
    const result = await runtime.observe(ctx, { kind: "utterance", text: PADDED });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe(PADDED);
  });
});
