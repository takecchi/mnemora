import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, Memory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryVectorStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE as SPACE,
} from "./test-db.js";

/**
 * `nowSeq + S_x`（`archiveDecayed`）・`decayFloorSeqAfter + S_x`（`aggregateScope`・`VectorStore.search`）が
 * bigint を溢れるとき、Postgres は `22003 bigint out of range` で文ごと失敗する。
 * testkit の InMemory も同じ入力で断ることを、**同じ入力を2実装へ流して**縛る。
 *
 * Postgres が溢れを見るのは、**その式が実際に評価される行があるとき**だけである:
 * - 評価されるのは `decay_floor_seq` が非 NULL（`IS NULL OR …`・`IS NOT NULL AND …` の短絡）で、記憶が subject を持つ行
 *   （`S_x` の引きが 0 に落ちる subject なしの行は `nowSeq + 0`）。
 * - 2軸（壁時計と活動時計）が両方あるときは、式の左（壁時計）で決まれば右（活動時計）は評価されない。
 * - 行が先に別の条件（`status`・`attributes`・集計の「スコープ内」など）で落ちれば、評価されない。
 * 例外の種類（`bigint`）だけを見る。文面・クラスは2実装で違う。
 */

const ctx: Ctx = { tenantId: "seq-sum-overflow" };
const BIG = 2 ** 63 - 1024; // ドライバは "9223372036854775000" にする。+807 まで入り、+808 で 2^63 以上。

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

type Outcome = "ok" | "bigint" | `other: ${string}`;

async function classify(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return "ok";
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const message = `${err.message} ${err.cause?.message ?? ""}`;
    if (err.cause?.code === "22003" || /must fit in a Postgres bigint/.test(message)) {
      return "bigint";
    }
    return `other: ${message.split("\n")[0]!.slice(0, 80)}`;
  }
}

interface Stores {
  mem: PostgresMemoryStore | InMemoryMemoryStore;
  vec: PostgresVectorStore | InMemoryVectorStore;
  setSubjectSeq: (value: number) => Promise<void>;
}

async function build(impl: "postgres" | "fixture"): Promise<Stores> {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return {
      mem: new PostgresMemoryStore(db),
      vec: new PostgresVectorStore(db),
      setSubjectSeq: async (value) => {
        await db.execute(
          sql`INSERT INTO tenant_subject_activity(tenant_id, subject_id, activity_seq)
              VALUES (${ctx.tenantId}, 's', ${value}::bigint)
              ON CONFLICT (tenant_id, subject_id) DO UPDATE SET activity_seq = EXCLUDED.activity_seq`,
        );
      },
    };
  }
  const mem = new InMemoryMemoryStore();
  return {
    mem,
    vec: new InMemoryVectorStore(mem),
    setSubjectSeq: async (value) => {
      mem.subjectActivitySeq.set(ctx.tenantId, new Map([["s", value]]));
    },
  };
}

async function both(expected: Outcome, run: (s: Stores) => Promise<unknown>) {
  await resetTestDatabase();
  const pg = await classify(() => build("postgres").then(run));
  const fx = await classify(() => build("fixture").then(run));
  expect({ postgres: pg, fixture: fx }).toEqual({ postgres: expected, fixture: expected });
}

interface Seeded {
  memory: Memory;
}
async function seed(
  s: Stores,
  counter: number,
  extra: { subjectId?: string | null; decayFloorSeq?: number | null } = {},
): Promise<Seeded> {
  await s.setSubjectSeq(counter);
  const subjectId = extra.subjectId === undefined ? "s" : extra.subjectId;
  const memory = await s.mem.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      subjectId,
      halfLifeRecalls: 100,
      decayBaseSeq: 0,
      ...(extra.decayFloorSeq === null ? {} : { decayFloorSeq: extra.decayFloorSeq ?? 5 }),
    }),
  );
  await s.vec.upsert(ctx, SPACE, memory.id, [1, 0, 0]);
  return { memory };
}

const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");
const ageOf = (m: Memory, aliveWall: boolean) =>
  new Date(m.decayFloorAt.getTime() + (aliveWall ? -1000 : 1000));

type Call = (s: Stores, seeded: Seeded) => Promise<unknown>;
const archive =
  (clock: "activity" | "either" | "wall", counters: boolean, nowSeq = BIG): Call =>
  (s) =>
    s.mem.archiveDecayed(ctx, {
      now: FAR_FUTURE,
      limit: 5,
      clock,
      nowSeq,
      usesSubjectActivityCounters: counters,
    });
const aggregate =
  (counters: boolean, extra: (m: Memory) => object = () => ({})): Call =>
  (s, { memory }) =>
    s.mem.aggregateScope(ctx, {
      decayFloorSeqAfter: BIG,
      decayFloorSeqUsesSubjectCounters: counters,
      ...extra(memory),
    });
const search =
  (counters: boolean, extra: (m: Memory) => object = () => ({})): Call =>
  (s, { memory }) =>
    s.vec.search(ctx, SPACE, [1, 0, 0], {
      limit: 3,
      filter: {
        tenantId: ctx.tenantId,
        decayFloorSeqAfter: BIG,
        decayFloorSeqUsesSubjectCounters: counters,
        ...extra(memory),
      },
    });

const seqOnly: Array<[string, (counters: boolean) => Call]> = [
  ["archiveDecayed clock: activity", (c) => archive("activity", c)],
  ["archiveDecayed clock: either（壁時計は沈んでいる）", (c) => archive("either", c)],
  ["aggregateScope", (c) => aggregate(c)],
  ["VectorStore.search", (c) => search(c)],
];

