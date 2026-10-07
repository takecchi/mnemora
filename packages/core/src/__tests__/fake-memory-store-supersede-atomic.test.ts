import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let counter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `atomic-hash-${counter}`,
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
    ...overrides,
  };
}

function supersedeEvent(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
  };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

/** Fake の裏の状態（記憶・索引・ラベル・イベント・outbox）を写し取る。 */
function snapshotOf(stores: Stores) {
  const backing = (
    stores.memoryStore as unknown as {
      backing: {
        memories: Map<string, unknown>;
        extractionIndex: Map<string, unknown>;
        labels: Map<string, unknown>;
        memoryLabels: Map<string, Set<string>>;
        events: unknown[];
        outboxJobs: unknown[];
      };
    }
  ).backing;
  return structuredClone({
    memories: [...backing.memories.entries()],
    extractionIndex: [...backing.extractionIndex.entries()],
    labels: [...backing.labels.entries()],
    memoryLabels: [...backing.memoryLabels.entries()].map(([k, v]) => [k, [...v]]),
    events: backing.events,
    outboxJobs: backing.outboxJobs,
  });
}

async function newObservation(stores: Stores) {
  return stores.memoryStore.createObservation(ctx, {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "fixture" },
    occurredAt: null,
  });
}

describe("FakeMemoryStore.supersedeWithNewMemories は news の途中で失敗したら何も残さない（ADR 0564）", () => {
  it("news[1] の sourceObservationId が実在しないと投げ、news[0]・索引・ラベル・outbox・旧行のどれも変えない", async () => {
    const stores = createFakeRuntimeStores();
    const old = await stores.memoryStore.createMemory(ctx, newMemory());
    const observation = await newObservation(stores);
    const before = snapshotOf(stores);

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [
          {
            input: newMemory({
              tags: ["atomic-tag"],
              sourceObservationId: observation.id,
              extractorVersion: "atomic-v1",
            }),
            jobKinds: ["embed"],
          },
          { input: newMemory({ sourceObservationId: randomUUID() }), jobKinds: ["embed"] },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: supersedeEvent(old.id),
          },
        ],
      ),
    ).rejects.toThrow(/observation not found/);

    expect(snapshotOf(stores)).toEqual(before);
    expect((await stores.memoryStore.get(ctx, old.id))?.status).toBe("active");
    expect(
      await stores.memoryStore.listBySourceObservation(ctx, observation.id, "atomic-v1"),
    ).toEqual([]);
  });

  it("失敗のあとに news[0] を同じ入力で作り直すと、新規作成（created: true）になる（索引が残っていない）", async () => {
    const stores = createFakeRuntimeStores();
    const observation = await newObservation(stores);
    const first = newMemory({ sourceObservationId: observation.id, extractorVersion: "atomic-v2" });

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: first, jobKinds: [] },
          { input: newMemory({ sourceObservationId: randomUUID() }), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toThrow();

    const retry = await stores.memoryStore.createMemoryWithOutbox(ctx, first, ["embed"]);
    expect(retry.created).toBe(true);
    expect(retry.jobs).toHaveLength(1);
  });

  it("失敗しても、無関係な既存の記憶・ラベル・outbox の行は残る（巻き戻しすぎない）", async () => {
    const stores = createFakeRuntimeStores();
    const keep = await stores.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory({ tags: ["keep-tag"] }),
      ["embed"],
    );
    const before = snapshotOf(stores);

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory({ tags: ["keep-tag", "new-tag"] }), jobKinds: ["embed"] },
          { input: newMemory({ sourceObservationId: randomUUID() }), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toThrow();

    expect(snapshotOf(stores)).toEqual(before);
    expect(await stores.memoryStore.get(ctx, keep.memory.id)).not.toBeNull();
    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["keep-tag"]);
    expect(labels[0]?.proposedCount).toBe(1);
  });

  it("対照: 全部の news が正しければ全部書かれ、旧行は superseded になる", async () => {
    const stores = createFakeRuntimeStores();
    const old = await stores.memoryStore.createMemory(ctx, newMemory());
    const observation = await newObservation(stores);

    const result = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [
        {
          input: newMemory({ tags: ["ok-tag"], sourceObservationId: observation.id }),
          jobKinds: ["embed"],
        },
        { input: newMemory({ tags: ["ok-tag"] }), jobKinds: ["embed"] },
      ],
      [
        {
          id: old.id,
          supersededByIndex: 1,
          expectedStatus: "active",
          event: supersedeEvent(old.id),
        },
      ],
    );

    expect(result.created.map((c) => c.created)).toEqual([true, true]);
    expect(result.created.map((c) => c.jobs.length)).toEqual([1, 1]);
    expect(result.superseded).toHaveLength(1);
    const updated = await stores.memoryStore.get(ctx, old.id);
    expect(updated?.status).toBe("superseded");
    expect(updated?.supersededById).toBe(result.created[1]!.memory.id);
    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.proposedCount).toBe(2);
    const backing = snapshotOf(stores);
    expect(backing.outboxJobs).toHaveLength(2);
  });
});
