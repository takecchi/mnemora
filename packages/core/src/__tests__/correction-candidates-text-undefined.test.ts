import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { FindCorrectionCandidatesInput } from "../correction-candidates.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FindCorrectionCandidatesResult.outcome` と `Runtime.findCorrectionCandidates` の TSDoc が書く今の振る舞い:
 * `text` が `undefined`（JavaScript や `as` で型を外したとき）でも例外にならず、**埋め込みを呼ばずに**
 * 候補の生成を飛ばして `no_candidates` を返す。「探していない」は `outcome` には出ず、`omitted` に出る。
 * 文書だけの直しの歯（挙動は変えていない）。
 */

const ctx: Ctx = { tenantId: "correction-candidates-text-undefined" };

function makeKit() {
  const stores = createFakeRuntimeStores();
  const counter = { embedCalls: 0 };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => ({ content: "" }),
      completeStructured: async () => {
        throw new Error("unexpected LLM call");
      },
    },
    embeddingProvider: {
      space: stores.embeddingProvider.space,
      embed: async (c, texts) => {
        counter.embedCalls += 1;
        return stores.embeddingProvider.embed(c, texts);
      },
    },
    hashContent: (content) => `h:${content}`,
  });
  return { runtime, counter };
}

describe("findCorrectionCandidates: text が undefined のときの今の振る舞い（TSDoc の約束）", () => {
  it("例外にならず、埋め込みを呼ばず、no_candidates を返し、候補の生成が飛ばされたことは omitted に出る", async () => {
    const { runtime, counter } = makeKit();
    const result = await runtime.findCorrectionCandidates(ctx, {
      text: undefined,
    } as unknown as FindCorrectionCandidatesInput);
    expect(result.outcome).toBe("no_candidates");
    expect(counter.embedCalls).toBe(0);
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });
  });

  it("陽性対照: 本文のある text なら埋め込みを1回呼び、omitted に candidate_generation の skip は無い", async () => {
    const { runtime, counter } = makeKit();
    const result = await runtime.findCorrectionCandidates(ctx, { text: "x" });
    expect(counter.embedCalls).toBe(1);
    expect(
      result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "candidate_generation"),
    ).toBe(false);
  });

  it("空文字は recall() の検証で例外になる（undefined とは違う）", async () => {
    const { runtime } = makeKit();
    await expect(runtime.findCorrectionCandidates(ctx, { text: "" })).rejects.toThrow();
  });
});
