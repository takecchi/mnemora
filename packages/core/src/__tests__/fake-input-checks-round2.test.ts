import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isMalformedIdentifierError } from "../identifier.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0493（穴探し60巡目）の続き（形 E「Fake だけ検査が甘い」）: core のテスト用の Fake が、`@mnemora/testkit` の InMemory と
 * `@mnemora/postgres` が**どちらも断る**入力を、断らずに通していた口を縛る。`fake-read-and-claim-input-checks.test.ts` の続き。
 *
 * 断る入力（手元の Postgres・InMemory・Fake に同じ入力を流して測った。Fake だけが通していた）:
 * - 全口: `ctx.tenantId` の NUL・孤立サロゲート。
 * - `aggregateScope` の scope（日時・`decayFloorSeqAfter`・`subjectId`・`attributes`・`labels`）、`VectorStore.search` の `decayFloorAtAfter`・`decayFloorSeqAfter`。
 * - イベントを積む口: `actor`・`meta` の NUL・孤立サロゲート・BigInt、`digestSnapshot` の NUL、`sizeBeforeBytes` の int4 外。
 * - `reinforce` の `nowSeq`（`bigint`・非負）、`createMemory` の活動時計3欄・`extractorVersion`・`subjectId`・`decayFloorAt`・`lastReinforcedAt`・列挙3欄。
 * - `createObservation` の `subjectId`・`externalId` の孤立サロゲート。
 * - `archiveDecayed` の `now`・`nowSeq`、`createObservationWithOutbox`・`supersedeWithNewMemories`・`requeueEmbedJobs` の `now`、`claimedBy`・`jobKinds` の NUL。
 * - `updateStatus` 系・`setEmbeddingStatus`・`resolveContestedPair` の列挙値、`eraseTenant` の `limit`。
 *
 * **やりすぎの対照**も置く: `halfLifeHours` の範囲（この Fake は意図して見ない）、`updateStatus` の `"contested"`（同じく意図して見ない）、
 * 行を書かないときの `now`・`jobKinds`（Postgres は見ない）、`TenantSettingsStore.eraseTenant` の `limit`（Postgres は使わない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const space = { provider: "test", model: "fixture-model", dimensions: 3 };
const bad = new Date("invalid");
let hashCounter = 0;

