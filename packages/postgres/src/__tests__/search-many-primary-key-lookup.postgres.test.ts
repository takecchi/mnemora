import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { assertSafeIdentifier, embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { captureClientQuery, closeTestClient, explainCaptured, getTestClient } from "./test-db.js";

/**
 * Issue #1181 / ADR 0362: `PostgresVectorStore.searchMany` は、統計の有無で
 * `memories` の引き方を2つ持つ（`pg_class.reltuples` で切り替える、追記・案2）。
 *
 * 1. **統計が無い**（`ANALYZE` 前）小さいテナントでも、`memories` を主キー
 *    （`memories_pkey`）で引く——`m.id = e.memory_id` を `Join Filter` として
 *    後から捨てる、統計に依存した悪いプラン（Issue #1181 本文の実測）に戻らない
 *    ことを縛る。
 * 2. **統計がある**場合は、`search()` と同じ素の `JOIN`（今の main の形）が
 *    そのまま走ることを縛る——`memories_pkey` を経由する形（1の枝）が実際には
 *    実行されない（`EXPLAIN` で `(never executed)`）ことを確認する。
 *
 * ⚠ **速さは縛らない**（環境・PostgreSQL の版・器の負荷に依存する）。縛るのは
 * プランの形（`memories_pkey` を使うこと・`m.id = e.memory_id` が `Join Filter`
 * として現れないこと）だけである。
 *
 * **共有の `TEST_EMBEDDING_SPACE`（`test-db.ts`）は使わない**——他の歯
 * （`recall.postgres.test.ts` 等）が既にその表を `ANALYZE` 済みにしていることが
 * あり、「統計が無い」という前提が崩れる。この歯専用の埋め込み空間（ランダムな
 * モデル名）を都度登録することで、対象の埋め込み表が必ず「今作られたばかりで
 * 一度も `ANALYZE` されていない」状態になるようにする。
 *
 * `memories` 自体は他の歯と共有するテーブルだが、`TRUNCATE`（`resetTestDatabase`
 * 相当は呼ばない——この歯は他の歯の後始末に依存したくない）ではなく、行数を
 * 増やす方向で安全側に振る: 実測（Issue #1181 本文・調査時のベンチ）では、
 * 極端に小さい・幅の狭い行だと「表がそもそも数ページしかない」ため Seq Scan と
 * Index Scan の見積もりが拮抗し、`memories_pkey` が選ばれないことがあった。
 * 本文の実測（`observe()` 経由・実データに近い内容）に寄せて `content` を
 * ある程度の長さにし、行数も 300 に取ることで、この歯の環境では安定して
 * `memories_pkey` が選ばれることを確認済み（この歯自体が、その確認の記録）。
 */
const SPACE: EmbeddingSpaceId = {
  provider: "test-issue-1181",
  model: `pk-lookup-${randomUUID()}`,
  dimensions: 3,
};
const TABLE = embeddingSpaceTableName(SPACE);
const TENANT = `issue-1181-${randomUUID()}`;
const ROW_COUNT = 300;

describe("searchMany: 統計が無くても memories を主キーで引く（Issue #1181 / ADR 0362）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("EXPLAIN で memories_pkey を使い、m.id = e.memory_id の Join Filter が出ない", async () => {
    const { db, pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SPACE);
    assertSafeIdentifier(TABLE);
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: `pk-lookup-${i}`,
          // Issue #1181 本文（observe() 経由の実データ）に寄せて、行の幅を
          // fixture の既定（短い定型文）より広げる（上のクラス doc コメント参照）。
          content: `issue-1181 pk-lookup fixture memory #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
          digest: `issue-1181 pk-lookup fixture digest #${i}`,
        }),
      );
      await vectorStore.upsert(ctx, SPACE, memory.id, [i % 7, (i * 3) % 11, (i * 5) % 13]);
    }

    // ⚠ ここが本題: `ANALYZE` を一度も打たない。

    const queries = [
      { key: "a", vector: [1, 2, 3] },
      { key: "b", vector: [4, 5, 6] },
      { key: "c", vector: [0, 1, 2] },
    ];
    const filter = { tenantId: TENANT };

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /values/i.test(text),
      () => vectorStore.searchMany(ctx, SPACE, queries, { limit: 40, filter }),
    );
    const plan = await explainCaptured(pool, captured, "FORMAT TEXT");

    expect(plan, `EXPLAIN 全文:\n${plan}`).toMatch(/Index (Only )?Scan using memories_pkey/);
    expect(plan, `EXPLAIN 全文:\n${plan}`).not.toMatch(/Join Filter: \(m\.id = e\.memory_id\)/);
  }, 60_000);

  it("EXPLAIN で、統計がある場合は今のSQL（main の形）がそのまま走る（memories_pkey 経由の枝は実行されない）", async () => {
    const { db, pool } = await getTestClient();
    const space: EmbeddingSpaceId = {
      provider: "test-issue-1181",
      model: `pk-lookup-stats-${randomUUID()}`,
      dimensions: 3,
    };
    const table = embeddingSpaceTableName(space);
    await registerEmbeddingSpace(pool, space);
    assertSafeIdentifier(table);
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const tenant = `issue-1181-stats-${randomUUID()}`;
    const ctx: Ctx = { tenantId: tenant };

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: tenant,
          contentHash: `pk-lookup-stats-${i}`,
          content: `issue-1181 pk-lookup-stats fixture memory #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
          digest: `issue-1181 pk-lookup-stats fixture digest #${i}`,
        }),
      );
      await vectorStore.upsert(ctx, space, memory.id, [i % 7, (i * 3) % 11, (i * 5) % 13]);
    }

    // ⚠ ここが本題: ここでは `ANALYZE` を打つ（1の歯の逆）。
    await pool.query(`ANALYZE ${table}`);
    await pool.query("ANALYZE memories");

    const queries = [
      { key: "a", vector: [1, 2, 3] },
      { key: "b", vector: [4, 5, 6] },
      { key: "c", vector: [0, 1, 2] },
    ];
    const filter = { tenantId: tenant };

    const captured = await captureClientQuery(
      (text) => text.includes(table) && /values/i.test(text),
      () => vectorStore.searchMany(ctx, space, queries, { limit: 40, filter }),
    );
    const plan = await explainCaptured(pool, captured, "ANALYZE, FORMAT TEXT");

    // `One-Time Filter` の切り替え自体が在ることを確認する。
    expect(plan, `EXPLAIN 全文:\n${plan}`).toMatch(/One-Time Filter/);
    // 候補D の枝は `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id
    // OFFSET 0) m` という形に由来するため、EXPLAIN 上は「`Subquery Scan on m`
    // （またはエイリアス `m_1`・`m_2`…）」という固有の形で現れる——`search()` と同じ
    // 素の `JOIN`（統計ありの枝）は `memories` を直接参照するテーブルスキャンであり、
    // この「派生テーブルとしての m」の形にはならない。⟹ この行がどれも
    // `(never executed)` であれば、統計ありの場面で候補D の枝が実際には動いていない
    // ことが分かる（`memories_pkey` 自体は、統計ありの枝が独自に Nested Loop で
    // 選ぶこともあるため、`memories_pkey` の使用の有無そのものは縛らない）。
    const subqueryScanOnMLines = plan.split("\n").filter((line) => /Subquery Scan on m(_\d+)?\b/.test(line));
    expect(subqueryScanOnMLines.length, `EXPLAIN 全文:\n${plan}`).toBeGreaterThan(0);
    for (const line of subqueryScanOnMLines) {
      expect(line, `EXPLAIN 全文:\n${plan}`).toMatch(/\(never executed\)/);
      expect(line, `EXPLAIN 全文:\n${plan}`).not.toMatch(/actual time=/);
    }
  }, 60_000);
});
