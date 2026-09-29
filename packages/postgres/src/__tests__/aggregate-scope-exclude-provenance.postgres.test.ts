import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Ctx, type Provenance } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0390: `PostgresMemoryStore.aggregateScope` の `options.excludeProvenanceKinds` が返す任意の欄
 * `excludedProvenanceIndexedCount`（除外される kind で、スコープ内の索引済み
 * （`embedding_status = 'ready'`）の行の数）の歯。in-memory 側の同じ歯は
 * `packages/core/src/__tests__/fake-aggregate-scope-exclude-provenance.test.ts` と
 * `packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts`。
 * `memory-store-conformance.ts` には足さない（Issue #809 の方針）。
 */

const ctx: Ctx = { tenantId: "agg-exclude-prov-tenant" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };

describe("PostgresMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390、本物の Postgres）", () => {
  let memoryStore: PostgresMemoryStore;
  let vectorStore: PostgresVectorStore;

  beforeEach(async () => {
    const client = await getTestClient();
    memoryStore = new PostgresMemoryStore(client.db);
    vectorStore = new PostgresVectorStore(client.db);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function put(overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `exclude-prov-${Math.random()}`,
        embeddingStatus: "ready",
        recordedAt: new Date(),
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"), // 忘却ゲートに掛からない
        ...overrides,
      }),
    );
    if (memory.embeddingStatus === "ready") {
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
    }
    return memory;
  }

  async function seed() {
    await put();
    await put({ provenance: consolidated });
    await put({ provenance: consolidated });
    // 未索引（pending）の除外 kind の行は「索引済み」に数えない。
    await put({ provenance: consolidated, embeddingStatus: "pending" });
    // archived はスコープの外（totalInScope にも数えない）。
    await put({ provenance: consolidated, status: "archived" });
  }

  it("除外 kind で索引済み・スコープ内の行の数を返す（pending・archived は数えない）。totalInScope の意味は変えない", async () => {
    await seed();
    const aggregate = await memoryStore.aggregateScope(
      ctx,
      {},
      { excludeProvenanceKinds: ["consolidated"] },
    );
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    expect(aggregate.totalInScope).toBe(4);
    expect(aggregate.notIndexed.pending.count).toBe(1);
  });

  it("空配列・未指定は no-op: 欄は返らず、返り値全体が指定なしと同じ", async () => {
    await seed();
    const without = await memoryStore.aggregateScope(ctx, {});
    const withEmpty = await memoryStore.aggregateScope(ctx, {}, { excludeProvenanceKinds: [] });
    expect(withEmpty).toEqual(without);
    expect(withEmpty.excludedProvenanceIndexedCount).toBeUndefined();
  });

  it("recall を通した問い2: 除外しない候補を全部拾えたら ann_unreached は鳴らない（除外行は分母から引かれる）", async () => {
    const { db } = await getTestClient();
    for (let i = 0; i < 3; i += 1) await put();
    for (let i = 0; i < 4; i += 1) await put({ provenance: consolidated });
    const runtime = createRuntime({
      memoryStore,
      vectorStore,
      eventStore: new PostgresEventStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: { space: TEST_EMBEDDING_SPACE, embed: async () => [] },
      hashContent: (content: string) => `sha256(${content})`,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(result.memories).toHaveLength(3);
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });
});
