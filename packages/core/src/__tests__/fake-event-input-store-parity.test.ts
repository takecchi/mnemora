import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-event-input-parity" };
const other: Ctx = { tenantId: "fake-event-input-parity-other" };

function memoryInput(): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "event-parity",
    digest: "本文",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "b" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2027-01-01T00:00:00Z"),
    embeddingStatus: "pending",
  } as NewMemory;
}

function event(memoryId: string, over: Record<string, unknown>): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: {},
    ...over,
  } as NewMemoryEvent;
}

describe("FakeEventStore.append", () => {
  it.each([
    ["meta が配列", { meta: [1, 2] }],
    ["meta が文字列", { meta: "x" }],
  ])("%s は受け付ける", async (_label, over) => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput());

    await expect(eventStore.append(ctx, event(memory.id, over))).resolves.toMatchObject({
      memoryId: memory.id,
    });
  });

  it("tenantId が ctx と違っても、ctx のテナントとして書く", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, memoryInput());

    const written = await eventStore.append(ctx, event(memory.id, { tenantId: other.tenantId }));

    expect(written.tenantId).toBe(ctx.tenantId);
    expect((await eventStore.list(ctx, { memoryId: memory.id })).map((e) => e.id)).toEqual([
      written.id,
    ]);
    expect(await eventStore.list(other, { memoryId: memory.id })).toEqual([]);
  });
});
