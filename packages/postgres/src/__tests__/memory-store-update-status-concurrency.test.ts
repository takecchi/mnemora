import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 別々の `Pool` を N 本立てる。同一 `Pool` を共有すると、複数の論理的な「プロセス」を同じ接続の使い回しで模すことになり、本当に別セッションから同時に UPDATE が来た場合の競合（行ロックの奪い合い）を再現できない。
 * 検査するのは、通常の行 UPDATE の `WHERE ... AND status = $expected` の compare-and-swap 自体が Postgres の MVCC/行ロックの下で正しく機能すること。
 * 4本が同時に同じ1行へ `expectedStatus: 'active'` の supersede を撃ったとき、ちょうど1本だけ成功し、残り3本は `MemoryStatusConflictError` になる。
 */
describe("PostgresMemoryStore.updateStatus の expectedStatus（compare-and-swap）を本物の並行で検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
    await closeTestClient();
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
    // 自己置換は断られるので、置き換えた側は別の記憶にする。
    const winner = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "superseding-winner" }),
    );

    // 4本の「プロセス」相当。同一 Pool を共有しない。
    const N = 4;
    const clients = Array.from({ length: N }, () => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.allSettled(
      stores.map((store) =>
        store.updateStatus(ctx, memory.id, "superseded", {
          supersededById: winner.id,
          expectedStatus: "active",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(MemoryStatusConflictError);
      expect((reason as MemoryStatusConflictError).memoryId).toBe(memory.id);
      expect((reason as MemoryStatusConflictError).expectedStatus).toBe("active");
      // 弾かれた後に読み直した値（弾かれた瞬間の値そのものとは限らない、doc コメント参照）。
      expect((reason as MemoryStatusConflictError).observedStatus).toBe("superseded");
    }

    const final = await seedStore.get(ctx, memory.id);
    expect(final?.status).toBe("superseded");
  }, 20_000);
});
