import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import type { TickOptions } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `EXPECTED`・`ACCEPTED` は、testkit の InMemory と Postgres の側（`packages/postgres/src/__tests__/tick-opts-validation.postgres.test.ts`）と同じ表を縛る。

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
  ["kinds: 空文字の要素（文字列なので断らない）", { kinds: [""] }],
  ["limit: 2^62（2^63 未満なので断らない）", { limit: 2 ** 62 }],
  ["limit: 2^63 未満で最大級の整数", { limit: 2 ** 63 - 1024 }],
  ["claimedBy: 空文字（今までどおり）", { claimedBy: "" }],
  ["leaseMs: 0（今までどおり）", { leaseMs: 0 }],
  ["leaseMs: -1（今までどおり）", { leaseMs: -1 }],
  ["leaseMs: 下限ちょうど", { leaseMs: MAX_STORABLE_LEASE_MS }],
  ["leaseMs: 負で大きいが保存できる", { leaseMs: -1e14 }],
];

const ctx: Ctx = { tenantId: "tick-opts-validation" };

function build() {
  const stores = createFakeRuntimeStores();
  const llm = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories: [{ content: "本文", provenanceKind: "stated" }] }) as T,
  } satisfies LLMProvider;
  const claim = { calls: 0 };
  const outboxStore = Object.create(stores.outboxStore) as typeof stores.outboxStore;
  outboxStore.claimBatch = async (...args) => {
    claim.calls += 1;
    return stores.outboxStore.claimBatch(...args);
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date(NOW_MS) },
  });
  return { runtime, stores, claim };
}

const base = { kinds: ["extract"], leaseMs: 60_000 };

describe("runtime.tick: kinds / limit / claimedBy / 巨大な leaseMs の入口検査（Fake）", () => {
  it.each(EXPECTED)(
    "%s は断る。claim せず、ジョブは取れるまま",
    async (_label, extra, ErrClass, message) => {
      const { runtime, stores, claim } = build();
      await runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });

      const err = await runtime
        .tick(ctx, { ...base, ...extra } as unknown as TickOptions)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ErrClass);
      expect((err as Error).constructor).toBe(ErrClass);
      expect((err as Error).message).toBe(message);
      expect(claim.calls).toBe(0);
      expect(stores.outboxStore.listJobs(ctx).map((j) => j.attempts)).toEqual([0]);

      const after = await runtime.tick(ctx, base);
      expect(after.processed + after.failed).toBe(1);
    },
  );

  it.each(ACCEPTED)("陽性対照: %s は断らず、claim まで進む", async (_label, extra) => {
    const { runtime, claim } = build();
    await runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
    await runtime.tick(ctx, { ...base, ...extra } as unknown as TickOptions);
    expect(claim.calls).toBe(1);
  });
});
