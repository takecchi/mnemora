import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * ADR 0500: `reinforce` の `addOwnSubjectSeq` は、`nowSeq + S_x`（`decay_base_seq`）と、床 `nowSeq + S_x + offset`
 * （`decay_floor_seq = LEAST(… + offset::bigint, MAX_SAFE_INTEGER)`）を、Postgres が `bigint` で足す。どちらかが 2^63 以上に
 * なると `22003 bigint out of range` で、行は何も書かれない（`reinforce`・`reinforceMany` とも。実測は ADR 0500）。
 * fixture は float64 で足して通していた。
 *
 * ⚠ Postgres が足すのは、ドライバが `nowSeq` を文字にした値（`String(2**63 - 1024)` は `"9223372036854775000"`）。
 * この歯の境界（S_x = 374 は通り、375 で落ちる）は、その値と、この Memory の `offset`（433）で決まる。
 * 実 DB での同じ境界は `testkit-fixture-alignment.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "reinforce-seq-overflow" };
const BIG = 2 ** 63 - 1024;
const AT = new Date("2030-01-01T00:00:00Z");

async function setup(subjectCounter: number) {
  const store = new InMemoryMemoryStore();
  store.subjectActivitySeq.set(ctx.tenantId, new Map([["s", subjectCounter]]));
  const memory = await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      subjectId: "s",
      halfLifeRecalls: 100,
      decayBaseSeq: 0,
      decayFloorSeq: 5,
    }),
  );
  return { store, memory };
}

describe("reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る", () => {
  it.each([375, 807, 808, 5000])("S_x = %i: 例外で、何も書かない", async (counter) => {
    const { store, memory } = await setup(counter);
    await expect(
      store.reinforce(ctx, memory.id, AT, { nowSeq: BIG, addOwnSubjectSeq: true }),
    ).rejects.toThrow(/^reinforce: decayBaseSeq \+ own subject seq must fit in a Postgres bigint/);
    const after = await store.get(ctx, memory.id);
    expect(after?.decayBaseSeq).toBe(0);
    expect(after?.decayFloorSeq).toBe(5);
    expect(after?.lastReinforcedAt ?? null).toBeNull();
  });

  it("reinforceMany も同じ（1件目で落ちる）", async () => {
    const { store, memory } = await setup(375);
    await expect(
      store.reinforceMany(ctx, [memory.id], AT, { nowSeq: BIG, addOwnSubjectSeq: true }),
    ).rejects.toThrow(/must fit in a Postgres bigint/);
  });

  it("やりすぎ: 溢れない境界（S_x = 374）は通る", async () => {
    const { store, memory } = await setup(374);
    const out = await store.reinforce(ctx, memory.id, AT, { nowSeq: BIG, addOwnSubjectSeq: true });
    expect(out.decayFloorSeq).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("やりすぎ: S_x が 0（カウンタ無し）・nowSeq が小さいときは通る", async () => {
    const a = await setup(0);
    await expect(
      a.store.reinforce(ctx, a.memory.id, AT, { nowSeq: BIG, addOwnSubjectSeq: true }),
    ).resolves.toBeDefined();
    const b = await setup(5000);
    await expect(
      b.store.reinforce(ctx, b.memory.id, AT, { nowSeq: 0, addOwnSubjectSeq: true }),
    ).resolves.toMatchObject({ decayBaseSeq: 5000 });
  });

  it("やりすぎ: addOwnSubjectSeq でなければ S_x を足さないので通る", async () => {
    const { store, memory } = await setup(5000);
    await expect(
      store.reinforce(ctx, memory.id, AT, { nowSeq: BIG, addOwnSubjectSeq: false }),
    ).resolves.toBeDefined();
  });

  it("やりすぎ: 何も書かない呼び出し（起点より古い at）は、溢れる組み合わせでも断らない（Postgres の SET は評価されない）", async () => {
    const { store, memory } = await setup(0);
    await store.reinforce(ctx, memory.id, AT, { nowSeq: 0, addOwnSubjectSeq: false });
    store.subjectActivitySeq.set(ctx.tenantId, new Map([["s", 5000]]));
    await expect(
      store.reinforce(ctx, memory.id, new Date("2029-01-01T00:00:00Z"), {
        nowSeq: BIG,
        addOwnSubjectSeq: true,
      }),
    ).resolves.toMatchObject({ decayBaseSeq: 0 });
  });
});
