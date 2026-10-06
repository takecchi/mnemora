import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Ctx } from "../ctx.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.scopeAggregate` が取れる値は `"exact"` と `"skip"` の2つだけである（省略は `"exact"` と同じ）。
 * それ以外は、段1〜6を走らせる前に `ZodError` で断る。値の意味の解釈は `MemoryStore` の仕事なので、
 * 通してしまうと、知らない値が adapter にそのまま渡り、`"skip"` ではない値が黙って集計する側に倒れる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const aggregateCalls: unknown[] = [];
  const aggregateScope = stores.memoryStore.aggregateScope.bind(stores.memoryStore);
  stores.memoryStore.aggregateScope = ((...args: Parameters<typeof aggregateScope>) => {
    aggregateCalls.push(args[2]);
    return aggregateScope(...args);
  }) as typeof aggregateScope;
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
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, aggregateCalls };
}

describe("recall() — scopeAggregate の値の範囲", () => {
  it.each(["approx", "", "SKIP", "Exact", "none"])(
    "知らない文字列 %j は ZodError で断り、aggregateScope まで届かない",
    async (value) => {
      const { runtime, aggregateCalls } = buildRuntime();
      await expect(
        runtime.recall(ctx, { vector: [1, 0], scopeAggregate: value as never }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(aggregateCalls).toEqual([]);
    },
  );

  it.each([1, 0, true, null, {}])("文字列でない値 %j も ZodError で断る", async (value) => {
    const { runtime } = buildRuntime();
    await expect(
      runtime.recall(ctx, { vector: [1, 0], scopeAggregate: value as never }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each(["exact", "skip"] as const)(
    "%s は通り、そのまま aggregateScope へ渡る",
    async (value) => {
      const { runtime, aggregateCalls } = buildRuntime();
      await runtime.recall(ctx, { vector: [1, 0], scopeAggregate: value });
      expect(aggregateCalls.map((o) => (o as { scopeAggregate?: string }).scopeAggregate)).toEqual([
        value,
      ]);
    },
  );

  it("省略すると aggregateScope へは 'exact' が渡る", async () => {
    const { runtime, aggregateCalls } = buildRuntime();
    await runtime.recall(ctx, { vector: [1, 0] });
    expect(aggregateCalls.map((o) => (o as { scopeAggregate?: string }).scopeAggregate)).toEqual([
      "exact",
    ]);
  });
});
