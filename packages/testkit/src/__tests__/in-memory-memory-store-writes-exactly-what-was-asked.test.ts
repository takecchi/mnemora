import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function recallRecord(createdAt: Date): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
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
    createdAt,
  };
}

describe("InMemoryMemoryStore.createObservationWithOutbox: jobKinds の各要素につき1件のジョブを積む", () => {
  it("同じ kind が2回並んでいれば、畳まずに2件積む", async () => {
    const store = new InMemoryMemoryStore();

    const { jobs } = await store.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
      ["extract", "extract"],
    );

    expect(jobs.map((job) => job.kind)).toEqual(["extract", "extract"]);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(store.outboxJobs.filter((job) => job.tenantId === ctx.tenantId)).toHaveLength(2);
  });
});

describe("InMemoryMemoryStore.recordUsage: 記憶の status では挿入を断らない", () => {
  it("forgotten の記憶と purge 済みの記憶への使用報告も、挿入して返す", async () => {
    const store = new InMemoryMemoryStore();
    const recallId = await store.createRecall(ctx, recallRecord(new Date()));
    const forgotten = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-forgotten" }),
    );
    await store.updateStatus(ctx, forgotten.id, "forgotten");
    const purged = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "hash-purged",
        status: "forgotten",
      }),
    );
    await store.purgeMemory(
      ctx,
      purged.id,
      { content: "[purged]", digest: "[purged]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: purged.id, kind: "purged" }),
    );

    const result = await store.recordUsage(ctx, recallId, [forgotten.id, purged.id]);

    expect(result.insertedMemoryIds).toEqual([forgotten.id, purged.id]);
  });
});

describe("InMemoryMemoryStore.purgeExpiredRecalls: limit は recalls の行数で、recall_usages の行は数えない", () => {
  it("使用記録を2件持つ recall も、limit 1 で消し、使用記録の件数は purgedUsages に返す", async () => {
    const store = new InMemoryMemoryStore();
    const oldest = await store.createRecall(
      ctx,
      recallRecord(new Date("2026-01-01T00:00:00.000Z")),
    );
    const newer = await store.createRecall(ctx, recallRecord(new Date("2026-01-02T00:00:00.000Z")));
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-a" }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-b" }),
    );
    await store.recordUsage(ctx, oldest, [a.id, b.id]);

    const result = await store.purgeExpiredRecalls(ctx, {
      olderThan: new Date("2026-02-01T00:00:00.000Z"),
      limit: 1,
    });

    expect(result).toMatchObject({ purged: 1, purgedUsages: 2, reachedLimit: true });
    await expect(store.recordUsage(ctx, oldest, [a.id])).rejects.toThrow(
      /recall not found for tenant/,
    );
    expect((await store.recordUsage(ctx, newer, [a.id])).insertedMemoryIds).toEqual([a.id]);
  });
});

describe("InMemoryMemoryStore.purgeExpiredEvents: kind が superseded の行も、保持期間を過ぎれば消す", () => {
  it("events_purged 以外の期限切れの行を、superseded も含めて消す", async () => {
    const store = new InMemoryMemoryStore();
    const replacement = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-replacement" }),
    );
    const replaced = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-replaced" }),
    );
    await store.updateStatusWithEvent(
      ctx,
      replaced.id,
      "superseded",
      { supersededById: replacement.id },
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: replaced.id,
        kind: "superseded",
        at: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    const result = await store.purgeExpiredEvents(ctx, {
      olderThan: new Date("2026-02-01T00:00:00.000Z"),
      limit: 10,
    });

    expect(result.purged).toBe(1);
    expect(store.events.filter((event) => event.kind === "superseded")).toEqual([]);
  });
});

describe("InMemoryMemoryStore.eraseTenant: 消すのは自分が持つ10表だけで、outbox のジョブには触れない", () => {
  it("テナントの outbox ジョブを残し、deleted にも数えない", async () => {
    const store = new InMemoryMemoryStore();
    await store.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
      ["extract"],
    );

    const result = await store.eraseTenant(ctx, { limit: 1000 });

    // 消えるのは observations の1行だけ。
    expect(result).toEqual({ kind: "executed", deleted: 1, reachedLimit: false });
    expect(store.outboxJobs.filter((job) => job.tenantId === ctx.tenantId)).toHaveLength(1);
  });
});

describe("InMemoryMemoryStore.createObservation: 空文字の kind を拒まず、そのまま書いて返す", () => {
  it("createObservation は kind が空文字の Observation を書いて返す", async () => {
    const store = new InMemoryMemoryStore();

    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId, kind: "" }),
    );

    expect(observation.kind).toBe("");
    expect((await store.getObservation(ctx, observation.id))?.kind).toBe("");
  });

  it("createObservationWithOutbox も、kind が空文字の Observation を書いてジョブを積む", async () => {
    const store = new InMemoryMemoryStore();

    const { observation, created, jobs } = await store.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId, kind: "" }),
      ["extract"],
    );

    expect(created).toBe(true);
    expect(observation.kind).toBe("");
    expect(jobs).toHaveLength(1);
  });
});
