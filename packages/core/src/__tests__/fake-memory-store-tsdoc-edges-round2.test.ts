import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `MemoryStore` の TSDoc が約束していて、どのテストも縛っていなかった振る舞いを、`FakeMemoryStore` について縛る
 * （2回目の棚卸し）。振る舞いは変えていない。同じ本文の歯を Postgres
 * （`packages/postgres/src/__tests__/memory-store-tsdoc-edges-round2.postgres.test.ts`）と testkit の fixture
 * （`packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts`）にも置いている。
 * 約束の一覧は Postgres 側の冒頭を見ること。
 *
 * `FakeMemoryStore` は適合試験の対象ではない（`fake-memory-store-supersede-with-new-memories.test.ts` 冒頭）。
 */

const IMPL = "FakeMemoryStore";

async function makeKit(): Promise<Kit> {
  const stores = createFakeRuntimeStores();
  return { store: stores.memoryStore, events: stores.eventStore };
}

interface Kit {
  store: MemoryStore;
  events: EventStore;
}

const ctx: Ctx = { tenantId: "tsdoc-promises-round2" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let hashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${hashCounter}`,
    contentHash: `tsdoc-round2-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "tsdoc-round2" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
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
    meta: { reason: "contested" },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("投げなかった");
}

async function contestedPair(kit: Kit): Promise<[MemoryId, MemoryId]> {
  const a = await kit.store.createMemory(ctx, newMemory());
  const b = await kit.store.createMemory(ctx, newMemory());
  await kit.store.markContestedPair!(
    ctx,
    { id: a.id, event: event(a.id) },
    { id: b.id, event: event(b.id) },
  );
  return [a.id, b.id];
}

async function eventCount(kit: Kit, memoryId: MemoryId): Promise<number> {
  return (await kit.events.list(ctx, { memoryId })).length;
}

describe(`${IMPL}.markContestedPair: CAS が破れたときの MemoryStatusConflictError の欄`, () => {
  it("expectedStatus は 'active'、memoryId と observedStatus は active でなかった側", async () => {
    const kit = await makeKit();
    const a = await kit.store.createMemory(ctx, newMemory());
    const b = await kit.store.createMemory(ctx, newMemory({ status: "archived" }));

    const error = await rejection(
      kit.store.markContestedPair!(
        ctx,
        { id: a.id, event: event(a.id) },
        { id: b.id, event: event(b.id) },
      ),
    );

    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    const conflict = error as MemoryStatusConflictError;
    expect({
      memoryId: conflict.memoryId,
      expectedStatus: conflict.expectedStatus,
      observedStatus: conflict.observedStatus,
    }).toEqual({ memoryId: b.id, expectedStatus: "active", observedStatus: "archived" });
  });
});

describe(`${IMPL}.resolveContestedPair: 両側 contested でも相互参照が成り立っていなければ CAS 破れ`, () => {
  it("別々の対の片側どうしを渡すと MemoryStatusConflictError（expectedStatus 'contested'）で、4件とも書き換えない", async () => {
    const kit = await makeKit();
    const [a, b] = await contestedPair(kit);
    const [c, d] = await contestedPair(kit);
    const before = { a: await eventCount(kit, a), c: await eventCount(kit, c) };

    const error = await rejection(
      kit.store.resolveContestedPair!(
        ctx,
        { id: a, status: "active", event: event(a) },
        { id: c, status: "active", event: event(c) },
      ),
    );

    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect((error as MemoryStatusConflictError).expectedStatus).toBe("contested");
    const snapshot = async (id: MemoryId) => {
      const memory = await kit.store.get(ctx, id);
      return { status: memory?.status, contestedWithId: memory?.contestedWithId };
    };
    expect({
      a: await snapshot(a),
      b: await snapshot(b),
      c: await snapshot(c),
      d: await snapshot(d),
      eventsA: await eventCount(kit, a),
      eventsC: await eventCount(kit, c),
    }).toEqual({
      a: { status: "contested", contestedWithId: b },
      b: { status: "contested", contestedWithId: a },
      c: { status: "contested", contestedWithId: d },
      d: { status: "contested", contestedWithId: c },
      eventsA: before.a,
      eventsC: before.c,
    });
  });
});

