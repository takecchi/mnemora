import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Fake の `limit` の検査は、負数・`NaN`・`Infinity`・非整数・bigint に収まらない値だけを断る。
 * `0` は断らず、「0件だけ返す」（Postgres の `LIMIT 0` と同じ）形で通す。
 * 断る側の歯は `fake-store-postgres-parity.test.ts` にある。ここは、断りすぎない側
 * （`limit: 0` を断る・`limit: 0` を「上限なし」と読む）を縛る。
 * 対象は、`limit` を検査する6つの口（claimBatch・VectorStore.search・LexicalStore.search・
 * EventStore.list・purgeExpiredEvents・aggregateScope の digestBand）。
 */

const TENANT = "fake-limit-zero-tenant";
const ctx: Ctx = { tenantId: TENANT };
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };
const LATE = new Date("2100-01-01T00:00:00.000Z");

function fixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  const recordedAt = overrides.recordedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "widget alpha bravo",
    contentHash: `limit-zero-hash-${recordedAt.getTime()}-${Math.random()}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("Fake の limit: 0 は断らず、0件だけ返す（上限なしとも読まない）", () => {
  it("FakeOutboxStore.claimBatch は 0件を返し、ジョブを claim しない", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, fixture({ embeddingStatus: "failed" }));
    await memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 1 });

    const none = await outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 0,
      now: LATE,
      claimedBy: "test",
      leaseMs: 60_000,
    });
    expect(none).toEqual([]);

    // 0 件の呼び出しは、ジョブの attempts を進めていない。
    const claimed = await outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 5,
      now: LATE,
      claimedBy: "test",
      leaseMs: 60_000,
    });
    expect(claimed.map((job) => job.attempts)).toEqual([1]);
  });

  it("FakeVectorStore.search は 0件を返す", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());
    await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0, 0]);

    await expect(
      vectorStore.search(ctx, SPACE, [1, 0, 0], { limit: 0, filter: { tenantId: TENANT } }),
    ).resolves.toEqual([]);
    const one = await vectorStore.search(ctx, SPACE, [1, 0, 0], {
      limit: 1,
      filter: { tenantId: TENANT },
    });
    expect(one.map((hit) => hit.memoryId)).toEqual([memory.id]);
  });

  it("FakeLexicalStore.search は 0件を返す", async () => {
    const { memoryStore, lexicalStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());

    await expect(
      lexicalStore.search(ctx, "widget", { limit: 0, filter: { tenantId: TENANT } }),
    ).resolves.toEqual([]);
    const one = await lexicalStore.search(ctx, "widget", {
      limit: 1,
      filter: { tenantId: TENANT },
    });
    expect(one.map((hit) => hit.memoryId)).toEqual([memory.id]);
  });

  it("FakeEventStore.list は limit: 0 で 0件を返す（limit を省くと全件）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());
    await eventStore.append(ctx, {
      tenantId: TENANT,
      memoryId: memory.id,
      kind: "updated",
      at: new Date("2026-01-02T00:00:00.000Z"),
      actor: { type: "system" },
      meta: {},
    });

    await expect(eventStore.list(ctx, { limit: 0 })).resolves.toEqual([]);
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("FakeMemoryStore.purgeExpiredEvents は limit: 0 で何も消さない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());
    await eventStore.append(ctx, {
      tenantId: TENANT,
      memoryId: memory.id,
      kind: "updated",
      at: new Date("2026-01-02T00:00:00.000Z"),
      actor: { type: "system" },
      meta: {},
    });

    const result = await memoryStore.purgeExpiredEvents!(ctx, {
      olderThan: new Date("2026-06-01T00:00:00.000Z"),
      limit: 0,
    });
    expect(result.purged).toBe(0);
    expect(result.reachedLimit).toBe(true);
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("FakeMemoryStore.aggregateScope の digestBand は limit: 0 で digests を空にし、対象の数は数える", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, fixture());

    const aggregate = await memoryStore.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 0, excludeMemoryIds: [] } },
    );
    expect(aggregate.digests).toEqual([]);
    expect(aggregate.digestEligible).toEqual({ count: 1, countKind: "exact" });
  });
});
