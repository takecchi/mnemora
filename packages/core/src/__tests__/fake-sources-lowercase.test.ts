import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-sources-lowercase" };
const T0 = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async (_c, req) => {
    const schema = (
      req as { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }
    ).schema;
    for (const cand of [
      { content: "merged", digest: "merged" },
      { outcome: "reflected", content: "reflection", digest: "reflection" },
    ]) {
      const parsed = schema.safeParse(cand);
      if (parsed.success) return parsed.data as never;
    }
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

describe("consolidate・reflect の created イベントの meta.sources は小文字（ADR 0527）", () => {
  const createdMeta = async (stores: ReturnType<typeof setup>["stores"], id: MemoryId) =>
    (await stores.eventStore.list(ctx, { memoryId: id })).find((e) => e.kind === "created")?.meta;

  it("consolidate { memoryIds }: 大文字で渡しても sources は小文字の行の id", async () => {
    const { rt, make, up, stores } = setup();
    const a = await make();
    const b = await make();
    const r = await rt.consolidate(ctx, { target: { memoryIds: [up(a), up(b)] } });
    expect(r.outcome).toBe("consolidated");
    const meta = await createdMeta(stores, r.consolidatedMemoryId!);
    expect(meta?.sources).toEqual([a, b]);
    const m = await stores.memoryStore.get(ctx, r.consolidatedMemoryId!);
    expect(m?.provenance).toMatchObject({ sources: [a, b] });
  });

  it("reflect { memoryIds } と { seedMemoryId }", async () => {
    const { rt, make, up, stores } = setup();
    const a = await make();
    const b = await make();
    const r1 = await rt.reflect(ctx, { target: { memoryIds: [up(a), up(b)] } } as never);
    const id1 =
      (r1 as { reflectedMemoryId?: MemoryId; memoryId?: MemoryId }).reflectedMemoryId ??
      (r1 as { memoryId?: MemoryId }).memoryId;
    expect((await createdMeta(stores, id1!))?.sources).toEqual([a, b]);
    const r2 = await rt.reflect(ctx, { target: { seedMemoryId: up(a) } } as never);
    const id2 =
      (r2 as { reflectedMemoryId?: MemoryId }).reflectedMemoryId ??
      (r2 as { memoryId?: MemoryId }).memoryId;
    const sources = (await createdMeta(stores, id2!))?.sources as string[];
    expect(sources[0]).toBe(a);
    expect(sources.every((s) => s === s.toLowerCase())).toBe(true);
  });

  it("小文字で渡したときは変わらない（やりすぎの対照）", async () => {
    const { rt, make, stores } = setup();
    const a = await make();
    const b = await make();
    const r = await rt.consolidate(ctx, { target: { memoryIds: [a, b] } });
    expect((await createdMeta(stores, r.consolidatedMemoryId!))?.sources).toEqual([a, b]);
  });

  it("同じ記憶を綴り違いで2回渡すと、2つ目は not_found（ADR 0521 の材料1）で、sources には1回だけ入る", async () => {
    const { rt, make, up, stores } = setup();
    const a = await make();
    const b = await make();
    const r = await rt.consolidate(ctx, { target: { memoryIds: [a, up(a), b] } });
    expect(r.sources.map((s) => s.kind)).toEqual(["superseded", "not_found", "superseded"]);
    expect((await createdMeta(stores, r.consolidatedMemoryId!))?.sources).toEqual([a, b]);
  });
});
