import { describe, expect, it } from "vitest";
import type { Ctx, Memory } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/** 境界は、ドライバが `nowSeq` を文字にした値（`String(2**63 - 1024)` は `"9223372036854775000"`）で決まる: S_x = 807 までは通り、808 で 2^63 以上になる。 */

const ctx: Ctx = { tenantId: "seq-sum-overflow" };
const SPACE = { provider: "p", model: "m", dimensions: 3 };
const BIG = 2 ** 63 - 1024;
const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");
const OVERFLOW = /must fit in a Postgres bigint/;

async function setup(
  counter: number,
  extra: { subjectId?: string | null; decayFloorSeq?: number | undefined } = {},
) {
  const mem = new InMemoryMemoryStore();
  const vec = new InMemoryVectorStore(mem);
  mem.subjectActivitySeq.set(ctx.tenantId, new Map([["s", counter]]));
  const memory = await mem.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      subjectId: extra.subjectId === undefined ? "s" : extra.subjectId,
      halfLifeRecalls: 100,
      decayBaseSeq: 0,
      ...("decayFloorSeq" in extra
        ? extra.decayFloorSeq === undefined
          ? {}
          : { decayFloorSeq: extra.decayFloorSeq }
        : { decayFloorSeq: 5 }),
    }),
  );
  await vec.upsert(ctx, SPACE, memory.id, [1, 0, 0]);
  return { mem, vec, memory };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const wall = (m: Memory, alive: boolean) =>
  new Date(m.decayFloorAt.getTime() + (alive ? -1000 : 1000));

const archive =
  (clock: "activity" | "either" | "wall", counters: boolean, nowSeq = BIG) =>
  (s: Setup) =>
    s.mem.archiveDecayed(ctx, {
      now: FAR_FUTURE,
      limit: 5,
      clock,
      nowSeq,
      usesSubjectActivityCounters: counters,
    });
const aggregate =
  (counters: boolean, extra: (m: Memory) => object = () => ({})) =>
  (s: Setup) =>
    s.mem.aggregateScope(ctx, {
      decayFloorSeqAfter: BIG,
      decayFloorSeqUsesSubjectCounters: counters,
      ...extra(s.memory),
    });
const search =
  (counters: boolean, extra: (m: Memory) => object = () => ({})) =>
  (s: Setup) =>
    s.vec.search(ctx, SPACE, [1, 0, 0], {
      limit: 3,
      filter: {
        tenantId: ctx.tenantId,
        decayFloorSeqAfter: BIG,
        decayFloorSeqUsesSubjectCounters: counters,
        ...extra(s.memory),
      },
    });

const seqOnly: Array<[string, (counters: boolean) => (s: Setup) => Promise<unknown>]> = [
  ["archiveDecayed clock: activity", (c) => archive("activity", c)],
  ["archiveDecayed clock: either（壁時計は沈んでいる）", (c) => archive("either", c)],
  ["aggregateScope", (c) => aggregate(c)],
  ["VectorStore.search", (c) => search(c)],
];

describe.each(seqOnly)("%s: nowSeq + S_x が bigint を溢れるなら断る", (_, call) => {
  it.each([808, 5000])("S_x = %i: 例外", async (counter) => {
    await expect(call(true)(await setup(counter))).rejects.toThrow(OVERFLOW);
  });

  it("S_x = 807（溢れない境界）・0 は通る", async () => {
    await expect(call(true)(await setup(807))).resolves.toBeDefined();
    await expect(call(true)(await setup(0))).resolves.toBeDefined();
  });
  it("usesSubjectCounters が false なら、S_x がいくつでも通る", async () => {
    await expect(call(false)(await setup(5000))).resolves.toBeDefined();
  });
  it("subject を持たない記憶は S_x を引かないので通る", async () => {
    await expect(call(true)(await setup(5000, { subjectId: null }))).resolves.toBeDefined();
  });
  it("decay_floor_seq が NULL の行は式が評価されないので通る", async () => {
    await expect(
      call(true)(await setup(5000, { decayFloorSeq: undefined })),
    ).resolves.toBeDefined();
  });
});

describe("式が評価される行が無ければ、溢れても通る", () => {
  it("archiveDecayed: 壁時計の clock は nowSeq を見ない。archived の行は対象の絞りで落ちる", async () => {
    await expect(archive("wall", true)(await setup(5000))).resolves.toBeDefined();
    const s = await setup(5000);
    await s.mem.archiveDecayed(ctx, { now: FAR_FUTURE, limit: 5, clock: "wall" });
    await expect(archive("activity", true)(s)).resolves.toBeDefined();
  });

  it("archiveDecayed clock: either は、壁時計が沈んでいない行で活動時計の式を評価しない", async () => {
    const s = await setup(5000);
    await expect(
      s.mem.archiveDecayed(ctx, {
        now: new Date(s.memory.decayFloorAt.getTime() - 1000),
        limit: 5,
        clock: "either",
        nowSeq: BIG,
        usesSubjectActivityCounters: true,
      }),
    ).resolves.toBeDefined();
  });

  it("aggregateScope: スコープ内でない行（archived）では評価しない", async () => {
    const s = await setup(5000);
    await s.mem.archiveDecayed(ctx, { now: FAR_FUTURE, limit: 5, clock: "wall" });
    await expect(aggregate(true)(s)).resolves.toBeDefined();
  });

  it("VectorStore.search: ほかの絞りで落ちる行では評価しない", async () => {
    await expect(
      search(true, () => ({ attributes: { nope: "x" } }))(await setup(5000)),
    ).resolves.toBeDefined();
  });

  it("VectorStore.search: ほかの絞りを通る行は、活動時計の条件で落ちる行でも評価される", async () => {
    // 活動時計の条件では落ちる行（decay_floor_seq 5 が「いま」より小さい）でも、式が先に評価される。
    await expect(search(true)(await setup(5000))).rejects.toThrow(OVERFLOW);
  });
});

