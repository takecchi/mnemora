import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `taxonomy_mode = 'strict'` のテナントで、`recall({ labels })` を本物の Postgres に対して
 * 端から端まで走らせる（Issue #201 PR-B、ADR 0323「決定2」訂正、docs/memory-model.md §8）。
 *
 * core の `recall-taxonomy-filter.test.ts` が Fake で押さえている約束——strict では
 * `registered` のラベルだけが絞り込みに参加し、`proposed` だけを渡すと「何にも一致しない」
 * 絞り込みになる。落ちた分は `filtered(condition: 'taxonomy')` として exact に数え、
 * `totalInScope` から除く——を、`PostgresTenantSettingsStore.getTaxonomyMode` と
 * `PostgresMemoryStore.listLabels`/`registerLabel` を通した実際の経路で確かめる。
 * 段1（ANN・語彙の両チャンネル）と段5（`aggregateScope`・目次帯）が同じ解決済みの
 * `labels` を見ていることも、ここで同時に見る。
 */

const TENANT = "recall-taxonomy-strict-tenant";
const ctx: Ctx = { tenantId: TENANT };

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by recall tests");
  },
  completeStructured: async () => {
    throw new Error("not used by recall tests");
  },
};

const embeddingProvider: EmbeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
};

async function setup(mode: "open" | "strict") {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  await tenantSettingsStore.setTaxonomyMode(ctx, mode);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    vectorStore,
    lexicalStore: new PostgresLexicalStore(db),
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore,
    llmProvider: throwingLlm,
    embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    // buildNewMemoryFixture の既定 recordedAt（2026-01-01）に固定する
    // （`recall.postgres.test.ts` と同じ理由——実時計だと decay で below_threshold に化ける）。
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  });
  const make = async (contentHash: string, tags: string[]) => {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash,
        tags,
        embeddingStatus: "ready",
        content: `分類境界プローブ ${contentHash}`,
        digest: `digest ${contentHash}`,
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
    return memory;
  };
  return { runtime, memoryStore, make };
}

const QUERY = {
  vector: [1, 0, 0],
  text: "分類境界プローブ",
  channels: ["ann", "lexical"] as ("ann" | "lexical")[],
  limit: 10,
  association: null,
};

describe("recall({ labels }) — taxonomy_mode='strict' のテナント（本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("strict で proposed のラベルだけを渡すと、絞り込みは何にも一致しない（段1・段5とも）", async () => {
    const { runtime, make } = await setup("strict");
    const proposedOnly = await make("strict-proposed-only", ["alpha"]); // registerLabel していない
    const other = await make("strict-other", ["beta"]);

    const result = await runtime.recall(ctx, { ...QUERY, labels: ["alpha"] });

    expect(result.memories).toHaveLength(0);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "taxonomy",
      scopeRelation: "outside_scope",
      count: 2,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(0);
    const bandIds = (result.index.digestBand ?? []).map((d) => d.memoryId);
    expect(bandIds).not.toContain(proposedOnly.id);
    expect(bandIds).not.toContain(other.id);
  });

  it("strict で registered に昇格したラベルは参加し、絞りの外は段1・段5のどちらにも出ない", async () => {
    const { runtime, memoryStore, make } = await setup("strict");
    await memoryStore.registerLabel(ctx, "alpha");
    const matching = await make("strict-registered-matching", ["alpha"]);
    const other = await make("strict-registered-other", ["beta"]);

    const result = await runtime.recall(ctx, { ...QUERY, labels: ["alpha"] });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toEqual([matching.id]);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "taxonomy",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
    expect((result.index.digestBand ?? []).map((d) => d.memoryId)).not.toContain(other.id);
  });

  it("対照: open（既定）では proposed のラベルも絞り込みに参加する", async () => {
    const { runtime, make } = await setup("open");
    const proposed = await make("open-proposed", ["alpha"]);
    const other = await make("open-other", ["beta"]);

    const result = await runtime.recall(ctx, { ...QUERY, labels: ["alpha"] });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(proposed.id);
    expect(ids).not.toContain(other.id);
    expect(result.index.totalInScope).toBe(1);
  });
});
