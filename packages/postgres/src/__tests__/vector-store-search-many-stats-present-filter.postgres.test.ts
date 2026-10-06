import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, VectorFilter, VectorHit } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { assertSafeIdentifier, embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { captureClientQuery, closeTestClient, getTestClient } from "./test-db.js";

/**
 * #932 の確かめ直し（#1774）。`searchMany()` が統計のある場面の枝（`buildStatsPresentBranches`、
 * `ANALYZE` 済みの表で選ばれる）でも、`filter` を `search()` と同じに効かせることを縛る。
 *
 * `vector-store-search-many.postgres.test.ts` の歯2（`subjectId`・`attributes`）と
 * `vector-search-many-diff.postgres.test.ts` は、統計の無い場面（候補D の枝）でしか走っていなかった
 * （`ANALYZE` していない表では `StatsPresenceGate` が候補D を選ぶ）。統計のある枝で `filter` を
 * `tenantId` だけに絞る実装は、全部の既存の歯をすり抜けた。
 *
 * 新しい `PostgresVectorStore` を使い（`StatsPresenceGate` はインスタンスごと）、`ANALYZE` 済みで統計のある枝が
 * 選ばれたこと（送った SQL に候補D 特有の `OFFSET 0` が無いこと）を、検算として見る。
 */

const TENANT = `search-many-stats-present-${randomUUID()}`;

interface Scenario {
  name: string;
  filter: VectorFilter;
}

describe("searchMany(): 統計のある枝でも filter が search() と同じに効く（#932）", () => {
  let space: EmbeddingSpaceId;
  let table: string;

  beforeAll(async () => {
    const { db, pool } = await getTestClient();
    space = { provider: "test-932", model: `stats-present-${randomUUID()}`, dimensions: 3 };
    table = embeddingSpaceTableName(space);
    await registerEmbeddingSpace(pool, space);
    assertSafeIdentifier(table);

    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const put = async (
      name: string,
      vector: number[],
      over: Parameters<typeof buildNewMemoryFixture>[0] = {},
    ) => {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, contentHash: name, ...over }),
      );
      await vectorStore.upsert(ctx, space, memory.id, vector);
    };
    await put("m1", [1, 0, 0], { subjectId: "s1", attributes: { team: "x" } });
    await put("m2", [1, 0, 0], { subjectId: "s2", attributes: { team: "y" } });
    await put("m3", [1, 1, 0], { status: "archived", subjectId: "s1" });
    await put("m4", [0, 1, 0], { subjectId: null });
    for (let i = 0; i < 100; i += 1) {
      await put(`filler-${i}`, [(i % 5) - 2, ((i * 3) % 5) - 2, ((i * 7) % 5) - 2], {
        content: `search-many-stats-present filler #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
      });
    }
    await pool.query(`ANALYZE ${table}`);
    await pool.query(`ANALYZE memories`);
  }, 120_000);

  afterAll(async () => {
    await closeTestClient();
  });

  const scenarios: Scenario[] = [
    { name: "tenantId だけ", filter: { tenantId: TENANT } },
    { name: "status:[active]", filter: { tenantId: TENANT, status: ["active"] } },
    { name: "status:[archived]", filter: { tenantId: TENANT, status: ["archived"] } },
    { name: "subjectId:s1", filter: { tenantId: TENANT, subjectId: "s1" } },
    {
      name: "subjectId:s1+includeSubjectless",
      filter: { tenantId: TENANT, subjectId: "s1", includeSubjectless: true },
    },
    { name: "attributes:{team:x}", filter: { tenantId: TENANT, attributes: { team: "x" } } },
  ];

  it("ANALYZE 済みの表（統計のある枝）で、searchMany の結果が search() と同じ（filter が効く）", async () => {
    const { db } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };
    const store = new PostgresVectorStore(db);
    const queries = [
      { key: "a", vector: [1, 0, 0] },
      { key: "b", vector: [0, 1, 0] },
    ];
    const mismatches: string[] = [];
    for (const scenario of scenarios) {
      const opts = { limit: 10, filter: scenario.filter };
      let many = new Map<string, VectorHit[]>();
      const captured = await captureClientQuery(
        (text) => text.includes(table) && /combined/i.test(text),
        async () => {
          many = await store.searchMany(ctx, space, queries, opts);
        },
      );
      expect(
        /OFFSET 0/i.test(captured.text),
        `${scenario.name}: 前提が崩れている——統計のある枝でなく候補D の枝が選ばれた`,
      ).toBe(false);
      for (const q of queries) {
        const single = await store.search(ctx, space, q.vector, opts);
        if (JSON.stringify(many.get(q.key)) !== JSON.stringify(single)) {
          mismatches.push(`- ${scenario.name} / ${q.key}`);
        }
      }
    }
    expect(
      mismatches,
      `searchMany と search が食い違うシナリオ:\n${mismatches.join("\n")}`,
    ).toEqual([]);
    // 陽性対照: 絞り込みが実際に結果を変えている（全シナリオが同じ結果ではない）
    const sizes = new Set<number>();
    for (const scenario of scenarios) {
      const hit = await store.search(ctx, space, [1, 0, 0], {
        limit: 200,
        filter: scenario.filter,
      });
      sizes.add(hit.length);
    }
    expect(sizes.size).toBeGreaterThan(1);
  }, 120_000);
});
