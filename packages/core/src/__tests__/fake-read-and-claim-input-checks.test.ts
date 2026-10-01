import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isMalformedIdentifierError } from "../identifier.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0493（穴探し60巡目、形 E「Fake だけ検査が甘い」）: core のテスト用の Fake の `VectorStore`・`LexicalStore`・
 * `EventStore`・`OutboxStore` が、`@mnemora/testkit` の InMemory と `@mnemora/postgres` が**どちらも断る**入力を、
 * 断らずに通していた口を縛る。直前までの Fake は、`limit` の検査（ADR 0434 より前）だけを持っていた。
 *
 * 断る入力（手元の Postgres・InMemory・Fake に同じ入力を流して測った。3者のうち Fake だけが通していた）:
 * - `VectorStore.search`・`LexicalStore.search` の `filter.occurredAfter`・`occurredBefore`・`validAt` が Invalid Date。
 * - 同 `filter.subjectId`・`filter.tenantId` に NUL（`MalformedIdentifierError`）。
 * - `LexicalStore.search` の `filter.attributes` の NUL。
 * - `EventStore.list` の `since`・`until` が Invalid Date。
 * - `OutboxStore.claimBatch` の `claimedBy` に NUL。
 * - `OutboxStore.complete`・`fail` の `opts.at` が Invalid Date（`OutboxStore.complete` の TSDoc が約束する。行には触れない）。
 * - `OutboxStore.purgeCompletedJobs` の `olderThan` が Invalid Date（`dryRun` でも断る）。
 *
 * Fake は適合試験の対象ではない（`fake-vector-store-filter.test.ts` 冒頭）。Runtime が組む値はこれらを破らないので、
 * 直接呼んだときだけ効く。やりすぎの対照（有効な Date・NUL の無い値・`claimedBy` の通常の値）も置く。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const space = { provider: "test", model: "fixture-model", dimensions: 3 };
const bad = new Date("invalid");
let hashCounter = 0;

function newMemory(): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "banana split",
    contentHash: `fake-read-claim-${hashCounter}`,
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
  };
}

async function seed() {
  const stores = createFakeRuntimeStores();
  const { memory, jobs } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), [
    "embed",
  ]);
  await stores.vectorStore.upsert(ctx, space, memory.id, [1, 0, 0]);
  return { ...stores, memory, job: jobs[0]! };
}

const claimOpts = (extra: Record<string, unknown> = {}) => ({
  limit: 5,
  now: new Date("2030-01-01T00:00:00.000Z"),
  claimedBy: "worker",
  leaseMs: 1000,
  ...extra,
});

describe("Fake の読み取り・claim の口の入力の検査（InMemory・Postgres と同じ側に断る）", () => {
  const filters: Array<[string, Record<string, unknown>, RegExp | "malformed"]> = [
    ["occurredAfter が Invalid Date", { occurredAfter: bad }, /filter\.occurredAfter must be a valid Date/],
    ["occurredBefore が Invalid Date", { occurredBefore: bad }, /filter\.occurredBefore must be a valid Date/],
    ["validAt が Invalid Date", { validAt: bad }, /filter\.validAt must be a valid Date/],
    ["subjectId に NUL", { subjectId: "a\u0000b" }, "malformed"],
    ["tenantId に NUL", { tenantId: "a\u0000b" }, "malformed"],
  ];

  async function expectRejected(call: () => Promise<unknown>, expected: RegExp | "malformed") {
    const error = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, "断られなかった").not.toBeNull();
    if (expected === "malformed") {
      expect(isMalformedIdentifierError(error)).toBe(true);
    } else {
      expect((error as Error).message).toMatch(expected);
    }
  }

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
    it(`LexicalStore.search: filter.${label}は断る`, async () => {
      const { lexicalStore } = await seed();
      await expectRejected(
        () =>
          lexicalStore.search(ctx, "banana", {
            limit: 5,
            filter: { tenantId: ctx.tenantId, ...filter },
          }),
        expected,
      );
    });
  }

  it("LexicalStore.search: filter.attributes の NUL は断る", async () => {
    const { lexicalStore } = await seed();
    await expectRejected(
      () =>
        lexicalStore.search(ctx, "banana", {
          limit: 5,
          filter: { tenantId: ctx.tenantId, attributes: { a: "b\u0000" } },
        }),
      /filter\.attributes must not contain NUL characters/,
    );
  });

  it("EventStore.list: since・until が Invalid Date なら断る", async () => {
    const { eventStore } = await seed();
    await expectRejected(() => eventStore.list(ctx, { since: bad }), /since must be a valid Date/);
    await expectRejected(() => eventStore.list(ctx, { until: bad }), /until must be a valid Date/);
  });

  it("OutboxStore.claimBatch: claimedBy の NUL は断る。claim もしない", async () => {
    const { outboxStore } = await seed();
    await expectRejected(
      () => outboxStore.claimBatch(ctx, claimOpts({ claimedBy: "a\u0000" })),
      /claimedBy must not contain NUL characters/,
    );
    expect(await outboxStore.claimBatch(ctx, claimOpts())).toHaveLength(1);
  });

  it("OutboxStore.complete・fail: opts.at が Invalid Date なら断り、行には触れない", async () => {
    const { outboxStore } = await seed();
    const [claimed] = await outboxStore.claimBatch(ctx, claimOpts());
    await expectRejected(
      () => outboxStore.complete(ctx, claimed!.id, claimed!.attempts, { at: bad }),
      /opts\.at must be a valid Date/,
    );
    await expectRejected(
      () => outboxStore.fail(ctx, claimed!.id, "e", claimed!.attempts, { at: bad }),
      /opts\.at must be a valid Date/,
    );
    // 触れていないので、同じ attempts でまだ終端にできる。
    await expect(
      outboxStore.complete(ctx, claimed!.id, claimed!.attempts),
    ).resolves.toBeUndefined();
  });

  it("OutboxStore.purgeCompletedJobs: olderThan が Invalid Date なら断る（dryRun でも）", async () => {
    const { outboxStore } = await seed();
    for (const dryRun of [false, true]) {
      await expectRejected(
        () => outboxStore.purgeCompletedJobs(ctx, { olderThan: bad, limit: 5, dryRun }),
        /olderThan must be a valid Date/,
      );
    }
  });

  it("対照（やりすぎの確認）: 有効な Date・NUL の無い値は今までどおり通る", async () => {
    const { vectorStore, lexicalStore, eventStore, outboxStore, memory } = await seed();
    const when = new Date("2026-06-01T00:00:00.000Z");
    const filter = {
      tenantId: ctx.tenantId,
      occurredBefore: new Date("2999-01-01T00:00:00.000Z"),
      validAt: when,
    };
    const hits = await vectorStore.search(ctx, space, [1, 0, 0], { limit: 5, filter });
    expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(await lexicalStore.search(ctx, "banana", { limit: 5, filter })).toHaveLength(1);
    expect(await eventStore.list(ctx, { since: when, until: new Date() })).toEqual([]);
    expect(await outboxStore.claimBatch(ctx, claimOpts({ claimedBy: "w-1" }))).toHaveLength(1);
    await expect(
      outboxStore.purgeCompletedJobs(ctx, { olderThan: when, limit: 5, dryRun: true }),
    ).resolves.toMatchObject({ purged: 0 });
  });
});
