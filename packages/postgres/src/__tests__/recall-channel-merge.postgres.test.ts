import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Ctx,
  EmbeddingProvider,
  LLMProvider,
  RecalledMemory,
  ScoreBreakdown,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0484: `recall({ channels: ["ann", "lexical"] })` の候補の合流を、実 Postgres の**2つの語彙 store**
 * （`PostgresLexicalStore` = tsvector、`PostgresTrigramLexicalStore` = pg_trgm）で、ADR 0084 の表に照らして縛る。
 *
 * 契約（ADR 0084 の表、`recall-runtime.ts` の和集合）:
 * - 同じ記憶を両チャンネルが当てたら、1件にまとまる。`retrievedVia` は `"ann"`、`score` に `similarity` と
 *   `lexicalMatch` の両方が載る。
 * - ANN だけが当てた記憶は `retrievedVia: "ann"`、`lexicalMatch` は無い。
 * - 語彙だけが当てた記憶は `retrievedVia: "lexical"`、`similarity` は無い。`lexicalMatch` は `(0, 1]`。
 * - `explain.stages` の `candidate_generation` は channel ごとに1つ（`ann`、`lexical` の順）。
 *
 * 記憶 3 件: A（ANN にも語彙にも当たる）、B（ANN だけ。語彙の語を含まない）、C（語彙だけ。ベクトルは遠く、
 * `overFetchFactor` を絞って ANN の窓〔k'〕から外す）。埋め込みの fake はどの文面も `[1, 0, 0]` を返す。
 */

const TENANT = "recall-channel-merge-pg";
const ctx: Ctx = { tenantId: TENANT };
const QUERY_TEXT = "alphaproject report";

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};
const embeddingProvider: EmbeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
};

type StoreKind = "tsvector" | "trigram";

async function setup(kind: StoreKind) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  let lexicalStore: PostgresLexicalStore | PostgresTrigramLexicalStore;
  if (kind === "tsvector") {
    lexicalStore = new PostgresLexicalStore(db);
  } else {
    try {
      lexicalStore = await PostgresTrigramLexicalStore.create(db);
    } catch (error) {
      // ADR 0103: この環境（SQL_ASCII の脚など）では pg_trgm を使えない。skip ではなく、使えないことを主張する。
      expect(String((error as Error).message)).toContain(
        TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
      );
      return null;
    }
  }
  const runtime = createRuntime({
    memoryStore,
    vectorStore,
    lexicalStore,
    outboxStore: { claimBatch: async () => [], complete: async () => {}, fail: async () => {} },
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore: {
      getDefaultHalfLifeHours: async () => 720,
    } as never,
    llmProvider: throwingLlm,
    embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  });
  const make = async (hash: string, content: string, vector: number[]) => {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: hash,
        content,
        digest: content,
        embeddingStatus: "ready",
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
    return memory;
  };
  const a = await make("both", "alphaproject report summary", [1, 0, 0]);
  const b = await make("ann-only", "zzzz qqqq wwww", [0.9, 0.1, 0]);
  const c = await make("lexical-only", "alphaproject report appendix", [0, 0, 1]);
  return { runtime, a, b, c };
}

function byId(memories: readonly RecalledMemory[]): Map<string, RecalledMemory> {
  return new Map(memories.map((m) => [m.memoryId, m]));
}

