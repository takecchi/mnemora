import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Ctx, MemoryId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import {
  insertRawMemory,
  newEvent,
  overlaps,
  randomValidity,
  rng,
  validityFor,
  type RawValidity,
  type Shape,
} from "./contested-group-fixtures.js";

/**
 * 2通りで縛る（どちらか片方だけでは、参照実装と実装が同じ誤りをする余地が残る）。
 * - `LEGACY_PAIRS_SQL`: 書き換え前の `INSERT ... SELECT` の `SELECT` 部分を、挿入せずにそのまま持つ参照実装。
 * - `overlaps()`: 有効期間から JS のマイクロ秒（BigInt）で期待集合を計算する。
 */

const LEGACY_PAIRS_SQL = `
  SELECT a.id AS from_id, b.id AS to_id
  FROM memories a
  JOIN memories b
    ON b.tenant_id = a.tenant_id
   AND b.id <> a.id
   AND b.id = ANY($2::uuid[])
  WHERE a.tenant_id = $1
    AND a.id = ANY($2::uuid[])
    AND (a.valid_from IS NULL OR b.valid_until IS NULL OR a.valid_from < b.valid_until)
    AND (b.valid_from IS NULL OR a.valid_until IS NULL OR b.valid_from < a.valid_until)
`;

const pairKey = (from: string, to: string): string => `${from}>${to}`;

async function storedPairs(pool: Pool, tenantId: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT from_memory_id, to_memory_id, kind FROM memory_relations WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const row of r.rows) expect(row.kind).toBe("contradicts");
  return r.rows.map((row) => pairKey(row.from_memory_id, row.to_memory_id)).sort();
}

async function legacyPairs(pool: Pool, tenantId: string, ids: MemoryId[]): Promise<string[]> {
  const r = await pool.query(LEGACY_PAIRS_SQL, [tenantId, ids]);
  return r.rows.map((row) => pairKey(row.from_id, row.to_id)).sort();
}

function jsPairs(ids: MemoryId[], validities: RawValidity[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i !== j && overlaps(validities[i]!, validities[j]!)) out.push(pairKey(ids[i]!, ids[j]!));
    }
  }
  return out.sort();
}

async function markAndCompare(
  tenantId: string,
  validities: RawValidity[],
): Promise<{ stored: string[]; legacy: string[]; js: string[] }> {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId };
  const ids: MemoryId[] = [];
  for (let i = 0; i < validities.length; i++) {
    ids.push(await insertRawMemory(pool, tenantId, `eq-${i}`, validities[i]!));
  }
  const legacy = await legacyPairs(pool, tenantId, ids);
  await store.markContestedGroup(
    ctx,
    ids.map((id) => ({ id, event: newEvent(tenantId, id, "eq") })),
  );
  return { stored: await storedPairs(pool, tenantId), legacy, js: jsPairs(ids, validities) };
}

afterAll(async () => {
  await closeTestClient();
});

describe("markContestedGroup: 関係の行の集合は旧 SQL・有効期間からの計算と一致する", () => {
  for (const shape of ["chain", "star", "complete"] as Shape[]) {
    it(`${shape}（N=12）`, async () => {
      const validities = Array.from({ length: 12 }, (_, i) => validityFor(shape, i));
      const { stored, legacy, js } = await markAndCompare(`eq-${shape}`, validities);
      expect(stored).toEqual(legacy);
      expect(stored).toEqual(js);
      // 形そのものの取り違え（全部空、全部つながる）を防ぐ: 鎖・星は 2(N-1) 行、完全は N(N-1) 行。
      expect(stored.length).toBe(shape === "complete" ? 12 * 11 : 2 * 11);
    });
  }

  it("乱数の有効期間（null・境目ちょうど・1マイクロ秒のずれを含む）を 5 種、N=16", async () => {
    let totalPairs = 0;
    let totalPossible = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const next = rng(seed);
      const validities = Array.from({ length: 16 }, () => randomValidity(next));
      const { stored, legacy, js } = await markAndCompare(`eq-rand-${seed}`, validities);
      expect(stored).toEqual(legacy);
      expect(stored).toEqual(js);
      totalPairs += stored.length;
      totalPossible += 16 * 15;
    }
    // 入力が退化していない（全部つながる・全部つながらない、のどちらでもない）ことの確認。
    expect(totalPairs).toBeGreaterThan(0);
    expect(totalPairs).toBeLessThan(totalPossible);
  });

  it("既に張られている行があっても冪等（重複を作らず、他の行も変わらない）", async () => {
    const tenantId = "eq-idempotent";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId };
    const validities = Array.from({ length: 6 }, () => ({ validFrom: null, validUntil: null }));
    const ids: MemoryId[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(await insertRawMemory(pool, tenantId, `idem-${i}`, validities[i]!));
    const members = ids.map((id) => ({ id, event: newEvent(tenantId, id, "idem") }));
    await store.markContestedGroup(ctx, members);
    const first = await storedPairs(pool, tenantId);
    await store.markContestedGroup(ctx, members);
    expect(await storedPairs(pool, tenantId)).toEqual(first);
    expect(first.length).toBe(6 * 5);
  });

  it("群の外の memory・別テナントの memory には行を張らない", async () => {
    const tenantId = "eq-scope";
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const inside: MemoryId[] = [];
    for (let i = 0; i < 3; i++) {
      inside.push(
        await insertRawMemory(pool, tenantId, `in-${i}`, { validFrom: null, validUntil: null }),
      );
    }
    await insertRawMemory(pool, tenantId, "outside", { validFrom: null, validUntil: null });
    await insertRawMemory(pool, "eq-scope-other", "other", { validFrom: null, validUntil: null });
    await store.markContestedGroup(
      { tenantId },
      inside.map((id) => ({ id, event: newEvent(tenantId, id, "scope") })),
    );
    const stored = await storedPairs(pool, tenantId);
    expect(stored.length).toBe(6);
    expect(await storedPairs(pool, "eq-scope-other")).toEqual([]);
  });
});
