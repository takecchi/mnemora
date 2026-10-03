import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0521: core の `FakeMemoryStore`（と `FakeVectorStore`・`FakeRelationStore`・`FakeEventStore`）も、操作の対象の
 * id の大文字小文字を区別しない——`@mnemora/postgres` が uuid 型の列で比べる・入口で `normalizeUuidCase` を掛けるのに揃えた
 * （ADR 0446 が「既存の違い」としていた点。ADR 0469・0475 はイベントの指し先だけを揃えていた）。
 *
 * 各 `it`: 大文字にした id を渡した操作が、小文字の id と同じ結果になること（状態・積まれるイベントの `memoryId` が小文字）。
 * 3実装の突き合わせは `packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`。
 * この Fake の id は小文字の `mem-N` だけで、小文字にそろえても別の id と混ざらない。
 * conformance suite には何も足していない（ADR 0434 決定5。約束を足すのはオーナーの判断）。
 */

const ctx: Ctx = { tenantId: "fake-uppercase-target" };
const T0 = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async (_c, req) => {
    const parsed = (
      req as { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }
    ).schema.safeParse({ content: "merged", digest: "merged" });
    if (parsed.success) return parsed.data as never;
    throw new Error("stub: no candidate matched");
  },
};

function setup() {
  let now = T0.getTime();
  const stores = createFakeRuntimeStores();
  const rt = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    relationStore: stores.relationStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (c: string) => `sha256(${c})`,
    clock: { now: () => new Date(now) },
  });
  let n = 0;
  const make = async (halfLifeHours = 24 * 365): Promise<MemoryId> => {
    n += 1;
    const recordedAt = new Date(now);
    const m: NewMemory = {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文 ${n}`,
      contentHash: `h-${n}`,
      digest: `要旨 ${n}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fake-uppercase" },
      tags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
    };
    const created = await stores.memoryStore.createMemory(ctx, m);
    const dims = stores.embeddingProvider.space.dimensions;
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      created.id,
      Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0)),
    );
    now += 1000;
    return created.id;
  };
  const up = (id: MemoryId) => id.toUpperCase() as MemoryId;
  const status = async (id: MemoryId) => (await stores.memoryStore.get(ctx, id))?.status;
  const eventsOf = async (id: MemoryId, kind: string) =>
    (await stores.eventStore.list(ctx, { memoryId: id })).filter((e) => e.kind === kind);
  return {
    stores,
    rt,
    make,
    up,
    status,
    eventsOf,
    advance: (ms: number) => (now += ms),
    nowDate: () => new Date(now),
  };
}

