import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "in-memory-fixtures-snapshots" };
const SPACE = { provider: "test", model: "snapshot", dimensions: 3 };
const T0 = new Date("2026-01-01T00:00:00.000Z");

function kit() {
  const memoryStore = new InMemoryMemoryStore();
  return {
    memoryStore,
    outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
    eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
    vectorStore: new InMemoryVectorStore(memoryStore),
  };
}

let counter = 0;
async function memory(
  store: InMemoryMemoryStore,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  counter += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `fixtures-snapshot-${counter}`,
      ...overrides,
    }),
  );
}

function observationInput() {
  return buildNewObservationFixture({
    tenantId: ctx.tenantId,
    payload: { text: "original" },
    attributes: { region: "jp" },
    occurredAt: new Date(T0),
  });
}

function recallRecord(): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "original" },
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
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe("(A) 後の操作で、受け取った値が遡って変わらない", () => {
  it("createObservationWithOutbox の jobs: 後の claimBatch / complete で書き換わらない", async () => {
    const { memoryStore, outboxStore } = kit();
    const { jobs } = await memoryStore.createObservationWithOutbox(ctx, observationInput(), [
      "extract",
    ]);
    const before = json(jobs);

    const [claimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 60_000),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    await outboxStore.complete(ctx, claimed!.id, claimed!.attempts);

    expect(json(jobs)).toBe(before);
  });
});

