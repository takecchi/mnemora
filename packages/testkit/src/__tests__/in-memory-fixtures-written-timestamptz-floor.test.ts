import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "../test-data.js";

/**
 * ADR 0640（Issue #1755）: 行に日時を**書く**口は、`timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）より前を、書く前に
 * `RangeError` で断る。Postgres は同じ入力を値が渡された時点で `22008` にする（口・欄ごとの実測の表は ADR 0640）。
 *
 * 見るのは4つ。
 * 1. 下限の1ms前・紀元前9001年は断る。メッセージは `<口>: <欄> must not be earlier than 4714-11-24 BC …`（`assertQueryTimestamptz` と同じ形）。
 * 2. **断ったら何も書かない**——Memory・Observation・イベント・outbox・ラベル・使用の記録・Recall・活動時計が、呼ぶ前と同じ。
 * 3. 対照: 下限ちょうど・1ms 後は通る（Postgres も下限ちょうどは通る。実測）。
 * 4. 対照: Postgres が日時を見ない分岐（CAS に弾かれる対象のイベント・冪等の既存行の `created` イベント・何も強化しない
 *    `recordUsageAndReinforce`・読みの口・`claimBatch` の `now`）は、下限より前でも断らない。
 *
 * 2実装を並べた歯は `packages/postgres/src/__tests__/testkit-fixture-alignment.postgres.test.ts`（DB が要る）。
 */

const ctx: Ctx = { tenantId: "written-floor" };
const T = ctx.tenantId;
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const AFTER = new Date(FLOOR_MS + 1);
const FAR = new Date(Date.UTC(-9000, 0, 1));
const GOOD = new Date("2030-01-01T00:00:00Z");
const MEMORY_FIELDS = [
  "occurredAt",
  "recordedAt",
  "lastReinforcedAt",
  "validFrom",
  "validUntil",
  "decayFloorAt",
] as const;
const OBSERVATION_FIELDS = ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const;

const message = (owner: string, field: string) =>
  new RegExp(`^${owner}: ${field} must not be earlier than 4714-11-24 BC`);

function build() {
  const mem = new InMemoryMemoryStore();
  return {
    mem,
    ev: new InMemoryEventStore(mem, mem.events),
    ob: new InMemoryOutboxStore(mem.outboxJobs),
  };
}
type K = ReturnType<typeof build>;

const mk = (k: K, over: object = {}) =>
  k.mem.createMemory(ctx, buildNewMemoryFixture({ tenantId: T, ...over }));
