import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, Memory, MemoryStore, NewMemoryEvent, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { sql } from "drizzle-orm";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0519（ADR 0501 負債3）: purge 済みの記憶に `reinforce`・`reinforceMany`・`recordUsageAndReinforce` を
 * 流したときの戻り値・例外・状態を、testkit の InMemory と Postgres に同じ入力で流して比べる。
 * 約束（`MemoryStore.reinforce` の TSDoc）は「弾く経路は無い。`lastReinforcedAt`・`decayFloorAt` が書き換わり、
 * `status`・`purgedAt`・`content`・`digest` は動かず、`memory_events` も書かない」。
 * 起点（`lastReinforcedAt ?? recordedAt`）以前の `at` は no-op（Issue #1093）で、purge 済みでも同じ。
 */

const A: Ctx = { tenantId: "reinforce-purged-a" };
const HOUR = 3_600_000;

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  store: MemoryStore;
  eventStore: EventStore;
  eventCount(): Promise<number>;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return {
    store: new PostgresMemoryStore(db),
    eventStore: new PostgresEventStore(db),
    eventCount: async () =>
      Number(
        (await db.execute(sql`SELECT count(*)::int AS c FROM memory_events`)).rows[0]!.c as number,
      ),
  };
}

async function inMemoryKit(): Promise<Kit> {
  const store = new InMemoryMemoryStore();
  return {
    store,
    eventStore: new InMemoryEventStore(store, store.events),
    eventCount: async () => store.events.length,
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
  ["Postgres", postgresKit],
];

let seq = 0;
const ev = (memoryId: string, kind: NewMemoryEvent["kind"]): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId,
  kind,
  actor: { type: "system" },
  meta: { probe: true },
});

async function purged(kit: Kit): Promise<Memory> {
  seq += 1;
  const m = await kit.store.createMemory(
    A,
    buildNewMemoryFixture({
      tenantId: A.tenantId,
      content: `body-${seq}`,
      digest: `digest-${seq}`,
      contentHash: `hash-${seq}`,
    }),
  );
  await kit.store.updateStatus(A, m.id, "forgotten");
  const { memory } = await kit.store.purgeMemory!(
    A,
    m.id,
    { content: "[purged]", digest: "[purged]" },
    ev(m.id, "purged"),
  );
  return memory;
}

/** 比べる欄だけの写し（`updatedAt` は実時計なので入れない）。 */
const shape = (m: Memory) => ({
  status: m.status,
  purgedAt: m.purgedAt?.getTime() ?? null,
  content: m.content,
  digest: m.digest,
  lastReinforcedAt: m.lastReinforcedAt?.getTime() ?? null,
  decayFloorAt: m.decayFloorAt.getTime(),
});

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: purge 済みの記憶への reinforce（ADR 0519）`, () => {
    it("reinforce は例外を投げず、lastReinforcedAt と decayFloorAt を書き換える。status・purgedAt・content・digest・events は動かない", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const events = await kit.eventCount();
      const at = new Date(Date.now() + 10 * HOUR);
      const returned = await kit.store.reinforce(A, t.id, at);
      expect(returned.lastReinforcedAt?.getTime()).toBe(at.getTime());
      expect(returned.decayFloorAt.getTime()).toBeGreaterThan(t.decayFloorAt.getTime());
      expect(returned.status).toBe("forgotten");
      expect(returned.purgedAt?.getTime()).toBe(t.purgedAt?.getTime());
      expect(returned.content).toBe("[purged]");
      expect(returned.digest).toBe("[purged]");
      expect(shape((await kit.store.get(A, t.id))!)).toEqual(shape(returned));
      expect(await kit.eventCount()).toBe(events);
    });

    it("起点以前の at は no-op（戻り値は現在の行、何も書かない）", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const first = await kit.store.reinforce(A, t.id, new Date(Date.now() + 10 * HOUR));
      const older = await kit.store.reinforce(A, t.id, new Date(Date.now() + 5 * HOUR));
      expect(shape(older)).toEqual(shape(first));
      expect(shape((await kit.store.get(A, t.id))!)).toEqual(shape(first));
    });

    it("reinforceMany は purged を含んでも例外を投げず、全件を書き換える", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const at = new Date(Date.now() + 10 * HOUR);
      const out = await kit.store.reinforceMany!(A, [t.id], at);
      expect(out.map((m) => m.lastReinforcedAt?.getTime())).toEqual([at.getTime()]);
      expect(shape((await kit.store.get(A, t.id))!)).toEqual(shape(out[0]!));
    });

    it("recordUsageAndReinforce は purged の使用の行を挿入し、lastReinforcedAt を書き換える", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const recallId = await kit.store.createRecall(A, {
        tenantId: A.tenantId,
        query: { text: "q" },
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
      const events = await kit.eventCount();
      const at = new Date(Date.now() + 10 * HOUR);
      const r = await kit.store.recordUsageAndReinforce!(A, recallId, [t.id], at);
      expect(r.insertedMemoryIds).toEqual([t.id]);
      const after = (await kit.store.get(A, t.id))!;
      expect(after.lastReinforcedAt?.getTime()).toBe(at.getTime());
      expect(after.status).toBe("forgotten");
      expect(after.purgedAt?.getTime()).toBe(t.purgedAt?.getTime());
      expect(after.content).toBe("[purged]");
      expect(await kit.eventCount()).toBe(events);
    });
  });
}
