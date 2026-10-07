import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { Memory, NewMemory } from "../memory.js";
import type { NewMemoryEvent } from "../event.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `tsdoc-edges-${contentHashCounter}`,
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

function backingMemories(stores: ReturnType<typeof createFakeRuntimeStores>): Map<string, Memory> {
  return (stores.memoryStore as unknown as { backing: { memories: Map<string, Memory> } }).backing
    .memories;
}

describe("FakeMemoryStore.listBySourceObservation: extractorVersion: null", () => {
  it("null を渡すと、その Observation の extractorVersion が null の行だけを返す", async () => {
    const stores = createFakeRuntimeStores();
    const obs = await stores.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "x" },
    });
    const other = await stores.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "y" },
    });
    const nullA = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const nullB = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const v1 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ sourceObservationId: obs.id, extractorVersion: "v1" }),
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ sourceObservationId: other.id, extractorVersion: null }),
    );

    const ids = async (version: string | null) =>
      (await stores.memoryStore.listBySourceObservation(ctx, obs.id, version))
        .map((m) => m.id)
        .sort();

    expect({ null: await ids(null), v1: await ids("v1") }).toEqual({
      null: [nullA.id, nullB.id].sort(),
      v1: [v1.id],
    });
  });
});

describe("FakeMemoryStore.requeueEmbedJobs: 選び方と、古い outbox 行", () => {
  it("updatedAt の古い順・同着は id の昇順で選び、繰り返すと一巡する", async () => {
    const stores = createFakeRuntimeStores();
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await stores.memoryStore.createMemory(ctx, newMemory()));
    }
    // 2件を同着（最も古い）、1件をそれより新しくする。同着の2件は id の昇順で並ぶ。
    const [late, tieX, tieY] = created;
    const memories = backingMemories(stores);
    memories.get(late!.id)!.updatedAt = new Date("2026-01-01T00:00:02.000Z");
    memories.get(tieX!.id)!.updatedAt = new Date("2026-01-01T00:00:01.000Z");
    memories.get(tieY!.id)!.updatedAt = new Date("2026-01-01T00:00:01.000Z");
    const ties = [tieX!.id, tieY!.id].sort();

    const picks: string[][] = [];
    for (let i = 0; i < 3; i += 1) {
      picks.push(
        (await stores.memoryStore.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 1 }))
          .memoryIds,
      );
    }

    expect(picks).toEqual([[ties[0]], [ties[1]], [late!.id]]);
  });

  it("失敗済みの古い embed 行には触らず、新しい行を attempts 0 で積む", async () => {
    const stores = createFakeRuntimeStores();
    const { memory, jobs } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), [
      "embed",
    ]);
    const [claimed] = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(Date.now() + 1_000),
      claimedBy: "worker-1",
      leaseMs: 60_000,
    });
    await stores.outboxStore.fail(ctx, claimed!.id, "boom", claimed!.attempts);
    await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    const oldBefore = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobs[0]!.id)!;

    await stores.memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

    const after = stores.outboxStore.listJobs(ctx);
    const newJobs = after.filter((j) => j.id !== jobs[0]!.id);
    expect({
      old: after.find((j) => j.id === jobs[0]!.id),
      newJobs: newJobs.map((j) => ({
        kind: j.kind,
        payload: j.payload,
        attempts: j.attempts,
        claimedAt: j.claimedAt ?? null,
        completedAt: j.completedAt,
        failedAt: j.failedAt,
      })),
    }).toEqual({
      old: { ...oldBefore, attempts: 1, lastError: "boom" },
      newJobs: [
        {
          kind: "embed",
          payload: { memoryId: memory.id },
          attempts: 0,
          claimedAt: null,
          completedAt: null,
          failedAt: null,
        },
      ],
    });
    expect(oldBefore.failedAt).not.toBeNull();
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: event.meta.supersededById", () => {
  it("呼び出し側が渡した meta.supersededById は、解決したアンカーの id で上書きし、meta の他の欄は変えない", async () => {
    const stores = createFakeRuntimeStores();
    const old = await stores.memoryStore.createMemory(ctx, newMemory());
    const decoy = await stores.memoryStore.createMemory(ctx, newMemory());
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: "digest",
      sizeBeforeBytes: null,
      meta: { reason: "caller-reason", supersededById: decoy.id, note: "keep" },
    };

    const result = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory({ content: "anchor" }), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event }],
    );

    const anchorId = result.created[0]!.memory.id;
    expect(anchorId).not.toBe(decoy.id);
    expect(result.superseded.map((e) => e.meta)).toEqual([
      { reason: "caller-reason", supersededById: anchorId, note: "keep" },
    ]);
  });
});