const evt = (
  memoryId: string | null,
  at: Date | undefined,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent =>
  buildNewMemoryEventFixture({ tenantId: T, memoryId: memoryId as never, kind, at });
const recall = (createdAt?: Date) =>
  ({
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
  }) as never;

/** 呼ぶ前と後で比べる、store の中身の写し（プリミティブへ写し取る）。private の Map も読む。 */
async function stateOf(k: K): Promise<string> {
  const priv = (name: string) => Reflect.get(k.mem, name) as Map<string, unknown> | Set<string>;
  return JSON.stringify({
    memories: k.mem.listByTenant(ctx).sort((a, b) => (a.id < b.id ? -1 : 1)),
    observations: [...(priv("observations") as Map<string, unknown>)],
    recalls: [...k.mem.recalls],
    usages: [...(priv("usages") as Set<string>)],
    events: k.mem.events,
    outbox: k.mem.outboxJobs,
    labels: await k.mem.listLabels(ctx),
    activitySeq: [...k.mem.activitySeq],
    subjectActivitySeq: [...k.mem.subjectActivitySeq].map(([t, m]) => [t, [...m]]),
    relations: k.mem.relations,
  });
}

/** 「準備を済ませて、断られるはずの呼び出しを返す」形。準備のあとに状態を写し、呼び出しの後に比べる。 */
type Prepare = (k: K, d: Date | undefined) => Promise<() => Promise<unknown>>;
interface Port {
  name: string;
  owner: string;
  field: string;
  prepare: Prepare;
  /** 下限以後の日時でも、別の理由で投げる口の、その例外の `name`（日時の検査では落ちないことを見る）。 */
  edgeError?: string;
}

const ports: Port[] = [
  ...MEMORY_FIELDS.flatMap((field): Port[] => {
    const input = (d: Date | undefined, over: object = {}) =>
      buildNewMemoryFixture({ tenantId: T, [field]: d, ...over } as never);
    return [
      {
        name: `createMemory ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => () => k.mem.createMemory(ctx, input(d)),
      },
      {
        name: `createMemoryWithOutbox ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => () => k.mem.createMemoryWithOutbox(ctx, input(d), ["embed"]),
      },
      {
        name: `createMemoriesWithOutboxAndEvents ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => () =>
          k.mem.createMemoriesWithOutboxAndEvents(
            ctx,
            [{ input: input(d), jobKinds: ["embed"] }],
            (m) => evt(m.id, GOOD, "created"),
          ),
      },
      {
        name: `supersedeWithNewMemories ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => {
          const old = await mk(k, { contentHash: "old" });
          return () =>
            k.mem.supersedeWithNewMemories(
              ctx,
              [{ input: input(d, { contentHash: "new", tags: ["t"] }), jobKinds: ["embed"] }],
              [{ id: old.id, supersededByIndex: 0, event: evt(old.id, GOOD, "superseded") }],
            );
        },
      },
      {
        // 冪等の既存の行が在っても、Postgres は衝突を見る前に拒む（実測）。
        name: `createMemory（冪等の既存行）${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => {
          const o = await k.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
          const base = { sourceObservationId: o.id, extractorVersion: "v1" };
          await mk(k, base);
          return () => k.mem.createMemory(ctx, input(d, base));
        },
      },
    ];
  }),
  ...OBSERVATION_FIELDS.flatMap((field): Port[] => {
    const input = (d: Date | undefined, over: object = {}) =>
      buildNewObservationFixture({ tenantId: T, [field]: d, ...over } as never);
    return [
      {
        name: `createObservation ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => () => k.mem.createObservation(ctx, input(d)),
      },
      {
        name: `createObservationWithOutbox ${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => () =>
          k.mem.createObservationWithOutbox(ctx, input(d), ["extract"]),
      },
      {
        name: `createObservation（externalId が既存）${field}`,
        owner: "InMemoryMemoryStore",
        field,
        prepare: async (k, d) => {
          await k.mem.createObservation(
            ctx,
            buildNewObservationFixture({ tenantId: T, externalId: "x" }),
          );
          return () => k.mem.createObservation(ctx, input(d, { externalId: "x" }));
        },
      },
    ];
  }),
  {
    name: "reinforce at",
    owner: "reinforce",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () => k.mem.reinforce(ctx, m.id, d!);
    },
  },
  {
    // 何も書かない呼び出し（起点より古い `at`）でも、Postgres は拒む（実測）。
    name: "reinforce at（起点より古い）",
    owner: "reinforce",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      await k.mem.reinforce(ctx, m.id, GOOD);
      return () => k.mem.reinforce(ctx, m.id, d!);
    },
  },
  {
    name: "reinforceMany at",
    owner: "reinforce",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () => k.mem.reinforceMany(ctx, [m.id], d!);
    },
  },
  {
    name: "recordUsageAndReinforce at",
    owner: "reinforce",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      const recallId = await k.mem.createRecall(ctx, recall());
      return () => k.mem.recordUsageAndReinforce(ctx, recallId, [m.id], d!);
    },
  },
  {
    name: "createRecall createdAt",
    owner: "createRecall",
    field: "createdAt",
    prepare: async (k, d) => () => k.mem.createRecall(ctx, recall(d)),
  },
  {
    name: "EventStore.append at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => () => k.ev.append(ctx, evt(null, d, "created")),
  },
  {
    name: "EventStore.append at（memoryId あり）",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () => k.ev.append(ctx, evt(m.id, d));
    },
  },
  {
    name: "updateStatusWithEvent event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () =>
        k.mem.updateStatusWithEvent(ctx, m.id, "forgotten", {}, evt(m.id, d, "forgotten"));
    },
  },
  {
    name: "supersedeWithNewMemories supersede[].event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const old = await mk(k, { contentHash: "old" });
      return () =>
        k.mem.supersedeWithNewMemories(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
          [{ id: old.id, supersededByIndex: 0, event: evt(old.id, d, "superseded") }],
        );
    },
  },
  {
    // 1つ目が CAS を通って（早い `at` のイベントを書く）、2つ目が CAS に弾かれる。Postgres は1つ目で拒む（実測）。
    name: "supersedeWithNewMemories 1つ目が CAS を通る・2つ目は CAS に弾かれる",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const o1 = await mk(k, { contentHash: "o1" });
      const o2 = await mk(k, { contentHash: "o2" });
      return () =>
        k.mem.supersedeWithNewMemories(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
          [
            { id: o1.id, supersededByIndex: 0, event: evt(o1.id, d, "superseded") },
            {
              id: o2.id,
              supersededByIndex: 0,
              expectedStatus: "archived",
              event: evt(o2.id, GOOD, "superseded"),
            },
          ],
        );
    },
  },
  {
    name: "supersedeWithNewMemories buildCreatedEvent の at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => () =>
      k.mem.supersedeWithNewMemories(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T }), jobKinds: ["embed"] }],
        [],
        { buildCreatedEvent: (m) => evt(m.id, d, "created") },
      ),
  },
  {
    name: "createMemoriesWithOutboxAndEvents buildCreatedEvent の at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => () =>
      k.mem.createMemoriesWithOutboxAndEvents(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T }), jobKinds: ["embed"] }],
        (m) => evt(m.id, d, "created"),
      ),
  },
  {
    name: "markContestedPair first.event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const a = await mk(k, { contentHash: "a" });
      const b = await mk(k, { contentHash: "b" });
      return () =>
        k.mem.markContestedPair(
          ctx,
          { id: a.id, event: evt(a.id, d) },
          { id: b.id, event: evt(b.id, GOOD) },
        );
    },
  },
  {
    name: "markContestedPair second.event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const a = await mk(k, { contentHash: "a" });
      const b = await mk(k, { contentHash: "b" });
      return () =>
        k.mem.markContestedPair(
          ctx,
          { id: a.id, event: evt(a.id, GOOD) },
          { id: b.id, event: evt(b.id, d) },
        );
    },
  },
  {
    name: "resolveContestedPair event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const a = await mk(k, { contentHash: "a" });
      const b = await mk(k, { contentHash: "b" });
      await k.mem.markContestedPair(
        ctx,
        { id: a.id, event: evt(a.id, GOOD) },
        { id: b.id, event: evt(b.id, GOOD) },
      );
      return () =>
        k.mem.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: evt(a.id, d) },
          { id: b.id, status: "active", event: evt(b.id, GOOD) },
        );
    },
  },
  {
    name: "resolveOrphanedContested event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const a = await mk(k, { contentHash: "a" });
      const b = await mk(k, { contentHash: "b" });
      await k.mem.markContestedPair(
        ctx,
        { id: a.id, event: evt(a.id, GOOD) },
        { id: b.id, event: evt(b.id, GOOD) },
      );
      return () =>
        k.mem.resolveOrphanedContested(ctx, {
          id: a.id,
          contestedWithId: b.id,
          event: evt(a.id, d),
        });
    },
  },
  {
    name: "markContestedGroup event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const ms = [
        await mk(k, { contentHash: "a" }),
        await mk(k, { contentHash: "b" }),
        await mk(k, { contentHash: "c" }),
      ];
      return () =>
        k.mem.markContestedGroup(
          ctx,
          ms.map((m, i) => ({ id: m.id, event: evt(m.id, i === 0 ? d : GOOD) })),
        );
    },
  },
  {
    name: "resolveContestedGroup event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const ms = [
        await mk(k, { contentHash: "a" }),
        await mk(k, { contentHash: "b" }),
        await mk(k, { contentHash: "c" }),
      ];
      await k.mem.markContestedGroup(
        ctx,
        ms.map((m) => ({ id: m.id, event: evt(m.id, GOOD) })),
      );
      return () =>
        k.mem.resolveContestedGroup(
          ctx,
          ms.map((m, i) => ({
            id: m.id,
            status: "active" as const,
            event: evt(m.id, i === 0 ? d : GOOD),
          })),
        );
    },
  },
  {
    name: "restoreSupersededBy event.at（対象あり）",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const old = await mk(k, { contentHash: "old" });
      const r = await k.mem.supersedeWithNewMemories(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: evt(old.id, GOOD, "superseded") }],
      );
      return () => k.mem.restoreSupersededBy(ctx, r.created[0]!.memory.id, { at: d! });
    },
  },
  {
    // 対象が1件も無くても、Postgres は拒む（実測）。
    name: "restoreSupersededBy event.at（対象なし）",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () => k.mem.restoreSupersededBy(ctx, m.id, { at: d! });
    },
  },
  {
    name: "purgeMemory event.at",
    owner: "memory_events",
    field: "at",
    prepare: async (k, d) => {
      const m = await mk(k);
      await k.mem.updateStatus(ctx, m.id, "forgotten", {});
      return () =>
        k.mem.purgeMemory(ctx, m.id, { content: "x", digest: "y" }, evt(m.id, d, "purged"));
    },
  },
  {
    // 墓石と同じく、CAS に弾かれる状態の行でも Postgres は先に拒む（実測）。
    name: "purgeMemory event.at（purge できない状態の行）",
    owner: "memory_events",
    field: "at",
    edgeError: "MemoryPurgeConflictError",
    prepare: async (k, d) => {
      const m = await mk(k);
      return () =>
        k.mem.purgeMemory(ctx, m.id, { content: "x", digest: "y" }, evt(m.id, d, "purged"));
    },
  },
];

describe("行に日時を書く口: 下限（4714-11-24 BC 00:00:00 UTC）より前は、書く前に RangeError で断り、何も書かない（ADR 0640）", () => {
  it.each(ports.map((p) => [p.name, p] as const))(
    "%s: 下限の1ms前・紀元前9001年は断る。何も書かない",
    async (_name, port) => {
      for (const d of [EARLY, FAR]) {
        const k = build();
        const act = await port.prepare(k, d);
        const before = await stateOf(k);
        const error = await act().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(RangeError);
        expect((error as RangeError).message).toMatch(message(port.owner, port.field));
        expect(await stateOf(k)).toBe(before);
      }
    },
  );

  it.each(ports.map((p) => [p.name, p] as const))(
    "%s: 下限ちょうど・1ms 後は通る（Postgres も下限ちょうどは通る。実測）",
    async (_name, port) => {
      for (const d of [EDGE, AFTER]) {
        const k = build();
        const act = await port.prepare(k, d);
        if (port.edgeError === undefined) {
          await expect(act()).resolves.not.toThrow();
        } else {
          // 日時の検査では落ちない。別の理由（この準備では purge できない状態）で落ちる口。
          await expect(act()).rejects.toMatchObject({ name: port.edgeError });
        }
      }
    },
  );

  it("例外は RangeError で、Invalid Date の例外（Error。文面は口ごと）とは別。Invalid Date の文面は変わらない", async () => {
    const k = build();
    const m = await mk(k);
    await expect(k.mem.reinforce(ctx, m.id, new Date(Number.NaN))).rejects.toThrow(
      "reinforce: at must be a valid Date (got Invalid Date)",
    );
    await expect(
      k.mem.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: T,
          contentHash: "nan",
          occurredAt: new Date(Number.NaN),
        }),
      ),
    ).rejects.toThrow("InMemoryMemoryStore: occurredAt must be a valid Date (got Invalid Date)");
    await expect(k.ev.append(ctx, evt(null, new Date(Number.NaN), "created"))).rejects.toThrow(
      "memory_events.at must be a valid Date (got Invalid Date)",
    );
  });
});

describe("Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640）", () => {
  it("supersedeWithNewMemories: CAS に弾かれる対象のイベントの at は見ない（Postgres はイベントを書かない）", async () => {
    const k = build();
    const old = await mk(k, { contentHash: "old" });
    const result = await k.mem.supersedeWithNewMemories(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "archived",
          event: evt(old.id, EARLY, "superseded"),
        },
      ],
    );
    expect(result.conflicted).toHaveLength(1);
    expect(result.superseded).toHaveLength(0);
  });

  it("supersedeWithNewMemories: 1つ目が CAS に弾かれて・2つ目が通るとき、書くのは2つ目のイベントだけ（1つ目の at は見ない）", async () => {
    const k = build();
    const o1 = await mk(k, { contentHash: "o1" });
    const o2 = await mk(k, { contentHash: "o2" });
    const result = await k.mem.supersedeWithNewMemories(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: T, contentHash: "new" }), jobKinds: [] }],
      [
        {
          id: o1.id,
          supersededByIndex: 0,
          expectedStatus: "archived",
          event: evt(o1.id, EARLY, "superseded"),
        },
        { id: o2.id, supersededByIndex: 0, event: evt(o2.id, GOOD, "superseded") },
      ],
    );
    expect(result.conflicted).toHaveLength(1);
    expect(result.superseded).toHaveLength(1);
  });

  it("updateStatusWithEvent: CAS に弾かれたら at を見ず、MemoryStatusConflictError を投げる", async () => {
    const k = build();
    const m = await mk(k);
    await expect(
      k.mem.updateStatusWithEvent(
        ctx,
        m.id,
        "forgotten",
        { expectedStatus: "archived" },
        evt(m.id, EARLY, "forgotten"),
      ),
    ).rejects.toMatchObject({ name: "MemoryStatusConflictError" });
  });

  it("冪等の既存行: created でない行には created イベントを作らないので、その at は見ない（2つの口）", async () => {
    const k = build();
    const o = await k.mem.createObservation(ctx, buildNewObservationFixture({ tenantId: T }));
    const base = { sourceObservationId: o.id, extractorVersion: "v1" };
    await mk(k, base);
    const eventsBefore = k.mem.events.length;
    const r1 = await k.mem.createMemoriesWithOutboxAndEvents(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: T, ...base }), jobKinds: [] }],
      (m) => evt(m.id, EARLY, "created"),
    );
    expect(r1.written.map((w) => w.created)).toEqual([false]);
    const r2 = await k.mem.supersedeWithNewMemories(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: T, ...base }), jobKinds: [] }],
      [],
      { buildCreatedEvent: (m) => evt(m.id, EARLY, "created") },
    );
    expect(r2.created.map((c) => c.created)).toEqual([false]);
    expect(k.mem.events.length).toBe(eventsBefore);
  });

  it("createMemoriesWithOutboxAndEvents: 下限より前の欄を持つ候補だけが dropped になり、残りは書く（Postgres と同じ。実測）", async () => {
    const k = build();
    const r = await k.mem.createMemoriesWithOutboxAndEvents(
      ctx,
      [
        {
          input: buildNewMemoryFixture({ tenantId: T, contentHash: "a", occurredAt: EARLY }),
          jobKinds: [],
        },
        { input: buildNewMemoryFixture({ tenantId: T, contentHash: "b" }), jobKinds: [] },
      ],
      (m) => evt(m.id, GOOD, "created"),
    );
    expect(r.dropped.map((d) => d.index)).toEqual([0]);
    expect((r.dropped[0]!.error as Error).name).toBe("RangeError");
    expect(r.written.map((w) => w.index)).toEqual([1]);
  });

  it("recordUsageAndReinforce: 何も強化しない呼び出し（ids が空・記録済み）は at を見ない", async () => {
    const k = build();
    const m = await mk(k);
    const recallId = await k.mem.createRecall(ctx, recall());
    await expect(k.mem.recordUsageAndReinforce(ctx, recallId, [], EARLY)).resolves.toEqual({
      insertedMemoryIds: [],
    });
    await k.mem.recordUsageAndReinforce(ctx, recallId, [m.id], GOOD);
    await expect(k.mem.recordUsageAndReinforce(ctx, recallId, [m.id], EARLY)).resolves.toEqual({
      insertedMemoryIds: [],
    });
    await expect(k.mem.reinforceMany(ctx, [], EARLY)).resolves.toEqual([]);
  });

  it("claimBatch の now・purgeExpiredEventsByRetention の now は、Postgres が下限へ寄せるので断らない（ADR 0547）", async () => {
    const k = build();
    await k.mem.createMemoryWithOutbox(ctx, buildNewMemoryFixture({ tenantId: T }), ["embed"]);
    await expect(
      k.ob.claimBatch(ctx, { now: EARLY, limit: 5, leaseMs: 1000, claimedBy: "w" }),
    ).resolves.toBeDefined();
    k.mem.eventRetentionDays.set(T, 30);
    await expect(
      k.mem.purgeExpiredEventsByRetention(ctx, { now: EARLY, limit: 5 }),
    ).resolves.toMatchObject({ kind: "executed" });
  });
});
