import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0640（Issue #1755）: core のテスト専用 Fake も、行に日時を書く口で `timestamptz` の下限（4714-11-24 BC 00:00 UTC）より前を、
 * 書く前に `RangeError` で断る（`@mnemora/testkit/fixtures` の `InMemory*` と同じ型・同じ文面。Postgres は `22008`）。
 * 前例は ADR 0597（`FakeOutboxStore.complete`・`fail`）。「Postgres で通らないテストが Fake で通る」ずれを残さない。
 *
 * 口を全部並べた歯は testkit 側（`in-memory-fixtures-written-timestamptz-floor.test.ts`）。Fake は conformance に繋がっていない
 * （Issue #768）ので、ここは代表の口（Memory・Observation の欄、`reinforce`・`createRecall`・イベントの `at`）と、
 * Postgres が日時を見ない分岐（CAS に弾かれる対象）を当てる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const GOOD = new Date("2030-01-01T00:00:00.000Z");

const newMemory = (over: Partial<NewMemory> = {}): NewMemory => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: "本文",
  contentHash: "hash",
  digest: "digest",
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "fixture" },
  tags: [],
  occurredAt: null,
  recordedAt: new Date("2020-01-01T00:00:00.000Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
  decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
  embeddingStatus: "pending",
  ...over,
});
const newObservation = (over: Partial<NewObservation> = {}): NewObservation => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  externalId: null,
  kind: "utterance",
  payload: { text: "発話" },
  occurredAt: null,
  ...over,
});
const evt = (
  memoryId: string | null,
  at: Date | undefined,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent => ({
  tenantId: ctx.tenantId,
  memoryId: memoryId as never,
  kind,
  at,
  actor: { type: "system" },
  digestSnapshot: null,
  sizeBeforeBytes: null,
  meta: {},
});
const recall = (createdAt?: Date) =>
  ({
    tenantId: ctx.tenantId,
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

type Stores = ReturnType<typeof createFakeRuntimeStores>;

/** Fake の中身（Map・Set・配列）を丸ごと文字にした写し。呼ぶ前と後で同じなら、何も書いていない。 */
function stateOf(stores: Stores): string {
  const backing = Reflect.get(stores.memoryStore, "backing") as Record<string, unknown>;
  return JSON.stringify(backing, (_k, v: unknown) =>
    v instanceof Map ? [...v] : v instanceof Set ? [...v] : v,
  );
}

const RANGE = (owner: string, field: string) =>
  new RegExp(`^${owner}: ${field} must not be earlier than 4714-11-24 BC`);

async function rejectsWithoutWriting(
  stores: Stores,
  call: () => Promise<unknown>,
  expected: RegExp,
) {
  const before = stateOf(stores);
  const error = await call().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RangeError);
  expect((error as RangeError).message).toMatch(expected);
  expect(stateOf(stores)).toBe(before);
}

describe("FakeMemoryStore・FakeEventStore: 行に日時を書く口は、下限より前を RangeError で断り、何も書かない（ADR 0640）", () => {
  for (const field of [
    "occurredAt",
    "recordedAt",
    "lastReinforcedAt",
    "validFrom",
    "validUntil",
    "decayFloorAt",
  ] as const) {
    it(`createMemory ${field}: 下限の1ms前は断り、下限ちょうどは通る`, async () => {
      const stores = createFakeRuntimeStores();
      await rejectsWithoutWriting(
        stores,
        () => stores.memoryStore.createMemory(ctx, newMemory({ [field]: EARLY })),
        RANGE("FakeMemoryStore", field),
      );
      await expect(
        stores.memoryStore.createMemory(ctx, newMemory({ [field]: EDGE })),
      ).resolves.toBeDefined();
    });
  }

  for (const field of ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const) {
    it(`createObservation ${field}: 下限の1ms前は断り、下限ちょうどは通る`, async () => {
      const stores = createFakeRuntimeStores();
      await rejectsWithoutWriting(
        stores,
        () => stores.memoryStore.createObservation(ctx, newObservation({ [field]: EARLY })),
        RANGE("FakeMemoryStore", field),
      );
      await expect(
        stores.memoryStore.createObservation(ctx, newObservation({ [field]: EDGE })),
      ).resolves.toBeDefined();
    });
  }

  it("reinforce の at: 断る（何も書かない呼び出しになる古い at でも）。下限ちょうどは通る", async () => {
    const stores = createFakeRuntimeStores();
    const m = await stores.memoryStore.createMemory(ctx, newMemory());
    await rejectsWithoutWriting(
      stores,
      () => stores.memoryStore.reinforce(ctx, m.id, EARLY),
      RANGE("reinforce", "at"),
    );
    await stores.memoryStore.reinforce(ctx, m.id, GOOD);
    await rejectsWithoutWriting(
      stores,
      () => stores.memoryStore.reinforce(ctx, m.id, EARLY),
      RANGE("reinforce", "at"),
    );
    await expect(stores.memoryStore.reinforce(ctx, m.id, EDGE)).resolves.toBeDefined();
  });

  it("createRecall の createdAt: 断る。下限ちょうどは通る", async () => {
    const stores = createFakeRuntimeStores();
    await rejectsWithoutWriting(
      stores,
      () => stores.memoryStore.createRecall(ctx, recall(EARLY)),
      RANGE("createRecall", "createdAt"),
    );
    await expect(stores.memoryStore.createRecall(ctx, recall(EDGE))).resolves.toBeDefined();
  });

  it("EventStore.append・updateStatusWithEvent の at: 断る。下限ちょうどは通る", async () => {
    const stores = createFakeRuntimeStores();
    const m = await stores.memoryStore.createMemory(ctx, newMemory());
    await rejectsWithoutWriting(
      stores,
      () => stores.eventStore.append(ctx, evt(null, EARLY, "created")),
      RANGE("memory_events", "at"),
    );
    await rejectsWithoutWriting(
      stores,
      () =>
        stores.memoryStore.updateStatusWithEvent(
          ctx,
          m.id,
          "forgotten",
          {},
          evt(m.id, EARLY, "forgotten"),
        ),
      RANGE("memory_events", "at"),
    );
    await expect(stores.eventStore.append(ctx, evt(null, EDGE, "created"))).resolves.toBeDefined();
  });

  it("restoreSupersededBy の at: 対象が1件も無くても断る（Postgres は 22008。実測）。下限ちょうどは通る", async () => {
    const stores = createFakeRuntimeStores();
    const m = await stores.memoryStore.createMemory(ctx, newMemory());
    await rejectsWithoutWriting(
      stores,
      () => stores.memoryStore.restoreSupersededBy!(ctx, m.id, { at: EARLY }),
      RANGE("memory_events", "at"),
    );
    await expect(stores.memoryStore.restoreSupersededBy!(ctx, m.id, { at: EDGE })).resolves.toEqual(
      { restored: [] },
    );
  });

  describe("supersedeWithNewMemories: イベントの at は、CAS を通ってイベントを書く対象だけが見る", () => {
    it("CAS を通る対象の下限より前の at は断り、news も書かない", async () => {
      const stores = createFakeRuntimeStores();
      const old = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "old" }));
      await rejectsWithoutWriting(
        stores,
        () =>
          stores.memoryStore.supersedeWithNewMemories!(
            ctx,
            [{ input: newMemory({ contentHash: "new" }), jobKinds: ["embed"] }],
            [{ id: old.id, supersededByIndex: 0, event: evt(old.id, EARLY, "superseded") }],
          ),
        RANGE("memory_events", "at"),
      );
    });

    it("CAS に弾かれる対象の at は見ない（Postgres はそのイベントを書かない。実測）", async () => {
      const stores = createFakeRuntimeStores();
      const old = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "old" }));
      const result = await stores.memoryStore.supersedeWithNewMemories!(
        ctx,
        [{ input: newMemory({ contentHash: "new" }), jobKinds: [] }],
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
  });
});
