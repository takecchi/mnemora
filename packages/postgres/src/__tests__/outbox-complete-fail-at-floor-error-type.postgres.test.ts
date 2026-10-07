import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 型は `packages/testkit` の適合テストには置かない（外部の adapter が別の型で断る実装にも効いてしまう）。この `@mnemora/postgres` 専用のファイルで縛る。形の崩れた `jobId`（DB に触れず入口で断る口）と、実在の `jobId` の両方で見る。 */

const CTX: Ctx = { tenantId: `outbox-floor-error-type-${randomUUID()}` };
const BELOW = new Date(Date.UTC(-4713, 10, 24) - 1);

async function seedClaimedJob(): Promise<{
  store: PostgresOutboxStore;
  id: string;
  attempts: number;
}> {
  const { pool, db } = await getTestClient();
  const seeded = await pool.query<{ id: string }>(
    `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
     VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
     RETURNING id`,
    [CTX.tenantId],
  );
  const store = new PostgresOutboxStore(db);
  const [job] = await store.claimBatch(CTX, {
    limit: 1,
    now: new Date(Date.now() + 60_000),
    claimedBy: "floor-error-type",
    leaseMs: 60_000,
  });
  expect(job?.id).toBe(seeded.rows[0]!.id);
  return { store, id: job!.id, attempts: job!.attempts };
}

describe("PostgresOutboxStore.complete・fail: opts.at が timestamptz の下限より前なら RangeError で断る", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  for (const how of ["complete", "fail"] as const) {
    for (const malformed of [true, false]) {
      it(`${how}: ${malformed ? "形の崩れた jobId" : "実在の jobId"} でも、例外の型は RangeError`, async () => {
        const { store, id, attempts } = await seedClaimedJob();
        const jobId = malformed ? "does-not-exist" : id;

        const call =
          how === "complete"
            ? store.complete(CTX, jobId, attempts, { at: BELOW })
            : store.fail(CTX, jobId, "boom", attempts, { at: BELOW });

        await expect(call).rejects.toBeInstanceOf(RangeError);
        await expect(call).rejects.toThrow(
          `${how}: opts.at must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`,
        );
      });
    }
  }
});
