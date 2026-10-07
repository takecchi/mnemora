import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import type { Pool } from "pg";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * JS の `Date` はミリ秒までしか持たず、アプリの書き込み経路は `toPgTimestamp` を通るので、この乖離は公開 API からは到達できない（`pool.query` で生 SQL を打って初めて作れる）。
 * `valid_until` が `valid_from` よりちょうど1マイクロ秒だけ後ろの組は、Postgres では重なると判定され、関係の行が張られる。
 * 同じ2つの時刻を JS の `Date` で表すと同じ値に潰れ、`InMemoryMemoryStore`/`FakeMemoryStore` はこの区別を原理的に表現できないので、Postgres を正とする。
 */

const TENANT = "mark-contested-group-microsecond";

async function insertRawMemory(
  pool: Pool,
  tenantId: string,
  contentHash: string,
  validFrom: string | null,
  validUntil: string | null,
): Promise<MemoryId> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO memories (id, tenant_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, recorded_at, strength, half_life_hours,
        decay_floor_at, embedding_status, created_at, updated_at, valid_from, valid_until,
        claim_key_subject, claim_key_predicate)
     VALUES ($1, $2, 'c', $3, 'd', 'llm', 'imported', '{"kind":"imported"}'::jsonb,
        'active', '{}'::text[], now(), 1, 720, now() + interval '30 days', 'ready', now(), now(),
        $4::timestamptz, $5::timestamptz, 'user', 'address')`,
    [id, tenantId, contentHash, validFrom, validUntil],
  );
  return id as MemoryId;
}

afterAll(async () => {
  await closeTestClient();
});

describe("markContestedGroup: 有効期間の重なりは Postgres の timestamptz（マイクロ秒精度）で正しく判定される", () => {
  it("validUntil が validFrom よりちょうど1マイクロ秒後ろにずれた組には、行が張られる（JS の Date では区別できない差）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const relationStore = new PostgresRelationStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const aId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-a",
      "2020-01-01T00:00:00.000000Z",
      "2021-01-01T00:00:00.000001Z",
    );
    const bId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-b",
      "2021-01-01T00:00:00.000000Z",
      "2022-01-01T00:00:00.000000Z",
    );
    const cId = await insertRawMemory(pool, TENANT, "microsecond-c", null, null);

    const event = (memoryId: MemoryId): NewMemoryEvent => ({
      tenantId: TENANT,
      memoryId,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "digest",
      meta: {},
    });
    await store.markContestedGroup(ctx, [
      { id: aId, event: event(aId) },
      { id: bId, event: event(bId) },
      { id: cId, event: event(cId) },
    ]);

    const fromA = (await relationStore.listRelated(ctx, aId)).map((r) => r.memoryId);
    expect(fromA.sort()).toEqual([bId, cId].sort());
  });

  it("陰性対照: validUntil が validFrom とちょうど同じ（重なりゼロ）なら、行は張られない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const relationStore = new PostgresRelationStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const aId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-zero-a",
      "2020-01-01T00:00:00.000000Z",
      "2021-01-01T00:00:00.000000Z",
    );
    // b.validFrom は a.validUntil とマイクロ秒まで完全に一致する。半開区間は境目を含まないので重ならない（上の陽性対照とちょうど1マイクロ秒だけ違う配置）。
    const bId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-zero-b",
      "2021-01-01T00:00:00.000000Z",
      "2022-01-01T00:00:00.000000Z",
    );
    const cId = await insertRawMemory(pool, TENANT, "microsecond-zero-c", null, null);

    const event = (memoryId: MemoryId): NewMemoryEvent => ({
      tenantId: TENANT,
      memoryId,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "digest",
      meta: {},
    });
    await store.markContestedGroup(ctx, [
      { id: aId, event: event(aId) },
      { id: bId, event: event(bId) },
      { id: cId, event: event(cId) },
    ]);

    const fromA = (await relationStore.listRelated(ctx, aId)).map((r) => r.memoryId);
    expect(fromA.sort()).toEqual([cId]);
  });
});