describe("(B) 受け取った値を書き換えても、store の中身が変わらない", () => {
  it("createObservation / getObservation の payload・attributes・Date", async () => {
    const { memoryStore } = kit();
    const created = await memoryStore.createObservation(ctx, observationInput());
    const before = json(await memoryStore.getObservation(ctx, created.id));

    (created.payload as { text: string }).text = "mutated-by-caller";
    created.attributes!["region"] = "mutated-by-caller";
    created.occurredAt!.setTime(0);
    expect(json(await memoryStore.getObservation(ctx, created.id))).toBe(before);

    const read = (await memoryStore.getObservation(ctx, created.id))!;
    (read.payload as { text: string }).text = "mutated-by-caller";
    read.recordedAt.setTime(0);
    expect(json(await memoryStore.getObservation(ctx, created.id))).toBe(before);
  });

  it("createObservationWithOutbox の observation と jobs の payload", async () => {
    const { memoryStore, outboxStore } = kit();
    const { observation, jobs } = await memoryStore.createObservationWithOutbox(
      ctx,
      observationInput(),
      ["extract"],
    );
    const beforeObservation = json(await memoryStore.getObservation(ctx, observation.id));

    (observation.payload as { text: string }).text = "mutated-by-caller";
    jobs[0]!.payload["observationId"] = "mutated-by-caller";
    jobs[0]!.availableAt.setTime(Date.now() + 10 * 365 * 24 * 3_600_000);

    expect(json(await memoryStore.getObservation(ctx, observation.id))).toBe(beforeObservation);
    const [claimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 60_000),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(claimed?.payload).toEqual({ observationId: observation.id });
  });

  it("getRecall の入れ子（query・omitted・returnedMemories・explain）", async () => {
    const { memoryStore } = kit();
    const id = await memoryStore.createRecall(ctx, recallRecord());
    const read = (await memoryStore.getRecall(ctx, id))!;
    const before = json(read);

    (read.query as { text: string }).text = "mutated-by-caller";
    read.omitted.push({ kind: "mutated-by-caller" } as never);
    read.returnedMemories.memories.push({ memoryId: "mutated-by-caller" } as never);
    read.explain.stages.push({ stage: "mutated-by-caller" } as never);
    read.createdAt.setTime(0);

    expect(json(await memoryStore.getRecall(ctx, id))).toBe(before);
  });

  it("listLabels / registerLabel の要素と registeredAt", async () => {
    const { memoryStore } = kit();
    const registered = await memoryStore.registerLabel(ctx, "home");
    const before = json(await memoryStore.listLabels(ctx));

    registered.proposedCount = 999;
    registered.registeredAt!.setTime(0);
    expect(json(await memoryStore.listLabels(ctx))).toBe(before);

    const [listed] = await memoryStore.listLabels(ctx);
    listed!.name = "mutated-by-caller";
    listed!.registeredAt!.setTime(0);
    expect(json(await memoryStore.listLabels(ctx))).toBe(before);
  });

  it("archiveDecayed の decayFloorAt", async () => {
    const { memoryStore } = kit();
    const m = await memory(memoryStore, { decayFloorAt: new Date(T0) });
    const { archived } = await memoryStore.archiveDecayed(ctx, {
      now: new Date("2030-01-01T00:00:00.000Z"),
      limit: 10,
    });
    expect(archived.map((a) => a.memoryId)).toEqual([m.id]);
    const before = json(await memoryStore.get(ctx, m.id));

    archived[0]!.decayFloorAt.setTime(0);
    expect(json(await memoryStore.get(ctx, m.id))).toBe(before);
  });

  it("purgeExpiredEvents（dryRun）の oldestPurgedAt・newestPurgedAt", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    await eventStore.append(
      ctx,
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: m.id,
        kind: "updated",
        at: new Date(T0),
      }),
    );
    const before = json(await eventStore.list(ctx, { memoryId: m.id }));

    const result = await memoryStore.purgeExpiredEvents(ctx, {
      olderThan: new Date("2030-01-01T00:00:00.000Z"),
      limit: 10,
      dryRun: true,
    });
    expect(result.purged).toBe(1);
    result.oldestPurgedAt!.setTime(0);
    result.newestPurgedAt!.setTime(0);

    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);
  });

  it("EventStore の append / get / list の meta・at", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    const appended = await eventStore.append(
      ctx,
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: m.id,
        kind: "updated",
        meta: { k: "v" },
      }),
    );
    const before = json(await eventStore.list(ctx, { memoryId: m.id }));

    appended.meta["k"] = "mutated-by-caller";
    appended.at.setTime(0);
    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);

    const got = (await eventStore.get(ctx, appended.id))!;
    got.meta["k"] = "mutated-by-caller";
    const [listed] = await eventStore.list(ctx, { memoryId: m.id });
    listed!.meta["k"] = "mutated-by-caller";
    listed!.at.setTime(0);
    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);
  });

  it("MemoryStore の *WithEvent が返すイベント", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    const { event } = await memoryStore.updateStatusWithEvent(
      ctx,
      m.id,
      "forgotten",
      {},
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId: m.id,
        kind: "forgotten",
        meta: { k: "v" },
      }),
    );
    const before = json(await eventStore.list(ctx, { memoryId: m.id }));

    event.meta["k"] = "mutated-by-caller";
    event.at.setTime(0);
    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);
  });

  it("VectorStore.getVectors の vector", async () => {
    const { memoryStore, vectorStore } = kit();
    const m = await memory(memoryStore);
    await vectorStore.upsert(ctx, SPACE, m.id, [1, 0, 0]);

    const [entry] = await vectorStore.getVectors(ctx, SPACE, [m.id]);
    entry!.vector[0] = 999;

    expect((await vectorStore.getVectors(ctx, SPACE, [m.id]))[0]!.vector).toEqual([1, 0, 0]);
  });

  it("OutboxStore.claimBatch の payload・Date", async () => {
    const { memoryStore, outboxStore } = kit();
    const { observation } = await memoryStore.createObservationWithOutbox(ctx, observationInput(), [
      "extract",
    ]);
    const now = Date.now() + 60_000;
    const [claimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(now),
      claimedBy: "worker",
      leaseMs: 60_000,
    });

    claimed!.payload["observationId"] = "mutated-by-caller";
    claimed!.claimedAt!.setTime(0);
    claimed!.availableAt.setTime(now + 10 * 365 * 24 * 3_600_000);

    const [reclaimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(now + 120_000),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(reclaimed?.payload).toEqual({ observationId: observation.id });
    const [early] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(now + 121_000),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(early).toBeUndefined();
  });
});

