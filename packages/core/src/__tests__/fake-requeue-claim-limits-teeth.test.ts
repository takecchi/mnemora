import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * PR #1058（`FakeMemoryStore.requeueEmbedJobs` の `limit` のガード）と PR #1059
 * （`FakeOutboxStore.claimBatch` の `leaseMs` のガード）の確かめ直しで、既存の歯
 * （`fake-store-postgres-parity.test.ts`。壊れた値を断る側だけ）がすり抜けた変異を押さえる歯。
 * testkit の `InMemory*` 側には、同じ陽性対照が既にある（`in-memory-fixtures-requeue-embed-jobs-limit.test.ts`・
 * `in-memory-fixtures-claim-batch-lease-ms.test.ts`）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2100-01-01T00:00:00.000Z");

function failedMemory(i: number): NewMemory {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: `fixture-hash-${i}`,
    digest: "テスト用の要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
    }),
    embeddingStatus: "failed",
  };
}

describe("FakeMemoryStore.requeueEmbedJobs: limit のガード（PR #1058）", () => {
  // 変異（負数を先に見る）を捕まえる。約束: `archiveDecayed` と同じ2段で、非整数を先に、次に負数を見る
  // （例外の文言も揃える）。-1.5 は「must be an integer」で断る。
  it("limit=-1.5 は「must be an integer」で断り、limit=-1 は「must not be negative」で断る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, failedMemory(0));
    await expect(
      memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: -1.5 }),
    ).rejects.toThrow(/requeueEmbedJobs: limit must be an integer \(got -1\.5\)/);
    await expect(
      memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: -1 }),
    ).rejects.toThrow(/requeueEmbedJobs: limit must not be negative \(got -1\)/);
  });

  // 変異（0 を断る・`isSafeInteger` で断る・2^62 以上を断る）を捕まえる。約束: 正常系は変えていない
  // （0・1・ちょうど・+1・2^62 が Postgres と同じ件数になる。PR 本文）。
  for (const [limit, expected] of [
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 3],
    [2 ** 62, 3],
  ] as const) {
    it(`limit=${limit} は ${expected} 件を積み直す（回帰確認）`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      for (let i = 0; i < 3; i++) await memoryStore.createMemory(ctx, failedMemory(i));
      const result = await memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit });
      expect(result.requeued).toBe(expected);
      expect(result.memoryIds).toHaveLength(expected);
    });
  }
});

describe("FakeOutboxStore.claimBatch: leaseMs が小数でも断らない（PR #1059）", () => {
  // 変異（`leaseMs` が整数でなければ断る）を捕まえる。約束: 有限の `leaseMs`（0・負数・小数を含む）の
  // 挙動は変えていない（PR 本文）。core の既存の歯は 0・負数の陽性対照を持つが、小数は持っていなかった。
  it("leaseMs=0.5 は断らず、未 claim のジョブを claim する", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, failedMemory(0));
    await memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 1 });

    const jobs = await outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 5,
      now: NOW,
      claimedBy: "test",
      leaseMs: 0.5,
    });

    expect(jobs.map((j) => j.attempts)).toEqual([1]);
  });
});
