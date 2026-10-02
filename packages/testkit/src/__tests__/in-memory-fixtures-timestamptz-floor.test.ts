import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

/**
 * ADR 0500: 紀元前4713年より前（Postgres の `timestamptz` の下限 4714-11-24 BC 00:00:00 UTC より前）の日時を、
 * Postgres は条件・引数に渡された時点で `22008 timestamp out of range` にする。fixture も同じ口で断る。
 * 口ごとの実測の表は ADR 0500 の「測ったこと」。**断らない口**（`purgeExpiredEvents`・`purgeExpiredRecalls`・
 * `purgeCompletedJobs` の `olderThan`。Postgres は下限より前の cutoff を「0件」で返す）は、やりすぎの歯で縛る。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/testkit-fixture-alignment.postgres.test.ts`（DB が要る）。
 */

const ctx: Ctx = { tenantId: "timestamptz-floor" };
const SPACE = { provider: "p", model: "m", dimensions: 3 };
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const FAR = new Date(Date.UTC(-9000, 0, 1));
const RANGE = /must not be earlier than 4714-11-24 BC/;
const CLAIM = (validFrom: Date | null, validUntil: Date | null) => ({
  subjectId: null,
  claimKey: { subject: "s", predicate: "p" },
  excludeMemoryId: "00000000-0000-4000-8000-000000000000",
  contentHash: "h",
  validFrom,
  validUntil,
});

function build() {
  const memoryStore = new InMemoryMemoryStore();
  return {
    mem: memoryStore,
    ev: new InMemoryEventStore(memoryStore, memoryStore.events),
    vec: new InMemoryVectorStore(memoryStore),
    lex: new InMemoryLexicalStore(memoryStore),
    ob: new InMemoryOutboxStore(memoryStore.outboxJobs),
  };
}
type K = ReturnType<typeof build>;
const f = (extra: object) => ({ tenantId: ctx.tenantId, ...extra });

/** 下限より前を断る口。`run(k, date)` は、その口に日時を1つ渡す。 */
const rejecting: Array<[string, (k: K, d: Date) => Promise<unknown>]> = [
  ["EventStore.list since", (k, d) => k.ev.list(ctx, { since: d } as never)],
  ["EventStore.list until", (k, d) => k.ev.list(ctx, { until: d } as never)],
  ...["occurredAfter", "occurredBefore", "validAt", "decayFloorAtAfter"].flatMap(
    (field): Array<[string, (k: K, d: Date) => Promise<unknown>]> => [
      [
        `VectorStore.search ${field}`,
        (k, d) => k.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: f({ [field]: d }) }),
      ],
      [
        `VectorStore.searchMany ${field}`,
        (k, d) =>
          k.vec.searchMany(ctx, SPACE, [{ key: "k", vector: [1, 0, 0] }], {
            limit: 3,
            filter: f({ [field]: d }),
          }),
      ],
      [`MemoryStore.aggregateScope ${field}`, (k, d) => k.mem.aggregateScope(ctx, { [field]: d })],
    ],
  ),
  ...["occurredAfter", "occurredBefore", "validAt"].map(
    (field): [string, (k: K, d: Date) => Promise<unknown>] => [
      `LexicalStore.search ${field}`,
      (k, d) => k.lex.search(ctx, "hello", { limit: 3, filter: f({ [field]: d }) }),
    ],
  ),
  ["OutboxStore.complete at", (k, d) => k.ob.complete(ctx, "j", 1, { at: d })],
  ["OutboxStore.fail at", (k, d) => k.ob.fail(ctx, "j", "e", 1, { at: d })],
  [
    "MemoryStore.requeueEmbedJobs now",
    (k, d) => k.mem.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 1 }, { now: d }),
  ],
  [
    "MemoryStore.archiveDecayed now",
    (k, d) => k.mem.archiveDecayed(ctx, { now: d, limit: 5, clock: "wall" }),
  ],
  [
    "MemoryStore.findActiveByClaimKey validFrom",
    (k, d) => k.mem.findActiveByClaimKey(ctx, CLAIM(d, null)),
  ],
  [
    "MemoryStore.findActiveByClaimKey validUntil",
    (k, d) => k.mem.findActiveByClaimKey(ctx, CLAIM(null, d)),
  ],
  [
    "MemoryStore.findContestedByClaimKey validFrom",
    (k, d) => k.mem.findContestedByClaimKey(ctx, CLAIM(d, null)),
  ],
  [
    "MemoryStore.findContestedByClaimKey validUntil",
    (k, d) => k.mem.findContestedByClaimKey(ctx, CLAIM(null, d)),
  ],
  [
    "MemoryStore.createObservationWithOutbox now",
    (k, d) =>
      k.mem.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        ["embed"],
        { now: d },
      ),
  ],
  [
    "MemoryStore.createMemoryWithOutbox now",
    (k, d) =>
      k.mem.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
        ["embed"],
        {
          now: d,
        },
      ),
  ],
  [
    "MemoryStore.createMemoriesWithOutboxAndEvents now",
    (k, d) =>
      k.mem.createMemoriesWithOutboxAndEvents(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: ctx.tenantId }), jobKinds: ["embed"] }],
        () => {
          throw new Error("unreachable");
        },
        { now: d },
      ),
  ],
  [
    "MemoryStore.supersedeWithNewMemories now",
    (k, d) =>
      k.mem.supersedeWithNewMemories(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: ctx.tenantId }), jobKinds: ["embed"] }],
        [],
        { now: d },
      ),
  ],
];

