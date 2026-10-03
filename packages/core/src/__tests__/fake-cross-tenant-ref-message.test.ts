import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewRecallRecord } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore`（ADR 0439）と `FakeVectorStore.upsert`（ADR 0436）が、別テナントの
 * memory・recall・observation を指す参照を、実在しない id と同じ message で断ることを縛る歯。
 *
 * クローンの判断: message（`... not found for tenant: <id>` の形）まで縛る。例外の型は縛らない
 * （`Error` の一種であればよい）。`toThrow(文字列)` は message の部分一致を見る。
 *
 * どの it も、同じ検査の中で「自テナントの参照は通る」も見る（検査の外し忘れ・やりすぎの両側に歯を当てる）。
 */

const ctxA: Ctx = { tenantId: "tenant-a" };
const ctxB: Ctx = { tenantId: "tenant-b" };
const space = { provider: "test", model: "fixture-model", dimensions: 3 };
let hashCounter = 0;

function newMemory(tenantId: string, overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `cross-tenant-hash-${hashCounter}`,
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

function newRecallRecord(tenantId: string): NewRecallRecord {
  return {
    tenantId,
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
  };
}

function newObservationInput(tenantId: string) {
  return {
    tenantId,
    subjectId: null,
    externalId: null,
    kind: "utterance" as const,
    payload: { text: "fixture" },
    occurredAt: null,
  };
}

describe("FakeMemoryStore: 別テナントの参照を断る（ADR 0439）", () => {
  it("recordUsage: 別テナントの recallId は recall not found for tenant で断り、自テナントの recallId は通す", async () => {
    const stores = createFakeRuntimeStores();
    const memoryA = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const recallB = await stores.memoryStore.createRecall(ctxB, newRecallRecord("tenant-b"));

    await expect(stores.memoryStore.recordUsage(ctxA, recallB, [memoryA.id])).rejects.toThrow(
      `FakeMemoryStore: recall not found for tenant: ${recallB}`,
    );

    const recallA = await stores.memoryStore.createRecall(ctxA, newRecallRecord("tenant-a"));
    const result = await stores.memoryStore.recordUsage(ctxA, recallA, [memoryA.id]);
    expect(result.insertedMemoryIds).toEqual([memoryA.id]);
  });

  it("recordUsage: 別テナントの memoryIds は memory not found for tenant で断り、自テナントの memoryIds は通す", async () => {
    const stores = createFakeRuntimeStores();
    const memoryA = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const memoryB = await stores.memoryStore.createMemory(ctxB, newMemory("tenant-b"));
    const recallA = await stores.memoryStore.createRecall(ctxA, newRecallRecord("tenant-a"));

    await expect(
      stores.memoryStore.recordUsage(ctxA, recallA, [memoryA.id, memoryB.id]),
    ).rejects.toThrow(`FakeMemoryStore: memory not found for tenant: ${memoryB.id}`);

    const result = await stores.memoryStore.recordUsage(ctxA, recallA, [memoryA.id]);
    expect(result.insertedMemoryIds).toEqual([memoryA.id]);
  });

  it("createMemory: 別テナントの sourceObservationId は observation not found for tenant で断り、自テナントのものは通す", async () => {
    const stores = createFakeRuntimeStores();
    const observationB = await stores.memoryStore.createObservation(
      ctxB,
      newObservationInput("tenant-b"),
    );

    await expect(
      stores.memoryStore.createMemory(
        ctxA,
        newMemory("tenant-a", { sourceObservationId: observationB.id }),
      ),
    ).rejects.toThrow(`FakeMemoryStore: observation not found for tenant: ${observationB.id}`);

    const observationA = await stores.memoryStore.createObservation(
      ctxA,
      newObservationInput("tenant-a"),
    );
    const created = await stores.memoryStore.createMemory(
      ctxA,
      newMemory("tenant-a", { sourceObservationId: observationA.id }),
    );
    expect(created.sourceObservationId).toBe(observationA.id);
  });

  it("createMemory: 別テナントの contestedWithId は memory not found for tenant で断り、自テナントのものは通す", async () => {
    const stores = createFakeRuntimeStores();
    const memoryB = await stores.memoryStore.createMemory(ctxB, newMemory("tenant-b"));

    await expect(
      stores.memoryStore.createMemory(ctxA, newMemory("tenant-a", { contestedWithId: memoryB.id })),
    ).rejects.toThrow(`FakeMemoryStore: memory not found for tenant: ${memoryB.id}`);

    const memoryA = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const created = await stores.memoryStore.createMemory(
      ctxA,
      newMemory("tenant-a", { contestedWithId: memoryA.id }),
    );
    expect(created.contestedWithId).toBe(memoryA.id);
  });

  it("createMemory: 別テナントの supersededById は memory not found for tenant で断り、自テナントのものは通す", async () => {
    const stores = createFakeRuntimeStores();
    const memoryB = await stores.memoryStore.createMemory(ctxB, newMemory("tenant-b"));

    await expect(
      stores.memoryStore.createMemory(ctxA, newMemory("tenant-a", { supersededById: memoryB.id })),
    ).rejects.toThrow(`FakeMemoryStore: memory not found for tenant: ${memoryB.id}`);

    const memoryA = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const created = await stores.memoryStore.createMemory(
      ctxA,
      newMemory("tenant-a", { supersededById: memoryA.id }),
    );
    expect(created.supersededById).toBe(memoryA.id);
  });

  it("updateStatus: 別テナントの supersededById は memory not found for tenant で断り、自テナントのものは通す", async () => {
    const stores = createFakeRuntimeStores();
    const target = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const memoryB = await stores.memoryStore.createMemory(ctxB, newMemory("tenant-b"));

    await expect(
      stores.memoryStore.updateStatus(ctxA, target.id, "superseded", {
        supersededById: memoryB.id,
      }),
    ).rejects.toThrow(`FakeMemoryStore: memory not found for tenant: ${memoryB.id}`);

    const successor = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const updated = await stores.memoryStore.updateStatus(ctxA, target.id, "superseded", {
      supersededById: successor.id,
    });
    expect(updated.supersededById).toBe(successor.id);
  });
});

describe("FakeVectorStore.upsert: 別テナントの記憶を指す upsert を断る（ADR 0436）", () => {
  it("別テナントの memoryId は memory not found for tenant で断り、自テナントの memoryId は通す", async () => {
    const stores = createFakeRuntimeStores();
    const memoryA = await stores.memoryStore.createMemory(ctxA, newMemory("tenant-a"));
    const memoryB = await stores.memoryStore.createMemory(ctxB, newMemory("tenant-b"));

    await expect(stores.vectorStore.upsert(ctxA, space, memoryB.id, [1, 0, 0])).rejects.toThrow(
      `FakeVectorStore: memory not found for tenant: ${memoryB.id}`,
    );

    await expect(
      stores.vectorStore.upsert(ctxA, space, memoryA.id, [1, 0, 0]),
    ).resolves.toBeUndefined();
    await expect(
      stores.vectorStore.upsert(ctxB, space, memoryB.id, [1, 0, 0]),
    ).resolves.toBeUndefined();
  });
});
