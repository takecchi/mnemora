import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 本番の `claimBatch` を実際に呼び、「詰まらないこと」を肯定側で主張する。外部トランザクション（`holder`）が唯一の claim 可能な行の行ロックを保持したまま、`lock_timeout` を積んだ専用クライアントで `claimBatch` を撃つ。
 * `SKIP LOCKED` が効いていれば、ロック済みの行を待たずに飛ばして 0件で解決する。外すと `lock_timeout=100ms` の間ロック解放を待ち続けて `55P03` で例外になり、赤くなる。
 *
 * ⛔ 手書きの SQL 文字列に対して `SKIP LOCKED` を外し、それが `55P03` で落ちることを確かめる形にはしない。それでは本番コードを1行も通らず、`outbox-store.ts` から `SKIP LOCKED` を消しても緑のままになる（赤くならないなら、その歯は飾りである）。
 *
 * 判定は所要時間の閾値ではなく、例外が出たか出なかったかという離散的な結果なので、flaky にならない。`holder` のロック保持は `finally` で明示的に手放すまで続くので、`lock_timeout = 100ms` を跨ぐ猶予は構造的に在る。
 *
 * `testkit` の適合 suite には置かない。`testkit` は store 非依存で `OutboxStore` interface 越しの操作しか受け取らず、生の接続（`BEGIN` / `lock_timeout` という session レベルの設定）を触れない。`55P03` は PostgreSQL 固有の SQLSTATE でもある。
 */
describe("PostgresOutboxStore.claimBatch — SKIP LOCKED が詰まりを止めること（ADR 0208）", () => {
  const TENANT = "outbox-skip-locked-non-blocking-tenant";

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("行ロックを保持された唯一の候補行に対して撃つと、待たずに0件で解決する", async () => {
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [TENANT],
    );
    const jobId = seeded.rows[0]?.id;
    expect(jobId).toBeDefined();

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM outbox WHERE id = $1 FOR UPDATE", [jobId]);

    const claimerClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c lock_timeout=100ms",
      max: 1,
    });

    try {
      const store = new PostgresOutboxStore(claimerClient.db);
      await expect(
        store.claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "skip-locked-claimer",
          leaseMs: 60_000,
        }),
      ).resolves.toEqual([]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }
  });
});
