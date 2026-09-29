import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import type { Pool } from "pg";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #207/#933 PR2（2026-09-30 の直し、ADR 0381 追記）: `markContestedGroup` の
 * 有効期間の重なり判定は、Postgres 側では `memories` テーブルの `timestamptz`
 * （マイクロ秒精度）を SQL の `INSERT ... SELECT` の中で直接比較する（JS 側に同じ式を
 * 二重に持たない、`memory-store.ts` の doc コメント参照）。
 *
 * **JS の `Date` はミリ秒までしか持たない。** アプリの書き込み経路（`createMemory` 等）は
 * すべて `toPgTimestamp(date: Date)` を通るため、実際に書かれる値は常にミリ秒精度
 * ——この乖離は、この repo のどの公開 API からも到達できない（この歯のように、
 * `pool.query` で生の SQL を打って初めて作れる）。
 *
 * この歯は、その「到達できないが Postgres は正しく処理する」ことを確認する——
 * `valid_until` が `valid_from` よりちょうど1マイクロ秒だけ後ろにずれた組が、
 * Postgres では（1マイクロ秒だけ）重なると判定され、関係の行が張られることを見る。
 * 同じ2つの時刻を JS の `Date`（ミリ秒精度）で表すと**同じ値に潰れ**、`<` の厳密比較は
 * 重ならないと判定してしまう——`InMemoryMemoryStore`/`FakeMemoryStore`（JS の `Date`
 * ベース）はこの区別を原理的に表現できない。ADR 0381 は、Postgres を正としてこの
 * 限界を引き受けたことを記録する。
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

    // a: [..., 2021-01-01T00:00:00.000001) ——年境界のちょうど1マイクロ秒後ろまで有効。
    const aId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-a",
      "2020-01-01T00:00:00.000000Z",
      "2021-01-01T00:00:00.000001Z",
    );
    // b: [2021-01-01T00:00:00.000000, ...) ——年境界ちょうどから有効。
    // a.validUntil（.000001）が b.validFrom（.000000）より1マイクロ秒だけ後ろなので、
    // 半開区間 [a.validFrom, a.validUntil) と [b.validFrom, b.validUntil) はちょうど
    // 1マイクロ秒だけ重なる。
    const bId = await insertRawMemory(
      pool,
      TENANT,
      "microsecond-b",
      "2021-01-01T00:00:00.000000Z",
      "2022-01-01T00:00:00.000000Z",
    );
    // c: markContestedGroup は3件以上が必要——常に重なる橋渡し役。
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
    // a は b（1マイクロ秒の重なり）・c（常に重なる）の両方と結ばれる。
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
    // b.validFrom は a.validUntil とマイクロ秒まで完全に一致——半開区間は境目を含まない
    // ので重ならない（上の陽性対照とちょうど1マイクロ秒だけ違う配置）。
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
    // a は c（常に重なる）とだけ結ばれる——b とは境目ちょうどで重ならない。
    expect(fromA.sort()).toEqual([cId]);
  });
});
