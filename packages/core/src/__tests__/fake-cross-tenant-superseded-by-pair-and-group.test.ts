import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const A: Ctx = { tenantId: "fake-xref-pair-group-a" };
const B: Ctx = { tenantId: "fake-xref-pair-group-b" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let counter = 0;

function newMemory(tenantId: string): NewMemory {
  counter += 1;
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `fake-xref-pair-group-${counter}`,
    digest: `要旨 ${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-xref-pair-group" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 168,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

function setup() {
  const store = createFakeRuntimeStores().memoryStore;
  const ev = (ctx: Ctx, memoryId: string): NewMemoryEvent => ({
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  });
  const mem = (ctx: Ctx): Promise<Memory> => store.createMemory(ctx, newMemory(ctx.tenantId));
  return { store, ev, mem };
}

describe("Fake: resolveContestedPair・resolveContestedGroup は、別テナントの memory を supersededById に書けない", () => {
  it("resolveContestedPair: 別テナントの supersededById は memory not found for tenant で断り、行は contested のまま。自テナントの勝者は通す", async () => {
    const { store, ev, mem } = setup();
    const [a, b] = [await mem(A), await mem(A)];
    const foreign = await mem(B);
    await store.markContestedPair!(
      A,
      { id: a.id, event: ev(A, a.id) },
      { id: b.id, event: ev(A, b.id) },
    );

    await expect(
      store.resolveContestedPair!(
        A,
        { id: a.id, status: "superseded", supersededById: foreign.id, event: ev(A, a.id) },
        { id: b.id, status: "active", event: ev(A, b.id) },
      ),
    ).rejects.toThrow(`FakeMemoryStore: memory not found for tenant: ${foreign.id}`);
    expect((await store.get(A, a.id))?.status).toBe("contested");
    expect((await store.get(A, b.id))?.status).toBe("contested");

    const ok = await store.resolveContestedPair!(
      A,
      { id: a.id, status: "superseded", supersededById: b.id, event: ev(A, a.id) },
      { id: b.id, status: "active", event: ev(A, b.id) },
    );
    expect(ok.first.supersededById).toBe(b.id);
  });

  it("resolveContestedGroup: 別テナントの supersededById は memory not found for tenant で断り、全員 contested のまま。自テナントの勝者は通す", async () => {
    const { store, ev, mem } = setup();
    const members = [await mem(A), await mem(A), await mem(A)];
    const foreign = await mem(B);
    await store.markContestedGroup!(
      A,
      members.map((m) => ({ id: m.id, event: ev(A, m.id) })),
    );
    const resolve = (by: string) =>
      store.resolveContestedGroup!(
        A,
        members.map((m, i) => ({
          id: m.id,
          status: i === 0 ? ("active" as const) : ("superseded" as const),
          ...(i === 0 ? {} : { supersededById: by }),
          event: ev(A, m.id),
        })),
      );

    await expect(resolve(foreign.id)).rejects.toThrow(
      `FakeMemoryStore: memory not found for tenant: ${foreign.id}`,
    );
    for (const m of members) {
      expect((await store.get(A, m.id))?.status).toBe("contested");
    }

    const done = await resolve(members[0]!.id);
    expect(done.members.filter((m) => m.supersededById === members[0]!.id)).toHaveLength(2);
  });
});
