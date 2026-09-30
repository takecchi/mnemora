import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0440（クローンの委譲先 mgr-0629e6a2 が書いた。直し方はクローン miku が決めた。オーナーではない）:
 * 同じリース（同じ `attempts`）で2回目の `complete`/`fail` が来ても、**先に付いた終端（先勝ち）**の
 * `completed_at`・`failed_at`・`last_error` を保つ。直す前は `complete` の UPDATE が `failed_at IS NULL`
 * しか、`fail` の UPDATE が `completed_at IS NULL` しか見ておらず、同種の再呼び出しが値を上書きした
 * （`purgeCompletedJobs` の olderThan の境界も後ろにずれた）。
 *
 * 戻り値（`Promise<void>`）と例外（`attempts` 不一致の `OutboxLeaseConflictError`、行が無いときの no-op）は
 * 直す前と同じ。testkit の fixture 側の対応する歯は
 * `packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts`。
 */
const T1 = new Date("2026-02-01T00:00:00.000Z");
const T2 = new Date("2026-03-01T00:00:00.000Z");

describe("PostgresOutboxStore.complete/fail — 先勝ち（ADR 0440）", () => {
  const TENANT = `outbox-first-wins-${randomUUID()}`;
  const ctx: Ctx = { tenantId: TENANT };

  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  async function seedClaimedJob(): Promise<{
    store: PostgresOutboxStore;
    jobId: string;
    attempts: number;
  }> {
    const { pool, db } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [TENANT],
    );
    const jobId = seeded.rows[0]!.id;
    const store = new PostgresOutboxStore(db);
    // 行の available_at は DB の now()。Node 側の now を少し先にして claim を確実にする。
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 5_000),
      claimedBy: "w1",
      leaseMs: 60_000,
    });
    const job = claimed.find((j) => j.id === jobId);
    if (job === undefined) throw new Error("claim 失敗");
    return { store, jobId, attempts: job.attempts };
  }

  async function readRow(jobId: string) {
    const { pool } = await getTestClient();
    const r = await pool.query<{
      completed_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
    }>(`SELECT completed_at, failed_at, last_error FROM outbox WHERE id = $1`, [jobId]);
    return r.rows[0]!;
  }

  it("complete → complete: completed_at は1回目のまま、戻り値は undefined", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.complete(ctx, jobId, attempts, { at: T1 });
    await expect(store.complete(ctx, jobId, attempts, { at: T2 })).resolves.toBeUndefined();
    const row = await readRow(jobId);
    expect(row.completed_at).toEqual(T1);
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("fail → fail: failed_at と last_error は1回目のまま、戻り値は undefined", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.fail(ctx, jobId, "first", attempts, { at: T1 });
    await expect(store.fail(ctx, jobId, "second", attempts, { at: T2 })).resolves.toBeUndefined();
    const row = await readRow(jobId);
    expect(row.failed_at).toEqual(T1);
    expect(row.last_error).toBe("first");
    expect(row.completed_at).toBeNull();
  });

  it("complete → fail: completed のまま（値は1回目）", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.complete(ctx, jobId, attempts, { at: T1 });
    await expect(store.fail(ctx, jobId, "late", attempts, { at: T2 })).resolves.toBeUndefined();
    const row = await readRow(jobId);
    expect(row.completed_at).toEqual(T1);
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("fail → complete: failed のまま（値は1回目）", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.fail(ctx, jobId, "first", attempts, { at: T1 });
    await expect(store.complete(ctx, jobId, attempts, { at: T2 })).resolves.toBeUndefined();
    const row = await readRow(jobId);
    expect(row.failed_at).toEqual(T1);
    expect(row.last_error).toBe("first");
    expect(row.completed_at).toBeNull();
  });

  it("purgeCompletedJobs の境界は1回目の completed_at で決まる（T1 < olderThan < T2）", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.complete(ctx, jobId, attempts, { at: T1 });
    await store.complete(ctx, jobId, attempts, { at: T2 });
    const olderThan = new Date("2026-02-15T00:00:00.000Z");
    const dry = await store.purgeCompletedJobs(ctx, { olderThan, limit: 10, dryRun: true });
    expect(dry.purged).toBe(1);
    expect(dry.oldestPurgedAt).toEqual(T1);
    const boundary = await store.purgeCompletedJobs(ctx, {
      olderThan: T1,
      limit: 10,
      dryRun: true,
    });
    expect(boundary.purged).toBe(0);
    const real = await store.purgeCompletedJobs(ctx, { olderThan, limit: 10 });
    expect(real).toMatchObject({ purged: 1, oldestPurgedAt: T1, newestPurgedAt: T1 });
  });

  it("終端後の claimBatch は0件（直す前と同じ）", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.complete(ctx, jobId, attempts, { at: T1 });
    await store.complete(ctx, jobId, attempts, { at: T2 });
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 3_600_000),
      claimedBy: "w2",
      leaseMs: 1,
    });
    expect(claimed).toHaveLength(0);
  });

  it("例外は直す前と同じ: attempts 不一致は終端後でも OutboxLeaseConflictError、行が無ければ no-op", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await store.complete(ctx, jobId, attempts, { at: T1 });
    await expect(store.complete(ctx, jobId, attempts + 1, { at: T2 })).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    await expect(store.fail(ctx, jobId, "x", attempts + 1, { at: T2 })).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    expect((await readRow(jobId)).completed_at).toEqual(T1);
    await expect(store.complete(ctx, randomUUID(), 0)).resolves.toBeUndefined();
    await expect(store.fail(ctx, randomUUID(), "x", 0)).resolves.toBeUndefined();
  });

  it("本物の2接続からの並行 fail+fail（同じ attempts）でも、last_error は先に付いた一方だけ", async () => {
    const { store, jobId, attempts } = await seedClaimedJob();
    await Promise.all([
      store.fail(ctx, jobId, "A", attempts, { at: T1 }),
      store.fail(ctx, jobId, "B", attempts, { at: T2 }),
    ]);
    const row = await readRow(jobId);
    // どちらが先かは決まらないが、failed_at と last_error が同じ呼び出しのものである（混ざらない）
    const pair = [row.failed_at?.getTime(), row.last_error];
    expect([
      [T1.getTime(), "A"],
      [T2.getTime(), "B"],
    ]).toContainEqual(pair);
  });
});
