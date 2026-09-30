import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { SourceMemoryForgottenError, type MemoryStore } from "../interfaces/memory-store.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0416（穴 D-3 の続き）: `supersedeWithNewMemories` に `opts.buildCreatedEvent` を渡し、store が
 * 戻り値の `createdEventsWritten: true` で**名乗ったときだけ**、runtime は別の `created` の append を省く。
 * 名乗らない adapter（この fixture の `FakeMemoryStore`。引数を黙って無視する既存の第三者の実装の代表）では、
 * 今までどおり別の文で積む。`reflect` は `createMemoriesWithOutboxAndEvents?` があればそれで積む。
 *
 * この歯が無いと、「core のテストが緑」は名乗らない adapter の経路しか縛らない
 * （実 adapter の歯は `packages/postgres` の `runtime-created-event-same-tx.postgres.test.ts`）。
 */

const ctx: Ctx = { tenantId: "created-event-claim" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    // extract / consolidate / reflect のどの schema でも通る形を順に試す。
    for (const value of [
      { memories: candidates.map((content) => ({ content, provenanceKind: "stated" })) },
      { outcome: "reflected", content: "内省の本文" },
      { content: "統合後の本文" },
    ]) {
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return parsed.data as T;
    }
    throw new Error("unexpected schema");
  },
};

function makeKit() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const createdFor = (memoryId: string) =>
    stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "created");
  return { stores, runtime, createdFor };
}

type SupersedeFn = NonNullable<MemoryStore["supersedeWithNewMemories"]>;
type SupersedeOpts = Parameters<SupersedeFn>[3];

/**
 * 名乗る adapter のふり: `opts.buildCreatedEvent` を**受け取り**、`created: true` ごとに `EventStore` へ積んで
 * `createdEventsWritten: true` を返す。受け取った opts は `seen` に残す。`failAfter` なら、積んだあとで投げる。
 */
function claimSupersede(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  seen: { opts: SupersedeOpts | undefined; appends: number },
  failAfter = false,
) {
  // `FakeMemoryStore` の `supersedeWithNewMemories` は第4引数（opts）を受け取らない——名乗らない adapter の代表。
  // ここでは `MemoryStore` として扱い、opts を受け取って名乗る adapter に差し替える。
  const store: MemoryStore = stores.memoryStore;
  const original = store.supersedeWithNewMemories!.bind(store);
  store.supersedeWithNewMemories = async (c, news, supersede, opts) => {
    seen.opts = opts;
    const result = await original(c, news, supersede, opts);
    for (const [index, entry] of result.created.entries()) {
      if (entry.created && opts?.buildCreatedEvent !== undefined) {
        await stores.eventStore.append(c, opts.buildCreatedEvent(entry.memory, index));
        seen.appends += 1;
      }
    }
    if (failAfter) throw new Error("名乗る adapter が積んだあとで失敗した（テストの注入）");
    return { ...result, createdEventsWritten: true as const };
  };
}

describe("reextract: created の省略は、store が名乗ったときだけ（ADR 0416）", () => {
  async function setup() {
    const kit = makeKit();
    candidates = ["旧い事実"];
    const observed = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      externalId: "claim-reextract",
    });
    candidates = ["新しい事実"];
    return { ...kit, observationId: observed.observationId };
  }

  it("名乗らない adapter（FakeMemoryStore）: opts.buildCreatedEvent を渡しても、runtime が今までどおり別の文で created を積む", async () => {
    const { runtime, observationId, createdFor } = await setup();
    const result = await runtime.reextract(ctx, observationId);
    expect(result.memoryIds).toHaveLength(1);
    expect(createdFor(result.memoryIds[0]!)).toHaveLength(1);
  });

  it("名乗る adapter: runtime は別の append を省く（created は adapter が積んだ1件だけ）。渡した関数は同じ形の created を返す", async () => {
    const { stores, runtime, observationId, createdFor } = await setup();
    const seen: Parameters<typeof claimSupersede>[1] = { opts: undefined, appends: 0 };
    claimSupersede(stores, seen);
    const result = await runtime.reextract(ctx, observationId);
    expect(seen.opts?.buildCreatedEvent).toBeTypeOf("function");
    expect(seen.appends).toBe(1);
    const created = createdFor(result.memoryIds[0]!);
    expect(created).toHaveLength(1);
    expect(created[0]!.meta).toMatchObject({
      reason: "extracted",
      sourceObservationId: observationId,
    });
  });

  it("名乗る adapter が投げても、runtime は旧経路で撃ち直さない（created は積まれない。ADR 0100）", async () => {
    const { stores, runtime, observationId } = await setup();
    const before = stores.eventStore.events.filter((e) => e.kind === "created").length;
    claimSupersede(stores, { opts: undefined, appends: 0 }, true);
    // 名乗る adapter が「積んだあとで投げた」ので、この adapter の created は1件在る。runtime が足すと2件になる。
    await expect(runtime.reextract(ctx, observationId)).rejects.toThrow("テストの注入");
    const after = stores.eventStore.events.filter((e) => e.kind === "created").length;
    expect(after - before).toBe(1);
  });
});