describe.each<StoreKind>(["tsvector", "trigram"])(
  "recall({ channels: ['ann','lexical'] }) の合流 — 語彙 store = %s（実 Postgres）",
  (kind) => {
    beforeEach(async () => {
      await resetTestDatabase();
    });
    afterAll(async () => {
      await closeTestClient();
    });

    // k' = round(limit × overFetchFactor) = 2: ANN は A・B を返し、C（ベクトルが遠い）は窓の外。
    const QUERY = {
      text: QUERY_TEXT,
      channels: ["ann", "lexical"] as ("ann" | "lexical")[],
      limit: 10,
      overFetchFactor: 0.2,
      association: null,
    };

    it("同じ記憶は1件にまとまり、retrievedVia と score の欄が出どころに合う", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime, a, b, c } = s;
      const result = await runtime.recall(ctx, QUERY);
      const ids = result.memories.map((m) => m.memoryId);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort());
      const m = byId(result.memories);

      const both = m.get(a.id)!;
      expect(both.retrievedVia).toBe("ann");
      expect(both.score.affinityMeasured).toBe(true);
      expect(typeof measured(both).similarity).toBe("number");
      expect(measured(both).lexicalMatch).toBeGreaterThan(0);
      expect(measured(both).lexicalMatch).toBeLessThanOrEqual(1);

      const annOnly = m.get(b.id)!;
      expect(annOnly.retrievedVia).toBe("ann");
      expect(typeof measured(annOnly).similarity).toBe("number");
      expect(measured(annOnly).lexicalMatch).toBeUndefined();

      const lexicalOnly = m.get(c.id)!;
      expect(lexicalOnly.retrievedVia).toBe("lexical");
      expect(measured(lexicalOnly).similarity).toBeUndefined();
      expect(measured(lexicalOnly).lexicalMatch).toBeGreaterThan(0);
      expect(measured(lexicalOnly).lexicalMatch).toBeLessThanOrEqual(1);
    });

    it("explain.stages の candidate_generation は channel ごとに1つ（ann、lexical の順）", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime } = s;
      const result = await runtime.recall(ctx, QUERY);
      const generation = result.explain.stages.filter((s) => s.stage === "candidate_generation");
      expect(
        generation.map((s) => (s.detail as { channel?: string } | undefined)?.channel),
      ).toEqual(["ann", "lexical"]);
      expect(generation.every((s) => s.executed)).toBe(true);
    });

    it("affinity は similarity と lexicalMatch の大きいほう（total = affinity × 他の項）", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime, a } = s;
      const result = await runtime.recall(ctx, QUERY);
      const both = byId(result.memories).get(a.id)!;
      const affinity = Math.max(measured(both).similarity!, measured(both).lexicalMatch!);
      const others =
        measured(both).decay *
        measured(both).tagMatch *
        measured(both).freshness *
        measured(both).strength;
      expect(measured(both).total).toBeCloseTo(affinity * others, 10);
    });

    it("同じ query を繰り返すと、順序まで同じ（同点の並びが揺れない）", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime } = s;
      const first = (await runtime.recall(ctx, QUERY)).memories.map((m) => m.memoryId);
      for (let i = 0; i < 4; i += 1) {
        expect((await runtime.recall(ctx, QUERY)).memories.map((m) => m.memoryId)).toEqual(first);
      }
    });

    it("limit を絞っても、重複せず、lexical_truncated が出る（語彙チャンネルが窓を埋めた）", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime } = s;
      const result = await runtime.recall(ctx, { ...QUERY, limit: 1, overFetchFactor: 1 });
      const ids = result.memories.map((m) => m.memoryId);
      expect(ids).toHaveLength(1);
      expect(result.omitted.some((o) => o.kind === "lexical_truncated")).toBe(true);
    });

    it("陽性対照: channels: ['ann']（既定）では、語彙だけが当てる C は入らず、lexicalMatch も付かない", async () => {
      const s = await setup(kind);
      if (s === null) return;
      const { runtime, a, c } = s;
      const result = await runtime.recall(ctx, { ...QUERY, channels: ["ann"] });
      const ids = result.memories.map((m) => m.memoryId);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(c.id);
      expect(
        result.memories.every(
          (m) => !("lexicalMatch" in m.score) || m.score.lexicalMatch === undefined,
        ),
      ).toBe(true);
    });
  },
);

/** 親和度を測った記憶（`affinityMeasured !== false`）の `score` を `ScoreBreakdown` として返す。 */
function measured(memory: RecalledMemory): ScoreBreakdown {
  if (memory.score.affinityMeasured === false) {
    throw new Error(`affinity を測っていない記憶（${memory.memoryId}）`);
  }
  return memory.score;
}
