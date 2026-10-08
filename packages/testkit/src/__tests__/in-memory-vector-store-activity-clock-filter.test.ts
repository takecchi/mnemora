import { describe, expect, it } from "vitest";
import type { Ctx, VectorFilter } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const TENANT = "in-memory-vector-activity-clock-filter";
const ctx: Ctx = { tenantId: TENANT };
const SPACE = { provider: "p", model: "m", dimensions: 3 };

async function setup(opts: { subjectId: string | null; decayFloorSeq: number; sx?: number }) {
  const memoryStore = new InMemoryMemoryStore();
  const vectorStore = new InMemoryVectorStore(memoryStore);
  if (opts.sx !== undefined) {
    memoryStore.subjectActivitySeq.set(TENANT, new Map([["s", opts.sx]]));
  }
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: TENANT,
      subjectId: opts.subjectId,
      halfLifeRecalls: 100,
      decayBaseSeq: 0,
      decayFloorSeq: opts.decayFloorSeq,
    }),
  );
  await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0, 0]);
  const search = async (filter: Omit<VectorFilter, "tenantId">) =>
    (
      await vectorStore.search(ctx, SPACE, [1, 0, 0], {
        limit: 5,
        filter: { tenantId: TENANT, ...filter },
      })
    ).map((h) => h.memoryId);
  return { memory, search };
}

describe("InMemoryVectorStore.search: decayFloorAnyAxis は、2つの境界が両方渡されたときだけ OR で結ぶ（片方だけなら無視する）", () => {
  it("活動時計の境界だけ: 活動時計で沈んだ記憶は、anyAxis: true でも返らない", async () => {
    const { memory, search } = await setup({ subjectId: null, decayFloorSeq: 5 });
    expect(await search({ decayFloorSeqAfter: 4, decayFloorAnyAxis: true })).toEqual([memory.id]);
    expect(await search({ decayFloorSeqAfter: 5, decayFloorAnyAxis: true })).toEqual([]);
  });

  it("壁時計の境界だけ: 壁時計で沈んだ記憶は、anyAxis: true でも返らない", async () => {
    const { memory, search } = await setup({ subjectId: null, decayFloorSeq: 5 });
    const before = new Date(memory.decayFloorAt.getTime() - 1);
    expect(await search({ decayFloorAtAfter: before, decayFloorAnyAxis: true })).toEqual([
      memory.id,
    ]);
    expect(
      await search({ decayFloorAtAfter: memory.decayFloorAt, decayFloorAnyAxis: true }),
    ).toEqual([]);
  });
});

describe("InMemoryVectorStore.search: decayFloorSeqUsesSubjectCounters: true は、境界にその行の subject の S_x を足して比べる", () => {
  it("decay_floor_seq 15・境界 10・S_x 10: 足せば 20 で沈み、足さなければ（false）通る", async () => {
    const { memory, search } = await setup({ subjectId: "s", decayFloorSeq: 15, sx: 10 });
    expect(
      await search({ decayFloorSeqAfter: 10, decayFloorSeqUsesSubjectCounters: true }),
    ).toEqual([]);
    expect(
      await search({ decayFloorSeqAfter: 10, decayFloorSeqUsesSubjectCounters: false }),
    ).toEqual([memory.id]);
  });

  it("ちょうど: decay_floor_seq 20 は境界 10 + S_x 10 と同じなので沈み、21 は通る", async () => {
    for (const [seq, expected] of [
      [20, false],
      [21, true],
    ] as const) {
      const { memory, search } = await setup({ subjectId: "s", decayFloorSeq: seq, sx: 10 });
      expect(
        await search({ decayFloorSeqAfter: 10, decayFloorSeqUsesSubjectCounters: true }),
      ).toEqual(expected ? [memory.id] : []);
    }
  });

  it("subject を持たない行は、境界だけと比べる（S_x を足さない）", async () => {
    const { memory, search } = await setup({ subjectId: null, decayFloorSeq: 15, sx: 10 });
    expect(
      await search({ decayFloorSeqAfter: 10, decayFloorSeqUsesSubjectCounters: true }),
    ).toEqual([memory.id]);
  });
});