describe(`${IMPL}.purgeMemory: 変えない欄と、形の崩れた id`, () => {
  it("contentHash と digestSource は変えない（返り値も、読み直した行も）", async () => {
    const kit = await makeKit();
    const memory = await kit.store.createMemory(
      ctx,
      newMemory({ status: "forgotten", contentHash: "purge-keeps-hash", digestSource: "fallback" }),
    );

    const { memory: returned } = await kit.store.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      event(memory.id, { kind: "purged", digestSnapshot: memory.digest, meta: {} }),
    );
    const after = await kit.store.get(ctx, memory.id);

    expect({
      returnedContentHash: returned.contentHash,
      returnedDigestSource: returned.digestSource,
      afterContentHash: after?.contentHash,
      afterDigestSource: after?.digestSource,
    }).toEqual({
      returnedContentHash: "purge-keeps-hash",
      returnedDigestSource: "fallback",
      afterContentHash: "purge-keeps-hash",
      afterDigestSource: "fallback",
    });
  });

  it("id の形が崩れていても「memory not found」を投げる", async () => {
    const kit = await makeKit();

    await expect(
      kit.store.purgeMemory!(
        ctx,
        "not-a-uuid",
        { content: "[purged]", digest: "[purged]" },
        event("not-a-uuid", { kind: "purged", meta: {} }),
      ),
    ).rejects.toThrow(/memory not found/);
  });
});

describe(`${IMPL}.restoreSupersededBy / previewRestoreSupersededBy: イベントの欄と、形の崩れた id`, () => {
  it("unsuperseded イベントの digestSnapshot は、その Memory の（変えていない）今の digest", async () => {
    const kit = await makeKit();
    const anchor = await kit.store.createMemory(ctx, newMemory());
    const restored = await kit.store.createMemory(
      ctx,
      newMemory({ status: "superseded", supersededById: anchor.id, digest: "戻る記憶の要旨" }),
    );

    await kit.store.restoreSupersededBy!(ctx, anchor.id, { at: NOW });

    const events = await kit.events.list(ctx, { memoryId: restored.id });
    expect(events.map((e) => [e.kind, e.digestSnapshot])).toEqual([
      ["unsuperseded", "戻る記憶の要旨"],
    ]);
    expect((await kit.store.get(ctx, restored.id))?.digest).toBe("戻る記憶の要旨");
  });

  it("event.actor を省けば { type: 'system' }、渡せばその値がイベントに入る", async () => {
    const kit = await makeKit();
    const anchorA = await kit.store.createMemory(ctx, newMemory());
    const anchorB = await kit.store.createMemory(ctx, newMemory());
    const byDefault = await kit.store.createMemory(
      ctx,
      newMemory({ status: "superseded", supersededById: anchorA.id }),
    );
    const byOperator = await kit.store.createMemory(
      ctx,
      newMemory({ status: "superseded", supersededById: anchorB.id }),
    );

    await kit.store.restoreSupersededBy!(ctx, anchorA.id, { at: NOW });
    await kit.store.restoreSupersededBy!(ctx, anchorB.id, {
      at: NOW,
      actor: { type: "human", id: "operator-1" },
    });

    const actorOf = async (id: MemoryId) =>
      (await kit.events.list(ctx, { memoryId: id })).map((e) => e.actor);
    expect({
      byDefault: await actorOf(byDefault.id),
      byOperator: await actorOf(byOperator.id),
    }).toEqual({
      byDefault: [{ type: "system" }],
      byOperator: [{ type: "human", id: "operator-1" }],
    });
  });

  it("supersededById の形が崩れていても投げず、restored も candidates も空", async () => {
    const kit = await makeKit();
    await kit.store.createMemory(ctx, newMemory());

    expect({
      restore: await kit.store.restoreSupersededBy!(ctx, "not-a-uuid", { at: NOW }),
      preview: await kit.store.previewRestoreSupersededBy!(ctx, "not-a-uuid"),
    }).toEqual({ restore: { restored: [] }, preview: { candidates: [] } });
  });

  it("supersededReason は、at が最も新しい superseded イベントの meta.reason（積んだ順ではない）", async () => {
    const kit = await makeKit();
    const anchor = await kit.store.createMemory(ctx, newMemory());
    const target = await kit.store.createMemory(
      ctx,
      newMemory({ status: "superseded", supersededById: anchor.id }),
    );
    // 新しい at のほうを先に積む——積んだ順で選ぶ実装ならここで赤になる。
    await kit.events.append(
      ctx,
      event(target.id, {
        kind: "superseded",
        at: new Date("2026-05-02T00:00:00.000Z"),
        meta: { reason: "新しいほう" },
      }),
    );
    await kit.events.append(
      ctx,
      event(target.id, {
        kind: "superseded",
        at: new Date("2026-05-01T00:00:00.000Z"),
        meta: { reason: "古いほう" },
      }),
    );

    const { candidates } = await kit.store.previewRestoreSupersededBy!(ctx, anchor.id);

    expect(candidates).toEqual([{ memoryId: target.id, supersededReason: "新しいほう" }]);
  });
});

