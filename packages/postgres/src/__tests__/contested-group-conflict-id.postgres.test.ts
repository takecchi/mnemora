import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Ctx, MemoryId } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import { insertRawMemory, newEvent } from "./contested-group-fixtures.js";

/**
 * Issue #1449 PR1（ADR 0401）の歯3: `markContestedGroup` / `resolveContestedGroup` の
 * 「どの id で落ちたか」と、返り値の並び（members は入力順、events は入力順）は、
 * メンバーごとの UPDATE / INSERT を定数個の文へまとめても変わらない。
 *
 * **これは既存の振る舞いの固定であり、実装前から緑になる**（赤を見せる歯ではない）。
 * 効くかどうかは変異試験で確かめる（PR 本文）。
 *
 * 入力の並び（`ids`）は uuid の昇順（`FOR UPDATE` の順）と**わざと違う**並びにする——
 * 「入力順で最初に条件を満たさなかった id」を指すのか「uuid 昇順で最初の id」を指すのかを
 * 区別するため。
 */

const none = { validFrom: null, validUntil: null };
const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function rowCounts(pool: Pool, tenantId: string): Promise<{ rel: number; ev: number }> {
  const rel = await pool.query(`SELECT count(*)::int c FROM memory_relations WHERE tenant_id=$1`, [
    tenantId,
  ]);
  const ev = await pool.query(`SELECT count(*)::int c FROM memory_events WHERE tenant_id=$1`, [
    tenantId,
  ]);
  return { rel: rel.rows[0].c, ev: ev.rows[0].c };
}

async function statuses(pool: Pool, ids: MemoryId[]): Promise<string[]> {
  const r = await pool.query(`SELECT id, status FROM memories WHERE id = ANY($1::uuid[])`, [ids]);
  const m = new Map(r.rows.map((x) => [x.id, x.status]));
  return ids.map((id) => m.get(id));
}

afterAll(async () => {
  await closeTestClient();
});

describe("markContestedGroup: 落ちる id と返り値の並び", () => {
  it("複数のメンバーが条件を外れているとき、入力順で最初のものを指す（uuid 昇順ではない）", async () => {
    const tenantId = "cg-mark-conflict";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId };
    const good: MemoryId[] = [];
    for (let i = 0; i < 3; i++) good.push(await insertRawMemory(pool, tenantId, `g${i}`, none));
    const bad1 = await insertRawMemory(pool, tenantId, "b1", none, "superseded");
    const bad2 = await insertRawMemory(pool, tenantId, "b2", none, "superseded");
    const [lowBad, highBad] = [bad1, bad2].sort(asc) as [MemoryId, MemoryId];
    // 入力順: good, highBad（uuid では後ろ）, good, lowBad（uuid では前）
    const order = [good[0]!, highBad, good[1]!, lowBad, good[2]!];
    const err = await store
      .markContestedGroup(
        ctx,
        order.map((id) => ({ id, event: newEvent(tenantId, id, "x") })),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MemoryStatusConflictError);
    const e = err as MemoryStatusConflictError;
    expect(e.memoryId).toBe(highBad);
    expect(e.expectedStatus).toBe("active");
    expect(e.observedStatus).toBe("superseded");
    // 何も書かれていない。
    expect(await rowCounts(pool, tenantId)).toEqual({ rel: 0, ev: 0 });
    expect(await statuses(pool, good)).toEqual(["active", "active", "active"]);
  });

  it("群の途中のメンバーが別の contested の相方を持つとき、その id を指す", async () => {
    const tenantId = "cg-mark-conflict-partner";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids: MemoryId[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertRawMemory(pool, tenantId, `m${i}`, none));
    const outsider = await insertRawMemory(pool, tenantId, "outsider", none);
    // ids[3] は群の外の memory と contested の相方関係にある。
    await pool.query(`UPDATE memories SET status='contested', contested_with_id=$2 WHERE id=$1`, [
      ids[3],
      outsider,
    ]);
    const err = await store
      .markContestedGroup(
        { tenantId },
        ids.map((id) => ({ id, event: newEvent(tenantId, id, "x") })),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MemoryStatusConflictError);
    expect((err as MemoryStatusConflictError).memoryId).toBe(ids[3]);
    expect((err as MemoryStatusConflictError).observedStatus).toBe("contested");
    expect(await rowCounts(pool, tenantId)).toEqual({ rel: 0, ev: 0 });
  });

  it("存在しない id が複数あるとき、入力順で最初のものを名指しする（エラーの種類も変わらない）", async () => {
    const tenantId = "cg-mark-missing";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const real: MemoryId[] = [];
    for (let i = 0; i < 2; i++) real.push(await insertRawMemory(pool, tenantId, `r${i}`, none));
    const missA = "ffffffff-0000-4000-8000-000000000001" as MemoryId;
    const missB = "00000000-0000-4000-8000-000000000002" as MemoryId;
    const order = [real[0]!, missA, real[1]!, missB];
    const err = await store
      .markContestedGroup(
        { tenantId },
        order.map((id) => ({ id, event: newEvent(tenantId, id, "x") })),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MemoryStatusConflictError);
    expect((err as Error).message).toBe(
      `PostgresMemoryStore: memory not found for tenant: ${missA}`,
    );
  });

  it("成功時: members は入力順、events も入力順（uuid 昇順ではない）で、各 event は自分の memory のもの", async () => {
    const tenantId = "cg-mark-order";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids: MemoryId[] = [];
    for (let i = 0; i < 6; i++) ids.push(await insertRawMemory(pool, tenantId, `o${i}`, none));
    const order = [...ids].sort(asc).reverse(); // uuid 降順 = 昇順ロックの順の逆
    const r = await store.markContestedGroup(
      { tenantId },
      order.map((id, k) => ({ id, event: newEvent(tenantId, id, `t${k}`) })),
    );
    expect(r.members.map((m) => m.id)).toEqual(order);
    expect(r.members.every((m) => m.status === "contested")).toBe(true);
    expect(r.events.map((e) => e.memoryId)).toEqual(order);
    expect(r.events.map((e) => e.meta)).toEqual(order.map((_, k) => ({ tag: `t${k}` })));
    expect(r.events.every((e) => e.digestSnapshot?.startsWith("digest-"))).toBe(true);
  });
});