describe("consolidate: created の省略は、store が名乗ったときだけ（ADR 0416）", () => {
  async function setup() {
    const kit = makeKit();
    const a = await kit.stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await kit.stores.memoryStore.createMemory(ctx, newMemory("B"));
    return { ...kit, ids: [a.id, b.id] };
  }

  it("名乗らない adapter（FakeMemoryStore）: runtime が別の文で created を1件積む（memoryId・digestSnapshot は実際の記憶のもの）", async () => {
    const { stores, runtime, ids, createdFor } = await setup();
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
    const created = createdFor(result.consolidatedMemoryId!);
    expect(created).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created[0]!.digestSnapshot).toBe(memory!.digest);
    expect(created[0]!.meta).toMatchObject({ reason: "consolidated", sources: ids });
  });

  it("名乗る adapter: runtime は別の append を省く（created は adapter が積んだ1件だけ）", async () => {
    const { stores, runtime, ids, createdFor } = await setup();
    const seen: Parameters<typeof claimSupersede>[1] = { opts: undefined, appends: 0 };
    claimSupersede(stores, seen);
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
    expect(seen.opts?.buildCreatedEvent).toBeTypeOf("function");
    expect(seen.opts?.abortIfForgotten).toEqual(ids);
    expect(seen.appends).toBe(1);
    expect(createdFor(result.consolidatedMemoryId!)).toHaveLength(1);
  });
});

describe("reflect: createMemoriesWithOutboxAndEvents? があればそれで積む（ADR 0416）", () => {
  async function setup() {
    const kit = makeKit();
    const a = await kit.stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await kit.stores.memoryStore.createMemory(ctx, newMemory("B"));
    return { ...kit, ids: [a.id, b.id] };
  }

  it("口が無い adapter（FakeMemoryStore）: 今までどおり createMemoryWithOutbox ＋別の append で created を1件積む", async () => {
    const { stores, runtime, ids, createdFor } = await setup();
    expect((stores.memoryStore as MemoryStore).createMemoriesWithOutboxAndEvents).toBeUndefined();
    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });
    expect(result.outcome).toBe("reflected");
    expect(createdFor(result.reflectedMemoryId!)).toHaveLength(1);
  });

  it("口がある adapter: 1件でその口を使い（abortIfForgotten も渡す）、runtime は別の append を省く", async () => {
    const { stores, runtime, ids, createdFor } = await setup();
    const calls: Array<{ count: number; abortIfForgotten: unknown }> = [];
    let withOutboxCalls = 0;
    const originalWithOutbox = stores.memoryStore.createMemoryWithOutbox.bind(stores.memoryStore);
    stores.memoryStore.createMemoryWithOutbox = async (...args) => {
      withOutboxCalls += 1;
      return originalWithOutbox(...args);
    };
    (stores.memoryStore as MemoryStore).createMemoriesWithOutboxAndEvents = async (
      c,
      news,
      build,
      opts,
    ) => {
      calls.push({ count: news.length, abortIfForgotten: opts?.abortIfForgotten });
      const written = [];
      for (const [index, { input, jobKinds }] of news.entries()) {
        const one = await originalWithOutbox(c, input, jobKinds);
        if (one.created) {
          await stores.eventStore.append(c, build(one.memory, []) satisfies NewMemoryEvent);
        }
        written.push({ index, ...one });
      }
      return { written, dropped: [] };
    };
    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });
    expect(result.outcome).toBe("reflected");
    expect(calls).toEqual([{ count: 1, abortIfForgotten: ids }]);
    expect(withOutboxCalls).toBe(0);
    const created = createdFor(result.reflectedMemoryId!);
    expect(created).toHaveLength(1);
    expect(created[0]!.meta).toMatchObject({ reason: "reflected", sources: ids });
  });

  it("口が SourceMemoryForgottenError を投げたら aborted_source_forgotten で返し、旧経路で撃ち直さない", async () => {
    const { stores, runtime, ids } = await setup();
    let withOutboxCalls = 0;
    const originalWithOutbox = stores.memoryStore.createMemoryWithOutbox.bind(stores.memoryStore);
    stores.memoryStore.createMemoryWithOutbox = async (...args) => {
      withOutboxCalls += 1;
      return originalWithOutbox(...args);
    };
    (stores.memoryStore as MemoryStore).createMemoriesWithOutboxAndEvents = async () => {
      throw new SourceMemoryForgottenError("createMemoriesWithOutboxAndEvents", [ids[0]!]);
    };
    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });
    expect(result.outcome).toBe("aborted_source_forgotten");
    expect(withOutboxCalls).toBe(0);
    expect(stores.eventStore.events.filter((e) => e.kind === "created")).toHaveLength(0);
  });
});