describe("壁時計と活動時計の2軸: 式の左（壁時計）で決まれば、右は評価されない", () => {
  it.each([
    [true, true],
    [false, false],
  ])("aggregateScope 既定: 壁時計が生きている=%s → 断る=%s", async (alive, throws) => {
    const s = await setup(5000);
    const run = aggregate(true, (m) => ({ decayFloorAtAfter: wall(m, alive) }))(s);
    await (throws ? expect(run).rejects.toThrow(OVERFLOW) : expect(run).resolves.toBeDefined());
  });
  it.each([
    [true, false],
    [false, true],
  ])("aggregateScope anyAxis: 壁時計が生きている=%s → 断る=%s", async (alive, throws) => {
    const s = await setup(5000);
    const run = aggregate(true, (m) => ({
      decayFloorAtAfter: wall(m, alive),
      decayFloorAnyAxis: true,
    }))(s);
    await (throws ? expect(run).rejects.toThrow(OVERFLOW) : expect(run).resolves.toBeDefined());
  });
  it.each([
    [true, true],
    [false, false],
  ])("search 既定: 壁時計が生きている=%s → 断る=%s", async (alive, throws) => {
    const s = await setup(5000);
    const run = search(true, (m) => ({ decayFloorAtAfter: wall(m, alive) }))(s);
    await (throws ? expect(run).rejects.toThrow(OVERFLOW) : expect(run).resolves.toBeDefined());
  });
  it.each([
    [true, false],
    [false, true],
  ])("search anyAxis: 壁時計が生きている=%s → 断る=%s", async (alive, throws) => {
    const s = await setup(5000);
    const run = search(true, (m) => ({
      decayFloorAtAfter: wall(m, alive),
      decayFloorAnyAxis: true,
    }))(s);
    await (throws ? expect(run).rejects.toThrow(OVERFLOW) : expect(run).resolves.toBeDefined());
  });
});

describe("VectorStore.search: provenance の除外・期間の絞りで落ちる行では、S_x の式を評価しない", () => {
  it.each([
    ["excludeProvenanceKinds", () => ({ excludeProvenanceKinds: ["imported"] })],
    ["occurredAfter", (m: Memory) => ({ occurredAfter: new Date(m.recordedAt.getTime() + 1) })],
    ["occurredBefore", (m: Memory) => ({ occurredBefore: new Date(m.recordedAt.getTime() - 1) })],
  ] as const)("%s", async (_, extra) => {
    const s = await setup(5000);
    expect(await search(true, extra)(s)).toEqual([]);
  });
});

describe("nowSeq（decayFloorSeqAfter）そのものが bigint に収まらないなら、行が無くても断る", () => {
  const empty = async () => {
    const mem = new InMemoryMemoryStore();
    return { mem, vec: new InMemoryVectorStore(mem), memory: undefined as never } as Setup;
  };
  it("archiveDecayed clock: activity・either。壁時計の clock は nowSeq を見ないので通る", async () => {
    for (const clock of ["activity", "either"] as const) {
      await expect(archive(clock, false, 2 ** 63)(await empty())).rejects.toThrow(OVERFLOW);
      await expect(archive(clock, false, BIG)(await empty())).resolves.toBeDefined();
    }
    await expect(archive("wall", false, 2 ** 63)(await empty())).resolves.toBeDefined();
  });
  it("aggregateScope・VectorStore.search", async () => {
    const s = await empty();
    await expect(s.mem.aggregateScope(ctx, { decayFloorSeqAfter: 2 ** 63 })).rejects.toThrow(
      OVERFLOW,
    );
    await expect(s.mem.aggregateScope(ctx, { decayFloorSeqAfter: BIG })).resolves.toBeDefined();
    const filter = (n: number) => ({ tenantId: ctx.tenantId, decayFloorSeqAfter: n });
    await expect(
      s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: filter(2 ** 63) }),
    ).rejects.toThrow(OVERFLOW);
    await expect(
      s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: filter(BIG) }),
    ).resolves.toBeDefined();
  });
  // 下限側。-2^63 ちょうどは Postgres が断り fixture が通す差が残っている（ドライバが `"-9223372036854776000"` にする）ので、ここでは見ない。
  it("下限の外（-2^63 より下の最初の double と -2^64）も断り、-2^63 の1つ上の double は通す", async () => {
    const s = await empty();
    const filter = (n: number) => ({ tenantId: ctx.tenantId, decayFloorSeqAfter: n });
    for (const n of [-(2 ** 63) - 2048, -(2 ** 64)]) {
      for (const clock of ["activity", "either"] as const) {
        await expect(archive(clock, false, n)(await empty())).rejects.toThrow(OVERFLOW);
      }
      await expect(s.mem.aggregateScope(ctx, { decayFloorSeqAfter: n })).rejects.toThrow(OVERFLOW);
      await expect(
        s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: filter(n) }),
      ).rejects.toThrow(OVERFLOW);
    }
    const above = -(2 ** 63) + 1024;
    await expect(archive("activity", false, above)(await empty())).resolves.toBeDefined();
    await expect(s.mem.aggregateScope(ctx, { decayFloorSeqAfter: above })).resolves.toBeDefined();
    await expect(
      s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: filter(above) }),
    ).resolves.toBeDefined();
  });
});
