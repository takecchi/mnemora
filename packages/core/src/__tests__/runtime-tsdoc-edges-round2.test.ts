import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import type { ScopeAggregate } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `Runtime` と `ScopeAggregate` の TSDoc が約束していて、どのテストも縛っていなかった振る舞いを、core の Fake で縛る
 * （2回目の棚卸し）。振る舞いは変えていない。
 *
 * - `ScopeAggregate.filteredTaxonomy?`: 「実装しない adapter では `recall-runtime.ts` がこの欄の不在を『0件』として扱う」。
 * - `ConsolidationResult.atomicity`: 「`outcome` が `"consolidated"` 以外のときは必ず `"not_attempted"`」。
 * - `ReflectOptions.actor`: 「`memory_events.actor`（`created` イベント）」。
 * - `ResolveOrphanedContestedOptions.actor`: 「`memory_events.actor`。省略時 `{ type: "system" }`」。
 * - `Runtime.applyCorrection`: 「`correctedId === correctingId` は特別扱いせず、`markContested` の `RangeError` を
 *   捕まえない」。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
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
    contentHash: `runtime-round2-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "runtime-round2" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function llmReturning(result: Record<string, unknown>): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("simulated LLM outage");
  },
};

function buildRuntime(llmProvider: LLMProvider = throwingLlm) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

async function createEmbedded(
  stores: Stores,
  vector: number[],
  overrides: Partial<NewMemory> = {},
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — aggregateScope が filteredTaxonomy を返さない adapter（ScopeAggregate.filteredTaxonomy? の doc）", () => {
  it("欄が無いことを0件として扱い、落ちずに返り、condition: 'taxonomy' を積まない", async () => {
    const { runtime, stores } = buildRuntime();
    const matching = await createEmbedded(stores, [1, 0], { tags: ["alpha"] });
    await createEmbedded(stores, [1, 0], { tags: ["beta"] });
    const aggregateScope = stores.memoryStore.aggregateScope.bind(stores.memoryStore);
    Object.defineProperty(stores.memoryStore, "aggregateScope", {
      value: async (...args: Parameters<typeof aggregateScope>): Promise<ScopeAggregate> => {
        const { filteredTaxonomy, ...rest } = await aggregateScope(...args);
        return rest;
      },
      configurable: true,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    expect({
      ids: result.memories.map((m) => m.memoryId),
      taxonomyOmissions: result.omitted.filter(
        (o) => o.kind === "filtered" && o.condition === "taxonomy",
      ),
      totalInScope: result.index.totalInScope,
    }).toEqual({ ids: [matching.id], taxonomyOmissions: [], totalInScope: 1 });
  });
});

describe("runtime.consolidate — outcome が consolidated 以外なら atomicity は必ず not_attempted", () => {
  it("dry_run・llm_failed・nothing_to_consolidate（no_eligible_sources・single_eligible_source）のどれも not_attempted", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory());
    const b = await stores.memoryStore.createMemory(ctx, newMemory());
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );

    const dryRun = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
      dryRun: true,
    });
    const llmFailed = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const noEligible = await runtime.consolidate(ctx, { target: { memoryIds: [forgotten.id] } });
    const single = await runtime.consolidate(ctx, { target: { memoryIds: [a.id] } });

    expect(
      [dryRun, llmFailed, noEligible, single].map((r) => [r.outcome, r.nothingReason, r.atomicity]),
    ).toEqual([
      ["dry_run", null, "not_attempted"],
      ["llm_failed", null, "not_attempted"],
      ["nothing_to_consolidate", "no_eligible_sources", "not_attempted"],
      ["nothing_to_consolidate", "single_eligible_source", "not_attempted"],
    ]);
  });
});

describe("runtime.reflect — opts.actor は created イベントの actor に入る", () => {
  it("渡した actor がそのまま入る", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning({ outcome: "reflected", content: "気づき", digest: "気づき", tags: [] }),
    );
    const basis = await stores.memoryStore.createMemory(ctx, newMemory());
    const actor = { type: "human" as const, id: "operator-1" };

    const result = await runtime.reflect(ctx, { target: { memoryIds: [basis.id] }, actor });

    expect(result.outcome).toBe("reflected");
    const created = stores.eventStore.events.filter(
      (e) => e.memoryId === result.reflectedMemoryId && e.kind === "created",
    );
    expect(created.map((e) => e.actor)).toEqual([actor]);
  });
});

describe("runtime.resolveOrphanedContested — opts.actor は生存側のイベントの actor に入り、省けば system", () => {
  async function orphanedSurvivor(stores: Stores): Promise<MemoryId> {
    const a = await stores.memoryStore.createMemory(ctx, newMemory());
    const b = await stores.memoryStore.createMemory(ctx, newMemory());
    const event = (memoryId: MemoryId): NewMemoryEvent => ({
      tenantId: ctx.tenantId,
      memoryId,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: "digest",
      meta: { reason: "contested" },
    });
    await stores.memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: event(a.id) },
      { id: b.id, event: event(b.id) },
    );
    await stores.memoryStore.updateStatusWithEvent(
      ctx,
      b.id,
      "forgotten",
      {},
      { ...event(b.id), kind: "forgotten" },
    );
    return a.id;
  }

  it("渡せばその値、省けば { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const withActor = await orphanedSurvivor(stores);
    const withoutActor = await orphanedSurvivor(stores);
    const actor = { type: "clone" as const, id: "miku" };

    const results = [
      await runtime.resolveOrphanedContested!(ctx, withActor, { actor }),
      await runtime.resolveOrphanedContested!(ctx, withoutActor),
    ];

    const resolvedActor = (id: MemoryId) =>
      stores.eventStore.events
        .filter((e) => e.memoryId === id && e.meta["resolution"] === "orphan_reclaimed")
        .map((e) => e.actor);
    expect({
      kinds: results.map((r) => r.outcome.kind),
      withActor: resolvedActor(withActor),
      withoutActor: resolvedActor(withoutActor),
    }).toEqual({
      kinds: ["resolved", "resolved"],
      withActor: [actor],
      withoutActor: [{ type: "system" }],
    });
  });
});

describe("runtime.applyCorrection — correctedId === correctingId は markContested の RangeError をそのまま外へ出す", () => {
  it("候補一覧に自分自身が居て、それを指名すると RangeError で落ち、何も書かない", async () => {
    const { runtime, stores } = buildRuntime();
    const self = await createEmbedded(stores, [4, 0], { digest: "訂正する側" });
    const discovery = await runtime.findCorrectionCandidates(ctx, { text: "seed" });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(self.id);
    const eventsBefore = stores.eventStore.events.length;

    await expect(
      runtime.applyCorrection(ctx, {
        discovery,
        correctedId: self.id,
        correctingId: self.id,
      }),
    ).rejects.toThrow(RangeError);

    expect({
      status: (await stores.memoryStore.get(ctx, self.id))?.status,
      newEvents: stores.eventStore.events.length - eventsBefore,
    }).toEqual({ status: "active", newEvents: 0 });
  });
});
