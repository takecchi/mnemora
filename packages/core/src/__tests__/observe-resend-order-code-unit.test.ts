import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0639: `ObserveResend.memories` は `memoryId` の昇順で、比較は文字列（コードユニット）の比較であり
 * `localeCompare` ではない。UUID（小文字の16進）だけでは両者が区別できないので、
 * 大文字と小文字が混ざる id を store が返す形で縛る（口は id の形を UUID に限らない）。
 */

const ctx: Ctx = { tenantId: "observe-resend-order-code-unit" };

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: ["a", "b", "c", "d"].map((content) => ({ content, provenanceKind: "stated" })),
    }),
};

function withIds(store: MemoryStore, ids: string[]): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "listBySourceObservationAllVersions") {
        return async (...args: unknown[]) => {
          const rows = await (value as (...a: unknown[]) => Promise<{ id: string }[]>).apply(
            target,
            args,
          );
          return rows.map((row, i) => ({ ...row, id: ids[i]! }));
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

describe("observe の再送: resend.memories の並びはコードユニットの昇順（localeCompare ではない）", () => {
  it("大文字と小文字が混ざる id でも、コードユニットの昇順で返る", async () => {
    const stores = createFakeRuntimeStores();
    const make = (memoryStore: MemoryStore) =>
      createRuntime({
        llmProvider: llm,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
        memoryStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        outboxStore: stores.outboxStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        config: { extractorVersion: "v1" },
      });
    const input = { kind: "utterance" as const, text: "発話", externalId: "order-code-unit" };
    await make(stores.memoryStore).observe(ctx, input);

    const resend = await make(withIds(stores.memoryStore, ["b1", "A1", "a1", "B1"])).observe(
      ctx,
      input,
    );

    expect(resend.resend!.memories.map((m) => m.memoryId)).toEqual(["A1", "B1", "a1", "b1"]);
  });
});