describe("下限より前の日時を、Postgres と同じ口で断る", () => {
  it.each(rejecting)("%s", async (_name, run) => {
    await expect(run(build(), EARLY)).rejects.toThrow(RANGE);
    await expect(run(build(), FAR)).rejects.toThrow(RANGE);
  });

  it("断る入力は、何も書かない（行を作る口は、前の呼び出しの行を増やさない）", async () => {
    const k = build();
    await expect(
      k.mem.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
        ["embed"],
        {
          now: EARLY,
        },
      ),
    ).rejects.toThrow(RANGE);
    expect(k.mem.outboxJobs).toHaveLength(0);
    expect(await k.mem.listByTenant({ tenantId: ctx.tenantId })).toHaveLength(0);
  });
});

describe("やりすぎ: 下限ちょうど・断らない口は通る", () => {
  it.each(rejecting.filter(([name]) => !/WithOutbox|AndEvents|supersede/.test(name)))(
    "下限ちょうど（4714-11-24 BC 00:00:00.000 UTC）は通る: %s",
    async (_name, run) => {
      const error = await run(build(), EDGE).then(
        () => null,
        (e: unknown) => e as Error,
      );
      // 日時の検査では落ちない（口によっては別の理由で落ちうるので、文面だけを見る）。
      expect(error?.message ?? "").not.toMatch(RANGE);
    },
  );

  it("下限ちょうどの now で outbox の行を書く口も通る", async () => {
    const k = build();
    await expect(
      k.mem.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
        ["embed"],
        {
          now: EDGE,
        },
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("jobKinds が空なら now を見ない（Postgres は outbox へ INSERT しない）", async () => {
    const k = build();
    await expect(
      k.mem.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        [],
        { now: EARLY },
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("purgeExpiredEvents・purgeExpiredRecalls・purgeCompletedJobs の olderThan は、下限より前でも0件で返る", async () => {
    const k = build();
    await expect(
      k.mem.purgeExpiredEvents(ctx, { olderThan: EARLY, limit: 5 }),
    ).resolves.toMatchObject({
      purged: 0,
    });
    await expect(
      k.mem.purgeExpiredRecalls(ctx, { olderThan: FAR, limit: 5 }),
    ).resolves.toMatchObject({
      purged: 0,
    });
    await expect(
      k.ob.purgeCompletedJobs(ctx, { olderThan: EARLY, limit: 5 }),
    ).resolves.toMatchObject({
      purged: 0,
    });
  });
});
