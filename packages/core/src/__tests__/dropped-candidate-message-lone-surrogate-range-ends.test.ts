import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** ソースにサロゲートは `\u` の表記で書く（生の文字を入れない）。 */

const ctx: Ctx = { tenantId: "dropped-candidate-message-range-ends" };

// 既存の歯は孤立した U+D800 が1つだけの原因しか渡しておらず、範囲の端・正しい対・複数の孤立を縛っていない。
const CASES: ReadonlyArray<readonly [label: string, inner: string, expected: string]> = [
  ["上位サロゲートの終点 U+DBFF の孤立", "e-a\uDBFFb", "e-a\uFFFDb"],
  ["末尾の U+DBFF の孤立", "e-ab\uDBFF", "e-ab\uFFFD"],
  ["下位サロゲートの終点 U+DFFF の孤立", "e-a\uDFFFb", "e-a\uFFFDb"],
  ["孤立が複数あれば、すべて置き換わる", "e-\uDC00-\uDBFF-\uDFFF", "e-\uFFFD-\uFFFD-\uFFFD"],
  [
    "範囲の端どうしの正しい対と、絵文字は変わらない",
    "e-\uD800\uDFFF-\uDBFF\uDC00-\uDBFF\uDFFF-\uD83D\uDE00",
    "e-\uD800\uDFFF-\uDBFF\uDC00-\uDBFF\uDFFF-\uD83D\uDE00",
  ],
];

function makeRuntime(innerMessage: string) {
  const stores = createFakeRuntimeStores();
  const memoryStore = new Proxy(stores.memoryStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "createMemoryWithOutbox") return value.bind(target);
      return (...args: Parameters<MemoryStore["createMemoryWithOutbox"]>) => {
        if (args[1].content === "BAD") {
          return Promise.reject(new Error("outer", { cause: new Error(innerMessage) }));
        }
        return (value as MemoryStore["createMemoryWithOutbox"]).apply(target, args);
      };
    },
  }) as MemoryStore;
  const llmProvider: LLMProvider = {
    complete: async () => ({ content: "" }),
    completeStructured: async (_ctx, req) =>
      req.schema.parse({
        memories: ["残る", "BAD"].map((content) => ({ content, provenanceKind: "stated" })),
      }),
  };
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `h(${content})`,
  });
  return { runtime, eventStore: stores.eventStore };
}

describe("落とした候補の message: サロゲートの範囲の端でも、孤立したものだけが1単位ずつ U+FFFD に置き換わる", () => {
  it.each(CASES)("%s", async (_label, inner, expected) => {
    const { runtime, eventStore } = makeRuntime(inner);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });

    expect(result.memoryIds).toHaveLength(1);
    const created = await eventStore.list(ctx, { kind: "created" });
    expect(created).toHaveLength(1);
    const dropped = created[0]!.meta?.droppedCandidates as Array<{ message: string }>;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.message).toBe(expected);
  });
});
