import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0549（ADR 0518 の TSDoc・ADR 0499 の約束）: core の Fake（`FakeMemoryStore`）の CAS（`expectedStatus`）も、
 * purge 済みの行（`status` は `forgotten` のまま、`purgedAt` が非 null）を、どの `expectedStatus` にも一致しないものとして弾く。
 * testkit の `InMemoryMemoryStore`（`casMismatch`）・`PostgresMemoryStore` と同じ。
 *
 * 対象の4か所: `updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories` の事前判定（ADR 0469 の willSupersede）・
 * 同 本処理（弾かれたら `conflicted`）。purge 済みの行は `runtime.forget` → `runtime.purge` で作る。
 */

const A: Ctx = { tenantId: "fake-cas-purged-a" };
const B: Ctx = { tenantId: "fake-cas-purged-b" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let counter = 0;

function newMemory(ctx: Ctx): NewMemory {
  counter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `fake-cas-purged-${counter}`,
    digest: `要旨 ${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-cas-purged" },
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
  const stores = createFakeRuntimeStores();
  const store = stores.memoryStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const backing = (
    store as unknown as { backing: { events: Array<{ memoryId: string | null }> } }
  ).backing;
  const ev = (memoryId: string | null): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  });
  /** forget → purge で、status は forgotten のまま purgedAt が入った行を作る。 */
  const makePurged = async () => {
    const m = await store.createMemory(A, newMemory(A));
    await runtime.forget(A, { memoryId: m.id });
    const result = await runtime.purge(A, { memoryId: m.id });
    expect(result.outcomes[0]?.kind).toBe("purged");
    const row = await store.get(A, m.id);
    expect(row?.status).toBe("forgotten");
    expect(row?.purgedAt).toBeInstanceOf(Date);
    return m;
  };
  return { store, backing, ev, makePurged };
}

describe("Fake の CAS は purge 済みの行を弾く（ADR 0549）", () => {
  it("updateStatus: expectedStatus 'forgotten' でも MemoryStatusConflictError。行は変わらない", async () => {
    const { store, makePurged } = setup();
    const m = await makePurged();
    const before = await store.get(A, m.id);
    const error = await store
      .updateStatus(A, m.id, "active", { expectedStatus: "forgotten" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    const after = await store.get(A, m.id);
    expect(after?.status).toBe("forgotten");
    expect(after?.purgedAt).toEqual(before?.purgedAt);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("updateStatusWithEvent: 同じく弾く。イベントは積まれない", async () => {
    const { store, backing, ev, makePurged } = setup();
    const m = await makePurged();
    const total = backing.events.length;
    const error = await store
      .updateStatusWithEvent(A, m.id, "active", { expectedStatus: "forgotten" }, ev(m.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect((await store.get(A, m.id))?.status).toBe("forgotten");
    expect(backing.events.length).toBe(total);
  });

  it("supersedeWithNewMemories: purge 済みの対象は conflicted に入る。status は変わらず、イベントも積まれない", async () => {
    const { store, backing, ev, makePurged } = setup();
    const m = await makePurged();
    const total = backing.events.length;
    const result = await store.supersedeWithNewMemories!(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: m.id, supersededByIndex: 0, expectedStatus: "forgotten", event: ev(m.id) }],
    );
    expect(result.conflicted).toEqual([{ id: m.id, observedStatus: "forgotten" }]);
    expect(result.superseded).toHaveLength(0);
    const after = await store.get(A, m.id);
    expect(after?.status).toBe("forgotten");
    expect(after?.supersededById ?? null).toBeNull();
    expect(backing.events.length).toBe(total);
  });

  it("supersedeWithNewMemories の事前判定: 弾かれる purge 済みの対象のイベント先は検査しない（別テナントでも例外にならない）", async () => {
    const { store, backing, ev, makePurged } = setup();
    const other = await store.createMemory(B, newMemory(B));
    const m = await makePurged();
    const total = backing.events.length;
    const result = await store.supersedeWithNewMemories!(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: m.id, supersededByIndex: 0, expectedStatus: "forgotten", event: ev(other.id) }],
    );
    expect(result.conflicted).toEqual([{ id: m.id, observedStatus: "forgotten" }]);
    expect(backing.events.length).toBe(total);
  });

  it("対照: purge していない forgotten の行は、expectedStatus 'forgotten' で通る", async () => {
    const { store } = setup();
    const m = await store.createMemory(A, { ...newMemory(A), status: "forgotten" });
    const updated = await store.updateStatus(A, m.id, "active", { expectedStatus: "forgotten" });
    expect(updated.status).toBe("active");
  });
});
