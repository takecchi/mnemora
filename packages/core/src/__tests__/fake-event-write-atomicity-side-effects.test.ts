import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-event-atomicity-side-effects" };
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
    contentHash: `side-effects-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "side-effects" },
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

describe("core の Fake: イベントが書けないとき、状態の外の書き込みも残さない", () => {
  it("updateStatusWithEvent は、superseded への書き換えを断ると supersededById も書かない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const target = await memoryStore.createMemory(ctx, newMemory());
    const winner = await memoryStore.createMemory(ctx, newMemory());

    await expect(
      memoryStore.updateStatusWithEvent(
        ctx,
        target.id,
        "superseded",
        { supersededById: winner.id, expectedStatus: "active" },
        event(target.id, { kind: "superseded", at: INVALID }),
      ),
    ).rejects.toThrow();

    const after = await memoryStore.get(ctx, target.id);
    expect(after?.status).toBe("active");
    expect(after?.supersededById ?? null).toBeNull();
  });

  it("purgeMemory は、ラベルの紐付けも目次帯の要旨も書き換えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const forgotten = await memoryStore.createMemory(
      ctx,
      newMemory({ tags: ["purge-kept-tag"], status: "forgotten" }),
    );
    const recallId = await memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      query: {},
      omitted: [],
      usage: {},
      indexBand: { digestBand: [{ memoryId: forgotten.id, digest: "元の要旨" }] },
      explain: { stages: [] },
      returnedMemories: [],
    } as never);

    await expect(
      memoryStore.purgeMemory(
        ctx,
        forgotten.id,
        { content: "[purged]", digest: "[purged]" },
        event(forgotten.id, { kind: "purged", at: INVALID }),
      ),
    ).rejects.toThrow();

    expect(await memoryStore.listLabels!(ctx)).toEqual([
      { name: "purge-kept-tag", status: "proposed", proposedCount: 1, registeredAt: null },
    ]);
    expect((await memoryStore.getRecall(ctx, recallId))?.indexBand).toEqual({
      digestBand: [{ memoryId: forgotten.id, digest: "元の要旨" }],
    });
  });

  it.each([
    ["at が Invalid Date", { at: INVALID }],
    ["kind が列挙に無い", { kind: "not-a-kind" as never }],
  ])(
    "supersedeWithNewMemories は、1件目の対象のイベントの %s でも、何も書かずに投げる",
    async (_label, broken) => {
      const { memoryStore } = createFakeRuntimeStores();
      const observation = await memoryStore.createObservation(ctx, {
        tenantId: ctx.tenantId,
        kind: "utterance",
        payload: { text: "t" },
        recordedAt: new Date("2026-01-01T00:00:00Z"),
      } as never);
      const first = await memoryStore.createMemory(ctx, newMemory());
      const second = await memoryStore.createMemory(ctx, newMemory());

      await expect(
        memoryStore.supersedeWithNewMemories(
          ctx,
          [
            {
              input: newMemory({ sourceObservationId: observation.id }),
              jobKinds: ["embed"],
            },
          ],
          [
            {
              id: first.id,
              supersededByIndex: 0,
              event: event(first.id, { kind: "superseded", ...broken }),
            },
            {
              id: second.id,
              supersededByIndex: 0,
              event: event(second.id, { kind: "superseded" }),
            },
          ],
        ),
      ).rejects.toThrow();

      expect((await memoryStore.get(ctx, first.id))?.status).toBe("active");
      expect((await memoryStore.get(ctx, second.id))?.status).toBe("active");
      expect(await memoryStore.listBySourceObservation(ctx, observation.id, null)).toEqual([]);
    },
  );

  it("restoreSupersededBy は、戻す対象が1件も無ければ、Invalid Date の at でも空で返す", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const anchor = await memoryStore.createMemory(ctx, newMemory());

    await expect(memoryStore.restoreSupersededBy(ctx, anchor.id, { at: INVALID })).resolves.toEqual(
      { restored: [] },
    );
  });
});
