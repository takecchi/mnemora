import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 実際の store では purge は `forgotten` の行にしか効かないので、`status` が `active` のまま `purgedAt` だけが立った行は runtime の経路では作れない。
 * 判定の `purgedAt` 側だけを独立に縛るため、種の `get` が返す行を差し替えて作る（`fake-embed-job-skips-withdrawn.test.ts` の `purgedOnly` と同じ作り方）。
 * 差し替えない対照（種が active なら、同じ近傍を束ねる）が、この構成で近傍が拾えることを示す。
 */

const ctx: Ctx = { tenantId: "withdrawn-seed-purged-at-only" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory>): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1e12),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    // consolidate の schema は `outcome` を、reflect の schema は `outcome: "reflected"` を要る（余分な欄は落ちる）。
    req.schema.parse({ outcome: "reflected", content: "統合・内省の本文" }) as T,
};

function withPurgedAtOnlyFor<T extends { get: (c: Ctx, id: string) => Promise<Memory | null> }>(
  store: T,
  seedId: () => string,
): T {
  return new Proxy(store, {
    get(target, prop, recv) {
      if (prop === "get") {
        return async (c: Ctx, id: string) => {
          const m = await target.get(c, id);
          return m !== null && m.id === seedId()
            ? ({ ...m, status: "active", purgedAt: new Date() } as Memory)
            : m;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function setup(purgedAtOnly: boolean) {
  const stores = createFakeRuntimeStores();
  let seedId = "";
  const runtime = createRuntime({
    memoryStore: purgedAtOnly
      ? withPurgedAtOnlyFor(stores.memoryStore, () => seedId)
      : stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const space = stores.embeddingProvider.space;
  const seed = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ content: "seed content", digest: "seed", embeddingStatus: "ready" }),
  );
  seedId = seed.id;
  await stores.vectorStore.upsert(ctx, space, seed.id, [4, 0]);
  const neighbor = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ content: "neighbor content", digest: "hn", embeddingStatus: "ready" }),
  );
  await stores.vectorStore.upsert(ctx, space, neighbor.id, [8, 0]);
  return { runtime, stores, seed, neighbor };
}

describe("種が purgedAt だけ立った記憶（status は active のまま）でも、近傍を集めない", () => {
  it("consolidate: 対照（種が普通の active）は近傍と一緒に統合される", async () => {
    const { runtime, seed, neighbor } = await setup(false);
    const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed.id } });
    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, neighbor.id]);
  });

  it("consolidate: 近傍を集めず、LLM も呼ばず、何も書かない", async () => {
    const { runtime, stores, seed, neighbor } = await setup(true);
    const eventsBefore = stores.eventStore.events.length;

    const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed.id } });

    expect(result.outcome).toBe("nothing_to_consolidate");
    // 近傍を集めなかったので対象は種1件だけ（`getMany` は差し替えていないので、種の行は active のまま読まれ、
    // 理由は `single_eligible_source` になる）。
    expect(result.llmCalls).toBe(0);
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id]);
    expect((await stores.memoryStore.get(ctx, neighbor.id))?.status).toBe("active");
    expect(stores.eventStore.events.length).toBe(eventsBefore);
  });

  it("reflect: 対照（種が普通の active）は近傍と一緒に土台になる", async () => {
    const { runtime, seed, neighbor } = await setup(false);
    const result = await runtime.reflect(ctx, { target: { seedMemoryId: seed.id } });
    expect(result.outcome).toBe("reflected");
    expect(result.basis.map((b) => b.memoryId)).toEqual([seed.id, neighbor.id]);
  });

  it("reflect: 近傍を集めず、土台は種1件だけになる", async () => {
    const { runtime, stores, seed, neighbor } = await setup(true);

    const result = await runtime.reflect(ctx, { target: { seedMemoryId: seed.id } });

    // 近傍を集めなかったので、土台は種1件だけ。reflect は1件からの一般化も許す（`getMany` は差し替えて
    // いないので、種の行は active のまま読まれ、種だけを土台に内省する）。近傍は土台に入らない。
    expect(result.basis.map((b) => b.memoryId)).toEqual([seed.id]);
    expect(stores.eventStore.events.filter((e) => e.memoryId === neighbor.id)).toEqual([]);
  });
});