function newMemory(over: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "banana split",
    contentHash: `fake-input-r2-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...over,
  };
}

function newObservation(over: Partial<NewObservation> = {}): NewObservation {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "hello" },
    occurredAt: null,
    ...over,
  };
}

function newEvent(memoryId: string | null, over: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...over,
  };
}

async function seed(over: Partial<NewMemory> = {}) {
  const stores = createFakeRuntimeStores();
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(over));
  await stores.vectorStore.upsert(ctx, space, memory.id, [1, 0, 0]);
  return { ...stores, memory };
}

async function expectRejected(
  call: () => Promise<unknown>,
  expected: RegExp | "malformed" | "bigint",
) {
  const error = await call().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "断られなかった").not.toBeNull();
  if (expected === "malformed") {
    expect(isMalformedIdentifierError(error)).toBe(true);
  } else if (expected === "bigint") {
    expect(error).toBeInstanceOf(TypeError);
  } else {
    expect((error as Error).message).toMatch(expected);
  }
}

describe("E1: ctx.tenantId の NUL・孤立サロゲートは全ての口で断る", () => {
  for (const [label, tenantId] of [
    ["NUL", "a\u0000b"],
    ["孤立サロゲート", "a\ud800b"],
  ] as const) {
    const badCtx: Ctx = { tenantId };
    const calls: Array<
      [string, (s: ReturnType<typeof createFakeRuntimeStores>) => Promise<unknown>]
    > = [
      ["MemoryStore.get", (s) => s.memoryStore.get(badCtx, "x")],
      ["MemoryStore.getMany", (s) => s.memoryStore.getMany(badCtx, ["x"])],
      [
        "MemoryStore.createObservation",
        (s) => s.memoryStore.createObservation(badCtx, newObservation()),
      ],
      ["MemoryStore.aggregateScope", (s) => s.memoryStore.aggregateScope(badCtx, {})],
      ["MemoryStore.listLabels", (s) => s.memoryStore.listLabels(badCtx)],
      ["MemoryStore.eraseTenant", (s) => s.memoryStore.eraseTenant!(badCtx, { limit: 5 })],
      [
        "VectorStore.search",
        (s) =>
          s.vectorStore.search(badCtx, space, [1, 0, 0], { limit: 5, filter: { tenantId: "ok" } }),
      ],
      ["VectorStore.eraseTenant", (s) => s.vectorStore.eraseTenant!(badCtx, { limit: 5 })],
      ["EventStore.list", (s) => s.eventStore.list(badCtx, {})],
      ["EventStore.append", (s) => s.eventStore.append(badCtx, newEvent(null))],
      [
        "OutboxStore.claimBatch",
        (s) =>
          s.outboxStore.claimBatch(badCtx, {
            limit: 5,
            now: new Date(),
            claimedBy: "w",
            leaseMs: 1000,
          }),
      ],
      [
        "TenantSettingsStore.getEventRetention",
        (s) => s.tenantSettingsStore.getEventRetention(badCtx),
      ],
      [
        "TenantSettingsStore.setEventRetention",
        (s) => s.tenantSettingsStore.setEventRetention(badCtx, { kind: "days", days: 5 }),
      ],
      ["RelationStore.listRelated", (s) => s.relationStore.listRelated(badCtx, "x")],
      ["RelationStore.link", (s) => s.relationStore.link(badCtx, "contradicts", "x", "y")],
    ];
    for (const [name, call] of calls) {
      it(`${name}: ctx.tenantId の${label}は MalformedIdentifierError`, async () => {
        await expectRejected(() => call(createFakeRuntimeStores()), "malformed");
      });
    }
  }

  it("対照: 妥当な tenantId（絵文字の対になったサロゲートを含む）は通る", async () => {
    const s = createFakeRuntimeStores();
    const okCtx: Ctx = { tenantId: "tenant-🍌" };
    await expect(s.memoryStore.get(okCtx, "x")).resolves.toBeNull();
    await expect(s.eventStore.list(okCtx, {})).resolves.toEqual([]);
  });
});

describe("E2・E3: aggregateScope の scope と VectorStore.search の絞りの日時・通し番号", () => {
  const scopes: Array<[string, Record<string, unknown>, RegExp | "malformed"]> = [
    ["occurredAfter が Invalid Date", { occurredAfter: bad }, /occurredAfter must be a valid Date/],
    [
      "occurredBefore が Invalid Date",
      { occurredBefore: bad },
      /occurredBefore must be a valid Date/,
    ],
    ["validAt が Invalid Date", { validAt: bad }, /validAt must be a valid Date/],
    [
      "decayFloorAtAfter が Invalid Date",
      { decayFloorAtAfter: bad },
      /decayFloorAtAfter must be a valid Date/,
    ],
    [
      "decayFloorSeqAfter が NaN",
      { decayFloorSeqAfter: Number.NaN },
      /decayFloorSeqAfter must be an integer/,
    ],
    [
      "decayFloorSeqAfter が Infinity",
      { decayFloorSeqAfter: Number.POSITIVE_INFINITY },
      /must be an integer/,
    ],
    ["decayFloorSeqAfter が 1.5", { decayFloorSeqAfter: 1.5 }, /must be an integer/],
    ["subjectId に NUL", { subjectId: "a\u0000b" }, "malformed"],
    ["subjectId に孤立サロゲート", { subjectId: "a\ud800b" }, "malformed"],
    ["attributes に NUL", { attributes: { k: "a\u0000" } }, /attributes must not contain NUL/],
    ["labels に NUL", { labels: ["a\u0000"] }, /labels must not contain NUL/],
  ];
  for (const [label, scope, expected] of scopes) {
    it(`aggregateScope: scope.${label}は断る`, async () => {
      const { memoryStore } = await seed();
      await expectRejected(() => memoryStore.aggregateScope(ctx, scope), expected);
    });
  }
  it("aggregateScope: scopeAggregate: skip で digestBand 無しなら attributes の NUL は見ない（Postgres は問い合わせを発行しない）", async () => {
    const { memoryStore } = await seed();
    await expect(
      memoryStore.aggregateScope(ctx, { attributes: { k: "a\u0000" } }, { scopeAggregate: "skip" }),
    ).resolves.toBeDefined();
  });
  it("対照: 妥当な scope は通る", async () => {
    const { memoryStore } = await seed();
    const r = await memoryStore.aggregateScope(ctx, {
      occurredAfter: new Date("2020-01-01"),
      decayFloorSeqAfter: 0,
    });
    expect(r.totalInScope).toBe(1);
  });

  const filters: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "decayFloorAtAfter が Invalid Date",
      { decayFloorAtAfter: bad },
      /filter\.decayFloorAtAfter must be a valid Date/,
    ],
    [
      "decayFloorSeqAfter が NaN",
      { decayFloorSeqAfter: Number.NaN },
      /filter\.decayFloorSeqAfter must be an integer/,
    ],
    ["decayFloorSeqAfter が 1.5", { decayFloorSeqAfter: 1.5 }, /must be an integer/],
  ];
  for (const [label, filter, expected] of filters) {
    it(`VectorStore.search: filter.${label}は断る`, async () => {
      const { vectorStore } = await seed();
      await expectRejected(
        () =>
          vectorStore.search(ctx, space, [1, 0, 0], {
            limit: 5,
            filter: { tenantId: ctx.tenantId, ...filter },
          }),
        expected,
      );
    });
  }
  it("対照: decayFloorSeqAfter が整数なら通る", async () => {
    const { vectorStore } = await seed();
    await expect(
      vectorStore.search(ctx, space, [1, 0, 0], {
        limit: 5,
        filter: { tenantId: ctx.tenantId, decayFloorSeqAfter: 0 },
      }),
    ).resolves.toBeDefined();
  });
});

describe("E4: イベントを積む口の NUL・孤立サロゲート・BigInt・int4", () => {
  const events: Array<[string, Partial<NewMemoryEvent>, RegExp | "bigint"]> = [
    [
      "actor.id に NUL",
      { actor: { type: "user", id: "a\u0000" } as never },
      /memory_events\.actor must not contain NUL/,
    ],
    [
      "actor.name に孤立サロゲート",
      { actor: { type: "agent", name: "a\ud800" } as never },
      /memory_events\.actor must not contain/,
    ],
    ["meta の値に NUL", { meta: { a: "x\u0000" } }, /memory_events\.meta must not contain NUL/],
    ["meta のキーに NUL", { meta: { "a\u0000": 1 } }, /memory_events\.meta must not contain NUL/],
    [
      "meta の入れ子の配列に NUL",
      { meta: { a: [{ b: "\u0000" }] } },
      /memory_events\.meta must not contain NUL/,
    ],
    ["meta に BigInt", { meta: { a: 1n } }, "bigint"],
    ["digestSnapshot に NUL", { digestSnapshot: "a\u0000" }, /digestSnapshot must not contain NUL/],
    [
      "sizeBeforeBytes が NaN",
      { sizeBeforeBytes: Number.NaN },
      /sizeBeforeBytes must be an integer/,
    ],
    [
      "sizeBeforeBytes が Infinity",
      { sizeBeforeBytes: Number.POSITIVE_INFINITY },
      /must be an integer/,
    ],
    ["sizeBeforeBytes が 1.5", { sizeBeforeBytes: 1.5 }, /must be an integer/],
    ["sizeBeforeBytes が 2^31", { sizeBeforeBytes: 2 ** 31 }, /int4/],
    ["sizeBeforeBytes が -2^31-1", { sizeBeforeBytes: -(2 ** 31) - 1 }, /int4/],
  ];
  for (const [label, over, expected] of events) {
    it(`EventStore.append: ${label}は断る`, async () => {
      const { eventStore, memory } = await seed();
      await expectRejected(() => eventStore.append(ctx, newEvent(memory.id, over)), expected);
      expect(eventStore.events).toHaveLength(0);
    });
    it(`updateStatusWithEvent: ${label}は断り、状態を書き換えない`, async () => {
      const { memoryStore, memory } = await seed();
      await expectRejected(
        () =>
          memoryStore.updateStatusWithEvent(
            ctx,
            memory.id,
            "forgotten",
            {},
            newEvent(memory.id, over),
          ),
        expected,
      );
      expect((await memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });
  }
  it("対照: 対になったサロゲート（絵文字）・int4 の境界・meta に NaN は通る", async () => {
    const { eventStore, memory } = await seed();
    for (const size of [2 ** 31 - 1, -(2 ** 31), 0, null]) {
      await eventStore.append(ctx, newEvent(memory.id, { sizeBeforeBytes: size }));
    }
    await eventStore.append(
      ctx,
      newEvent(memory.id, { meta: { note: "🍌", n: Number.NaN }, digestSnapshot: "🍌" }),
    );
    expect(eventStore.events).toHaveLength(5);
  });
});

describe("E5: reinforce の nowSeq", () => {
  const nowSeqs: Array<[string, number]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["1.5", 1.5],
    ["1e300", 1e300],
    ["-1（書く値が負）", -1],
  ];
  for (const [label, nowSeq] of nowSeqs) {
    it(`halfLifeRecalls を持つ記憶: nowSeq が ${label} なら断り、何も書かない`, async () => {
      const { memoryStore, memory } = await seed({
        halfLifeRecalls: 10,
        decayBaseSeq: 0,
        decayFloorSeq: 10,
      });
      await expect(
        memoryStore.reinforce(ctx, memory.id, new Date("2026-07-01"), { nowSeq }),
      ).rejects.toThrow(
        /nowSeq must be an integer|nowSeq must fit|decayBaseSeq must not be negative/,
      );
      const after = await memoryStore.get(ctx, memory.id);
      expect(after?.lastReinforcedAt).toBeNull();
      expect(after?.decayBaseSeq).toBe(0);
    });
  }
  it("対照: halfLifeRecalls を持たない記憶は nowSeq を使わないので、NaN でも通る（Postgres は見ない）", async () => {
    const { memoryStore, memory } = await seed();
    await expect(
      memoryStore.reinforce(ctx, memory.id, new Date("2026-07-01"), { nowSeq: Number.NaN }),
    ).resolves.toBeDefined();
  });
  it("対照: 0 と正の整数は通り、起点を進める", async () => {
    const { memoryStore, memory } = await seed({
      halfLifeRecalls: 10,
      decayBaseSeq: 0,
      decayFloorSeq: 10,
    });
    const r = await memoryStore.reinforce(ctx, memory.id, new Date("2026-07-01"), { nowSeq: 7 });
    expect(r.decayBaseSeq).toBe(7);
  });
});

describe("E6・E7: createMemory・createObservation の欄", () => {
  const memories: Array<[string, Partial<NewMemory>, RegExp | "malformed"]> = [
    ["decayBaseSeq が NaN", { decayBaseSeq: Number.NaN }, /decayBaseSeq must be an integer/],
    ["decayBaseSeq が -1", { decayBaseSeq: -1 }, /decayBaseSeq must not be negative/],
    ["decayFloorSeq が 1.5", { decayFloorSeq: 1.5 }, /decayFloorSeq must be an integer/],
    ["decayFloorSeq が 1e300", { decayFloorSeq: 1e300 }, /decayFloorSeq must fit/],
    ["halfLifeRecalls が 0", { halfLifeRecalls: 0 }, /halfLifeRecalls out of range/],
    ["halfLifeRecalls が -1", { halfLifeRecalls: -1 }, /halfLifeRecalls out of range/],
    ["halfLifeRecalls が NaN", { halfLifeRecalls: Number.NaN }, /halfLifeRecalls out of range/],
    [
      "halfLifeRecalls が float4 で 0 に丸まる",
      { halfLifeRecalls: 1e-50 },
      /halfLifeRecalls does not fit/,
    ],
    [
      "extractorVersion に NUL",
      { extractorVersion: "a\u0000" },
      /extractorVersion must not contain NUL/,
    ],
    ["subjectId に孤立サロゲート", { subjectId: "a\ud800" }, "malformed"],
    ["decayFloorAt が Invalid Date", { decayFloorAt: bad }, /decayFloorAt must be a valid Date/],
    [
      "lastReinforcedAt が Invalid Date",
      { lastReinforcedAt: bad },
      /lastReinforcedAt must be a valid Date/,
    ],
    ["status が列挙に無い", { status: "bogus" as never }, /memories\.status must be one of/],
    [
      "digestSource が列挙に無い",
      { digestSource: "bogus" as never },
      /memories\.digest_source must be one of/,
    ],
    [
      "embeddingStatus が列挙に無い",
      { embeddingStatus: "bogus" as never },
      /memories\.embedding_status must be one of/,
    ],
  ];
  for (const [label, over, expected] of memories) {
    it(`createMemory: ${label}は断る`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expectRejected(() => memoryStore.createMemory(ctx, newMemory(over)), expected);
    });
  }
  it("対照: halfLifeHours の範囲（0・負数）は、この Fake が意図して見ない（recall-pipeline.test.ts が「壊れた」記憶を作る）ので通る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, newMemory({ halfLifeHours: 0 })),
    ).resolves.toBeDefined();
    await expect(
      memoryStore.createMemory(ctx, newMemory({ halfLifeHours: -1 })),
    ).resolves.toBeDefined();
  });
  it("対照: 妥当な活動時計3欄・対になったサロゲートの subjectId は通る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const m = await memoryStore.createMemory(
      ctx,
      newMemory({
        decayBaseSeq: 0,
        decayFloorSeq: 5,
        halfLifeRecalls: 100,
        subjectId: "subject-🍌",
      }),
    );
    expect(m.decayFloorSeq).toBe(5);
  });

  it("createObservation: subjectId・externalId の孤立サロゲートは MalformedIdentifierError", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expectRejected(
      () => memoryStore.createObservation(ctx, newObservation({ subjectId: "a\ud800" })),
      "malformed",
    );
    await expectRejected(
      () => memoryStore.createObservation(ctx, newObservation({ externalId: "a\ud800" })),
      "malformed",
    );
  });
  it("対照: 対になったサロゲートの externalId は通る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createObservation(ctx, newObservation({ externalId: "e-🍌" })),
    ).resolves.toBeDefined();
  });
});

describe("E8・E9・E11: archiveDecayed・outbox の行を書く口の now・claimedBy・jobKinds", () => {
  it("archiveDecayed: now が Invalid Date・nowSeq が 1.5・NaN なら断る", async () => {
    const { memoryStore } = await seed();
    await expectRejected(
      () => memoryStore.archiveDecayed(ctx, { now: bad, limit: 5 }),
      /now must be a valid Date/,
    );
    await expectRejected(
      () =>
        memoryStore.archiveDecayed(ctx, {
          now: new Date(),
          limit: 5,
          nowSeq: 1.5,
          clock: "activity",
        }),
      /nowSeq must be an integer/,
    );
    await expectRejected(
      () => memoryStore.archiveDecayed(ctx, { now: new Date(), limit: 5, nowSeq: Number.NaN }),
      /nowSeq must be an integer/,
    );
  });
  it("E11: archiveDecayed の limit 0 は reachedLimit: false（何も選ばない）。limit 1 で1件選べば true", async () => {
    const { memoryStore } = await seed();
    const now = new Date("2030-01-01");
    expect(await memoryStore.archiveDecayed(ctx, { now, limit: 0 })).toEqual({
      archived: [],
      reachedLimit: false,
    });
    const r = await memoryStore.archiveDecayed(ctx, { now, limit: 1 });
    expect(r.archived).toHaveLength(1);
    expect(r.reachedLimit).toBe(true);
  });

  it("createObservationWithOutbox: now が Invalid Date・claimedBy に NUL・jobKinds に NUL は、観測も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const input = newObservation({ externalId: "ext-1" });
    await expectRejected(
      () => memoryStore.createObservationWithOutbox(ctx, input, ["extract"], { now: bad }),
      /opts\.now must be a valid Date/,
    );
    await expectRejected(
      () =>
        memoryStore.createObservationWithOutbox(ctx, input, ["extract"], { claimedBy: "a\u0000" }),
      /claimedBy must not contain NUL/,
    );
    await expectRejected(
      () => memoryStore.createObservationWithOutbox(ctx, input, ["a\u0000" as never]),
      /jobKinds must not contain NUL/,
    );
    expect(outboxStore.listJobs(ctx)).toHaveLength(0);
    // 書いていないので、同じ externalId で新規に作れる
    const ok = await memoryStore.createObservationWithOutbox(ctx, input, ["extract"]);
    expect(ok.created).toBe(true);
  });
  it("対照: 行を書かないとき（jobKinds が空・冪等の既存の行）は now・claimedBy を見ない（Postgres は INSERT しない）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const input = newObservation({ externalId: "ext-2" });
    await expect(
      memoryStore.createObservationWithOutbox(ctx, newObservation({ externalId: "ext-3" }), [], {
        now: bad,
      }),
    ).resolves.toMatchObject({ created: true, jobs: [] });
    await memoryStore.createObservationWithOutbox(ctx, input, ["extract"]);
    await expect(
      memoryStore.createObservationWithOutbox(ctx, input, ["extract"], {
        now: bad,
        claimedBy: "a\u0000",
      }),
    ).resolves.toMatchObject({ created: false });
  });
  it("createMemoryWithOutbox: jobKinds の NUL は記憶も書かずに断る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const input = newMemory();
    await expectRejected(
      () => memoryStore.createMemoryWithOutbox(ctx, input, ["a\u0000" as never]),
      /jobKinds must not contain NUL/,
    );
    await expect(memoryStore.createMemoryWithOutbox(ctx, input, ["embed"])).resolves.toMatchObject({
      created: true,
    });
  });
  it("supersedeWithNewMemories: opts.now が Invalid Date なら、何も書かずに断る（jobKinds が空なら見ない）", async () => {
    const { memoryStore, memory } = await seed();
    await expectRejected(
      () =>
        memoryStore.supersedeWithNewMemories(
          ctx,
          [{ input: newMemory(), jobKinds: ["embed"] }],
          [
            {
              id: memory.id,
              supersededByIndex: 0,
              event: newEvent(memory.id, { kind: "superseded" }),
            },
          ],
          { now: bad },
        ),
      /opts\.now must be a valid Date/,
    );
    expect((await memoryStore.get(ctx, memory.id))?.status).toBe("active");
    await expect(
      memoryStore.supersedeWithNewMemories(
        ctx,
        [{ input: newMemory(), jobKinds: [] }],
        [
          {
            id: memory.id,
            supersededByIndex: 0,
            event: newEvent(memory.id, { kind: "superseded" }),
          },
        ],
        { now: bad },
      ),
    ).resolves.toBeDefined();
  });
  it("requeueEmbedJobs: writeOpts.now が Invalid Date なら断る", async () => {
    const { memoryStore } = await seed({ embeddingStatus: "failed" });
    await expectRejected(
      () => memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 5 }, { now: bad }),
      /writeOpts\.now must be a valid Date/,
    );
    await expect(
      memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 5 }, { now: new Date() }),
    ).resolves.toMatchObject({ requeued: 1 });
  });
});

describe("E10: 列挙値", () => {
  it('updateStatus・updateStatusWithEvent: 列挙に無い status（"bogus"・"purged"）は断り、書き換えない', async () => {
    const { memoryStore, memory } = await seed();
    for (const status of ["bogus", "purged"]) {
      await expectRejected(
        () => memoryStore.updateStatus(ctx, memory.id, status as never),
        /memories\.status must be one of/,
      );
      await expectRejected(
        () =>
          memoryStore.updateStatusWithEvent(
            ctx,
            memory.id,
            status as never,
            {},
            newEvent(memory.id),
          ),
        /memories\.status must be one of/,
      );
    }
    expect((await memoryStore.get(ctx, memory.id))?.status).toBe("active");
  });
  it('対照: updateStatus の "contested" は、この Fake が意図して見ない（ADR 0140 決定2・Issue #768）ので通る', async () => {
    const { memoryStore, memory } = await seed();
    expect((await memoryStore.updateStatus(ctx, memory.id, "contested")).status).toBe("contested");
  });
  it("setEmbeddingStatus: 列挙に無い値は断る", async () => {
    const { memoryStore, memory } = await seed();
    await expectRejected(
      () => memoryStore.setEmbeddingStatus(ctx, memory.id, "bogus" as never),
      /memories\.embedding_status must be one of/,
    );
  });
  it("resolveContestedPair・resolveContestedGroup: 列挙に無い status は断る", async () => {
    const { memoryStore } = await seed();
    const side = (status: string) => ({ id: "x", status: status as never, event: newEvent(null) });
    await expectRejected(
      () => memoryStore.resolveContestedPair(ctx, side("bogus"), side("active")),
      /memories\.status must be one of/,
    );
    await expectRejected(
      () => memoryStore.resolveContestedGroup(ctx, [side("active"), side("active"), side("bogus")]),
      /memories\.status must be one of/,
    );
  });
});

describe("E12: ベクトルは float4 に丸めて持つ", () => {
  it("1e-50 の成分は 0 に丸まり、距離は NaN になる。問い合わせの 1e39 は Infinity になり NaN になる", async () => {
    const { vectorStore, memory } = await seed();
    await vectorStore.upsert(ctx, space, memory.id, [1e-50, 0, 0]);
    const hits = await vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 5,
      filter: { tenantId: ctx.tenantId },
    });
    expect(Number.isNaN(hits[0]!.distance)).toBe(true);
    await vectorStore.upsert(ctx, space, memory.id, [1, 0, 0]);
    const hits2 = await vectorStore.search(ctx, space, [1e39, 0, 0], {
      limit: 5,
      filter: { tenantId: ctx.tenantId },
    });
    expect(Number.isNaN(hits2[0]!.distance)).toBe(true);
  });
  it("対照: 普通のベクトルの距離は 0（同じ向き）", async () => {
    const { vectorStore } = await seed();
    const hits = await vectorStore.search(ctx, space, [2, 0, 0], {
      limit: 5,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits[0]!.distance).toBeCloseTo(0, 6);
  });
});

describe("D3: eraseTenant の limit（Fake。MemoryStore・VectorStore・OutboxStore）", () => {
  for (const limit of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 63]) {
    it(`limit が ${limit} なら断る（Postgres は bigint の引数として拒む）`, async () => {
      const s = createFakeRuntimeStores();
      await expectRejected(
        () => s.memoryStore.eraseTenant!(ctx, { limit }),
        /eraseTenant: limit must/,
      );
      await expectRejected(
        () => s.vectorStore.eraseTenant!(ctx, { limit }),
        /eraseTenant: limit must/,
      );
      await expectRejected(
        () => s.outboxStore.eraseTenant!(ctx, { limit }),
        /eraseTenant: limit must/,
      );
    });
  }
  it("対照: 0 と正の整数は通る。TenantSettingsStore は limit を使わない（Postgres も見ない）ので NaN でも通る", async () => {
    const s = createFakeRuntimeStores();
    await expect(s.memoryStore.eraseTenant!(ctx, { limit: 0 })).resolves.toBeDefined();
    await expect(s.vectorStore.eraseTenant!(ctx, { limit: 10 })).resolves.toBeDefined();
    await expect(s.outboxStore.eraseTenant!(ctx, { limit: 10 })).resolves.toBeDefined();
    await expect(
      s.tenantSettingsStore.eraseTenant!(ctx, { limit: Number.NaN }),
    ).resolves.toBeDefined();
  });
});