describe("(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない", () => {
  it("createObservation の payload・attributes・occurredAt", async () => {
    const { memoryStore } = kit();
    const input = observationInput();
    const created = await memoryStore.createObservation(ctx, input);
    const before = json(await memoryStore.getObservation(ctx, created.id));

    (input.payload as { text: string }).text = "mutated-by-caller";
    input.attributes!["region"] = "mutated-by-caller";
    input.occurredAt!.setTime(0);

    expect(json(await memoryStore.getObservation(ctx, created.id))).toBe(before);
  });

  it("createRecall の入れ子", async () => {
    const { memoryStore } = kit();
    const input = recallRecord();
    const id = await memoryStore.createRecall(ctx, input);
    const before = json(await memoryStore.getRecall(ctx, id));

    (input.query as { text: string }).text = "mutated-by-caller";
    input.omitted.push({ kind: "mutated-by-caller" } as never);
    input.returnedMemories.push({ memoryId: "mutated-by-caller" } as never);
    input.explain.stages.push({ stage: "mutated-by-caller" } as never);

    expect(json(await memoryStore.getRecall(ctx, id))).toBe(before);
  });

  it("createRecall に渡した createdAt（Issue #1731）", async () => {
    const { memoryStore } = kit();
    const input = recallRecord();
    input.createdAt = new Date(T0);
    const id = await memoryStore.createRecall(ctx, input);

    input.createdAt.setTime(0);

    expect((await memoryStore.getRecall(ctx, id))!.createdAt.getTime()).toBe(T0.getTime());
  });

  it("purgeMemory に渡した event.at は purgedAt に写り、後から書き換えても動かない（Issue #1731）", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    await memoryStore.updateStatusWithEvent(
      ctx,
      m.id,
      "forgotten",
      {},
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: m.id, kind: "forgotten" }),
    );
    const at = new Date(T0);
    await memoryStore.purgeMemory(
      ctx,
      m.id,
      { content: "[purged]", digest: "[purged]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: m.id, kind: "purged", at }),
    );

    at.setTime(0);

    const read = (await memoryStore.get(ctx, m.id))!;
    expect(read.purgedAt!.getTime()).toBe(T0.getTime());
    const purgedEvents = (await eventStore.list(ctx, { memoryId: m.id })).filter(
      (e) => e.kind === "purged",
    );
    expect(purgedEvents).toHaveLength(1);
    expect(purgedEvents[0]!.at.getTime()).toBe(T0.getTime());
  });

  it("EventStore.append の meta・at", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    const input = buildNewMemoryEventFixture({
      tenantId: ctx.tenantId,
      memoryId: m.id,
      kind: "updated",
      meta: { k: "v" },
      at: new Date(T0),
    });
    await eventStore.append(ctx, input);
    const before = json(await eventStore.list(ctx, { memoryId: m.id }));

    input.meta["k"] = "mutated-by-caller";
    input.at!.setTime(0);

    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);
  });

  it("MemoryStore の *WithEvent に渡したイベントの meta・at", async () => {
    const { memoryStore, eventStore } = kit();
    const m = await memory(memoryStore);
    const input = buildNewMemoryEventFixture({
      tenantId: ctx.tenantId,
      memoryId: m.id,
      kind: "forgotten",
      meta: { k: "v" },
      at: new Date(T0),
    });
    await memoryStore.updateStatusWithEvent(ctx, m.id, "forgotten", {}, input);
    const before = json(await eventStore.list(ctx, { memoryId: m.id }));

    input.meta["k"] = "mutated-by-caller";
    input.at!.setTime(0);

    expect(json(await eventStore.list(ctx, { memoryId: m.id }))).toBe(before);
  });

  it("VectorStore.upsert の vector", async () => {
    const { memoryStore, vectorStore } = kit();
    const m = await memory(memoryStore);
    const input = [1, 0, 0];
    await vectorStore.upsert(ctx, SPACE, m.id, input);

    input[0] = 999;

    expect((await vectorStore.getVectors(ctx, SPACE, [m.id]))[0]!.vector).toEqual([1, 0, 0]);
  });

  it("MemoryStore.reinforce の at", async () => {
    const { memoryStore } = kit();
    const m = await memory(memoryStore);
    const at = new Date("2030-01-01T00:00:00.000Z");
    await memoryStore.reinforce(ctx, m.id, at);
    const before = json(await memoryStore.get(ctx, m.id));

    at.setTime(0);

    expect(json(await memoryStore.get(ctx, m.id))).toBe(before);
  });

  it("OutboxStore.claimBatch の now（claimedAt に写る）", async () => {
    const { memoryStore, outboxStore } = kit();
    await memoryStore.createObservationWithOutbox(ctx, observationInput(), ["extract"]);
    const nowMs = Date.now() + 60_000;
    const now = new Date(nowMs);
    const [claimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now,
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(claimed).toBeDefined();

    now.setTime(0);

    const [early] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(nowMs + 1_000),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(early).toBeUndefined();
  });

  it("OutboxStore.claimBatch の now（取り直しのとき availableAt に写る）（#1120）", async () => {
    const { memoryStore, outboxStore } = kit();
    await memoryStore.createObservationWithOutbox(ctx, observationInput(), ["extract"]);
    const firstMs = Date.now() + 60_000;
    const [first] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(firstMs),
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();

    const reclaimMs = firstMs + 120_000;
    const reclaimNow = new Date(reclaimMs);
    const [reclaimed] = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: reclaimNow,
      claimedBy: "worker",
      leaseMs: 60_000,
    });
    expect(reclaimed).toBeDefined();

    reclaimNow.setTime(0);

    const stored = memoryStore.outboxJobs.find((job) => job.id === first!.id);
    expect(stored?.availableAt.getTime()).toBe(reclaimMs);
  });
});
