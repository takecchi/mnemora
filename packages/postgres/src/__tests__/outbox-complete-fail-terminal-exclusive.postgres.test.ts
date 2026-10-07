import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `complete`/`fail` の CAS な `WHERE` が `attempts` の一致しか見ないと、同じ `attempts` のまま complete → fail（逐次でも、本物の2接続からの並行でも）を呼ぶと両方の終端列が付く。
 * 先に付いた終端を勝たせる。相手側の終端列が既に付いていれば、後から来た complete/fail は行を変えない（例外も投げない）。`attempts` 不一致の CAS 衝突や、行が無い場合の no-op はこれまで通り。
 * complete+complete / fail+fail の歯は `outbox-store-conformance.ts`（`conformance.postgres.test.ts` 経由）が検査するので、ここには複製しない。
 */
describe("PostgresOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826）", () => {
  const TENANT = `outbox-terminal-exclusive-${randomUUID()}`;

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /** claim 可能なジョブを1本 seed し、1度 claim して `expectedAttempts` を得る。 */
  async function seedClaimedJob(ctx: Ctx): Promise<{ jobId: string; attempts: number }> {
    const { pool, db } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [ctx.tenantId],
    );
    const jobId = seeded.rows[0]?.id;
    if (jobId === undefined) throw new Error("seed 失敗");
    const store = new PostgresOutboxStore(db);
    // ⚠ `now` は「十分先」の時刻にする。行の `available_at` は DB サーバの `now()` で決まり、この `claimBatch` の `now` は Node 側の `new Date()` なので、壁時計のわずかなずれで `available_at <= now` が偽になり claim が0件になることがある。
    // このテストは claim の境界条件ではなく CAS な complete/fail の排他だけを見たいので、余裕を持たせて回避する。
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 5_000),
      claimedBy: "seed-claimer",
      leaseMs: 60_000,
    });
    const job = claimed.find((j) => j.id === jobId);
    if (job === undefined) {
      throw new Error("claim 失敗");
    }
    return { jobId, attempts: job.attempts };
  }

  /** 2本の独立した `pg.Pool`（各 `max: 1`）に対応する `PostgresOutboxStore` を作る。 */
  function twoIndependentStores(): {
    storeA: PostgresOutboxStore;
    storeB: PostgresOutboxStore;
    cleanup: () => Promise<void>;
  } {
    const clientA = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    const clientB = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    return {
      storeA: new PostgresOutboxStore(clientA.db),
      storeB: new PostgresOutboxStore(clientB.db),
      cleanup: async () => {
        await closePostgresClient(clientA);
        await closePostgresClient(clientB);
      },
    };
  }

  async function readRow(jobId: string) {
    const { pool } = await getTestClient();
    const result = await pool.query<{
      completed_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
      attempts: number;
    }>(`SELECT completed_at, failed_at, last_error, attempts FROM outbox WHERE id = $1`, [jobId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("行が消えている");
    return row;
  }

  it("逐次: complete → fail（同じ attempts）— completed のまま、failed_at/last_error は null、例外も投げない", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedClaimedJob(ctx);
    const store = new PostgresOutboxStore((await getTestClient()).db);

    await expect(store.complete(ctx, jobId, attempts)).resolves.not.toThrow();
    await expect(store.fail(ctx, jobId, "should-not-be-recorded", attempts)).resolves.not.toThrow();

    const row = await readRow(jobId);
    expect(row.completed_at).not.toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("逐次: fail → complete（同じ attempts）— failed のまま、completed_at は null、例外も投げない", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedClaimedJob(ctx);
    const store = new PostgresOutboxStore((await getTestClient()).db);

    await expect(store.fail(ctx, jobId, "boom", attempts)).resolves.not.toThrow();
    await expect(store.complete(ctx, jobId, attempts)).resolves.not.toThrow();

    const row = await readRow(jobId);
    expect(row.failed_at).not.toBeNull();
    expect(row.last_error).toBe("boom");
    expect(row.completed_at).toBeNull();
  });

  /** 取り直し（リースが切れた行の再 claim）で attempts を 2 にして、その行の id と attempts を返す。 */
  async function seedReclaimedJob(ctx: Ctx): Promise<{ jobId: string; attempts: number }> {
    const first = await seedClaimedJob(ctx);
    const { db } = await getTestClient();
    const store = new PostgresOutboxStore(db);
    const reclaimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 3_600_000),
      claimedBy: "second-claimer",
      leaseMs: 60_000,
    });
    const job = reclaimed.find((j) => j.id === first.jobId);
    if (job === undefined) {
      throw new Error("取り直しに失敗");
    }
    expect(job.attempts).toBe(2);
    return { jobId: first.jobId, attempts: job.attempts };
  }

  it("取り直した後（attempts が2）の正当な complete は completed_at を付ける（黙って返さない）", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedReclaimedJob(ctx);
    const store = new PostgresOutboxStore((await getTestClient()).db);

    await store.complete(ctx, jobId, attempts);

    const row = await readRow(jobId);
    expect(row.completed_at).not.toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.attempts).toBe(2);
  });

  it("取り直した後（attempts が2）の正当な fail は failed_at と last_error を付ける（黙って返さない）", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedReclaimedJob(ctx);
    const store = new PostgresOutboxStore((await getTestClient()).db);

    await store.fail(ctx, jobId, "second-claim-error", attempts);

    const row = await readRow(jobId);
    expect(row.failed_at).not.toBeNull();
    expect(row.last_error).toBe("second-claim-error");
    expect(row.completed_at).toBeNull();
  });

  it("本物の2接続からの並行 complete+fail（同じ attempts）— 例外は投げず、どちらか一方の終端だけが付く（10ラウンド）", async () => {
    // 「出なかった」を根拠にするなら陽性対照が要る。10ラウンド繰り返し、毎回ちょうど一方だけが付くことを見る。
    const ROUNDS = 10;
    for (let round = 0; round < ROUNDS; round++) {
      const ctx: Ctx = { tenantId: `${TENANT}-round-${round}` };
      const { jobId, attempts } = await seedClaimedJob(ctx);
      const { storeA, storeB, cleanup } = twoIndependentStores();
      try {
        const results = await Promise.allSettled([
          storeA.complete(ctx, jobId, attempts),
          storeB.fail(ctx, jobId, `error-from-B-round-${round}`, attempts),
        ]);
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);

        const row = await readRow(jobId);
        const completed = row.completed_at !== null;
        const failed = row.failed_at !== null;
        expect(completed && failed).toBe(false);
        expect(completed || failed).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });
});
