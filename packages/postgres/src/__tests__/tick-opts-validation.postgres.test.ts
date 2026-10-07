import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, OutboxStore, Runtime, TickOptions } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `runtime.tick` の入口は、`claimBatch` を呼ぶ前に `opts.kinds`・`limit`・`claimedBy` と、
 * store が保存できない巨大な `leaseMs` を、名指しの例外で断る。testkit の InMemory と実 Postgres の両方で、同じ顔（種類・message）になることを縛る。
 */

const NOW_MS = Date.parse("2100-01-01T00:00:00.000Z");
/** Postgres の `timestamptz` の下限（4714-11-24 BC）。`now - leaseMs` がこれより前になる `leaseMs` は、どの store でも保存できない。 */
const PG_MIN_MS = -210_866_803_200_000;
const MAX_STORABLE_LEASE_MS = NOW_MS - PG_MIN_MS;

const KINDS_MSG = "Runtime.tick: opts.kinds must be an array of strings";
const LIMIT_MSG = "Runtime.tick: opts.limit must be an integer from 0 up to (not including) 2^63";
const CLAIMED_BY_MSG = "Runtime.tick: opts.claimedBy must be a string";
const CLAIMED_BY_NUL_MSG = "Runtime.tick: opts.claimedBy must not contain NUL characters (U+0000)";
const LEASE_RANGE_MSG =
  "Runtime.tick: opts.leaseMs is out of range (now - leaseMs must be a timestamp every store can hold)";

/** 3者（core の Fake・testkit の InMemory・Postgres）が同じ顔で断る入力。 */
const EXPECTED: Array<
  [string, Record<string, unknown>, typeof TypeError | typeof RangeError, string]
> = [
  ["kinds: 裸の文字列", { kinds: "extract" }, TypeError, KINDS_MSG],
  ["kinds: null", { kinds: null }, TypeError, KINDS_MSG],
  ["kinds: object", { kinds: {} }, TypeError, KINDS_MSG],
  ["kinds: 数", { kinds: 5 }, TypeError, KINDS_MSG],
  ["kinds: 数の要素", { kinds: [1] }, TypeError, KINDS_MSG],
  ["kinds: null の要素", { kinds: ["extract", null] }, TypeError, KINDS_MSG],
  ["limit: 文字列", { limit: "5" }, RangeError, LIMIT_MSG],
  ["limit: null", { limit: null }, RangeError, LIMIT_MSG],
  ["limit: NaN", { limit: Number.NaN }, RangeError, LIMIT_MSG],
  ["limit: Infinity", { limit: Number.POSITIVE_INFINITY }, RangeError, LIMIT_MSG],
  ["limit: 負", { limit: -1 }, RangeError, LIMIT_MSG],
  ["limit: 小数", { limit: 1.5 }, RangeError, LIMIT_MSG],
  ["limit: 2^63", { limit: 2 ** 63 }, RangeError, LIMIT_MSG],
  ["claimedBy: 数", { claimedBy: 5 }, TypeError, CLAIMED_BY_MSG],
  ["claimedBy: null", { claimedBy: null }, TypeError, CLAIMED_BY_MSG],
  ["claimedBy: object", { claimedBy: {} }, TypeError, CLAIMED_BY_MSG],
  ["claimedBy: NUL を含む", { claimedBy: "w\u0000x" }, RangeError, CLAIMED_BY_NUL_MSG],
  ["leaseMs: 1e20", { leaseMs: 1e20 }, RangeError, LEASE_RANGE_MSG],
  ["leaseMs: -1e20", { leaseMs: -1e20 }, RangeError, LEASE_RANGE_MSG],
  [
    "leaseMs: 3e14（Date としては有効だが紀元前4714年より前）",
    { leaseMs: 3e14 },
    RangeError,
    LEASE_RANGE_MSG,
  ],
  ["leaseMs: 下限の1ミリ秒先", { leaseMs: MAX_STORABLE_LEASE_MS + 1 }, RangeError, LEASE_RANGE_MSG],
];

/** 断らない入力（陽性対照）。 */
const ACCEPTED: Array<[string, Record<string, unknown>]> = [
  ["limit: 0（何も claim しない。TSDoc どおり）", { limit: 0 }],
  ["kinds: []（何も claim しない。TSDoc どおり）", { kinds: [] }],
  ["claimedBy: 空文字（今までどおり）", { claimedBy: "" }],
  ["leaseMs: 0（今までどおり）", { leaseMs: 0 }],
  ["leaseMs: -1（今までどおり）", { leaseMs: -1 }],
  ["leaseMs: 下限ちょうど", { leaseMs: MAX_STORABLE_LEASE_MS }],
  ["leaseMs: 負で大きいが保存できる", { leaseMs: -1e14 }],
];

const ctx: Ctx = { tenantId: "tick-opts-validation" };

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => new Date(NOW_MS) },
};

/** `claimBatch` が呼ばれた回数を数える包み。 */
function counting(store: OutboxStore, claim: { calls: number }): OutboxStore {
  const wrapped = Object.create(store) as OutboxStore;
  wrapped.claimBatch = async (...args) => {
    claim.calls += 1;
    return store.claimBatch(...args);
  };
  return wrapped;
}

const KITS: Array<[string, (claim: { calls: number }) => Promise<Runtime>]> = [
  [
    "testkit の InMemory",
    async (claim) => {
      const memoryStore = new InMemoryMemoryStore();
      return createRuntime({
        ...shared,
        memoryStore,
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        vectorStore: new InMemoryVectorStore(memoryStore),
        outboxStore: counting(new InMemoryOutboxStore(memoryStore.outboxJobs), claim),
      });
    },
  ],
  [
    "Postgres",
    async (claim) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return createRuntime({
        ...shared,
        memoryStore: new PostgresMemoryStore(db),
        eventStore: new PostgresEventStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: counting(new PostgresOutboxStore(db), claim),
      });
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

const base = { kinds: ["extract"], leaseMs: 60_000 };

async function seed(runtime: Runtime): Promise<void> {
  await runtime.observe(ctx, {
    kind: "utterance",
    text: "x",
    speaker: "u",
    extract: "deferred",
  });
}

for (const [name, makeRuntime] of KITS) {
  describe(`${name}: tick の kinds / limit / claimedBy / 巨大な leaseMs の入口検査（ADR 0514）`, () => {
    it.each(EXPECTED)(
      "%s は断る。同じ種類・同じ message で、claim しない",
      async (_label, extra, ErrClass, message) => {
        const claim = { calls: 0 };
        const runtime = await makeRuntime(claim);
        await seed(runtime);

        const err = await runtime
          .tick(ctx, { ...base, ...extra } as unknown as TickOptions)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).constructor).toBe(ErrClass);
        expect((err as Error).message).toBe(message);
        expect((err as Error).cause).toBeUndefined();
        expect(claim.calls).toBe(0);

        // 落ちた tick が claim していれば、同じ時刻の正しい tick はリース中の行を取れず 0 件になる。
        const after = await runtime.tick(ctx, base);
        expect(after.processed + after.failed).toBe(1);
      },
    );

    it.each(ACCEPTED)("陽性対照: %s は断らず、claim まで進む", async (_label, extra) => {
      const claim = { calls: 0 };
      const runtime = await makeRuntime(claim);
      await seed(runtime);
      await runtime.tick(ctx, { ...base, ...extra } as unknown as TickOptions);
      expect(claim.calls).toBe(1);
    });
  });
}
