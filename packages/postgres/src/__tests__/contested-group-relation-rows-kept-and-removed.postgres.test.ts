import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Ctx, MemoryId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import { insertRawMemory, newEvent } from "./contested-group-fixtures.js";

/** 群を作る側は既存の contradicts を消さず、解消する側は群の外へ向かう行を消さない。 */

const none = { validFrom: null, validUntil: null };

async function contradicts(pool: Pool, tenantId: string, from: MemoryId, to: MemoryId) {
  const r = await pool.query(
    `SELECT count(*)::int AS c FROM memory_relations
     WHERE tenant_id = $1 AND from_memory_id = $2 AND to_memory_id = $3 AND kind = 'contradicts'`,
    [tenantId, from, to],
  );
  return r.rows[0].c as number;
}

afterAll(async () => {
  await closeTestClient();
});

describe("markContestedGroup: 既存の contradicts を消さない", () => {
  it("有効期間が重ならない2者の間に先に張った contradicts は、群を作ったあとも残る", async () => {
    const tenantId = "cg-mark-keeps-existing-relation";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const relations = new PostgresRelationStore(db);
    const ctx: Ctx = { tenantId };
    // a と b は有効期間が重ならない。c は無期限で、両方と重なる。
    const a = await insertRawMemory(pool, tenantId, "a", {
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2020-02-01T00:00:00Z",
    });
    const b = await insertRawMemory(pool, tenantId, "b", {
      validFrom: "2021-01-01T00:00:00Z",
      validUntil: "2021-02-01T00:00:00Z",
    });
    const c = await insertRawMemory(pool, tenantId, "c", none);
    await relations.link(ctx, "contradicts", a, b);
    await relations.link(ctx, "contradicts", b, a);
    expect(await contradicts(pool, tenantId, a, b)).toBe(1);

    await store.markContestedGroup(
      ctx,
      [a, b, c].map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );

    // 重ならない組には、markContestedGroup 自身は行を張らない。先に張った行がそのまま残る。
    expect(await contradicts(pool, tenantId, a, b)).toBe(1);
    expect(await contradicts(pool, tenantId, b, a)).toBe(1);
    // 重なる組には張られている。
    expect(await contradicts(pool, tenantId, a, c)).toBe(1);
    expect(await contradicts(pool, tenantId, c, b)).toBe(1);
  });
});

describe("markContestedGroup: 既に在る contradicts の行は書き換えない", () => {
  it("既に contradicts が張られたメンバーで呼んでも、その行の id と created_at は変わらない", async () => {
    const tenantId = "cg-mark-leaves-existing-relation-rows";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const relations = new PostgresRelationStore(db);
    const ctx: Ctx = { tenantId };
    const a = await insertRawMemory(pool, tenantId, "a", none);
    const b = await insertRawMemory(pool, tenantId, "b", none);
    const c = await insertRawMemory(pool, tenantId, "c", none);
    await relations.link(ctx, "contradicts", a, b);
    await relations.link(ctx, "contradicts", b, a);
    const rowsOf = async () =>
      (
        await pool.query(
          `SELECT id, from_memory_id, to_memory_id, created_at FROM memory_relations
           WHERE tenant_id = $1 AND from_memory_id IN ($2, $3) AND to_memory_id IN ($2, $3)
           ORDER BY from_memory_id`,
          [tenantId, a, b],
        )
      ).rows;
    const before = await rowsOf();
    expect(before).toHaveLength(2);

    await store.markContestedGroup(
      ctx,
      [a, b, c].map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );

    expect(await rowsOf()).toEqual(before);
    // 重なる組のうち、まだ無かった a-c・b-c には新しく張られている。
    expect(await contradicts(pool, tenantId, a, c)).toBe(1);
    expect(await contradicts(pool, tenantId, c, b)).toBe(1);
  });
});

describe("resolveContestedGroup: 群から抜けた元メンバーとの行を消さない", () => {
  it("群の外へ向かう contradicts は、残りのメンバーを解消したあとも残る", async () => {
    const tenantId = "cg-resolve-keeps-outside-relation";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId };
    const ids: MemoryId[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertRawMemory(pool, tenantId, `m${i}`, none));
    const [a, b, c, gone] = ids as [MemoryId, MemoryId, MemoryId, MemoryId];
    await store.markContestedGroup(
      ctx,
      ids.map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );
    // gone は群から抜ける（関係の行は残るが contested ではなくなる）。
    await store.updateStatus(ctx, gone, "archived");
    expect(await contradicts(pool, tenantId, a, gone)).toBe(1);
    expect(await contradicts(pool, tenantId, gone, a)).toBe(1);

    await store.resolveContestedGroup(
      ctx,
      [a, b, c].map((id) => ({
        id,
        status: "active" as const,
        event: newEvent(tenantId, id, "r"),
      })),
    );

    // メンバー同士の行は消える。
    expect(await contradicts(pool, tenantId, a, b)).toBe(0);
    expect(await contradicts(pool, tenantId, b, c)).toBe(0);
    // 抜けた側との行は、どちら向きも残る。
    for (const member of [a, b, c]) {
      expect(await contradicts(pool, tenantId, member, gone)).toBe(1);
      expect(await contradicts(pool, tenantId, gone, member)).toBe(1);
    }
  });
});