describe(`${IMPL}.archiveDecayed: clock が 'activity'/'either' なら nowSeq は必須`, () => {
  it.each(["activity", "either"] as const)(
    "clock: '%s' で nowSeq を省くと投げ、沈んだ行も archived にしない",
    async (clock) => {
      const kit = await makeKit();
      const decayed = await kit.store.createMemory(
        ctx,
        newMemory({ decayFloorAt: new Date("2000-01-01T00:00:00.000Z"), decayFloorSeq: 1 }),
      );

      await expect(kit.store.archiveDecayed!(ctx, { now: NOW, limit: 10, clock })).rejects.toThrow(
        /nowSeq/,
      );

      expect({
        status: (await kit.store.get(ctx, decayed.id))?.status,
        events: await eventCount(kit, decayed.id),
      }).toEqual({ status: "active", events: 0 });
    },
  );
});

describe(`${IMPL}.aggregateScope: 返す countKind はすべて 'exact'（ScopeAggregate.countKind「Phase 1 は常に 'exact'」）`, () => {
  it("どの filtered* 欄も 0 でない入力で、countKind・groups・notIndexed・filtered*・digestEligible がすべて 'exact'", async () => {
    const kit = await makeKit();
    const inPeriod = new Date("2026-03-01T00:00:00.000Z");
    const labelled = { tags: ["alpha"], occurredAt: inPeriod };
    await kit.store.createMemory(ctx, newMemory({ ...labelled, subjectId: "s1" }));
    await kit.store.createMemory(ctx, newMemory({ ...labelled, embeddingStatus: "pending" }));
    await kit.store.createMemory(ctx, newMemory({ ...labelled, embeddingStatus: "failed" }));
    await kit.store.createMemory(ctx, newMemory({ ...labelled, embeddingStatus: "skipped" }));
    await kit.store.createMemory(
      ctx,
      newMemory({ ...labelled, decayFloorAt: new Date("2000-01-01T00:00:00.000Z") }),
    );
    await kit.store.createMemory(ctx, newMemory({ ...labelled, status: "archived" }));
    await kit.store.createMemory(ctx, newMemory({ ...labelled, status: "superseded" }));
    await kit.store.createMemory(ctx, newMemory({ ...labelled, status: "forgotten" }));
    await kit.store.createMemory(
      ctx,
      newMemory({ tags: ["alpha"], occurredAt: new Date("2025-01-01T00:00:00.000Z") }),
    );
    await kit.store.createMemory(
      ctx,
      newMemory({ ...labelled, validUntil: new Date("2026-04-01T00:00:00.000Z") }),
    );
    await kit.store.createMemory(
      ctx,
      newMemory({ ...labelled, validFrom: new Date("2026-07-01T00:00:00.000Z") }),
    );
    await kit.store.createMemory(ctx, newMemory({ tags: ["beta"], occurredAt: inPeriod }));

    const aggregate = await kit.store.aggregateScope(
      ctx,
      {
        occurredAfter: new Date("2026-02-01T00:00:00.000Z"),
        validAt: NOW,
        labels: ["alpha"],
        decayFloorAtAfter: NOW,
      },
      { digestBand: { limit: 10, excludeMemoryIds: [] } },
    );

    // 入力がどの欄も踏んでいること（0 の欄の countKind を見ても意味が薄い）。
    expect({
      totalInScope: aggregate.totalInScope,
      pending: aggregate.notIndexed.pending.count,
      failed: aggregate.notIndexed.failed.count,
      skipped: aggregate.notIndexed.skipped.count,
      archived: aggregate.filteredArchived.count,
      superseded: aggregate.filteredSuperseded.count,
      forgotten: aggregate.filteredForgotten.count,
      period: aggregate.filteredPeriod.count,
      expired: aggregate.filteredExpired.count,
      notYetValid: aggregate.filteredNotYetValid.count,
      taxonomy: aggregate.filteredTaxonomy?.count,
      decayed: aggregate.filteredDecayed.count,
      digestEligible: aggregate.digestEligible.count,
    }).toEqual({
      totalInScope: 5,
      pending: 1,
      failed: 1,
      skipped: 1,
      archived: 1,
      superseded: 1,
      forgotten: 1,
      period: 1,
      expired: 1,
      notYetValid: 1,
      taxonomy: 1,
      decayed: 1,
      digestEligible: 5,
    });
    const kinds = {
      countKind: aggregate.countKind,
      groups: aggregate.groups.map((g) => g.countKind),
      notIndexed: Object.values(aggregate.notIndexed).map((v) => v.countKind),
      filteredArchived: aggregate.filteredArchived.countKind,
      filteredSuperseded: aggregate.filteredSuperseded.countKind,
      filteredForgotten: aggregate.filteredForgotten.countKind,
      filteredPeriod: aggregate.filteredPeriod.countKind,
      filteredExpired: aggregate.filteredExpired.countKind,
      filteredNotYetValid: aggregate.filteredNotYetValid.countKind,
      filteredTaxonomy: aggregate.filteredTaxonomy?.countKind,
      filteredDecayed: aggregate.filteredDecayed.countKind,
      digestEligible: aggregate.digestEligible.countKind,
    };
    expect(kinds).toEqual({
      countKind: "exact",
      groups: aggregate.groups.map(() => "exact"),
      notIndexed: ["exact", "exact", "exact"],
      filteredArchived: "exact",
      filteredSuperseded: "exact",
      filteredForgotten: "exact",
      filteredPeriod: "exact",
      filteredExpired: "exact",
      filteredNotYetValid: "exact",
      filteredTaxonomy: "exact",
      filteredDecayed: "exact",
      digestEligible: "exact",
    });
    expect(aggregate.groups.length).toBeGreaterThan(0);
  });
});

