import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `updateStatus` の `expectedStatus`（compare-and-swap、ADR 0030・安全弁3）を
 * **本物の並行**で検査する。
 *
 * `migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` の構えに倣い、
 * 「別々の `Pool` を N 本」立てる——同一 `Pool`（コネクションプール）を共有すると、
 * 複数の論理的な「プロセス」を同じ接続の使い回しで模すことになり、本当に別セッションから
 * 同時に UPDATE が来た場合の競合（行ロックの奪い合い）を再現できない、というのが
 * 両ファイルの共通コメントの理由。ここでも同じ理由でプールを分ける。
 *
 * この歯が検査するのは DDL の排他（advisory lock）ではなく、通常の行 UPDATE における
 * `WHERE ... AND status = $expected` の compare-and-swap 自体が Postgres の
 * MVCC/行ロックの下で正しく機能すること——4本が同時に同じ1行へ
 * `expectedStatus: 'active'` の supersede を撃ったとき、**ちょうど1本だけ成功し、
 * 残り3本は `MemoryStatusConflictError` になる**ことを実測する。
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** この器には Docker/PostgreSQL/
 * `DATABASE_URL` が無く、手元では実行できていない（`requireDatabaseUrl()` が
 * `DATABASE_URL` 未設定で例外を投げ、テストランナー自体が起動しない）。
 */
describe("PostgresMemoryStore.updateStatus の expectedStatus（compare-and-swap）を本物の並行で検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
  });

  it("同じ1行に4本が同時に expectedStatus:'active' で updateStatus を撃つと、ちょうど1本だけ成功し残り3本は MemoryStatusConflictError になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const memory = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1" }),
    );
    expect(memory.status).toBe("active");

    // 4本の「プロセス」相当。同一 Pool を共有しない理由は本ファイル冒頭のコメント参照。
    const N = 4;
    const clients = Array.from({ length: N }, () => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.allSettled(
      stores.map((store) =>
        store.updateStatus(ctx, memory.id, "superseded", {
          supersededById: memory.id,
          expectedStatus: "active",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // ちょうど1本だけ成功。
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    // 残り全部が MemoryStatusConflictError（別種の例外に化けていない）。
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(MemoryStatusConflictError);
      expect((reason as MemoryStatusConflictError).memoryId).toBe(memory.id);
      expect((reason as MemoryStatusConflictError).expectedStatus).toBe("active");
      // 弾かれた後に読み直した値（弾かれた瞬間の値そのものとは限らない、doc コメント参照）。
      expect((reason as MemoryStatusConflictError).observedStatus).toBe("superseded");
    }

    // 最終状態: superseded が1回分だけ適用されている（二重に上書きされていない）。
    const final = await seedStore.get(ctx, memory.id);
    expect(final?.status).toBe("superseded");
  }, 20_000);
});
