import { describe, expect, it } from "vitest";
import type { Ctx, Memory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "memory-store-tsdoc-edges" };
let hashCounter = 0;
const memory = (overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) => {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `tsdoc-edges-${hashCounter}`,
    ...overrides,
  });
};

/** `updatedAt` を歯の側から決めるため、fixture の中の行に直接書く（`get` はスナップショットを返す）。 */
function setUpdatedAt(store: InMemoryMemoryStore, id: string, at: Date): void {
  (store as unknown as { memories: Map<string, Memory> }).memories.get(id)!.updatedAt = at;
}

describe("InMemoryMemoryStore.listBySourceObservation: extractorVersion: null", () => {
  it("null を渡すと、その Observation の extractorVersion が null の行だけを返す", async () => {
    const store = new InMemoryMemoryStore();
    const obs = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const other = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const nullA = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const nullB = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const v1 = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: "v1" }),
    );
    await store.createMemory(
      ctx,
      memory({ sourceObservationId: other.id, extractorVersion: null }),
    );

    const ids = async (version: string | null) =>
      (await store.listBySourceObservation(ctx, obs.id, version)).map((m) => m.id).sort();

    expect({ null: await ids(null), v1: await ids("v1") }).toEqual({
      null: [nullA.id, nullB.id].sort(),
      v1: [v1.id],
    });
  });
});

describe("InMemoryMemoryStore.requeueEmbedJobs: 選び方と、古い outbox 行", () => {
  it("updatedAt の古い順・同着は id の昇順で選び、繰り返すと一巡する", async () => {
    const store = new InMemoryMemoryStore();
    const late = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    const tieX = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    const tieY = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    setUpdatedAt(store, late.id, new Date("2026-01-01T00:00:02.000Z"));
    setUpdatedAt(store, tieX.id, new Date("2026-01-01T00:00:01.000Z"));
    setUpdatedAt(store, tieY.id, new Date("2026-01-01T00:00:01.000Z"));
    const ties = [tieX.id, tieY.id].sort();

    const picks: string[][] = [];
    for (let i = 0; i < 3; i += 1) {
      picks.push(
        (await store.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 1 })).memoryIds,
      );
    }

    expect(picks).toEqual([[ties[0]], [ties[1]], [late.id]]);
  });

  it("失敗済みの古い embed 行には触らず、新しい行を attempts 0 で積む", async () => {
    const store = new InMemoryMemoryStore();
    const outbox = new InMemoryOutboxStore(store.outboxJobs);
    const { memory: m, jobs } = await store.createMemoryWithOutbox(ctx, memory(), ["embed"]);
    const [claimed] = await outbox.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(Date.now() + 1_000),
      claimedBy: "worker-1",
      leaseMs: 60_000,
    });
    await outbox.fail(ctx, claimed!.id, "boom", claimed!.attempts);
    await store.setEmbeddingStatus(ctx, m.id, "failed");
    const oldBefore = { ...store.outboxJobs.find((j) => j.id === jobs[0]!.id)! };
    expect({ attempts: oldBefore.attempts, lastError: oldBefore.lastError }).toEqual({
      attempts: 1,
      lastError: "boom",
    });
    expect(oldBefore.failedAt).not.toBeNull();

    await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

    const tenantJobs = store.outboxJobs.filter((j) => j.tenantId === ctx.tenantId);
    expect({
      old: tenantJobs.find((j) => j.id === jobs[0]!.id),
      newJobs: tenantJobs
        .filter((j) => j.id !== jobs[0]!.id)
        .map((j) => ({
          kind: j.kind,
          payload: j.payload,
          attempts: j.attempts,
          claimedAt: j.claimedAt ?? null,
          completedAt: j.completedAt,
          failedAt: j.failedAt,
        })),
    }).toEqual({
      old: oldBefore,
      newJobs: [
        {
          kind: "embed",
          payload: { memoryId: m.id },
          attempts: 0,
          claimedAt: null,
          completedAt: null,
          failedAt: null,
        },
      ],
    });
  });
});

describe("InMemoryMemoryStore.supersedeWithNewMemories: event.meta.supersededById", () => {
  it("呼び出し側が渡した meta.supersededById は、解決したアンカーの id で上書きし、meta の他の欄は変えない", async () => {
    const store = new InMemoryMemoryStore();
    const old = await store.createMemory(ctx, memory());
    const decoy = await store.createMemory(ctx, memory());
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: old.digest,
      sizeBeforeBytes: null,
      meta: { reason: "caller-reason", supersededById: decoy.id, note: "keep" },
    };

    const result = await store.supersedeWithNewMemories(
      ctx,
      [{ input: memory({ content: "anchor" }), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event }],
    );

    const anchorId = result.created[0]!.memory.id;
    expect(anchorId).not.toBe(decoy.id);
    expect(result.superseded.map((e) => e.meta)).toEqual([
      { reason: "caller-reason", supersededById: anchorId, note: "keep" },
    ]);
  });
});
