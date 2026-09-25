import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.markContestedPair` / `resolveContestedPair`（Issue #197、
 * ADR 0134・ADR 0150）を、**同じ対を引数の順序だけ入れ替えて並行に呼ぶ**という
 * `packages/testkit` の適合テストも既存の `resolve-contested-pair-scope-and-concurrency
 * .postgres.test.ts` も踏まない経路で検査する。
 *
 * どちらのメソッドも、事前検証の後 `updateSide(first.id, ...)` → `updateSide(second.id,
 * ...)` の順に行 UPDATE（暗黙の行ロック）を撃つ。事前検証の `SELECT` に `ORDER BY`/
 * `FOR UPDATE` が無いと、行ロックを取る順序は**呼び出し側が渡した引数の順**に一致する
 * ——`markContestedPair(A, B)` と `markContestedPair(B, A)`（同じ対 {A,B} を逆順で呼ぶ
 * 2つの並行呼び出し）が同時に走ると、片方が A→B、もう片方が B→A の順で行ロックを
 * 掴み合い、Postgres の 40P01（`deadlock detected`）で片方が中断される。
 *
 * `packages/core/src/interfaces/memory-store.ts` の `markContestedPair?`/
 * `resolveContestedPair?` の契約節は「CAS が破れた場合は {@link MemoryStatusConflictError}
 * を投げる」と約束しており、呼び出し側はこの型だけを見て「対が競合した」を判定できる
 * ことを前提にしてよいはずである。**しかし 40P01 は生の Postgres 例外
 * （drizzle 経由では `DrizzleQueryError`、`cause.code === '40P01'`）であり、
 * {@link MemoryStatusConflictError} ではない**——約束された型で「競合」を捕まえようと
 * する呼び出し側のコードを素通りしてクラッシュさせる。
 *
 * 修正: 事前検証の `SELECT` に `ORDER BY id ASC FOR UPDATE` を足し、行ロックを
 * 呼び出し順ではなく常に id 昇順で取るようにした（`memory-store.ts` の
 * `markContestedPair`/`resolveContestedPair` 冒頭コメント参照）。これにより、
 * 引数の順序に関わらずどちらの呼び出しも同じ順序でしか行を掴めなくなり、循環待ちが
 * 構造的に起きない——後から来たほうは先着の行ロックの解放待ちでブロックされるだけに
 * なり、解放後に読み直した `status`/`contested_with_id` が期待と違えば、下の CAS が
 * そのまま {@link MemoryStatusConflictError} を投げる。
 *
 * この歯は、実際のタイミング依存の競合を「毎回」起こすことを保証しない（デッドロックは
 * 本質的にタイミング依存であり、`git stash` で修正前のコードへ戻して手元で確かめた
 * ところ、複数回の反復のうち高い頻度で 40P01 が発生した——反復回数はその実測に基づく）。
 * **この歯が検査する不変条件は「エラーが起きるなら、その型は必ず
 * {@link MemoryStatusConflictError} である（生の Postgres 例外・その他の型が漏れない）」
 * ことであり、「デッドロックそのものを毎回再現できる」ことではない。**
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** `DATABASE_URL` が無い環境では
 * `requireDatabaseUrl()` が例外を投げ、テストランナー自体が起動しない。
 */
describe("PostgresMemoryStore.markContestedPair / resolveContestedPair — 対を逆順で並行に呼んでも生の Postgres 例外が漏れない", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
  });

  function event(memoryId: MemoryId): NewMemoryEvent {
    return {
      tenantId: "tenant-1",
      memoryId,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "digest",
      meta: {},
    };
  }

  it("markContestedPair(A,B) と markContestedPair(B,A) を反復して並行に呼んでも、失敗は必ず MemoryStatusConflictError であり、勝者はちょうど1本になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const a = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "lock-order-a" }),
    );
    const b = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "lock-order-b" }),
    );

    const clientT1 = createPostgresClient(requireDatabaseUrl());
    const clientT2 = createPostgresClient(requireDatabaseUrl());
    pools.push(clientT1, clientT2);
    const storeT1 = new PostgresMemoryStore(clientT1.db);
    const storeT2 = new PostgresMemoryStore(clientT2.db);

    const ITERATIONS = 15;
    let successCount = 0;
    let conflictCount = 0;
    const unexpected: unknown[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // 両方を 'active' に戻す（前回の反復の結果を消す）。
      await db.execute(sql`
        UPDATE memories SET status = 'active', contested_with_id = NULL
        WHERE tenant_id = 'tenant-1' AND id = ANY(${sql.param([a.id, b.id])}::uuid[])
      `);

      const p1 = storeT1.markContestedPair!(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );
      const p2 = storeT2.markContestedPair!(
        ctx,
        { id: b.id, event: event(b.id) },
        { id: a.id, event: event(a.id) },
      );

      const results = await Promise.allSettled([p1, p2]);
      for (const r of results) {
        if (r.status === "fulfilled") {
          successCount++;
        } else if (r.reason instanceof MemoryStatusConflictError) {
          conflictCount++;
        } else {
          unexpected.push(r.reason);
        }
      }
    }

    expect(unexpected).toEqual([]);
    expect(successCount).toBe(ITERATIONS);
    expect(conflictCount).toBe(ITERATIONS);
  }, 30_000);

  it("resolveContestedPair(A,B) と resolveContestedPair(B,A) を反復して並行に呼んでも、失敗は必ず MemoryStatusConflictError であり、勝者はちょうど1本になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const a = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "resolve-lock-order-a" }),
    );
    const b = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "resolve-lock-order-b" }),
    );

    const clientT1 = createPostgresClient(requireDatabaseUrl());
    const clientT2 = createPostgresClient(requireDatabaseUrl());
    pools.push(clientT1, clientT2);
    const storeT1 = new PostgresMemoryStore(clientT1.db);
    const storeT2 = new PostgresMemoryStore(clientT2.db);

    const ITERATIONS = 15;
    let successCount = 0;
    let conflictCount = 0;
    const unexpected: unknown[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // 両方を 'contested' な相互参照に戻す（前回の反復の結果を消す）。
      await seedStore.markContestedPair!(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      );

      const p1 = storeT1.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: "active", event: event(b.id) },
      );
      const p2 = storeT2.resolveContestedPair!(
        ctx,
        { id: b.id, status: "active", event: event(b.id) },
        { id: a.id, status: "active", event: event(a.id) },
      );

      const results = await Promise.allSettled([p1, p2]);
      for (const r of results) {
        if (r.status === "fulfilled") {
          successCount++;
        } else if (r.reason instanceof MemoryStatusConflictError) {
          conflictCount++;
        } else {
          unexpected.push(r.reason);
        }
      }
    }

    expect(unexpected).toEqual([]);
    expect(successCount).toBe(ITERATIONS);
    expect(conflictCount).toBe(ITERATIONS);
  }, 30_000);
});
