import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 行に日時を**書く**口が、`timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）より前で、2実装（`@mnemora/postgres` と
 * `@mnemora/testkit/fixtures`）とも断る。**同じ入力を2実装へ流して**縛る——Postgres の側は実測の常設で、変われば落ちる。
 * 見るのは、断ったか・何で断ったか（`range`＝下限、`other`＝別の理由）だけ。例外の文面・クラスは2実装で違う。
 */
const ctx: Ctx = { tenantId: "written-floor-align" };
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const AFTER = new Date(FLOOR_MS + 1);
const FAR = new Date(Date.UTC(-9000, 0, 1));
const T = ctx.tenantId;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function classify(run: () => Promise<unknown>): Promise<string> {
  try {
    const r = (await run()) as { dropped?: unknown[]; written?: unknown[] } | undefined;
    // 一部だけ書けなかった（dropped が空でない）ときは、何件書けたかも見る。
    return r && Array.isArray(r.dropped) && r.dropped.length > 0
      ? `ok dropped=${r.dropped.length} written=${r.written?.length}`
      : "ok";
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const message = `${err.message} ${err.cause?.message ?? ""}`;
    if (err.cause?.code === "22008" || /must not be earlier than 4714-11-24 BC/.test(message))
      return "range";
    return `other: ${message.split("\n")[0]!.slice(0, 90)}`;
  }
}

async function build(impl: "postgres" | "fixture") {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return {
      mem: new PostgresMemoryStore(db),
      ev: new PostgresEventStore(db),
      ob: new PostgresOutboxStore(db),
    };
  }
  const mem = new InMemoryMemoryStore();
  return {
    mem,
    ev: new InMemoryEventStore(mem, mem.events),
    ob: new InMemoryOutboxStore(mem.outboxJobs),
  };
}
type S = Awaited<ReturnType<typeof build>>;
type Case = [string, (d: Date) => (s: S) => Promise<unknown>];

const mk = (s: S, over: object = {}) =>
  s.mem.createMemory(ctx, buildNewMemoryFixture({ tenantId: T, ...over }));
const ev = (memoryId: string | null, d: Date, kind: string = "updated") =>
  buildNewMemoryEventFixture({
    tenantId: T,
    memoryId: memoryId as never,
    kind: kind as never,
    at: d,
  });

const memFields = [
  "occurredAt",
  "recordedAt",
  "lastReinforcedAt",
  "validFrom",
  "validUntil",
  "decayFloorAt",
] as const;
const obsFields = ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const;

const cases: Case[] = [
  ...memFields.flatMap((k): Case[] => [
    [`createMemory ${k}`, (d) => (s) => mk(s, { [k]: d })],
    [
      `createMemoryWithOutbox ${k}`,
      (d) => (s) =>
        s.mem.createMemoryWithOutbox(ctx, buildNewMemoryFixture({ tenantId: T, [k]: d }), []),
    ],
    [
      `createMemoriesWithOutboxAndEvents ${k}`,
      (d) => (s) =>
        s.mem.createMemoriesWithOutboxAndEvents!(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: T, [k]: d }), jobKinds: [] }],
          (m) => ev(m.id, new Date("2030-01-01T00:00:00Z"), "created"),
        ),
    ],
    [
      `supersedeWithNewMemories ${k}`,
      (d) => (s) =>
        s.mem.supersedeWithNewMemories!(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: T, [k]: d }), jobKinds: [] }],
          [],
        ),
    ],
  ]),
  ...obsFields.flatMap((k): Case[] => [
    [
      `createObservation ${k}`,
      (d) => (s) =>
        s.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T, [k]: d })),
    ],
    [
      `createObservationWithOutbox ${k}`,
      (d) => (s) =>
        s.mem.createObservationWithOutbox(
          ctx,
          buildNewObservationFixture({ tenantId: T, [k]: d }),
          [],
        ),
    ],
    [
      `createObservation(既存externalId) ${k}`,
      (d) => async (s) => {
        await s.mem.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: T, externalId: "x" }),
        );
        return s.mem.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: T, externalId: "x", [k]: d }),
        );
      },
    ],
  ]),
  [
    "createMemory(冪等の既存行) occurredAt",
    (d) => async (s) => {
      const o = await s.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
      const base = { sourceObservationId: o.id, extractorVersion: "v1" };
      await mk(s, base);
      return mk(s, { ...base, occurredAt: d });
    },
  ],
  [
    "createMemory(冪等の既存行) decayFloorAt",
    (d) => async (s) => {
      const o = await s.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
      const base = { sourceObservationId: o.id, extractorVersion: "v1" };
      await mk(s, base);
      return mk(s, { ...base, decayFloorAt: d });
    },
  ],
  ["reinforce at", (d) => async (s) => s.mem.reinforce(ctx, (await mk(s)).id, d)],
  [
    "reinforce at(古い at: lastReinforcedAt が後)",
    (d) => async (s) => {
      const m = await mk(s);
      await s.mem.reinforce(ctx, m.id, new Date("2030-01-01T00:00:00Z"));
      return s.mem.reinforce(ctx, m.id, d);
    },
  ],
  [
    "reinforce at(対象なし)",
    (d) => async (s) => {
      return s.mem.reinforce(ctx, "00000000-0000-4000-8000-000000000000" as never, d);
    },
  ],
  ["reinforceMany at", (d) => async (s) => s.mem.reinforceMany!(ctx, [(await mk(s)).id], d)],
  ["reinforceMany at(ids空)", (d) => async (s) => s.mem.reinforceMany!(ctx, [], d)],
  [
    "recordUsageAndReinforce at",
    (d) => async (s) => {
      const m = await mk(s);
      const recallId = await s.mem.createRecall(ctx, recallRecord());
      return s.mem.recordUsageAndReinforce!(ctx, recallId, [m.id], d);
    },
  ],
  [
    "recordUsageAndReinforce at(ids空)",
    (d) => async (s) => {
      const recallId = await s.mem.createRecall(ctx, recallRecord());
      return s.mem.recordUsageAndReinforce!(ctx, recallId, [], d);
    },
  ],
  ["createRecall createdAt", (d) => (s) => s.mem.createRecall(ctx, recallRecord(d))],
  ["EventStore.append at", (d) => (s) => s.ev.append(ctx, ev(null, d, "created"))],
  [
    "EventStore.append at(memoryId あり)",
    (d) => async (s) => s.ev.append(ctx, ev((await mk(s)).id, d)),
  ],
  [
    "updateStatusWithEvent event.at",
    (d) => async (s) => {
      const m = await mk(s);
      return s.mem.updateStatusWithEvent(ctx, m.id, "forgotten", {}, ev(m.id, d, "forgotten"));
    },
  ],
  [
    "updateStatusWithEvent event.at(CAS不一致)",
    (d) => async (s) => {
      const m = await mk(s);
      return s.mem.updateStatusWithEvent(
        ctx,
        m.id,
        "forgotten",
        { expectedStatus: "archived" },
        ev(m.id, d, "forgotten"),
      );
    },
  ],
  [
    "supersedeWithNewMemories supersede[].event.at",
    (d) => async (s) => {
      const old = await mk(s, { contentHash: "old" });
      return s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(old.id, d, "superseded") }],
      );
    },
  ],
  [
    "supersedeWithNewMemories supersede[].event.at(CAS不一致)",
    (d) => async (s) => {
      const old = await mk(s, { contentHash: "old" });
      return s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "archived",
            event: ev(old.id, d, "superseded"),
          },
        ],
      );
    },
  ],
  [
    "supersedeWithNewMemories buildCreatedEvent at",
    (d) => (s) =>
      s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T }), jobKinds: [] }],
        [],
        { buildCreatedEvent: (m) => ev(m.id, d, "created") },
      ),
  ],
  [
    "createMemoriesWithOutboxAndEvents buildCreatedEvent at",
    (d) => (s) =>
      s.mem.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T }), jobKinds: [] }],
        (m) => ev(m.id, d, "created"),
      ),
  ],
  [
    "markContestedPair event.at",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      return s.mem.markContestedPair!(
        ctx,
        { id: a.id, event: ev(a.id, d, "updated") },
        { id: b.id, event: ev(b.id, new Date("2030-01-01T00:00:00Z"), "updated") },
      );
    },
  ],
  [
    "markContestedPair second.event.at",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      return s.mem.markContestedPair!(
        ctx,
        { id: a.id, event: ev(a.id, new Date("2030-01-01T00:00:00Z"), "updated") },
        { id: b.id, event: ev(b.id, d, "updated") },
      );
    },
  ],
  [
    "resolveContestedPair event.at",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      const ok = new Date("2030-01-01T00:00:00Z");
      await s.mem.markContestedPair!(
        ctx,
        { id: a.id, event: ev(a.id, ok) },
        { id: b.id, event: ev(b.id, ok) },
      );
      return s.mem.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: ev(a.id, d) },
        { id: b.id, status: "active", event: ev(b.id, ok) },
      );
    },
  ],
  [
    "markContestedGroup event.at",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      const c = await mk(s, { contentHash: "c" });
      return s.mem.markContestedGroup!(ctx, [
        { id: a.id, event: ev(a.id, d) },
        { id: b.id, event: ev(b.id, new Date("2030-01-01T00:00:00Z")) },
        { id: c.id, event: ev(c.id, new Date("2030-01-01T00:00:00Z")) },
      ]);
    },
  ],
  [
    "restoreSupersededBy event.at(対象あり)",
    (d) => async (s) => {
      const old = await mk(s, { contentHash: "old" });
      const r = await s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            event: ev(old.id, new Date("2030-01-01T00:00:00Z"), "superseded"),
          },
        ],
      );
      return s.mem.restoreSupersededBy!(ctx, r.created[0]!.memory.id, { at: d });
    },
  ],
  [
    "restoreSupersededBy event.at(対象なし)",
    (d) => async (s) => {
      const m = await mk(s);
      return s.mem.restoreSupersededBy!(ctx, m.id, { at: d });
    },
  ],
  [
    "purgeMemory event.at",
    (d) => async (s) => {
      const m = await mk(s);
      await s.mem.updateStatus(ctx, m.id, "forgotten", {});
      return s.mem.purgeMemory!(ctx, m.id, { content: "x", digest: "y" }, ev(m.id, d, "purged"));
    },
  ],
  [
    "purgeMemory event.at(purge できない=active)",
    (d) => async (s) => {
      const m = await mk(s);
      return s.mem.purgeMemory!(ctx, m.id, { content: "x", digest: "y" }, ev(m.id, d, "purged"));
    },
  ],
  [
    "purgeExpiredEventsByRetention now(保持日数 設定済)",
    (d) => async (s) => {
      if (s.mem instanceof InMemoryMemoryStore) {
        s.mem.eventRetentionDays.set(T, 30);
      } else {
        const { db } = await getTestClient();
        await new PostgresTenantSettingsStore(db).setEventRetention(ctx, {
          kind: "days",
          days: 30,
        });
      }
      return s.mem.purgeExpiredEventsByRetention!(ctx, { now: d, limit: 5 });
    },
  ],
  [
    "updateStatusWithEvent(対象なし)",
    (d) => async (s) =>
      s.mem.updateStatusWithEvent(
        ctx,
        "00000000-0000-4000-8000-000000000000" as never,
        "forgotten",
        {},
        ev(null, d, "forgotten"),
      ),
  ],
  [
    "supersede 2対象: 1つ目CAS不一致(早い event)・2つ目OK",
    (d) => async (s) => {
      const o1 = await mk(s, { contentHash: "o1" });
      const o2 = await mk(s, { contentHash: "o2" });
      const ok = new Date("2030-01-01T00:00:00Z");
      return s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [
          {
            id: o1.id,
            supersededByIndex: 0,
            expectedStatus: "archived",
            event: ev(o1.id, d, "superseded"),
          },
          { id: o2.id, supersededByIndex: 0, event: ev(o2.id, ok, "superseded") },
        ],
      );
    },
  ],
  [
    "supersede 2対象: 1つ目OK(早い event)・2つ目CAS不一致",
    (d) => async (s) => {
      const o1 = await mk(s, { contentHash: "o1" });
      const o2 = await mk(s, { contentHash: "o2" });
      const ok = new Date("2030-01-01T00:00:00Z");
      return s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [
          { id: o1.id, supersededByIndex: 0, event: ev(o1.id, d, "superseded") },
          {
            id: o2.id,
            supersededByIndex: 0,
            expectedStatus: "archived",
            event: ev(o2.id, ok, "superseded"),
          },
        ],
      );
    },
  ],
  [
    "supersede news 冪等の既存行 + buildCreatedEvent(早い at)",
    (d) => async (s) => {
      const o = await s.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
      const base = { sourceObservationId: o.id, extractorVersion: "v1" };
      await mk(s, base);
      return s.mem.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, ...base }), jobKinds: [] }],
        [],
        { buildCreatedEvent: (m) => ev(m.id, d, "created") },
      );
    },
  ],
  [
    "createMemoriesWithOutboxAndEvents 冪等の既存行 + buildCreatedEvent(早い at)",
    (d) => async (s) => {
      const o = await s.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
      const base = { sourceObservationId: o.id, extractorVersion: "v1" };
      await mk(s, base);
      return s.mem.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, ...base }), jobKinds: [] }],
        (m) => ev(m.id, d, "created"),
      );
    },
  ],
  [
    "recordUsageAndReinforce 2回目(記録済み)",
    (d) => async (s) => {
      const m = await mk(s);
      const recallId = await s.mem.createRecall(ctx, recallRecord());
      await s.mem.recordUsageAndReinforce!(ctx, recallId, [m.id], new Date("2030-01-01T00:00:00Z"));
      return s.mem.recordUsageAndReinforce!(ctx, recallId, [m.id], d);
    },
  ],
  [
    "reinforceMany 対象なしのid",
    (d) => async (s) =>
      s.mem.reinforceMany!(ctx, ["00000000-0000-4000-8000-000000000000" as never], d),
  ],
  [
    "restoreSupersededBy 対象なしのid",
    (d) => async (s) =>
      s.mem.restoreSupersededBy!(ctx, "00000000-0000-4000-8000-000000000000" as never, { at: d }),
  ],
  ["markContestedGroup 空", () => async (s) => s.mem.markContestedGroup!(ctx, [])],
  ["resolveContestedGroup 空", () => async (s) => s.mem.resolveContestedGroup!(ctx, [])],
  [
    "resolveOrphanedContested(contested でない)",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      return s.mem.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: ev(a.id, d),
      });
    },
  ],
  [
    "resolveContestedPair(contested でない)",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      const ok = new Date("2030-01-01T00:00:00Z");
      return s.mem.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: ev(a.id, d) },
        { id: b.id, status: "active", event: ev(b.id, ok) },
      );
    },
  ],
  [
    "markContestedPair(2件目なし)",
    (d) => async (s) => {
      const a = await mk(s, { contentHash: "a" });
      return s.mem.markContestedPair!(
        ctx,
        { id: a.id, event: ev(a.id, d) },
        { id: "00000000-0000-4000-8000-000000000000" as never, event: ev(null, d) },
      );
    },
  ],
  [
    "createMemoriesWithOutboxAndEvents [早い, OK]",
    (d) => (s) =>
      s.mem.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ tenantId: T, contentHash: "a", occurredAt: d }),
            jobKinds: [],
          },
          { input: buildNewMemoryFixture({ tenantId: T, contentHash: "b" }), jobKinds: [] },
        ],
        (m) => ev(m.id, new Date("2030-01-01T00:00:00Z"), "created"),
      ),
  ],
  [
    "createMemoriesWithOutboxAndEvents [OK, 早い]",
    (d) => (s) =>
      s.mem.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          { input: buildNewMemoryFixture({ tenantId: T, contentHash: "a" }), jobKinds: [] },
          {
            input: buildNewMemoryFixture({ tenantId: T, contentHash: "b", occurredAt: d }),
            jobKinds: [],
          },
        ],
        (m) => ev(m.id, new Date("2030-01-01T00:00:00Z"), "created"),
      ),
  ],
  [
    "createMemoriesWithOutboxAndEvents [OK, InvalidDate]",
    () => (s) =>
      s.mem.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          { input: buildNewMemoryFixture({ tenantId: T, contentHash: "a" }), jobKinds: [] },
          {
            input: buildNewMemoryFixture({
              tenantId: T,
              contentHash: "b",
              occurredAt: new Date(NaN),
            }),
            jobKinds: [],
          },
        ],
        (m) => ev(m.id, new Date("2030-01-01T00:00:00Z"), "created"),
      ),
  ],
  [
    "purgeMemory 対象なし",
    (d) => async (s) =>
      s.mem.purgeMemory!(
        ctx,
        "00000000-0000-4000-8000-000000000000" as never,
        { content: "x", digest: "y" },
        ev(null, d, "purged"),
      ),
  ],
  [
    "resolveContestedGroup event.at",
    (d) => async (s) => {
      const ok = new Date("2030-01-01T00:00:00Z");
      const ms = [
        await mk(s, { contentHash: "a" }),
        await mk(s, { contentHash: "b" }),
        await mk(s, { contentHash: "c" }),
      ];
      await s.mem.markContestedGroup!(
        ctx,
        ms.map((m) => ({ id: m.id, event: ev(m.id, ok) })),
      );
      return s.mem.resolveContestedGroup!(
        ctx,
        ms.map((m, i) => ({
          id: m.id,
          status: "active" as const,
          event: ev(m.id, i === 0 ? d : ok),
        })),
      );
    },
  ],
  [
    "resolveOrphanedContested event.at(成功する経路)",
    (d) => async (s) => {
      const ok = new Date("2030-01-01T00:00:00Z");
      const a = await mk(s, { contentHash: "a" });
      const b = await mk(s, { contentHash: "b" });
      await s.mem.markContestedPair!(
        ctx,
        { id: a.id, event: ev(a.id, ok) },
        { id: b.id, event: ev(b.id, ok) },
      );
      return s.mem.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: ev(a.id, d),
      });
    },
  ],
  [
    "OutboxStore.claimBatch now",
    (d) => async (s) => {
      await s.mem.createMemoryWithOutbox(ctx, buildNewMemoryFixture({ tenantId: T }), ["embed"]);
      return s.ob.claimBatch(ctx, { now: d, limit: 5, leaseMs: 1000, claimedBy: "w" });
    },
  ],
];

function recallRecord(createdAt?: Date) {
  return {
    tenantId: T,
    subjectId: null,
    query: { text: "q" },
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
    ...(createdAt ? { createdAt } : {}),
  } as never;
}

/**
 * 下限より前（1ms 前・紀元前9001年）で、Postgres が**日時を見ない**（CAS に弾かれる・冪等の既存行の `created` イベント・何も強化しない・
 * `now` を下限へ寄せる）ために、断らない口。
 */
const OK_ON_EARLY = new Set([
  "supersedeWithNewMemories supersede[].event.at(CAS不一致)",
  "supersede 2対象: 1つ目CAS不一致(早い event)・2つ目OK",
  "supersede news 冪等の既存行 + buildCreatedEvent(早い at)",
  "createMemoriesWithOutboxAndEvents 冪等の既存行 + buildCreatedEvent(早い at)",
  "recordUsageAndReinforce 2回目(記録済み)",
  "reinforceMany at(ids空)",
  "recordUsageAndReinforce at(ids空)",
  "purgeExpiredEventsByRetention now(保持日数 設定済)",
  "OutboxStore.claimBatch now",
]);
/** 下限より前でも、日時より先に別の理由（対象が無い・CAS に弾かれる・形が違う）で投げる口。日時の例外にはならない。 */
const OTHER_ON_EARLY = new Set([
  "reinforce at(対象なし)",
  "reinforceMany 対象なしのid",
  "updateStatusWithEvent event.at(CAS不一致)",
  "updateStatusWithEvent(対象なし)",
  "markContestedGroup 空",
  "resolveContestedGroup 空",
  "resolveOrphanedContested(contested でない)",
  "resolveContestedPair(contested でない)",
  "markContestedPair(2件目なし)",
]);
/** 1件が下限より前で、もう1件は書ける `createMemoriesWithOutboxAndEvents`: 前者だけが dropped になる（Postgres は SAVEPOINT）。 */
const DROPPED_ON_EARLY = new Set([
  "createMemoriesWithOutboxAndEvents [早い, OK]",
  "createMemoriesWithOutboxAndEvents [OK, 早い]",
]);
const DROPPED_ALWAYS = new Set(["createMemoriesWithOutboxAndEvents [OK, InvalidDate]"]);

function expectedOnEarly(name: string): string {
  if (DROPPED_ON_EARLY.has(name) || DROPPED_ALWAYS.has(name)) return "ok dropped=1 written=1";
  if (OTHER_ON_EARLY.has(name)) return "other";
  return OK_ON_EARLY.has(name) ? "ok" : "range";
}
const norm = (x: string) => (x.startsWith("other") ? "other" : x);

/** 2実装へ同じ入力を流す。状態のある Postgres は、呼ぶ前に必ず空にする。 */
async function outcomes(make: (s: S) => Promise<unknown>) {
  await resetTestDatabase();
  const postgres = norm(await classify(() => build("postgres").then(make)));
  const fixture = norm(await classify(() => build("fixture").then(make)));
  return { postgres, fixture };
}

describe("行に日時を書く口: 下限（4714-11-24 BC 00:00:00 UTC）より前は、2実装とも書く前に断る。下限ちょうどは2実装とも通る（ADR 0640）", () => {
  it.each(cases.map((c) => [c[0], c[1]] as const))(
    "%s",
    async (name, make) => {
      const early = expectedOnEarly(name);
      for (const d of [EARLY, FAR]) {
        expect(await outcomes(make(d))).toEqual({ postgres: early, fixture: early });
      }
      // 下限ちょうど・1ms 後は、日時では落ちない（Postgres で実測）。fixture も同じ。
      for (const d of [EDGE, AFTER]) {
        const r = await outcomes(make(d));
        expect(r.postgres).not.toBe("range");
        expect(r.fixture).toBe(r.postgres);
      }
    },
    60_000,
  );
});
