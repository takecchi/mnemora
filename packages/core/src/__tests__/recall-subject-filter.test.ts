import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorFilter } from "../interfaces/vector-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ⭐ 配線の歯（歯C）: `recall()` が `ctx.subjectId` を段1（VectorStore.search）の
 * filter に載せていることを検査する。
 *
 * マネージャーが確認した問題: 段1へ渡す filter は `{ tenantId, status }` だけで、
 * subject は候補取得後の後段フィルタでしか絞っていなかった（大規模テナントで
 * over-fetch の窓を無駄にする）。`recall-runtime.ts` の段1呼び出しに
 * `subjectId: scope.subjectId` を足したことの配線を、ここで直接検査する。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない
 * （`runtime-fakes.ts` 冒頭のコメントと同じ理由）。DB を要さないため手元で実行できる。
 *
 * ⟹ `recall-runtime.ts` から `subjectId:` の行を消す変異を当てると、
 * 1つ目の it() が確実に赤くなる（`capturedFilters[0]?.subjectId` が `undefined` になる）。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("recall() — 段1の filter に ctx.subjectId が載ること（配線の歯）", () => {
  it("ctx.subjectId が VectorStore.search の opts.filter.subjectId に渡る", async () => {
    const { runtime, stores } = buildRuntime();

    const capturedFilters: VectorFilter[] = [];
    const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
    stores.vectorStore.search = async (ctx, space, query, opts) => {
      capturedFilters.push(opts.filter);
      return originalSearch(ctx, space, query, opts);
    };

    const ctx: Ctx = { tenantId: "tenant-1", subjectId: "user-42" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.subjectId).toBe("user-42");
  });

  it("ctx.subjectId が無いときは opts.filter.subjectId も undefined のまま渡る（tenant 全体を対象にする既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();

    const capturedFilters: VectorFilter[] = [];
    const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
    stores.vectorStore.search = async (ctx, space, query, opts) => {
      capturedFilters.push(opts.filter);
      return originalSearch(ctx, space, query, opts);
    };

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.subjectId).toBeUndefined();
  });
});
