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
 * Issue #1181/#1415 / ADR 0374: `PostgresVectorStore.searchMany` は、統計の有無で
 * `memories` の引き方を2つ持つ——`this.statsPresenceGate`（インスタンス・表ごとに
 * 「両方の統計が確認済みか」を覚える、`vector-store.ts` の `StatsPresenceGate` の
 * doc 参照）で切り替える。**ADR 0362 が最初に採った「1本の SQL に両枝を入れて
 * `pg_class.reltuples` の One-Time Filter で切り替える」やり方は、Issue #1415 の
 * 実測（統計がある場面で `search()` に同じ仕組みを適用したところ +5.06ms、線を
 * 大きく超えた）を受けて置き換えられた——この歯もその置き換えに合わせて書き直す。**
 *
 * 1. **統計が無い**（`ANALYZE` 前）小さいテナントでも、`memories` を主キー
 *    （`memories_pkey`）で引く——`m.id = e.memory_id` を `Join Filter` として
 *    後から捨てる、統計に依存した悪いプラン（Issue #1181 本文の実測）に戻らない
 *    ことを縛る。
 * 2. **統計がある**場合は、`search()` と同じ素の `JOIN`（今の main の形）が
 *    **1バイトも変わらずに**そのまま送られることを縛る——送った SQL のテキスト
 *    そのものに `reltuples`/`OFFSET 0`/`CROSS JOIN LATERAL` が一切現れないことを
 *    確認する（ADR 0362 の「1本の SQL に両方の形を持たせる」仕組み自体が
 *    無くなったので、`(never executed)` の枝を探すという以前の確認方法はもう
 *    成立しない——統計がある場面では候補D の SQL 自体が生成されない）。
 *
 * ⚠ **速さは縛らない**（環境・PostgreSQL の版・器の負荷に依存する）。縛るのは
 * プランの形・送られる SQL の形（`memories_pkey` を使うこと・`m.id = e.memory_id`
 * が `Join Filter` として現れないこと・統計がある場面で候補D の痕跡が SQL に
 * 全く現れないこと）だけである。
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

  it("統計がある場合は、送る SQL 自体が今の main の形のまま（候補D の痕跡が一切現れない）", async () => {
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

    // ADR 0374: 統計が確認済みになったあとは、`reltuples`/One-Time Filter/候補D の
    // 痕跡を一切持たない、今の main と同じ2枝の SQL がそのまま送られる。
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/reltuples/i);
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/OFFSET 0/i);
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(/to_regclass/i);
    // ⚠ `CROSS JOIN LATERAL` 自体は searchMany() の VALUES 束ね（アンカーごとの
    // LATERAL、クラス doc コメント参照）で常に現れるため縛らない——候補D 特有の
    // `CROSS JOIN LATERAL (SELECT * FROM memories WHERE id = e.memory_id OFFSET 0)`
    // という形だけを見る。
    expect(captured.text, `送られた SQL:\n${captured.text}`).not.toMatch(
      /CROSS JOIN LATERAL\s*\(\s*SELECT \* FROM memories/i,
    );
    // `vector_norm(e.embedding) > 0` 枝・`= 0` 枝の2つだけ——候補D を混ぜていた頃の
    // 4枝には戻っていない（`UNION ALL` は1回だけ現れる）。
    expect(captured.text.match(/UNION ALL/gi)?.length, `送られた SQL:\n${captured.text}`).toBe(1);

    const plan = await explainCaptured(pool, captured, "ANALYZE, FORMAT TEXT");
    // 素の `JOIN memories m ON ...` が走ることの確認（`Subquery Scan on m` という
    // 候補D 特有の形は現れない——候補D の SQL 自体を送っていないため）。
    expect(plan, `EXPLAIN 全文:\n${plan}`).not.toMatch(/Subquery Scan on m/);
  }, 60_000);
});