describe("FakeMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521）", () => {
  it("forget・purge: 状態が変わり、積まれるイベントの memoryId は小文字", async () => {
    const { rt, make, up, status, eventsOf, stores } = setup();
    const a = await make();
    const r = await rt.forget(ctx, { memoryId: up(a) });
    expect(r.outcomes[0]?.kind).toBe("forgotten");
    expect(await status(a)).toBe("forgotten");
    expect((await eventsOf(a, "forgotten")).map((e) => e.memoryId)).toEqual([a]);
    const p = await rt.purge(ctx, { memoryId: up(a) });
    expect(p.outcomes[0]?.kind).toBe("purged");
    expect((await stores.memoryStore.get(ctx, a))?.purgedAt).toBeTruthy();
    expect((await eventsOf(a, "purged")).map((e) => e.memoryId)).toEqual([a]);
    const again = await rt.purge(ctx, { memoryId: up(a) });
    expect(again.outcomes[0]?.kind).toBe("already_purged");
  });

  it("restoreArchived: archived を大文字の id で戻せる", async () => {
    const { rt, make, up, status, advance, nowDate } = setup();
    const a = await make(1);
    advance(400 * 24 * 3600_000);
    await rt.sweepArchive(ctx, { now: nowDate(), limit: 50 } as never);
    expect(await status(a)).toBe("archived");
    const r = await rt.restoreArchived(ctx, { memoryId: up(a) });
    expect(r.outcomes[0]?.kind).toBe("restored");
    expect(await status(a)).toBe("active");
  });

  it("markContested・resolveContested: 対の相互参照・supersededById は小文字で持つ", async () => {
    const { rt, make, up, status, stores } = setup();
    const a = await make();
    const b = await make();
    const m = await rt.markContested(ctx, up(a), up(b));
    expect(m.outcome.kind).toBe("contested");
    expect((await stores.memoryStore.get(ctx, a))?.contestedWithId).toBe(b);
    const r = await rt.resolveContested(ctx, up(a), up(b), { kind: "supersede", winnerId: up(a) });
    expect(r.outcome.kind).toBe("resolved");
    expect(await status(a)).toBe("active");
    expect(await status(b)).toBe("superseded");
    expect((await stores.memoryStore.get(ctx, b))?.supersededById).toBe(a);
  });

  it("markContestedGroup・resolveContestedGroup", async () => {
    const { rt, make, up, status } = setup();
    const [a, b, c] = [await make(), await make(), await make()] as [MemoryId, MemoryId, MemoryId];
    const m = await rt.markContestedGroup!(ctx, [up(a), up(b), up(c)]);
    expect(m.outcome.kind).toBe("contested_group");
    expect(await status(b)).toBe("contested");
    const r = await rt.resolveContestedGroup!(ctx, [up(a), up(b), up(c)], {
      kind: "supersede",
      winnerId: up(a),
    });
    expect(r.outcome.kind).toBe("resolved");
    expect(await status(a)).toBe("active");
    expect(await status(c)).toBe("superseded");
  });

  it("consolidate・restoreSuperseded", async () => {
    const { rt, make, up, status, stores } = setup();
    const a = await make();
    const b = await make();
    const r = await rt.consolidate(ctx, { target: { memoryIds: [up(a), up(b)] } });
    expect(r.outcome).toBe("consolidated");
    expect(await status(a)).toBe("superseded");
    const merged = r.consolidatedMemoryId!;
    const back = await rt.restoreSuperseded(ctx, { supersededById: up(merged) });
    expect(back.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
    expect(await status(a)).toBe("active");
    expect((await stores.memoryStore.get(ctx, a))?.supersededById ?? null).toBe(null);
  });

  it("使用報告（memory_usage）: 例外にならず、使用の行は小文字の id で一度だけ入る", async () => {
    const { rt, make, up, stores } = setup();
    const a = await make();
    const rec = await rt.recall(ctx, {
      vector: Array.from({ length: stores.embeddingProvider.space.dimensions }, (_, i) =>
        i === 0 ? 1 : 0,
      ),
      limit: 10,
    });
    await rt.observe(ctx, { kind: "memory_usage", recallId: rec.recallId, usedMemoryIds: [up(a)] });
    const again = await stores.memoryStore.recordUsage(ctx, rec.recallId, [a]);
    expect(again.insertedMemoryIds).toEqual([]);
  });

  it("MemoryStore の口: get・getMany（綴り違いの重複は1件）・updateStatus・reinforce・setEmbeddingStatus", async () => {
    const { make, up, stores, nowDate } = setup();
    const ms = stores.memoryStore;
    const a = await make();
    const b = await make();
    expect((await ms.get(ctx, up(a)))?.id).toBe(a);
    expect((await ms.getMany(ctx, [a, up(a), up(b)])).map((m) => m.id)).toEqual([a, b]);
    const s = await ms.updateStatus(ctx, up(a), "superseded", { supersededById: up(b) });
    expect(s.id).toBe(a);
    expect(s.supersededById).toBe(b);
    expect((await ms.reinforce(ctx, up(b), new Date(nowDate().getTime() + 1000))).id).toBe(b);
    expect((await ms.setEmbeddingStatus(ctx, up(b), "pending")).id).toBe(b);
  });

  it("VectorStore・RelationStore・EventStore の口", async () => {
    const { make, up, stores, rt } = setup();
    const a = await make();
    const b = await make();
    const space = stores.embeddingProvider.space;
    await stores.vectorStore.upsert(
      ctx,
      space,
      up(a),
      Array.from({ length: space.dimensions }, () => 0.5),
    );
    const got = await stores.vectorStore.getVectors!(ctx, space, [a, up(a)]);
    expect(got.map((g) => g.memoryId)).toEqual([a]);
    await stores.vectorStore.delete(ctx, space, up(a));
    expect(await stores.vectorStore.getVectors!(ctx, space, [a])).toEqual([]);

    await stores.relationStore.link(ctx, "contradicts", up(a), up(b));
    expect(
      (await stores.relationStore.listRelated(ctx, up(a), "contradicts")).map((r) => r.memoryId),
    ).toEqual([b]);
    await stores.relationStore.unlink(ctx, "contradicts", up(a), up(b));
    expect(await stores.relationStore.listRelated(ctx, a, "contradicts")).toEqual([]);

    await rt.forget(ctx, { memoryId: a });
    expect((await stores.eventStore.list(ctx, { memoryId: up(a) })).length).toBe(1);
  });

  it("同じ記憶を綴り違いで2回渡した markContested は、同じ記憶どうしとして断る（Postgres と同じ）", async () => {
    const { rt, make, up } = setup();
    const a = await make();
    const m = await rt.markContested(ctx, a, up(a));
    expect(m.outcome.kind).toBe("ineligible");
  });

  it("EventStore.get: 大文字のイベント id でも同じイベントが当たる（ADR 0556。Postgres は uuid 型の列で比べる）", async () => {
    const { make, stores } = setup();
    const a = await make();
    const stored = await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: a,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "d",
      meta: {},
    });
    expect((await stores.eventStore.get(ctx, stored.id))?.id).toBe(stored.id);
    expect((await stores.eventStore.get(ctx, stored.id.toUpperCase() as never))?.id).toBe(
      stored.id,
    );
  });

  it("EventStore.get: 別のイベント id は、前方一致・部分一致では当たらず null（ADR 0580。Postgres は id の等しさで比べる）", async () => {
    const { make, stores } = setup();
    const a = await make();
    const stored = await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: a,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "d",
      meta: {},
    });
    // 実在の id の末尾の1字を落とした形は、`startsWith`・`includes` なら当たってしまう別の id。
    const prefix = stored.id.slice(0, -1) as never;
    expect(prefix).not.toBe(stored.id);
    expect(await stores.eventStore.get(ctx, prefix)).toBeNull();
    expect(await stores.eventStore.get(ctx, stored.id)).not.toBeNull();
  });
});
