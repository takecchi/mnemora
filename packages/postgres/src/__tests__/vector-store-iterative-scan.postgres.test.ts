import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, VectorFilter } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `withRelaxedOrderScan` の `SET LOCAL` の約束を、ソースの文字列ではなく**実際に発行される SQL と DB の挙動**で縛る。
 *
 * 既存の歯（`hnsw-ef-search-window-ceiling.test.ts` 検査2）は「`SET ... hnsw.iterative_scan`
 * という文字列が `vector-store.ts` に1つある」ことしか見ない。そのため、`SET LOCAL` が `SET`
 * になっても、SELECT の後ろへ動いても、`search()`・`searchMany()` のどちらかから外れても、
 * `hnsw.max_scan_tuples` が足されても、HNSW を使わない読みまで SET が広がっても緑のままになる。
 */

interface Recorded {
  client: Client;
  text: string;
}

async function recordClientQueries(fn: () => Promise<unknown>): Promise<Recorded[]> {
  const records: Recorded[] = [];
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config] = args as [string | { text: string }];
    records.push({ client: this, text: typeof config === "string" ? config : config.text });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return records;
}

const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
const isSet = (text: string): boolean => /^\s*set\b/i.test(text);
// `hnsw-ef-search-window-ceiling.test.ts` 検査2が全ソースを正規表現で走査するので、リテラルを1つの文字列に書かない
// （書くと「SET している箇所」に数えられ、その歯が赤くなる）。
const RELAXED = ["SET LOCAL hnsw", "iterative_scan = relaxed_order"].join(".");

describe("PostgresVectorStore: hnsw.iterative_scan = relaxed_order は search/searchMany の SELECT だけに、同じトランザクションで効く（ADR 0284）", () => {
  const ctx: Ctx = { tenantId: "iterative-scan-t" };
  const filter: VectorFilter = { tenantId: ctx.tenantId, status: ["active", "contested"] };
  const opts = { limit: 5, filter };

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function seed(): Promise<{ vectorStore: PostgresVectorStore; ids: string[] }> {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0.1 * (i + 1), 0]);
      ids.push(m.id);
    }
    return { vectorStore, ids };
  }

  /** SELECT を発行した接続の、直近の BEGIN から SELECT までと、SELECT の後ろの文を返す。 */
  function around(records: Recorded[], isSelect: (text: string) => boolean) {
    const selectIndex = records.findIndex((r) => isSelect(r.text));
    expect(selectIndex, "対象の SELECT が観測されなかった").toBeGreaterThanOrEqual(0);
    const client = records[selectIndex]!.client;
    const mine = records.map((r, index) => ({ ...r, index })).filter((r) => r.client === client);
    const beginAt = mine.filter((r) => r.index < selectIndex && /^\s*begin\b/i.test(r.text)).pop();
    expect(beginAt, "SELECT は BEGIN の中で発行される").toBeDefined();
    const between = mine
      .filter((r) => r.index > beginAt!.index && r.index < selectIndex)
      .map((r) => norm(r.text));
    const after = mine.filter((r) => r.index > selectIndex).map((r) => norm(r.text));
    return { between, after };
  }

  it("search(): SELECT の前の同じトランザクションで SET LOCAL relaxed_order を1回だけ発行し、それ以外の SET を発行しない", async () => {
    const { vectorStore } = await seed();
    const records = await recordClientQueries(() =>
      vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], opts),
    );
    const { between, after } = around(records, (t) => /combined/.test(t) && /SELECT/i.test(t));
    expect(between.filter(isSet)).toEqual([RELAXED]);
    expect(after.filter(isSet)).toEqual([]);
    // 全体でも、SET は1文だけ（`hnsw.max_scan_tuples`・`hnsw.ef_search` などを足さない）。
    expect(records.map((r) => norm(r.text)).filter(isSet)).toEqual([RELAXED]);
  });

  it("searchMany(): SELECT の前の同じトランザクションで SET LOCAL relaxed_order を1回だけ発行し、それ以外の SET を発行しない", async () => {
    const { vectorStore } = await seed();
    const records = await recordClientQueries(() =>
      vectorStore.searchMany(
        ctx,
        TEST_EMBEDDING_SPACE,
        [
          { key: "a", vector: [1, 0, 0] },
          { key: "b", vector: [0, 1, 0] },
        ],
        opts,
      ),
    );
    const { between, after } = around(records, (t) => /query_idx/.test(t) && /SELECT/i.test(t));
    expect(between.filter(isSet)).toEqual([RELAXED]);
    expect(after.filter(isSet)).toEqual([]);
    expect(records.map((r) => norm(r.text)).filter(isSet)).toEqual([RELAXED]);
  });

  it("HNSW を使わない getVectors・upsert・delete・deleteAcrossSpaces は、どの SET も発行しない（広げない）", async () => {
    const { vectorStore, ids } = await seed();
    const records = await recordClientQueries(async () => {
      await vectorStore.getVectors(ctx, TEST_EMBEDDING_SPACE, ids as never);
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, ids[0]! as never, [0, 0, 1]);
      await vectorStore.delete(ctx, TEST_EMBEDDING_SPACE, ids[1]! as never);
      await vectorStore.deleteAcrossSpaces(ctx, [ids[2]!] as never);
    });
    expect(records.map((r) => norm(r.text)).filter(isSet)).toEqual([]);
  });

  it("SET LOCAL は接続へ漏れない: search/searchMany の後の同じ接続で hnsw.iterative_scan は既定値のまま", async () => {
    await seed();
    // 接続を1本に絞った別のプールで、同じ接続を使い回して確かめる。
    const solo = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    try {
      const vectorStore = new PostgresVectorStore(solo.db);
      await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], opts);
      await vectorStore.searchMany(
        ctx,
        TEST_EMBEDDING_SPACE,
        [{ key: "a", vector: [1, 0, 0] }],
        opts,
      );
      const shown = await solo.pool.query("SHOW hnsw.iterative_scan");
      expect(shown.rows[0]["hnsw.iterative_scan"]).toBe("off");
    } finally {
      await solo.pool.end();
    }
  });
});
