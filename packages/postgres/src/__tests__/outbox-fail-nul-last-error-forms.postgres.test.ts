import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresOutboxStore.fail`（PR #1060）の約束: `error` の NUL（U+0000）だけを、目に見える6文字の
 * `\u0000` に置き換えて書く（黙って消さない）。それ以外の文字は変えない。
 * `outbox-fail-nul-last-error.postgres.test.ts` は NUL が1つの例だけを見る。ここは、
 * NUL が複数ある・バックスラッシュや前後の空白・本物の `\u0000`（6文字の文字列）を含む `error` で、
 * 置き換えが「全部の NUL」「NUL だけ」であることを固定する。
 */

const CTX: Ctx = { tenantId: `outbox-fail-nul-forms-${randomUUID()}` };

async function failWith(error: string): Promise<string | null> {
  const { pool, db } = await getTestClient();
  const seeded = await pool.query<{ id: string }>(
    `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
     VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
     RETURNING id`,
    [CTX.tenantId],
  );
  const jobId = seeded.rows[0]!.id;
  const store = new PostgresOutboxStore(db);
  const [job] = await store.claimBatch(CTX, {
    limit: 1,
    now: new Date(Date.now() + 60_000),
    claimedBy: "nul-forms",
    leaseMs: 60_000,
  });
  expect(job?.id).toBe(jobId);
  await store.fail(CTX, jobId, error, job!.attempts);
  const row = await pool.query<{ last_error: string | null }>(
    "SELECT last_error FROM outbox WHERE id = $1",
    [jobId],
  );
  return row.rows[0]?.last_error ?? null;
}

describe("PostgresOutboxStore.fail: last_error に書く文字列は、NUL だけが6文字の \\u0000 に変わる", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("NUL が複数あれば、すべて置き換わる（先頭だけでも、間引きでもない）", async () => {
    expect(await failWith("a\u0000b\u0000c\u0000\u0000d")).toBe("a\\u0000b\\u0000c\\u0000\\u0000d");
  });

  it("NUL 以外は変わらない：バックスラッシュ・前後の空白・改行・本物の \\u0000（6文字）", async () => {
    // 本物の「\u0000」6文字（NUL ではない）と、バックスラッシュ、前後の空白、改行を含む。
    const literal = " lead\\x \\u0000 end\n tail ";
    expect(await failWith(literal)).toBe(literal);
    // NUL と同居しても、NUL 以外の文字は同じ。
    expect(await failWith(" a\\b\u0000c\\u0000 ")).toBe(" a\\b\\u0000c\\u0000 ");
  });
});
