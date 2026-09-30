import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * [ADR 0438](../../../docs/decisions/0438-tenant-boundary-teeth-and-purge-uuid-case.md) の実バグ:
 * subject 単位の活動カウンタ（`tenant_subject_activity`）を引く相関サブクエリに、修飾の無い
 * `tenant_id`/`subject_id` を渡していた（`aggregateScope`・`archiveDecayed` の2箇所）。サブクエリの中では
 * 修飾の無い列名は内側の `tenant_subject_activity` の列に解決され、`sa.tenant_id = tenant_id` は恒真になる。
 *
 * - 行が2本以上あるとき: 「more than one row returned by a subquery」で文が落ちる。
 * - 行が全体で1本だけのとき: 別テナント・別 subject のカウンタを黙って使う。
 */

const A: Ctx = { tenantId: "counter-tenant-a" };
const B: Ctx = { tenantId: "counter-tenant-b" };

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};
const tick = (mem: PostgresMemoryStore, ctx: Ctx, subjectId: string) =>
  mem.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage,
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock: { scope: "subject", subjectId },
  } as never);

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setup() {
  const { db } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  const make = (ctx: Ctx, name: string, over: Record<string, unknown> = {}) =>
    mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: name,
        contentHash: `counter-${ctx.tenantId}-${name}`,
        subjectId: "s",
        decayBaseSeq: 0,
        decayFloorSeq: 5,
        ...over,
      }),
    );
  return { mem, make };
}

const archiveOpts = (nowSeq: number) => ({
  now: new Date("2026-01-01T00:00:00.000Z"),
  limit: 10,
  clock: "activity" as const,
  nowSeq,
  usesSubjectActivityCounters: true,
});
const scopeOf = (decayFloorSeqAfter: number) => ({
  subjectId: "s",
  decayFloorSeqAfter,
  decayFloorSeqUsesSubjectCounters: true,
});

describe("archiveDecayed（subject カウンタ）: カウンタ行をテナント・subject で引く", () => {
  it("A・B が同じ subject のカウンタ行を持っていても落ちず、A の記憶だけを archived にする", async () => {
    const { mem, make } = await setup();
    await tick(mem, A, "s"); // S_A = 1
    await tick(mem, B, "s"); // S_B = 1
    const am = await make(A, "a1");
    const bm = await make(B, "b1");
    // 4 + S_A(1) = 5 >= 床 5 なので沈んでいる。
    const res = await mem.archiveDecayed(A, archiveOpts(4));
    expect(res.archived.map((x) => x.memoryId)).toEqual([am.id]);
    expect((await mem.get(B, bm.id))!.status).toBe("active");
  });

  it("カウンタ行が全体で1本（B のもの）だけのとき、A の記憶の判定に B のカウンタを使わない", async () => {
    const { mem, make } = await setup();
    for (let i = 0; i < 3; i++) await tick(mem, B, "s"); // S_B = 3、A の行は無い（S_A = 0）
    const am = await make(A, "a1");
    // 4 + S_A(0) = 4 < 床 5 なので沈んでいない。B の 3 が混ざると 7 >= 5 で誤って archived になる。
    const res = await mem.archiveDecayed(A, archiveOpts(4));
    expect(res.archived).toEqual([]);
    expect((await mem.get(A, am.id))!.status).toBe("active");
  });
});

describe("aggregateScope（subject カウンタ）: カウンタ行をテナント・subject で引く", () => {
  it("A・B が同じ subject のカウンタ行を持っていても落ちない", async () => {
    const { mem, make } = await setup();
    await tick(mem, A, "s");
    await tick(mem, B, "s");
    await make(A, "a1");
    await make(B, "b1");
    const agg = await mem.aggregateScope(A, scopeOf(4));
    expect(agg.totalInScope).toBe(1);
  });

  it("カウンタ行が全体で1本（B のもの）だけのとき、A の記憶を B のカウンタで忘却ゲートに掛けない", async () => {
    const { mem, make } = await setup();
    for (let i = 0; i < 3; i++) await tick(mem, B, "s");
    await make(A, "a1");
    // 床 5 > 4 + S_A(0) なので生きている（decayed に数えない）。B の 3 が混ざると 5 > 7 が偽で decayed になる。
    const agg = await mem.aggregateScope(A, scopeOf(4));
    expect(agg.totalInScope).toBe(1);
    expect(agg.filteredDecayed?.count ?? 0).toBe(0);
  });
});
