import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-reextract-unsupported-cas" };

function llmReturning(contents: string[]): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) =>
      req.schema.parse({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
      }),
  };
}

function setup() {
  const stores = createFakeRuntimeStores();
  const runtimeWith = (contents: string[]) =>
    createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning(contents),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
  return { stores, runtimeWith };
}

describe("口の無い adapter の reextract は、updateStatusWithEvent を CAS で1件ずつ呼ぶ（ADR 0030）", () => {
  it("1件の書き込みの瞬間に status が変わっても、その1件だけ status_changed_concurrently で飛ばし、別の1件は置き換える", async () => {
    const { stores, runtimeWith } = setup();
    const observed = await runtimeWith(["M候補", "N候補"]).observe(ctx, {
      kind: "utterance",
      text: "発話",
    });
    const [mId, nId] = observed.memoryIds as [string, string];

    // 口を隠す（第三者の既存 adapter がこの形）。
    Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
      value: undefined,
      configurable: true,
    });
    const mRow = stores.memoryStore.liveRowForTest(ctx, mId)!;
    let intervened = false;
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (!intervened && id === mId) {
        intervened = true;
        mRow.status = "forgotten";
      }
    };

    const result = await runtimeWith(["新しい抽出結果"]).reextract(ctx, observed.observationId);

    expect(result.atomicity).toBe("store_unsupported");
    expect((await stores.memoryStore.get(ctx, mId))?.status).toBe("forgotten");
    expect(result.supersededMemoryIds).toEqual([nId]);
    expect(result.skipped).toContainEqual({
      kind: "status_changed_concurrently",
      memoryId: mId,
      observedStatus: "forgotten",
    });
    expect(
      stores.eventStore.events.filter((e) => e.memoryId === mId && e.kind === "superseded"),
    ).toEqual([]);
    expect((await stores.memoryStore.get(ctx, nId))?.status).toBe("superseded");
  });

  it("競合ではない例外は skipped に化けず、そのまま投げ直される", async () => {
    const { stores, runtimeWith } = setup();
    const observed = await runtimeWith(["M候補"]).observe(ctx, { kind: "utterance", text: "発話" });
    Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
      value: undefined,
      configurable: true,
    });
    stores.memoryStore.updateStatusWithEvent = async () => {
      throw new Error("simulated connection reset");
    };

    await expect(
      runtimeWith(["新しい抽出結果"]).reextract(ctx, observed.observationId),
    ).rejects.toThrow("simulated connection reset");
  });
});
