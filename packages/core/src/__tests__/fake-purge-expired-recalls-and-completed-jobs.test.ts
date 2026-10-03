import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.purgeExpiredRecalls` / `FakeOutboxStore.purgeCompletedJobs`
 * （[ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)）が、
 * `InMemoryMemoryStore` / `PostgresMemoryStore` と同じ契約を守っていることを固定する歯。
 *
 * **`packages/testkit` の適合テストの対象ではない**（`fake-archive-decayed-clock.test.ts` と同じ理由——
 * `FakeMemoryStore` は `packages/core` 自身の runtime テスト専用の別系統）。同じ契約の歯を、
 * 要点だけここに写している。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const NEW_RECALL = {
  tenantId: "tenant-1",
  subjectId: null,
  query: { text: "q" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

function newMemory(): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "purge-recalls-fake",
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

describe("FakeMemoryStore.purgeExpiredRecalls（ADR 0404）", () => {
  it("createRecall は createdAt を渡すとそれを使う", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    const id = await memoryStore.createRecall(ctx, { ...NEW_RECALL, createdAt });
    expect((await memoryStore.getRecall(ctx, id))?.createdAt).toEqual(createdAt);
  });

  it("古い recall を recall_usages ごと消し、境界と新しい recall は残す。消した recall への recordUsage は例外", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const cutoff = new Date("2025-01-01T00:00:00.000Z");
    const old = await memoryStore.createRecall(ctx, {
      ...NEW_RECALL,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const boundary = await memoryStore.createRecall(ctx, { ...NEW_RECALL, createdAt: cutoff });
    await memoryStore.recordUsage(ctx, old, [memory.id]);
    await memoryStore.recordUsage(ctx, boundary, [memory.id]);

    const dry = await memoryStore.purgeExpiredRecalls!(ctx, {
      olderThan: cutoff,
      limit: 10,
      dryRun: true,
    });
    expect(dry).toMatchObject({ purged: 1, purgedUsages: 1, dryRun: true });
    expect(await memoryStore.getRecall(ctx, old)).not.toBeNull();

    const result = await memoryStore.purgeExpiredRecalls!(ctx, { olderThan: cutoff, limit: 10 });
    expect(result).toMatchObject({ purged: 1, purgedUsages: 1, reachedLimit: false });
    expect(await memoryStore.getRecall(ctx, old)).toBeNull();
    expect(await memoryStore.getRecall(ctx, boundary)).not.toBeNull();
    await expect(memoryStore.recordUsage(ctx, old, [memory.id])).rejects.toThrow();
    // 境界の recall の使用記録は残っている。
    expect((await memoryStore.recordUsage(ctx, boundary, [memory.id])).insertedMemoryIds).toEqual(
      [],
    );
  });

  it("limit を超えると reachedLimit: true、負の limit は例外", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    for (let i = 0; i < 3; i++) {
      await memoryStore.createRecall(ctx, {
        ...NEW_RECALL,
        createdAt: new Date(Date.UTC(2020, 0, 1 + i)),
      });
    }
    const olderThan = new Date("2025-01-01T00:00:00.000Z");
    const first = await memoryStore.purgeExpiredRecalls!(ctx, { olderThan, limit: 2 });
    expect(first).toMatchObject({ purged: 2, reachedLimit: true });
    await expect(memoryStore.purgeExpiredRecalls!(ctx, { olderThan, limit: -2 })).rejects.toThrow();
  });
});

describe("FakeOutboxStore.purgeCompletedJobs（ADR 0404）", () => {
  it("completedAt が付いた古い行だけを消し、failed・claim 中・未処理は消さない", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      const { jobs: created } = await memoryStore.createObservationWithOutbox(
        ctx,
        { tenantId: "tenant-1", subjectId: null, externalId: null, kind: "utterance", payload: {} },
        ["embed"],
      );
      jobs.push(created[0]!);
    }
    const claimed = await outboxStore.claimBatch(ctx, {
      limit: 3,
      now: new Date(),
      claimedBy: "w",
      leaseMs: 60_000,
    });
    const [done, failed, inFlight] = claimed;
    await outboxStore.complete(ctx, done!.id, done!.attempts, {
      at: new Date("2020-01-01T00:00:00.000Z"),
    });
    await outboxStore.fail(ctx, failed!.id, "boom", failed!.attempts, {
      at: new Date("2000-01-01T00:00:00.000Z"),
    });

    const result = await outboxStore.purgeCompletedJobs!(ctx, {
      olderThan: new Date("2999-01-01T00:00:00.000Z"),
      limit: 10,
    });

    expect(result).toMatchObject({ purged: 1, reachedLimit: false });
    const remaining = outboxStore.listJobs(ctx).map((j) => j.id);
    expect(remaining).not.toContain(done!.id);
    expect(remaining).toContain(failed!.id);
    expect(remaining).toContain(inFlight!.id);
    expect(remaining).toHaveLength(3);
  });
});

describe("FakeMemoryStore.createRecall / getRecall（ADR 0480）", () => {
  it("createdAt が Invalid Date なら拒む（InMemory・Postgres と同じ）。活動時計も進めない", async () => {
    const { memoryStore, tenantSettingsStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createRecall(ctx, {
        ...NEW_RECALL,
        createdAt: new Date(Number.NaN),
        advanceActivityClock: true,
      }),
    ).rejects.toThrow(/createdAt must be a valid Date/);
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);
  });

  it("書いた後に入力を、読んだ後に戻り値を書き換えても、記録は変わらない（Postgres は往復で別物になる）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const input = {
      ...NEW_RECALL,
      query: { text: "q" },
      explain: { stages: [] as never[] },
      createdAt,
    };
    const id = await memoryStore.createRecall(ctx, input);
    (input.query as { text: string }).text = "changed";
    input.explain.stages.push({ stage: "x" } as never);
    // 渡した createdAt を後から書き換えても、記録の createdAt は動かない（ADR 0598）。
    createdAt.setTime(0);
    const first = await memoryStore.getRecall(ctx, id);
    expect(first?.query).toEqual({ text: "q" });
    expect(first?.explain.stages).toEqual([]);
    expect(first?.createdAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    (first!.query as { text: string }).text = "changed-again";
    first!.createdAt.setFullYear(1999);
    const second = await memoryStore.getRecall(ctx, id);
    expect(second?.query).toEqual({ text: "q" });
    expect(second!.createdAt.getFullYear()).not.toBe(1999);
  });
});