describe(`${IMPL}.aggregateScope の目次帯（digests / digestEligible）: スコープ内なら載る`, () => {
  it("contested な Memory も載る（段1と同じ status ゲート）", async () => {
    const kit = await makeKit();
    const [a, b] = await contestedPair(kit);
    const active = await kit.store.createMemory(ctx, newMemory());

    const aggregate = await kit.store.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 10, excludeMemoryIds: [] } },
    );

    expect({
      ids: aggregate.digests.map((d) => d.memoryId).sort(),
      eligible: aggregate.digestEligible.count,
    }).toEqual({ ids: [a, b, active.id].sort(), eligible: 3 });
  });

  it("validAt のゲートの外（期限切れ・まだ有効でない）は載らない", async () => {
    const kit = await makeKit();
    await kit.store.createMemory(ctx, newMemory({ validUntil: NOW }));
    await kit.store.createMemory(
      ctx,
      newMemory({ validFrom: new Date("2026-06-02T00:00:00.000Z") }),
    );
    const valid = await kit.store.createMemory(
      ctx,
      newMemory({
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );

    const aggregate = await kit.store.aggregateScope(
      ctx,
      { validAt: NOW },
      { digestBand: { limit: 10, excludeMemoryIds: [] } },
    );

    expect({
      ids: aggregate.digests.map((d) => d.memoryId),
      eligible: aggregate.digestEligible.count,
    }).toEqual({ ids: [valid.id], eligible: 1 });
  });

  it("減衰しきった Memory（filteredDecayed に数えたもの）も、群カウントにも帯にも載る", async () => {
    const kit = await makeKit();
    const decayed = await kit.store.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date("2000-01-01T00:00:00.000Z") }),
    );
    const alive = await kit.store.createMemory(ctx, newMemory());

    const aggregate = await kit.store.aggregateScope(
      ctx,
      { decayFloorAtAfter: NOW },
      { digestBand: { limit: 10, excludeMemoryIds: [] } },
    );

    expect({
      filteredDecayed: aggregate.filteredDecayed.count,
      totalInScope: aggregate.totalInScope,
      groupsTotal: aggregate.groups
        .filter((g) => g.axis === "subject")
        .reduce((sum, g) => sum + g.count, 0),
      ids: aggregate.digests.map((d) => d.memoryId).sort(),
      eligible: aggregate.digestEligible.count,
    }).toEqual({
      filteredDecayed: 1,
      totalInScope: 2,
      groupsTotal: 2,
      ids: [decayed.id, alive.id].sort(),
      eligible: 2,
    });
  });
});
