import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const AT = new Date("2026-02-01T00:00:00.000Z");

describe("PostgresOutboxStore.complete/fail — CAS で弾いたとき・通したときに、触れる行と列", () => {
  const TENANT = `outbox-cas-row-${randomUUID()}`;
  const ctx: Ctx = { tenantId: TENANT };

  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  // 行は生の SQL で入れる。claim は store の `claimBatch` に任せ、2本を同じバッチで claim して attempts を揃える。
  async function seedClaimedJobs(count: number) {
    const { pool, db } = await getTestClient();
    for (let i = 0; i < count; i++) {
      await pool.query(
        `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
         VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())`,
        [TENANT],
      );
    }
    const store = new PostgresOutboxStore(db);
    const jobs = await store.claimBatch(ctx, {
      limit: count,
      now: new Date(Date.now() + 5_000),
      claimedBy: "w1",
      leaseMs: 60_000,
    });
    expect(jobs).toHaveLength(count);
    return { store, jobs };
  }

  async function readRow(jobId: string) {
    const { pool } = await getTestClient();
    const r = await pool.query(`SELECT * FROM outbox WHERE id = $1`, [jobId]);
    return r.rows[0]!;
  }

  type Terminate = (store: PostgresOutboxStore, id: string, attempts: number) => Promise<void>;
  const TERMINATES: [string, Terminate][] = [
    ["complete", (store, id, attempts) => store.complete(ctx, id, attempts, { at: AT })],
    ["fail", (store, id, attempts) => store.fail(ctx, id, "boom", attempts, { at: AT })],
  ];

  for (const [how, terminate] of TERMINATES) {
    it(`${how}: 同じテナントの、同じ attempts の別のジョブには終端を付けない`, async () => {
      const { store, jobs } = await seedClaimedJobs(2);
      const [other, target] = jobs as [(typeof jobs)[number], (typeof jobs)[number]];
      expect(other.attempts).toBe(target.attempts);
      const otherBefore = await readRow(other.id);

      await terminate(store, target.id, target.attempts);

      expect(await readRow(other.id)).toEqual(otherBefore);
    });

    it(`${how}: attempts が違うと OutboxLeaseConflictError を投げ、行は1列も変わらない`, async () => {
      const { store, jobs } = await seedClaimedJobs(1);
      const job = jobs[0]!;
      const before = await readRow(job.id);

      for (const wrong of [job.attempts - 1, job.attempts + 1]) {
        await expect(terminate(store, job.id, wrong)).rejects.toBeInstanceOf(
          OutboxLeaseConflictError,
        );
      }

      expect(await readRow(job.id)).toEqual(before);
    });
  }

  it("complete は completed_at だけを書き、ほかの列は変えない", async () => {
    const { store, jobs } = await seedClaimedJobs(1);
    const job = jobs[0]!;
    const before = await readRow(job.id);

    await store.complete(ctx, job.id, job.attempts, { at: AT });

    expect(await readRow(job.id)).toEqual({ ...before, completed_at: AT });
  });

  it("fail は failed_at と last_error だけを書き、ほかの列は変えない", async () => {
    const { store, jobs } = await seedClaimedJobs(1);
    const job = jobs[0]!;
    const before = await readRow(job.id);

    await store.fail(ctx, job.id, "boom", job.attempts, { at: AT });

    expect(await readRow(job.id)).toEqual({ ...before, failed_at: AT, last_error: "boom" });
  });
});