describe("resolveContestedGroup: 落ちる id と返り値の並び", () => {
  async function contestedGroup(tenantId: string, n: number): Promise<MemoryId[]> {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids: MemoryId[] = [];
    for (let i = 0; i < n; i++) ids.push(await insertRawMemory(pool, tenantId, `c${i}`, none));
    await store.markContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, event: newEvent(tenantId, id, "mark") })),
    );
    return ids;
  }

  it("複数のメンバーが contested でないとき、入力順で最初のものを指す", async () => {
    const tenantId = "cg-resolve-conflict";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids = await contestedGroup(tenantId, 6);
    const [lowBad, highBad] = [ids[1]!, ids[4]!].sort(asc) as [MemoryId, MemoryId];
    await pool.query(`UPDATE memories SET status='archived' WHERE id = ANY($1::uuid[])`, [
      [lowBad, highBad],
    ]);
    const good = ids.filter((id) => id !== lowBad && id !== highBad);
    const order = [good[0]!, highBad, good[1]!, lowBad, good[2]!, good[3]!];
    const before = await rowCounts(pool, tenantId);
    const err = await store
      .resolveContestedGroup(
        { tenantId },
        order.map((id) => ({ id, status: "active" as const, event: newEvent(tenantId, id, "r") })),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MemoryStatusConflictError);
    const e = err as MemoryStatusConflictError;
    expect(e.memoryId).toBe(highBad);
    expect(e.expectedStatus).toBe("contested");
    expect(e.observedStatus).toBe("archived");
    expect(await rowCounts(pool, tenantId)).toEqual(before);
    expect(await statuses(pool, good)).toEqual(good.map(() => "contested"));
  });

  it("成功時: members / events は入力順、status と supersededById は各メンバーごとに反映される", async () => {
    const tenantId = "cg-resolve-order";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids = await contestedGroup(tenantId, 5);
    const order = [...ids].sort(asc).reverse();
    const winner = order[2]!;
    const r = await store.resolveContestedGroup(
      { tenantId },
      order.map((id, k) =>
        id === winner
          ? { id, status: "active" as const, event: newEvent(tenantId, id, `t${k}`) }
          : {
              id,
              status: "superseded" as const,
              supersededById: winner,
              event: newEvent(tenantId, id, `t${k}`),
            },
      ),
    );
    expect(r.members.map((m) => m.id)).toEqual(order);
    expect(r.members.map((m) => m.status)).toEqual(
      order.map((id) => (id === winner ? "active" : "superseded")),
    );
    expect(r.members.map((m) => m.supersededById ?? null)).toEqual(
      order.map((id) => (id === winner ? null : winner)),
    );
    expect(
      r.members.every((m) => m.contestedWithId === null || m.contestedWithId === undefined),
    ).toBe(true);
    expect(r.events.map((e) => e.memoryId)).toEqual(order);
    expect(r.events.map((e) => e.meta)).toEqual(order.map((_, k) => ({ tag: `t${k}` })));
    const rel = await pool.query(
      `SELECT count(*)::int c FROM memory_relations WHERE tenant_id=$1`,
      [tenantId],
    );
    expect(rel.rows[0].c).toBe(0);
  });

  it("supersededById を渡さない active は、既存の superseded_by_id を消さない（COALESCE）", async () => {
    const tenantId = "cg-resolve-coalesce";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ids = await contestedGroup(tenantId, 3);
    const other = await insertRawMemory(pool, tenantId, "other", none);
    await pool.query(`UPDATE memories SET superseded_by_id=$2 WHERE id=$1`, [ids[0], other]);
    const r = await store.resolveContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, status: "active" as const, event: newEvent(tenantId, id, "r") })),
    );
    expect(r.members[0]!.supersededById).toBe(other);
    expect(r.members[1]!.supersededById ?? null).toBeNull();
  });
});
