import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * `createPostgresClient` の `Pool` は常に `error` リスナーを1つ付ける。待機中の接続が DB 側から切られると pg の `Pool` が `error` を emit し、`onPoolError` を渡さず利用者も `client.pool.on("error", …)` を付けなければ、既定のリスナーが `console.warn` で名乗って続行する（`readme-unbound-promises.postgres.test.ts` の A が縛る）。
 * この歯は、利用者が `client.pool.on("error", …)` を付けた場合だけを縛る（リスナーはこの歯の中で利用者の役として付ける）。既定の警告は出ず、死んだ接続は pool から捨てられ、次の呼び出しは新しい接続で通る。
 * 切り方は `pg_terminate_backend`（Postgres の再起動と同じ `terminating connection due to administrator command` が届く）。CI の Postgres はサービスコンテナで再起動できないため、これで代える。
 * 借りている最中の接続が切れる場合（`db.transaction()` の途中）は別の場所で扱う。
 */
describe("createPostgresClient の pool: 待機中の接続が DB 側から切られたとき（利用者が error リスナーを付けた場合）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("切れた接続は捨てられ、次の呼び出しは新しい接続で通り、idle in transaction は残らない", async () => {
    const admin = await getTestClient(); // マイグレーション済みにする・切る側の接続
    const applicationName = `mnemora-idle-loss-${randomUUID().slice(0, 8)}`;
    const client = createPostgresClient(requireDatabaseUrl(), {
      max: 3,
      application_name: applicationName,
    });
    const poolErrors: Error[] = [];
    client.pool.on("error", (error) => poolErrors.push(error));
    try {
      await Promise.all([1, 2, 3].map(() => client.pool.query("SELECT pg_sleep(0.05)")));
      expect(client.pool.idleCount).toBe(3);

      const terminated = await admin.pool.query<{ ok: boolean }>(
        "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      expect(terminated.rows).toHaveLength(3);

      for (let i = 0; i < 100 && (poolErrors.length < 3 || client.pool.totalCount > 0); i++) {
        await sleep(50);
      }
      expect(poolErrors).toHaveLength(3);
      for (const error of poolErrors) {
        expect(error.message).toMatch(/terminating connection due to administrator command/);
      }
      expect(client.pool.totalCount).toBe(0);

      const ctx = { tenantId: `idle-loss-${applicationName}` };
      const store = new PostgresMemoryStore(client.db);
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "after-loss" }),
      );
      expect((await store.get(ctx, created.id))?.id).toBe(created.id);
      expect(client.pool.totalCount).toBeGreaterThanOrEqual(1);
      expect(client.pool.waitingCount).toBe(0);

      const states = await admin.pool.query<{ state: string | null }>(
        "SELECT state FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      expect(states.rows.map((r) => r.state)).not.toContain("idle in transaction");
    } finally {
      await client.pool.end();
    }
  });
});
