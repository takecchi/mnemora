import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { FindCorrectionCandidatesInput } from "../correction-candidates.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0496（ADR 0485 の材料・ADR 0490 穴3）: `findCorrectionCandidates` の入口は、型の外の入力を **`recall()` を呼ぶ前に** `TypeError` で断る。
 * - `excludeMemoryIds` が配列でない（裸の文字列を含む）・文字列でない要素を含む。
 * - `text` が文字列でない（`undefined` を含む）。以前は `no_candidates` を返していた。
 * 断った入力が recall の記録も埋め込みも起こさないこと（`embedCalls`・`recalls`）を確かめる。
 */

const ctx: Ctx = { tenantId: "correction-candidates-input-rejections" };

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

const asInput = (x: unknown) => x as FindCorrectionCandidatesInput;

describe("findCorrectionCandidates: excludeMemoryIds の型の外の入力は TypeError", () => {
  it.each([
    ["裸の文字列", "00000000-0000-4000-8000-000000000001"],
    ["数", 5],
    ["オブジェクト", {}],
    ["null", null],
    ["Set（反復できるが配列でない）", new Set(["a"])],
  ])("配列でない（%s）", async (_label, bad) => {
    const { runtime, counter } = makeKit();
    await expect(
      runtime.findCorrectionCandidates(ctx, asInput({ text: "x", excludeMemoryIds: bad })),
    ).rejects.toThrow(TypeError);
    expect(counter.embedCalls).toBe(0);
  });

  it.each([
    ["null", [null]],
    ["数", [1]],
    ["オブジェクト", [{}]],
    ["undefined", [undefined]],
    ["先頭は文字列・後ろが違う", ["a", 2]],
  ])("文字列でない要素を含む（%s）", async (_label, bad) => {
    const { runtime, counter } = makeKit();
    await expect(
      runtime.findCorrectionCandidates(ctx, asInput({ text: "x", excludeMemoryIds: bad })),
    ).rejects.toThrow(TypeError);
    expect(counter.embedCalls).toBe(0);
  });

  it("陽性対照: 省略・空配列・文字列の配列は今までどおり通る（埋め込みを1回呼ぶ）", async () => {
    for (const excludeMemoryIds of [undefined, [], ["00000000-0000-4000-8000-000000000001"]]) {
      const { runtime, counter } = makeKit();
      const result = await runtime.findCorrectionCandidates(
        ctx,
        asInput({ text: "x", excludeMemoryIds }),
      );
      expect(result.outcome).toBe("no_candidates");
      expect(counter.embedCalls).toBe(1);
    }
  });
});

describe("findCorrectionCandidates: text が文字列でなければ TypeError（以前は no_candidates）", () => {
  it.each([
    ["undefined", undefined],
    ["欄なし", "__absent__"],
    ["数", 5],
    ["null", null],
    ["配列", ["x"]],
  ])("text=%s", async (_label, text) => {
    const { runtime, counter } = makeKit();
    const input = text === "__absent__" ? {} : { text };
    await expect(runtime.findCorrectionCandidates(ctx, asInput(input))).rejects.toThrow(TypeError);
    expect(counter.embedCalls).toBe(0);
  });

  it("空文字は今までどおり recall() の検証で例外になる（TypeError ではない）", async () => {
    const { runtime } = makeKit();
    const err = await runtime.findCorrectionCandidates(ctx, { text: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("陽性対照: 本文のある text は埋め込みを1回呼ぶ", async () => {
    const { runtime, counter } = makeKit();
    await runtime.findCorrectionCandidates(ctx, { text: "x" });
    expect(counter.embedCalls).toBe(1);
  });
});
