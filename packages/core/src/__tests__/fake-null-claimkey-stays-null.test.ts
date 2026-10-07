import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const T0 = "2026-01-01T00:00:00.000Z";

let hashCounter = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `null-claimkey-hash-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    attributes: {},
    claimKey: null,
    occurredAt: new Date(T0),
    recordedAt: new Date(T0),
    lastReinforcedAt: new Date(T0),
    validFrom: new Date(T0),
    validUntil: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date(T0),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("入力の claimKey: null は、保存・返却のどちらでも null のまま（ADR 0588）", () => {
  it("createMemory: 返り値・liveRowForTest・get の claimKey が null", async () => {
    const stores = createFakeRuntimeStores();
    const created = await stores.memoryStore.createMemory(ctx, newMemory({ claimKey: null }));
    expect(created.claimKey).toBeNull();
    expect(stores.memoryStore.liveRowForTest(ctx, created.id)?.claimKey).toBeNull();
    expect((await stores.memoryStore.get(ctx, created.id))?.claimKey).toBeNull();
  });

  it("createMemoryWithOutbox: 新規でも再送でも claimKey が null", async () => {
    const stores = createFakeRuntimeStores();
    const obs = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: "ext-null-claimkey",
      kind: "utterance",
      payload: { text: "hello" },
      occurredAt: new Date(T0),
      recordedAt: new Date(T0),
      validFrom: new Date(T0),
      validUntil: null,
      attributes: {},
    });
    const input = newMemory({
      claimKey: null,
      sourceObservationId: obs.id,
      extractorVersion: "v1",
      contentHash: "null-claimkey-same",
    });
    const first = await stores.memoryStore.createMemoryWithOutbox(ctx, input, []);
    expect(first.created).toBe(true);
    expect(first.memory.claimKey).toBeNull();
    const again = await stores.memoryStore.createMemoryWithOutbox(ctx, input, []);
    expect(again.created).toBe(false);
    expect(again.memory.claimKey).toBeNull();
    expect(stores.memoryStore.liveRowForTest(ctx, first.memory.id)?.claimKey).toBeNull();
  });

  it("null の claimKey の行は、claimKey を持つ行の検索（findActiveByClaimKey）に出てこない", async () => {
    const stores = createFakeRuntimeStores();
    const withNull = await stores.memoryStore.createMemory(ctx, newMemory({ claimKey: null }));
    const probe = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ claimKey: { subject: "s", predicate: "p" } }),
    );
    const found = await stores.memoryStore.findActiveByClaimKey!(ctx, {
      subjectId: null,
      claimKey: { subject: "s", predicate: "p" },
      excludeMemoryId: probe.id,
      contentHash: "other-hash",
      validFrom: null,
      validUntil: null,
    });
    expect(found.map((m) => m.id)).not.toContain(withNull.id);
  });
});
