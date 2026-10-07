import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryId, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.reinforce`（と `reinforceMany`・`recordUsageAndReinforce`）は、減衰の起点を巻き戻さない。
 * 規則は1つ: **`at` が起点（`lastReinforcedAt ?? recordedAt`）より新しいときだけ書く。そうでなければ、活動時計の欄も含めて何も書かない。**
 */

const ctx: Ctx = { tenantId: "reinforce-origin-no-rewind" };
const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const NOW_SEQ = 50;

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

async function unreinforced(store: MemoryStore, hash: string): Promise<Memory> {
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: hash,
      recordedAt: RECORDED_AT,
      halfLifeHours: 720,
      strength: 1,
      halfLifeRecalls: 100,
      decayBaseSeq: 0,
      decayFloorSeq: 100,
    }),
  );
}

/** 起点・床・活動時計の欄だけを並べる（比べやすくするため）。 */
function clocks(m: Memory | null | undefined) {
  return {
    lastReinforcedAt: m?.lastReinforcedAt?.toISOString() ?? null,
    decayFloorAt: m?.decayFloorAt?.toISOString() ?? null,
    decayBaseSeq: m?.decayBaseSeq ?? null,
    decayFloorSeq: m?.decayFloorSeq ?? null,
  };
}

async function recallFor(store: MemoryStore): Promise<string> {
  return store.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  });
}

type Op = (store: MemoryStore, id: MemoryId, at: Date) => Promise<void>;
const OPS: Array<[string, Op]> = [
  ["reinforce", async (s, id, at) => void (await s.reinforce(ctx, id, at, { nowSeq: NOW_SEQ }))],
  [
    "reinforceMany",
    async (s, id, at) => void (await s.reinforceMany!(ctx, [id], at, { nowSeq: NOW_SEQ })),
  ],
  [
    "recordUsageAndReinforce",
    async (s, id, at) =>
      void (await s.recordUsageAndReinforce!(ctx, await recallFor(s), [id], at, {
        nowSeq: NOW_SEQ,
      })),
  ],
];

describe.each(KITS)("reinforce は減衰の起点を巻き戻さない（%s）", (_name, build) => {
  describe.each(OPS)("%s", (opName, op) => {
    it("未強化の記憶に、作成時刻より前の at を渡すと、活動時計の欄も含めて何も書かない", async () => {
      const store = await build();
      const m = await unreinforced(store, `${opName}-before`);
      await op(store, m.id, new Date(RECORDED_AT.getTime() - 10 * DAY));
      expect(clocks(await store.get(ctx, m.id))).toEqual(clocks(m));
    });

    it("作成時刻ちょうどの at も書かない（既存の lastReinforcedAt の比較と同じく、より新しいときだけ書く）", async () => {
      const store = await build();
      const m = await unreinforced(store, `${opName}-equal`);
      await op(store, m.id, new Date(RECORDED_AT.getTime()));
      expect(clocks(await store.get(ctx, m.id))).toEqual(clocks(m));
    });

    it("作成時刻より新しい at なら書く（陽性対照）", async () => {
      const store = await build();
      const m = await unreinforced(store, `${opName}-after`);
      const at = new Date(RECORDED_AT.getTime() + 1);
      await op(store, m.id, at);
      const after = clocks(await store.get(ctx, m.id));
      expect(after.lastReinforcedAt).toBe(at.toISOString());
      expect(after.decayBaseSeq).toBe(NOW_SEQ);
    });
  });

  it("強化済みの記憶に、lastReinforcedAt ちょうどの at を渡しても何も書かない（既存の規則。同じ1つの規則であることの対照）", async () => {
    const store = await build();
    const m = await unreinforced(store, "reinforced-equal");
    const first = new Date(RECORDED_AT.getTime() + DAY);
    const reinforced = await store.reinforce(ctx, m.id, first);
    await store.reinforce(ctx, m.id, new Date(first.getTime()), { nowSeq: NOW_SEQ });
    expect(clocks(await store.get(ctx, m.id))).toEqual(clocks(reinforced));
  });
});
