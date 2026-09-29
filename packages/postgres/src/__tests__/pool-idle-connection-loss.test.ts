import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * `createPostgresClient` の `Pool` は常に `error` リスナーを1つ付ける（Issue #1213。2026-09-29 に
 * 反転した——以前はリスナーを付けず、利用者が付けることが前提だった）。pool の中で**待機中**の接続が
 * DB 側から切られる（Postgres の再起動・フェイルオーバー・運用者の切断）と、pg の `Pool` が `error` を
 * emit する。**`onPoolError` を渡さず、利用者も `client.pool.on("error", …)` を付けなければ**、
 * `createPostgresClient` 自身の既定のリスナーが `console.warn` で名乗って続行する
 * （`src/__tests__/readme-unbound-promises.postgres.test.ts` の A が縛る）。**利用者が
 * `client.pool.on("error", …)` を付けていれば**（この歯がその役をする）、既定の警告は出ず、死んだ接続は
 * pool から捨てられ、次の呼び出しは新しい接続で通る。この歯は後者（利用者が自分でリスナーを付けた場合）
 * だけを縛る（リスナーは、この歯の中で利用者の役として付ける。実装は変えていない）。
 *
 * 切り方は `pg_terminate_backend`（Postgres の再起動と同じ `terminating connection due to administrator
 * command` が届く）。CI の Postgres はサービスコンテナで再起動できないため、これで代える。
 * 【実測 2026-09-27】手元で `pg_ctl restart -m fast` を当てても同じだった（リスナー有りで、再起動の後の
 * `recall` 50回がすべて通った）。
 *
 * 借りている最中の接続が切れる場合（`db.transaction()` の途中）は別の場所であり、Issue #868 が扱う。
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
      // pool に待機中の接続を3本置く。
      await Promise.all([1, 2, 3].map(() => client.pool.query("SELECT pg_sleep(0.05)")));
      expect(client.pool.idleCount).toBe(3);

      const terminated = await admin.pool.query<{ ok: boolean }>(
        "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      expect(terminated.rows).toHaveLength(3);

      // 3本とも error として届き、pool から捨てられるまで待つ。
      for (let i = 0; i < 100 && (poolErrors.length < 3 || client.pool.totalCount > 0); i++) {
        await sleep(50);
      }
      expect(poolErrors).toHaveLength(3);
      for (const error of poolErrors) {
        expect(error.message).toMatch(/terminating connection due to administrator command/);
      }
      expect(client.pool.totalCount).toBe(0);

      // 次の呼び出しは新しい接続で通る。
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
