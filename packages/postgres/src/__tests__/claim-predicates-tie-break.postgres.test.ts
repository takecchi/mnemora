import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * - 「副キーを丸ごと外す」: GROUP BY の出力順（実行計画しだいの偶然の並び）が昇順に当たると副キーが無くても緑になるので、
 *   同着の predicate を多数・書いた順と無関係な名前で入れ、偶然では昇順にならないようにする。
 * - 「`COLLATE "C"` を外す」: DB の既定の照合順序が `C.UTF-8` だと、外してもコードポイント順になり差が出ない
 *   （CI の2脚も C 系で、C でない照合順序の DB を立てる脚は無い）。結果では見えないので、
 *   発行される SQL の `ORDER BY` が副キーと `COLLATE "C"` を持つことを文面で縛る。
 */

const ctx: Ctx = { tenantId: "claim-predicates-tie-break-tenant" };
const TIED_AT = new Date("2026-03-01T00:00:00.000Z");
const NEWER_AT = new Date("2026-03-02T00:00:00.000Z");

async function captureStatements(fn: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const first = args[0];
    statements.push(
      typeof first === "string" ? first : String((first as { text?: unknown } | undefined)?.text),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return statements;
}

describe("listActiveClaimPredicates: 同着の副キー（predicate のコードポイント順の昇順）（Issue #1734 / PR #1484 のすり抜け、本物の Postgres）", () => {
  let store: PostgresMemoryStore;
  let pool: Awaited<ReturnType<typeof getTestClient>>["pool"];

  beforeEach(async () => {
    const client = await getTestClient();
    store = new PostgresMemoryStore(client.db);
    pool = client.pool;
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /** `created_at` を直接指定して、同着の行を `count` 件入れる（predicate は md5 由来で、書いた順と昇順が無関係）。 */
  async function insertPredicates(count: number, at: Date, prefix: string) {
    await pool.query(
      `INSERT INTO memories (id, tenant_id, subject_id, content, content_hash, digest, digest_source,
          provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
          decay_floor_at, embedding_status, created_at, updated_at, claim_key_subject, claim_key_predicate)
       SELECT gen_random_uuid(), $1, 'user-1', 'c', $3 || i, 'd', 'llm',
          'imported', '{"kind":"imported"}'::jsonb, 'active',
          '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready',
          $2::timestamptz, now(), 'user', $3 || md5(i::text)
       FROM generate_series(1, $4::int) AS i`,
      [ctx.tenantId, at.toISOString(), prefix, count],
    );
  }

  it("同着の predicate が多数あっても、predicate の昇順で返る（副キーが無いと実行計画しだいの並びになる）", async () => {
    await insertPredicates(300, TIED_AT, "tie-");
    await pool.query("ANALYZE memories");

    const predicates = await store.listActiveClaimPredicates(ctx, {
      subjectId: "user-1",
      limit: 1000,
    });
    expect(predicates).toHaveLength(300);
    expect(predicates).toEqual([...predicates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("同着の並びは新しい順の内側だけに効く（新しい群が先頭に来て、群の内側が昇順）", async () => {
    await insertPredicates(50, TIED_AT, "old-");
    await insertPredicates(50, NEWER_AT, "new-");
    await pool.query("ANALYZE memories");

    const predicates = await store.listActiveClaimPredicates(ctx, {
      subjectId: "user-1",
      limit: 1000,
    });
    const asc = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(predicates.slice(0, 50)).toEqual(asc(predicates.slice(0, 50)));
    expect(predicates.slice(0, 50).every((p) => p.startsWith("new-"))).toBe(true);
    expect(predicates.slice(50)).toEqual(asc(predicates.slice(50)));
    expect(predicates.slice(50).every((p) => p.startsWith("old-"))).toBe(true);
  });

  it('発行される SQL の ORDER BY は、副キー `claim_key_predicate COLLATE "C" ASC` を持つ（照合順序が C の DB でも、書いた文の形で縛る）', async () => {
    await insertPredicates(3, TIED_AT, "sql-");
    const statements = await captureStatements(() =>
      store.listActiveClaimPredicates(ctx, { subjectId: "user-1", limit: 10 }),
    );
    // 探り棒が生きていること: 発行した SQL を拾えている。
    const select = statements.filter(
      (s) => s.includes("claim_key_predicate") && /ORDER BY/i.test(s),
    );
    expect(select).toHaveLength(1);
    const orderBy = /ORDER BY([\s\S]*?)LIMIT/i.exec(select[0]!)?.[1] ?? "";
    expect(orderBy.replace(/\s+/g, " ").trim()).toBe(
      'MAX(created_at) DESC, claim_key_predicate COLLATE "C" ASC',
    );
  });
});