describe.each(seqOnly)("%s: nowSeq + S_x が bigint を溢れるなら、2実装とも断る", (_, call) => {
  it.each([
    [0, "ok"],
    [807, "ok"],
    [808, "bigint"],
    [5000, "bigint"],
  ] as const)("S_x = %i: %s", async (counter, expected) => {
    await both(expected, async (s) => call(true)(s, await seed(s, counter)));
  });

  it("S_x を足さない（usesSubjectCounters が false）なら、S_x がいくつでも通る", async () => {
    await both("ok", async (s) => call(false)(s, await seed(s, 5000)));
  });

  it("subject を持たない記憶は S_x を引かない（0）ので通る", async () => {
    await both("ok", async (s) => call(true)(s, await seed(s, 5000, { subjectId: null })));
  });

  it("decay_floor_seq が NULL の行は、式が評価されないので通る", async () => {
    await both("ok", async (s) => call(true)(s, await seed(s, 5000, { decayFloorSeq: null })));
  });
});

describe("式が評価される行が無ければ、溢れても通る", () => {
  it("archiveDecayed: archived の行は対象の絞りで落ちる。壁時計の clock は nowSeq を使わない", async () => {
    await both("ok", async (s) => {
      const seeded = await seed(s, 5000);
      await s.mem.archiveDecayed(ctx, { now: FAR_FUTURE, limit: 5, clock: "wall" });
      return archive("activity", true)(s, seeded);
    });
    await both("ok", async (s) => archive("wall", true)(s, await seed(s, 5000)));
  });

  it("archiveDecayed clock: either は、壁時計が沈んでいない行で活動時計の式を評価しない", async () => {
    await both("ok", async (s) => {
      const seeded = await seed(s, 5000);
      return s.mem.archiveDecayed(ctx, {
        now: new Date(seeded.memory.decayFloorAt.getTime() - 1000),
        limit: 5,
        clock: "either",
        nowSeq: BIG,
        usesSubjectActivityCounters: true,
      });
    });
  });

  it("aggregateScope: スコープ内でない行（archived）では評価しない", async () => {
    await both("ok", async (s) => {
      const seeded = await seed(s, 5000);
      await s.mem.archiveDecayed(ctx, { now: FAR_FUTURE, limit: 5, clock: "wall" });
      return aggregate(true)(s, seeded);
    });
  });

  it("VectorStore.search: ほかの絞りで落ちる行では評価しない", async () => {
    await both("ok", async (s) =>
      search(true, () => ({ attributes: { nope: "x" } }))(s, await seed(s, 5000)),
    );
  });
});

describe("壁時計と活動時計の2軸: 式の左で決まれば、右は評価されない", () => {
  // aggregateScope の既定（両方の軸が生きていなければ「沈んだ」）: `(NOT wall OR NOT activity)`。
  // 壁時計が生きている → 左が偽で右を評価する。沈んでいる → 左が真で右を評価しない。
  it.each([
    [true, "bigint"],
    [false, "ok"],
  ] as const)("aggregateScope 既定: 壁時計が生きている=%s → %s", async (alive, expected) => {
    await both(expected, async (s) => {
      const seeded = await seed(s, 5000);
      return aggregate(true, (m) => ({ decayFloorAtAfter: ageOf(m, alive) }))(s, seeded);
    });
  });

  // `decayFloorAnyAxis`（`(NOT wall AND NOT activity)`）: 壁時計が生きている → 左が偽で右を評価しない。
  it.each([
    [true, "ok"],
    [false, "bigint"],
  ] as const)("aggregateScope anyAxis: 壁時計が生きている=%s → %s", async (alive, expected) => {
    await both(expected, async (s) => {
      const seeded = await seed(s, 5000);
      return aggregate(true, (m) => ({
        decayFloorAtAfter: ageOf(m, alive),
        decayFloorAnyAxis: true,
      }))(s, seeded);
    });
  });

  // search の既定: 壁時計と活動時計は別々の条件（AND）。壁時計で落ちる行は、活動時計の式まで行かない。
  it.each([
    [true, "bigint"],
    [false, "ok"],
  ] as const)("search 既定: 壁時計が生きている=%s → %s", async (alive, expected) => {
    await both(expected, async (s) => {
      const seeded = await seed(s, 5000);
      return search(true, (m) => ({ decayFloorAtAfter: ageOf(m, alive) }))(s, seeded);
    });
  });

  // search の anyAxis: `(wall OR activity)`。壁時計が生きている → 右を評価しない。
  it.each([
    [true, "ok"],
    [false, "bigint"],
  ] as const)("search anyAxis: 壁時計が生きている=%s → %s", async (alive, expected) => {
    await both(expected, async (s) => {
      const seeded = await seed(s, 5000);
      return search(true, (m) => ({
        decayFloorAtAfter: ageOf(m, alive),
        decayFloorAnyAxis: true,
      }))(s, seeded);
    });
  });
});

describe("nowSeq（decayFloorSeqAfter）そのものが bigint に収まらないなら、行が無くても断る", () => {
  it.each([
    ["archiveDecayed clock: activity", (n: number): Call => archive("activity", false, n)],
    ["archiveDecayed clock: either", (n: number): Call => archive("either", false, n)],
    [
      "aggregateScope",
      (n: number): Call =>
        (s) =>
          s.mem.aggregateScope(ctx, { decayFloorSeqAfter: n }),
    ],
    [
      "VectorStore.search",
      (n: number): Call =>
        (s) =>
          s.vec.search(ctx, SPACE, [1, 0, 0], {
            limit: 3,
            filter: { tenantId: ctx.tenantId, decayFloorSeqAfter: n },
          }),
    ],
  ] as const)("%s", async (_, make) => {
    await both("bigint", (s) => make(2 ** 63)(s, undefined as never));
    await both("ok", (s) => make(BIG)(s, undefined as never));
  });
});
