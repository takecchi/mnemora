import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, ReinforceOptions } from "@mnemora/core";
import { defaultActivityDecayStrategy } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 書く側の `S_x` は `tenant_subject_activity` を引く相関サブクエリで、テナントの絞りが外れると別テナントの同じ subject id のカウンタを拾う。
 * 別テナントにも同じ subject id のカウンタ行がある形（サブクエリが2行を返して文が落ちる）と、
 * 自分のテナントに無く別テナントにだけある形（落ちずに別テナントの `S_x` で起点が決まる）の両方を作る。
 */

const A: Ctx = { tenantId: "own-subject-tenant-a" };
const B: Ctx = { tenantId: "own-subject-tenant-b" };
const C: Ctx = { tenantId: "own-subject-tenant-c" };

const T = 10;
const S_A = 7;
const S_B = 20;
const HALF_LIFE = 360;
const AT = new Date("2100-01-01T00:00:00.000Z");

const recallInput = (ctx: Ctx, subjectId: string | null) => ({
  tenantId: ctx.tenantId,
  subjectId,
  query: { text: "q" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
});

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setupStore() {
  const { db } = await getTestClient();
  return { db, mem: new PostgresMemoryStore(db) };
}

/** `ctx` のテナントの subject "s" のカウンタを `n` まで進める。 */
async function advanceSubject(mem: PostgresMemoryStore, ctx: Ctx, n: number) {
  for (let i = 0; i < n; i += 1) {
    await mem.createRecall(ctx, {
      ...recallInput(ctx, null),
      advanceActivityClock: { scope: "subject", subjectId: "s" },
    } as never);
  }
}

async function seedMemory(mem: PostgresMemoryStore, ctx: Ctx, name: string) {
  return mem.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      content: name,
      contentHash: `own-subject-tenant-${ctx.tenantId}-${name}`,
      subjectId: "s",
      strength: 1,
      halfLifeRecalls: HALF_LIFE,
      decayBaseSeq: 0,
      decayFloorSeq: 1,
    }),
  );
}

type Port = (
  mem: PostgresMemoryStore,
  ctx: Ctx,
  memoryId: MemoryId,
  opts: ReinforceOptions,
) => Promise<unknown>;

const PORTS: Array<[string, Port]> = [
  ["reinforce", (mem, ctx, id, opts) => mem.reinforce(ctx, id, AT, opts)],
  ["reinforceMany", (mem, ctx, id, opts) => mem.reinforceMany(ctx, [id], AT, opts)],
  [
    "recordUsageAndReinforce",
    async (mem, ctx, id, opts) => {
      const recallId = await mem.createRecall(ctx, recallInput(ctx, null) as never);
      return mem.recordUsageAndReinforce(ctx, recallId, [id], AT, opts);
    },
  ],
];

const OWN_SUBJECT_OPTS: ReinforceOptions = { nowSeq: T, addOwnSubjectSeq: true };

async function readOrigin(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
  ctx: Ctx,
  memoryId: MemoryId,
): Promise<{ base: number; floor: number }> {
  const result = await db.execute(sql`
    SELECT decay_base_seq::float8 AS base, decay_floor_seq::float8 AS floor
    FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${memoryId}
  `);
  const row = result.rows[0] as { base: number; floor: number };
  return { base: row.base, floor: row.floor };
}

function floorFrom(baseSeq: number): number {
  return defaultActivityDecayStrategy.floorAt({
    baseSeq,
    strength: 1,
    halfLifeRecalls: HALF_LIFE,
  });
}

describe("addOwnSubjectSeq の S_x は、強化される行のテナントのカウンタ行から引く（書く側のテナント境界）", () => {
  it.each(PORTS)(
    "%s: 同じ subject id のカウンタ行が2つのテナントにあっても、各テナントの起点・床は自分の T + S_x",
    async (_name, port) => {
      const { db, mem } = await setupStore();
      await advanceSubject(mem, A, S_A);
      await advanceSubject(mem, B, S_B);
      const a = await seedMemory(mem, A, "a");
      const b = await seedMemory(mem, B, "b");

      await port(mem, A, a.id, OWN_SUBJECT_OPTS);
      await port(mem, B, b.id, OWN_SUBJECT_OPTS);

      expect(await readOrigin(db, A, a.id)).toEqual({ base: T + S_A, floor: floorFrom(T + S_A) });
      expect(await readOrigin(db, B, b.id)).toEqual({ base: T + S_B, floor: floorFrom(T + S_B) });
    },
  );

  it.each(PORTS)(
    "%s: 自分のテナントにカウンタ行が無ければ、別のテナントのカウンタ行は使わず、起点・床は T のみ",
    async (_name, port) => {
      const { db, mem } = await setupStore();
      await advanceSubject(mem, A, S_A);
      const c = await seedMemory(mem, C, "c");

      await port(mem, C, c.id, OWN_SUBJECT_OPTS);

      expect(await readOrigin(db, C, c.id)).toEqual({ base: T, floor: floorFrom(T) });
    },
  );
});
