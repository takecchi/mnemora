import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * 読みの口（検索・集約・掃除）の条件の Invalid Date と、整数でない通し番号を、testkit の fixture も Postgres と同じく
 * 拒む（Postgres はクエリの時点で `timestamptz`・`bigint` への変換に失敗する）。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/store-boundary-diff.postgres.test.ts`（DB が要る）。
 * ここは DB 無しで走る側の歯で、文面を縛る。
 */

const ctx: Ctx = { tenantId: "query-invalid-values" };
const bad = () => new Date(Number.NaN);
const SPACE = { provider: "p", model: "m", dimensions: 3 };

function build() {
  const memoryStore = new InMemoryMemoryStore();
  return {
    memoryStore,
    eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
    vectorStore: new InMemoryVectorStore(memoryStore),
    lexicalStore: new InMemoryLexicalStore(memoryStore),
  };
}

describe("testkit の fixture は読みの口の条件の Invalid Date・整数でない通し番号を拒む", () => {
  const cases: Array<[string, (k: ReturnType<typeof build>) => Promise<unknown>, RegExp]> = [
    [
      "purgeExpiredEvents の olderThan",
      (k) => k.memoryStore.purgeExpiredEvents(ctx, { olderThan: bad(), limit: 10 }),
      /^purgeExpiredEvents: olderThan must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "archiveDecayed の now",
      (k) => k.memoryStore.archiveDecayed(ctx, { now: bad(), limit: 10 }),
      /^archiveDecayed: now must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "archiveDecayed の nowSeq",
      (k) =>
        k.memoryStore.archiveDecayed(ctx, {
          now: new Date(),
          limit: 10,
          nowSeq: 1.5,
          clock: "activity",
        }),
      /^archiveDecayed: nowSeq must be an integer \(got 1\.5\)$/,
    ],
    [
      "aggregateScope の validAt",
      (k) => k.memoryStore.aggregateScope(ctx, { validAt: bad() }),
      /^aggregateScope: validAt must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "aggregateScope の decayFloorSeqAfter",
      (k) => k.memoryStore.aggregateScope(ctx, { decayFloorSeqAfter: 1.5 }),
      /^aggregateScope: decayFloorSeqAfter must be an integer \(got 1\.5\)$/,
    ],
    [
      "findActiveByClaimKey の validUntil",
      (k) =>
        k.memoryStore.findActiveByClaimKey(ctx, {
          subjectId: null,
          claimKey: { subject: "user", predicate: "home_city" },
          excludeMemoryId: "mem-x",
          contentHash: "x",
          validFrom: null,
          validUntil: bad(),
        }),
      /^findActiveByClaimKey: validUntil must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "EventStore.list の since",
      (k) => k.eventStore.list(ctx, { since: bad() }),
      /^list: since must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "VectorStore.search の filter.occurredBefore",
      (k) =>
        k.vectorStore.search(ctx, SPACE, [1, 0, 0], {
          limit: 5,
          filter: { tenantId: ctx.tenantId, occurredBefore: bad() },
        }),
      /^search: filter\.occurredBefore must be a valid Date \(got Invalid Date\)$/,
    ],
    [
      "VectorStore.search の filter.decayFloorSeqAfter",
      (k) =>
        k.vectorStore.search(ctx, SPACE, [1, 0, 0], {
          limit: 5,
          filter: { tenantId: ctx.tenantId, decayFloorSeqAfter: Number.NaN },
        }),
      /^search: filter\.decayFloorSeqAfter must be an integer \(got NaN\)$/,
    ],
    [
      "LexicalStore.search の filter.validAt",
      (k) =>
        k.lexicalStore.search(ctx, "東京", {
          limit: 5,
          filter: { tenantId: ctx.tenantId, validAt: bad() },
        }),
      /^search: filter\.validAt must be a valid Date \(got Invalid Date\)$/,
    ],
  ];
  it.each(cases)("%s", async (_label, call, message) => {
    await expect(call(build())).rejects.toThrow(message);
  });

  it("省略（undefined）は条件が無いのであって、拒まない", async () => {
    const k = build();
    await expect(k.memoryStore.aggregateScope(ctx, {})).resolves.toBeDefined();
    await expect(k.eventStore.list(ctx, {})).resolves.toEqual([]);
  });
});
