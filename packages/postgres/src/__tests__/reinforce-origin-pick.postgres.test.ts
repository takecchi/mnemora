import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryId, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.reinforce`（と `reinforceMany`・`recordUsageAndReinforce`）が書くかどうかを決める起点は、**`lastReinforcedAt ?? recordedAt`** である。
 * `reinforce-origin-no-rewind.postgres.test.ts` は、起点が作成時刻（`recordedAt`）より後ろにある場面と、未強化の記憶で `recordedAt` が過去にある場面を縛る。
 * ここは、その歯が持たない2つの向きを縛る。
 *
 * - **起点が `lastReinforcedAt` であること**: `lastReinforcedAt` が `recordedAt` より前にある行（既に作成時刻より前の起点を持つ記憶）では、
 *   `lastReinforcedAt` と `recordedAt` の間の `at`、`recordedAt` ちょうどの `at` が書かれる。起点を `GREATEST(lastReinforcedAt, recordedAt)` で取ると、この行だけ強化が落ちる。
 * - **未強化の起点が `recordedAt` であって、行ができた時刻（`createdAt`）ではないこと**: 呼び手が `recordedAt` を未来で渡す取り込みでは、`createdAt` より後ろに `recordedAt` が来る。
 *   `createdAt < at < recordedAt` の `at` は書かれない。起点を `LEAST(recordedAt, createdAt)` で取ると書いてしまう。
 *
 * 3つの口（`reinforce`・`reinforceMany`・`recordUsageAndReinforce`）に、Postgres と testkit の InMemory で当てる。
 */

const ctx: Ctx = { tenantId: "reinforce-origin-pick" };
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

describe.each(KITS)("reinforce が書くかどうかを決める起点（%s）", (_name, build) => {
  describe.each(OPS)("%s", (opName, op) => {
    // lastReinforcedAt（2026-01-01）が recordedAt（2026-03-01）より前にある行。
    const RECORDED_AT = new Date("2026-03-01T00:00:00.000Z");
    const LAST_REINFORCED_AT = new Date("2026-01-01T00:00:00.000Z");

    async function withEarlierLastReinforced(store: MemoryStore, hash: string): Promise<Memory> {
      return store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: hash,
          recordedAt: RECORDED_AT,
          lastReinforcedAt: LAST_REINFORCED_AT,
          halfLifeHours: 720,
          strength: 1,
          halfLifeRecalls: 100,
          decayBaseSeq: 0,
          decayFloorSeq: 100,
        }),
      );
    }

    it("lastReinforcedAt が recordedAt より前の行は、その2つの間の at で書く（起点は lastReinforcedAt）", async () => {
      const store = await build();
      const m = await withEarlierLastReinforced(store, `${opName}-between`);
      expect(m.lastReinforcedAt?.toISOString()).toBe(LAST_REINFORCED_AT.toISOString());
      const at = new Date(LAST_REINFORCED_AT.getTime() + 10 * DAY);
      expect(at.getTime()).toBeLessThan(RECORDED_AT.getTime());
      await op(store, m.id, at);
      const after = clocks(await store.get(ctx, m.id));
      expect(after.lastReinforcedAt).toBe(at.toISOString());
      expect(after.decayBaseSeq).toBe(NOW_SEQ);
    });

    it("同じ行に recordedAt ちょうどの at でも書く", async () => {
      const store = await build();
      const m = await withEarlierLastReinforced(store, `${opName}-at-recorded`);
      await op(store, m.id, new Date(RECORDED_AT.getTime()));
      const after = clocks(await store.get(ctx, m.id));
      expect(after.lastReinforcedAt).toBe(RECORDED_AT.toISOString());
      expect(after.decayBaseSeq).toBe(NOW_SEQ);
    });

    it("陰性対照: 同じ行でも lastReinforcedAt ちょうど・それより前の at は書かない", async () => {
      const store = await build();
      const m = await withEarlierLastReinforced(store, `${opName}-not-after`);
      await op(store, m.id, new Date(LAST_REINFORCED_AT.getTime()));
      await op(store, m.id, new Date(LAST_REINFORCED_AT.getTime() - DAY));
      expect(clocks(await store.get(ctx, m.id))).toEqual(clocks(m));
    });

    it("未強化で recordedAt が行の作成時刻より未来の記憶は、createdAt と recordedAt の間の at では書かない（起点は recordedAt）", async () => {
      const store = await build();
      const futureRecordedAt = new Date("2100-01-01T00:00:00.000Z");
      const m = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `${opName}-future-recorded`,
          recordedAt: futureRecordedAt,
          halfLifeHours: 720,
          strength: 1,
          halfLifeRecalls: 100,
          decayBaseSeq: 0,
          decayFloorSeq: 100,
        }),
      );
      // 行ができた時刻は、実行している今（2100 年より前）である。
      expect(m.createdAt.getTime()).toBeLessThan(futureRecordedAt.getTime() - 365 * DAY);
      const at = new Date(futureRecordedAt.getTime() - 30 * DAY);
      expect(at.getTime()).toBeGreaterThan(m.createdAt.getTime());
      await op(store, m.id, at);
      expect(clocks(await store.get(ctx, m.id))).toEqual(clocks(m));
    });

    it("陽性対照: 同じ記憶に recordedAt より新しい at なら書く", async () => {
      const store = await build();
      const futureRecordedAt = new Date("2100-01-01T00:00:00.000Z");
      const m = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `${opName}-future-recorded-after`,
          recordedAt: futureRecordedAt,
          halfLifeHours: 720,
          strength: 1,
          halfLifeRecalls: 100,
          decayBaseSeq: 0,
          decayFloorSeq: 100,
        }),
      );
      const at = new Date(futureRecordedAt.getTime() + 1);
      await op(store, m.id, at);
      expect(clocks(await store.get(ctx, m.id)).lastReinforcedAt).toBe(at.toISOString());
    });
  });
});
