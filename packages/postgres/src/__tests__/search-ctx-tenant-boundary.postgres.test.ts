import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `search` の3口（`PostgresVectorStore.search`/`searchMany`、`PostgresLexicalStore.search`、`PostgresTrigramLexicalStore.search`）は、
 * `opts.filter.tenantId` に加えて `ctx.tenantId` の境界も掛ける（AND）。2つが食い違えば、両方を満たす行は無いので空を返す（例外は投げない）。
 * 隔離の境界は `ctx.tenantId` である。`VectorStore.getVectors` の doc も同じ境界を約束している。
 *
 * `packages/testkit` の `*-conformance.ts` には足さない。InMemory 側の同じ歯は `packages/testkit/src/__tests__/in-memory-search-ctx-tenant-boundary.test.ts`。
 *
 * 「変わらない」（食い違えば空）だけでなく「変わる」（一致すれば A 自身が返る）も同じ it の中で見る。そうしないと「常に空を返す」実装でも緑になる。
 */

const TENANT_A = "search-boundary-tenant-a";
const TENANT_B = "search-boundary-tenant-b";
const ctxA: Ctx = { tenantId: TENANT_A };
const ctxB: Ctx = { tenantId: TENANT_B };
const ASCII_QUERY = "boundary probe token";
const JA_QUERY = "境界プローブ";

async function seed() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const ids: Record<string, string> = {};
  for (const ctx of [ctxA, ctxB]) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `search-boundary-${ctx.tenantId}`,
        content: `${ASCII_QUERY} ${JA_QUERY}の記憶`,
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
    ids[ctx.tenantId] = memory.id;
  }
  return { db, vectorStore, idA: ids[TENANT_A]!, idB: ids[TENANT_B]! };
}

describe("search の3口は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PostgresVectorStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ", async () => {
    const { vectorStore, idA, idB } = await seed();

    const mismatched = await vectorStore.search(ctxB, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(mismatched).toEqual([]);

    const matched = await vectorStore.search(ctxA, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
    expect(matched.map((h) => h.memoryId)).not.toContain(idB);
  });

  it("PostgresVectorStore.searchMany: 食い違えば各 key が空配列（key 自体は残る）、一致すればそのテナントだけ", async () => {
    const { vectorStore, idA } = await seed();
    const queries = [
      { key: "q1", vector: [1, 0, 0] },
      { key: "q2", vector: [0.9, 0.1, 0] },
    ];

    const mismatched = await vectorStore.searchMany(ctxB, TEST_EMBEDDING_SPACE, queries, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect([...mismatched.entries()]).toEqual([
      ["q1", []],
      ["q2", []],
    ]);

    const matched = await vectorStore.searchMany(ctxA, TEST_EMBEDDING_SPACE, queries, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.get("q1")!.map((h) => h.memoryId)).toEqual([idA]);
    expect(matched.get("q2")!.map((h) => h.memoryId)).toEqual([idA]);
  });

  it("PostgresLexicalStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ", async () => {
    const { db, idA } = await seed();
    const lexicalStore = new PostgresLexicalStore(db);

    const mismatched = await lexicalStore.search(ctxB, ASCII_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(mismatched).toEqual([]);

    const matched = await lexicalStore.search(ctxA, ASCII_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT_A },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([idA]);
  });

  it("PostgresTrigramLexicalStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ", async () => {
    const { db, idA } = await seed();
    // `trigram-lexical-store-subject.postgres.test.ts` と同じ作法: pg_trgm が無い器では見ない。
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;
    const trigramStore = await PostgresTrigramLexicalStore.create(db);

    for (const query of [ASCII_QUERY, JA_QUERY]) {
      const mismatched = await trigramStore.search(ctxB, query, {
        limit: 10,
        filter: { tenantId: TENANT_A },
      });
      expect(mismatched, query).toEqual([]);

      const matched = await trigramStore.search(ctxA, query, {
        limit: 10,
        filter: { tenantId: TENANT_A },
      });
      expect(
        matched.map((h) => h.memoryId),
        query,
      ).toEqual([idA]);
    }
  });
});
