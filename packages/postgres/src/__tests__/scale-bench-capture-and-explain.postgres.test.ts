import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

// `scale-bench-close-on-throw.postgres.test.ts` と同じ理由で、`main()` を止めてから
// dynamic import する。
process.env.MNEMORA_SCALE_BENCH_SKIP_MAIN = "1";
const { captureAndExplain } = await import("../bench/scale-bench.js");

const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
const TENANT = "scale-bench-capture-tenant";

/**
 * Issue #1016: ADR 0284 以降、`PostgresVectorStore.search()` は `db.transaction()` の中で
 * ADR 0284 の `SET LOCAL`（`hnsw.iterative_scan` を対象にした1文）を打ってから SELECT する
 * （文そのものをここに書かないのは、`hnsw-ef-search-window-ceiling.test.ts` 検査2が
 * ソースを走査して SET の箇所を数えるため）。
 * トランザクションは `pool.connect()` で借りた client の `client.query()` を使うので、
 * `pool.query` を差し替える捕まえ方では search の SQL が見えず、`bench:scale` の
 * Part 2 以降が「一致するクエリが観測されなかった」で毎回落ちていた。
 *
 * 捕まえられることに加えて、EXPLAIN が `search()` と同じ `SET LOCAL` の効いた
 * トランザクションで打たれることを見る。`EXPLAIN (SETTINGS)` は pgvector の GUC を
 * 出さないため（【実測】PostgreSQL 17.11 / pgvector 0.8.0）、プランの文面ではなく、
 * EXPLAIN を打った接続に流れた文の並びを観測する。
 */
describe("scale-bench: captureAndExplain は search() のクエリを本番と同じ条件で EXPLAIN する（Issue #1016、本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("search() の SQL を捕まえ、BEGIN → SET LOCAL hnsw.iterative_scan → EXPLAIN (ANALYZE, BUFFERS) の順で打つ", async () => {
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    for (let i = 0; i < 3; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT }),
      );
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, i + 1, 0.5]);
    }

    // 接続ごとに、発行された文を順に記録する。
    const statementsByClient = new Map<Client, string[]>();
    const originalQuery = Client.prototype.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
      const config = args[0] as string | { text: string };
      const text = typeof config === "string" ? config : config.text;
      const statements = statementsByClient.get(this) ?? [];
      statements.push(text);
      statementsByClient.set(this, statements);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any).apply(this, args);
    };
    let plan: string;
    try {
      plan = await captureAndExplain(
        pool,
        (text) => text.includes(TABLE) && /order by/i.test(text),
        () =>
          vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 1, 1], {
            limit: 2,
            filter: { tenantId: TENANT },
          }),
      );
    } finally {
      Client.prototype.query = originalQuery;
    }

    expect(plan).toMatch(/actual time=/);

    // EXPLAIN ごとに、同じ接続で直前の BEGIN から EXPLAIN までに流れた文を集める。
    const explainRuns: Array<{ explain: string; inTransaction: string[] }> = [];
    for (const statements of statementsByClient.values()) {
      let inTransaction: string[] = [];
      for (const text of statements) {
        if (/^\s*(commit|rollback)\b/i.test(text)) {
          inTransaction = [];
          continue;
        }
        if (/^\s*begin\b/i.test(text)) {
          inTransaction = [];
        } else if (/^\s*explain\b/i.test(text)) {
          explainRuns.push({ explain: text, inTransaction });
        }
        inTransaction = [...inTransaction, text];
      }
    }
    expect(explainRuns).toHaveLength(1);
    const [run] = explainRuns;
    expect(run?.explain).toMatch(/^EXPLAIN \(ANALYZE, BUFFERS, FORMAT TEXT\)/);
    expect(run?.explain).toContain(TABLE);
    expect(run?.inTransaction[0]).toMatch(/^\s*begin\b/i);
    expect(
      run?.inTransaction.some((s) => /^\s*set\s+local\s+hnsw\.iterative_scan\b/i.test(s)),
    ).toBe(true);
  });
});
