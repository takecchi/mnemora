import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const INVALID = new Date(Number.NaN);
let hashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${hashCounter}`,
    contentHash: `atomic-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "atomic" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function event(memoryId: MemoryId, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: {},
    ...overrides,
  };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

/** Fake の中身（記憶・イベント・outbox のジョブ）を写し取る。投げた後に1つも変わっていないことを比べる。 */
function snapshotOf(stores: Stores) {
  const backing = (
    stores.memoryStore as unknown as {
      backing: { memories: Map<string, unknown>; events: unknown[]; outboxJobs: unknown[] };
    }
  ).backing;
  return structuredClone({
    memories: [...backing.memories.entries()],
    events: backing.events,
    outboxJobs: backing.outboxJobs,
  });
}

async function expectRejectsWithoutAnyWrite(stores: Stores, call: () => Promise<unknown>) {
  const before = snapshotOf(stores);
  await expect(call()).rejects.toThrow();
  expect(snapshotOf(stores)).toEqual(before);
}

async function contestedPair(stores: Stores) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory());
  const b = await stores.memoryStore.createMemory(ctx, newMemory());
  await stores.memoryStore.markContestedPair(
    ctx,
    { id: a.id, event: event(a.id) },
    { id: b.id, event: event(b.id) },
  );
  return { a, b };
}

async function supersededGroup(stores: Stores, size: number) {
  const anchor = await stores.memoryStore.createMemory(ctx, newMemory());
  const group = [];
  for (let i = 0; i < size; i += 1) {
    group.push(
      await stores.memoryStore.createMemory(
        ctx,
        newMemory({ status: "superseded", supersededById: anchor.id }),
      ),
    );
  }
  return { anchor, group };
}

describe("core の Fake: イベントが書けないときは、状態を1つも書き換えずに投げる", () => {
  it("purgeMemory", async () => {
    const stores = createFakeRuntimeStores();
    const m = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.purgeMemory(
        ctx,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        event(m.id, { kind: "purged", at: INVALID }),
      ),
    );
  });

  it.each([
    ["2件目の at が Invalid Date", { at: INVALID }],
    ["2件目の kind が列挙に無い", { kind: "not-a-kind" as never }],
  ])("markContestedPair（%s）", async (_label, broken) => {
    const stores = createFakeRuntimeStores();
    const a = await stores.memoryStore.createMemory(ctx, newMemory());
    const b = await stores.memoryStore.createMemory(ctx, newMemory());

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.markContestedPair(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id, broken) },
      ),
    );
  });

  it("resolveContestedPair（2件目の at が Invalid Date）", async () => {
    const stores = createFakeRuntimeStores();
    const { a, b } = await contestedPair(stores);

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        {
          id: b.id,
          status: "superseded",
          supersededById: a.id,
          event: event(b.id, { at: INVALID }),
        },
      ),
    );
  });

  it("resolveOrphanedContested（at が Invalid Date）", async () => {
    const stores = createFakeRuntimeStores();
    const { a, b } = await contestedPair(stores);
    await stores.memoryStore.updateStatus(ctx, b.id, "forgotten");

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.resolveOrphanedContested(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: event(a.id, { at: INVALID }),
      }),
    );
  });

  it("supersedeWithNewMemories（2件目の対象のイベントの at が Invalid Date）——新しい記憶も outbox のジョブも作らない", async () => {
    const stores = createFakeRuntimeStores();
    const first = await stores.memoryStore.createMemory(ctx, newMemory());
    const second = await stores.memoryStore.createMemory(ctx, newMemory());

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [{ input: newMemory({ content: "統合先" }), jobKinds: ["embed"] }],
        [
          { id: first.id, supersededByIndex: 0, event: event(first.id, { kind: "superseded" }) },
          {
            id: second.id,
            supersededByIndex: 0,
            event: event(second.id, { kind: "superseded", at: INVALID }),
          },
        ],
      ),
    );
  });

  it("restoreSupersededBy（対象2件、at が Invalid Date）——1件も戻さない", async () => {
    const stores = createFakeRuntimeStores();
    const { anchor } = await supersededGroup(stores, 2);

    await expectRejectsWithoutAnyWrite(stores, () =>
      stores.memoryStore.restoreSupersededBy(ctx, anchor.id, { at: INVALID }),
    );
  });
});

describe("core の Fake: やりすぎない——正しいイベントなら今どおり書き換え、イベントを積む", () => {
  it("6つの口とも、正しいイベントでは状態が変わり、イベントが積まれる", async () => {
    const stores = createFakeRuntimeStores();
    const events = () =>
      (stores.memoryStore as unknown as { backing: { events: unknown[] } }).backing.events.length;
    const start = events();

    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const purged = await stores.memoryStore.purgeMemory(
      ctx,
      forgotten.id,
      { content: "[purged]", digest: "[purged]" },
      event(forgotten.id, { kind: "purged" }),
    );
    const { a, b } = await contestedPair(stores);
    const resolved = await stores.memoryStore.resolveContestedPair(
      ctx,
      { id: a.id, status: "active", event: event(a.id) },
      { id: b.id, status: "superseded", supersededById: a.id, event: event(b.id) },
    );
    const pair = await contestedPair(stores);
    await stores.memoryStore.updateStatus(ctx, pair.b.id, "forgotten");
    const orphan = await stores.memoryStore.resolveOrphanedContested(ctx, {
      id: pair.a.id,
      contestedWithId: pair.b.id,
      event: event(pair.a.id),
    });
    const old = await stores.memoryStore.createMemory(ctx, newMemory());
    const superseded = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory({ content: "統合先2" }), jobKinds: ["embed"] }],
      [{ id: old.id, supersededByIndex: 0, event: event(old.id, { kind: "superseded" }) }],
    );
    const { anchor } = await supersededGroup(stores, 2);
    const restored = await stores.memoryStore.restoreSupersededBy(ctx, anchor.id, {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect({
      purgedContent: purged.memory.content,
      resolved: [resolved.first.status, resolved.second.status],
      orphan: orphan.memory.status,
      oldStatus: (await stores.memoryStore.get(ctx, old.id))?.status,
      newCreated: superseded.created[0]?.created,
      restored: restored.restored.map((m) => m.status),
      eventsAdded: events() - start,
    }).toEqual({
      purgedContent: "[purged]",
      resolved: ["active", "superseded"],
      orphan: "active",
      oldStatus: "superseded",
      newCreated: true,
      restored: ["active", "active"],
      eventsAdded: 11,
    });
  });
});
