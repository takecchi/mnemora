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
 * Issue #1415 / ADR 0374: `PostgresVectorStore.search()`（段1、`searchMany()` の
 * 単一クエリ版）も、`searchMany()` と同じ欠陥を持っていた——`memories` の統計が無い
 * （`ANALYZE` 前）小さいテナントで、`m.id = e.memory_id` を `Join Filter` として
 * 後から捨てる悪いプランを選ぶ（Issue #1181 が `searchMany()` に見つけたのと同じ
 * 病、Issue #1415 本文の実測）。
 *
 * `search()` と `searchMany()` は同じ `StatsPresenceGate`（インスタンス・表ごとに
 * 「両方の統計が確認済みか」を覚える、`vector-store.ts` の doc 参照）で切り替える
 * ため、この歯は `search-many-primary-key-lookup.postgres.test.ts` と対になる
 * ——`searchMany()` 用の歯が持つ理由・注意点（共有の `TEST_EMBEDDING_SPACE` を
 * 使わない理由、行数・幅を実データに寄せる理由）はそのまま当てはまる。
 *
 * ⚠ **速さは縛らない**。縛るのはプランの形・送られる SQL の形だけである。
 */
const SPACE: EmbeddingSpaceId = {
  provider: "test-issue-1415",
  model: `search-pk-lookup-${randomUUID()}`,
  dimensions: 3,
};
const TABLE = embeddingSpaceTableName(SPACE);
const TENANT = `issue-1415-${randomUUID()}`;
const ROW_COUNT = 300;

describe("search: 統計が無くても memories を主キーで引く（Issue #1415 / ADR 0374）", () => {
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
          contentHash: `search-pk-lookup-${i}`,
          content: `issue-1415 search pk-lookup fixture memory #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
          digest: `issue-1415 search pk-lookup fixture digest #${i}`,
        }),
      );
      await vectorStore.upsert(ctx, SPACE, memory.id, [i % 7, (i * 3) % 11, (i * 5) % 13]);
    }

    // ⚠ ここが本題: `ANALYZE` を一度も打たない。

    const filter = { tenantId: TENANT };
    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /combined/i.test(text),
      () => vectorStore.search(ctx, SPACE, [1, 2, 3], { limit: 40, filter }),
    );
    const plan = await explainCaptured(pool, captured, "FORMAT TEXT");

    expect(plan, `EXPLAIN 全文:\n${plan}`).toMatch(/Index (Only )?Scan using memories_pkey/);
    expect(plan, `EXPLAIN 全文:\n${plan}`).not.toMatch(/Join Filter: \(m\.id = e\.memory_id\)/);
  }, 60_000);

  it("統計がある場合は、送る SQL 自体が今の main の形のまま（候補D の痕跡が一切現れない）", async () => {
    const { db, pool } = await getTestClient();
    const space: EmbeddingSpaceId = {
      provider: "test-issue-1415",
      model: `search-pk-lookup-stats-${randomUUID()}`,
      dimensions: 3,
    };
    const table = embeddingSpaceTableName(space);
    await registerEmbeddingSpace(pool, space);
    assertSafeIdentifier(table);
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const tenant = `issue-1415-stats-${randomUUID()}`;
    const ctx: Ctx = { tenantId: tenant };

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: tenant,
          contentHash: `search-pk-lookup-stats-${i}`,
          content: `issue-1415 search pk-lookup-stats fixture memory #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
          digest: `issue-1415 search pk-lookup-stats fixture digest #${i}`,
        }),
      );
      await vectorStore.upsert(ctx, space, memory.id, [i % 7, (i * 3) % 11, (i * 5) % 13]);
    }

    // ⚠ ここが本題: ここでは `ANALYZE` を打つ（1の歯の逆）。
    await pool.query(`ANALYZE ${table}`);
    await pool.query("ANALYZE memories");

    const filter = { tenantId: tenant };
    const captured = await captureClientQuery(
      (text) => text.includes(table) && /combined/i.test(text),
      () => vectorStore.search(ctx, space, [1, 2, 3], { limit: 40, filter }),
    );

    // ADR 0374: 統計が確認済みになったあとは、`reltuples`/One-Time Filter/候補D の
    // 痕跡を一切持たない、今の main と同じ2枝の SQL がそのまま送られる。
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/reltuples/i);
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/OFFSET 0/i);
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/to_regclass/i);
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/CROSS JOIN LATERAL/i);
    expect(captured.text.match(/UNION ALL/gi)?.length, `送られた SQL:\n${captured.text}`).toBe(1);

    const plan = await explainCaptured(pool, captured, "ANALYZE, FORMAT TEXT");
    expect(plan, `EXPLAIN 全文:\n${plan}`).not.toMatch(/Subquery Scan on m/);
  }, 60_000);
});
