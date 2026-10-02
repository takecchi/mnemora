import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0555: outbox 行の時刻について、`FakeMemoryStore` を `MemoryStore` の約束（`InMemoryMemoryStore`・
 * `PostgresMemoryStore` の振る舞い）に揃える歯。
 *
 * 約束は4つの口にある:
 *  - `createObservationWithOutbox` の `opts.now`（と `opts.claimedBy` のときの `claimedAt`）
 *  - `createMemoryWithOutbox` の `opts.now`
 *  - `supersedeWithNewMemories` の `opts.now`
 *  - `requeueEmbedJobs` の `writeOpts.now`
 * どれも、積む outbox 行の `availableAt`・`createdAt` にその値を使い（claim 済みで積むなら `claimedAt` も）、
 * 省略時は壁時計を**1回だけ**読んで、その呼び出しで積む全部の行に使う。
 *
 * `packages/testkit` の適合テストは Fake を通らない（Issue #768）ので、同じ期待をここで当てる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

let hashCounter = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: PAST,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function supersedeEvent(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
  };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

/** 4つの口。`nowOpt` は `undefined` なら opts を渡さない。積んだ job を `listJobs` で返す（2本以上積む）。 */
const ports: Array<{
  name: string;
  run: (stores: Stores, nowOpt: Date | undefined) => Promise<OutboxJobRecord[]>;
}> = [
  {
    name: "createObservationWithOutbox",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: {},
        },
        ["extract", "embed"],
        now === undefined ? undefined : { now },
      );
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "createMemoryWithOutbox",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createMemoryWithOutbox(
        ctx,
        newMemory(),
        ["embed", "extract"],
        now === undefined ? undefined : { now },
      );
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "supersedeWithNewMemories",
    run: async ({ memoryStore, outboxStore }, now) => {
      const old = await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory(), jobKinds: ["embed", "extract"] },
          { input: newMemory(), jobKinds: ["embed"] },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: supersedeEvent(old.id),
          },
        ],
        now === undefined ? undefined : { now },
      );
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "requeueEmbedJobs",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.requeueEmbedJobs(
        ctx,
        { statuses: ["pending"], limit: 10 },
        now === undefined ? undefined : { now },
      );
      return outboxStore.listJobs(ctx);
    },
  },
];

/** Date の引数なしコンストラクタが、読むたびに1ms進む壁時計（同じ呼び出しの中で読み直すと値が割れる）。 */
function stubTickingWallClock(startMs: number): void {
  const RealDate = Date;
  let n = 0;
  class TickingDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(startMs + n++);
      } else {
        super(...(args as [number]));
      }
    }
  }
  vi.stubGlobal("Date", TickingDate);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(ports)("FakeMemoryStore.$name: outbox 行の時刻（ADR 0555）", ({ run }) => {
  it("opts.now を渡すと、availableAt・createdAt がその値になる", async () => {
    const jobs = await run(createFakeRuntimeStores(), PAST);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const job of jobs) {
      expect(job.availableAt).toEqual(PAST);
      expect(job.createdAt).toEqual(PAST);
      expect(job.claimedAt).toBeNull();
    }
  });

  it("過去の clock で積んだ job は、その clock の claimBatch で拾われる", async () => {
    const stores = createFakeRuntimeStores();
    const jobs = await run(stores, PAST);
    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: PAST,
      claimedBy: "w",
      leaseMs: LEASE_MS,
    });
    expect(claimed.map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
  });

  it("省略すると、availableAt・createdAt は呼ぶ前と呼んだ後の間の壁時計になる", async () => {
    const before = Date.now();
    const jobs = await run(createFakeRuntimeStores(), undefined);
    const after = Date.now();
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const job of jobs) {
      for (const at of [job.availableAt, job.createdAt]) {
        expect(at.getTime()).toBeGreaterThanOrEqual(before);
        expect(at.getTime()).toBeLessThanOrEqual(after);
      }
    }
  });

  it("省略したとき、1回の呼び出しで積んだ全部の job が同じ時刻になる（壁時計は1回だけ読む）", async () => {
    stubTickingWallClock(Date.parse("2026-06-01T00:00:00.000Z"));
    const jobs = await run(createFakeRuntimeStores(), undefined);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const stamps = new Set(jobs.flatMap((j) => [j.availableAt.getTime(), j.createdAt.getTime()]));
    expect([...stamps]).toHaveLength(1);
  });
});

describe("FakeMemoryStore.createObservationWithOutbox: claimedBy のとき claimedAt も同じ時刻（ADR 0407・0555）", () => {
  const obs = {
    tenantId: ctx.tenantId,
    subjectId: null,
    externalId: null,
    kind: "utterance" as const,
    payload: {},
  };

  it("opts.now を渡すと、availableAt・createdAt・claimedAt がその値になる", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await memoryStore.createObservationWithOutbox(ctx, obs, ["extract", "embed"], {
      now: PAST,
      claimedBy: "sync",
    });
    for (const job of outboxStore.listJobs(ctx)) {
      expect(job.availableAt).toEqual(PAST);
      expect(job.createdAt).toEqual(PAST);
      expect(job.claimedAt).toEqual(PAST);
      expect(job.claimedBy).toBe("sync");
      expect(job.attempts).toBe(1);
    }
  });

  it("省略すると、全部の job の3つの時刻が1回だけ読んだ同じ壁時計になる", async () => {
    stubTickingWallClock(Date.parse("2026-06-01T00:00:00.000Z"));
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await memoryStore.createObservationWithOutbox(ctx, obs, ["extract", "embed"], {
      claimedBy: "sync",
    });
    const jobs = outboxStore.listJobs(ctx);
    expect(jobs).toHaveLength(2);
    const stamps = new Set(
      jobs.flatMap((j) => [j.availableAt.getTime(), j.createdAt.getTime(), j.claimedAt!.getTime()]),
    );
    expect([...stamps]).toHaveLength(1);
  });
});

describe("FakeMemoryStore: opts を受けた検査（ADR 0434・0493・0555）", () => {
  const invalid = new Date(Number.NaN);

  it("createMemoryWithOutbox は、opts.now が Invalid Date なら何も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"], { now: invalid }),
    ).rejects.toThrow(/opts\.now/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });

  it("createMemoryWithOutbox は、jobKinds が空なら Invalid Date を見ない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const r = await memoryStore.createMemoryWithOutbox(ctx, newMemory(), [], { now: invalid });
    expect(r.created).toBe(true);
  });

  it("createMemoryWithOutbox は、jobKinds に NUL があれば何も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed\u0000" as never]),
    ).rejects.toThrow(/NUL/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });

  it("supersedeWithNewMemories は、opts.now が Invalid Date なら何も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.supersedeWithNewMemories(ctx, [{ input: newMemory(), jobKinds: ["embed"] }], [], {
        now: invalid,
      }),
    ).rejects.toThrow(/opts\.now/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });

  it("supersedeWithNewMemories は、jobKinds に NUL があれば何も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.supersedeWithNewMemories(
        ctx,
        [{ input: newMemory(), jobKinds: ["embed\u0000" as never] }],
        [],
      ),
    ).rejects.toThrow(/NUL/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });
});
