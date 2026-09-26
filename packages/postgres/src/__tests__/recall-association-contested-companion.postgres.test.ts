import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import type { RecallResult } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Issue #959（本物の Postgres + pgvector に対する歯）: 段3.5（連想枠）が拾った
 * `contested` の記憶が、対向なしの単独で `memories` に返っていた穴を、案 (B) で
 * 塞いだことを実データに対して確かめる。
 *
 * `packages/core` 側の歯（`recall-association-contested-companion.test.ts`）が
 * Fake で網羅的に検査している——ここでは同じ最小再現と drop 経路の2本だけを、
 * 実際の `PostgresMemoryStore`/`PostgresVectorStore` に対して繰り返す
 * （`AGENTS.md` の「テストは本物の Postgres + pgvector に対して走る」原則）。
 */

const TENANT = "recall-959-tenant";

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by recall tests");
  },
  completeStructured: async () => {
    throw new Error("not used by recall tests");
  },
};

function makeEmbeddingProvider(): EmbeddingProvider {
  return {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
  };
}

async function buildTestRuntime() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    vectorStore,
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore: {
      getDefaultHalfLifeHours: async () => 720,
      getEventRetention: async () => {
        throw new Error(
          "recall-association-contested-companion.postgres.test.ts のダミーは getEventRetention を呼ばないはず",
        );
      },
      setEventRetention: async () => {
        throw new Error(
          "recall-association-contested-companion.postgres.test.ts のダミーは setEventRetention を呼ばないはず",
        );
      },
    },
    llmProvider: throwingLlm,
    embeddingProvider: makeEmbeddingProvider(),
    hashContent: (content: string) => `sha256(${content})`,
    // buildNewMemoryFixture の既定 recordedAt（2026-01-01）に固定する
    // （recall.postgres.test.ts と同じ理由——decay で score.total が落ちるのを防ぐ）。
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  });
  return { runtime, memoryStore, vectorStore };
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  vector: number[],
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, embeddingStatus: "ready", ...overrides }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

/** `recall-association-contested-companion.test.ts` と同じ不変条件の歯。 */
async function assertNoLoneContested(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  result: RecallResult,
): Promise<void> {
  const returnedIds = new Set(result.memories.map((m) => m.memoryId));
  for (const recalled of result.memories) {
    const memory = await memoryStore.get(ctx, recalled.memoryId);
    if (memory && memory.status === "contested" && memory.contestedWithId) {
      expect(
        returnedIds.has(memory.contestedWithId),
        `contested な ${memory.id}（digest: ${memory.digest}）が、対向 ${memory.contestedWithId} を伴わずに返っている`,
      ).toBe(true);
    }
  }
}

describe("runtime.recall() — 段3.5(連想枠)の contested 候補にも必須の同伴取得をかける（Issue #959、本物の Postgres + pgvector）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("🔴 Issue #959 最小再現: limit の外に落ちた contested が連想枠の候補になっても、対向なしの単独では返らない", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    const q = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "Q",
    });
    const c1 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.95, 0.05, 0], {
      digest: "C1",
    });
    // C2: embedding を持たない——getMany（必須の同伴取得）だけが引ける対向。
    const c2 = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, digest: "C2" }),
    );

    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 1 });

    await assertNoLoneContested(memoryStore, ctx, result);

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);

    const c1Result = result.memories.find((m) => m.memoryId === c1.id);
    const c2Result = result.memories.find((m) => m.memoryId === c2.id);
    expect(c1Result?.retrievedVia).toBe("association");
    expect(c2Result?.retrievedVia).toBe("mandatory_companion");
    expect(c2Result?.companionOf).toBe(c1.id);
    expect(c1Result?.contestedWith).toBe(c2.id);
    expect(c2Result?.contestedWith).toBe(c1.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("forget 済みの対向は同伴取得の対象にならない——生存側も単独では出ず Unit ごと落ちる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    const q = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "Q",
    });
    const c1 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.95, 0.05, 0], {
      digest: "C1",
    });
    const c2 = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, digest: "C2" }),
    );
    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");
    await runtime.forget(ctx, { memoryId: c2.id });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 1 });

    await assertNoLoneContested(memoryStore, ctx, result);
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(c2.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped" && o.count >= 1)).toBe(
      true,
    );
  });
});
