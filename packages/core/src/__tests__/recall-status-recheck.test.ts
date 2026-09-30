import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * recall の段1（後置の再検査）と段3.5（連想枠）が、`status ∈ {active, contested}` を
 * 再検査する歯（ADR 0432 AL-1）。
 *
 * 窓: `vectorStore.search` が候補を返したあと、`memoryStore.getMany` が今の状態を読むまでの間に
 * `sweepArchive`（archived へ）や `forget`（forgotten へ）が入ると、`VectorFilter.status` は
 * 検索の時点でしか効いていないので、その記憶が `memories` に混ざっていた。
 * 「割り込ませない recall では返らない」ことを陽性対照として同じ配置で見る。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);
const SUNK = new Date(NOW.getTime() - 1_000);
const ANCHOR_VECTOR = [0.70710678, 0.70710678];
const ASSOCIATED_VECTOR = [0, 1];
const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
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
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
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
  return { runtime, stores };
}

async function embedded(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

/** `search` の n 回目（1 始まり）が返った直後に `hook` を1度だけ走らせる。 */
function interposeAfterSearch(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  n: number,
  hook: () => Promise<unknown>,
): void {
  const original = stores.vectorStore.search.bind(stores.vectorStore);
  let calls = 0;
  stores.vectorStore.search = async (c, space, query, opts) => {
    const hits = await original(c, space, query, opts);
    calls += 1;
    if (calls === n) await hook();
    return hits;
  };
}

const QUERY = { vector: [1, 0], limit: 10, includeFullyDecayed: true } as const;

describe("recall() — 段1の後置の再検査は status を見る（ADR 0432 AL-1）", () => {
  it("陽性対照: 割り込ませなければ、sweep 済みの archived は返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const m = await embedded(stores, [1, 0], { decayFloorAt: SUNK });
    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });
    const result = await runtime.recall(ctx, QUERY);
    expect(result.memories.map((x) => x.memoryId)).not.toContain(m.id);
  });

  it("search のあとに sweepArchive が入っても、archived の記憶は memories に入らない。件数は段5の filtered(archived) が1件だけ名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const m = await embedded(stores, [1, 0], { decayFloorAt: SUNK });
    interposeAfterSearch(stores, 1, () => runtime.sweepArchive(ctx, { now: NOW, limit: 10 }));

    const result = await runtime.recall(ctx, QUERY);

    expect((await stores.memoryStore.get(ctx, m.id))?.status).toBe("archived");
    expect(result.memories.map((x) => x.memoryId)).not.toContain(m.id);
    const archivedOmissions = result.omitted.filter(
      (o) => o.kind === "filtered" && o.condition === "archived",
    );
    expect(archivedOmissions).toEqual([
      {
        kind: "filtered",
        condition: "archived",
        scopeRelation: "outside_scope",
        count: 1,
        countKind: "exact",
      },
    ]);
  });

  it("search のあとに forget が入っても、forgotten の記憶は memories に入らない", async () => {
    const { runtime, stores } = buildRuntime();
    const m = await embedded(stores, [1, 0]);
    interposeAfterSearch(stores, 1, () => runtime.forget(ctx, { memoryId: m.id }));

    const result = await runtime.recall(ctx, QUERY);

    expect((await stores.memoryStore.get(ctx, m.id))?.status).toBe("forgotten");
    expect(result.memories.map((x) => x.memoryId)).not.toContain(m.id);
  });
});

describe("recall() — 連想枠の後置の再検査も status を見る（ADR 0432 AL-1）", () => {
  it("連想用 search のあとに sweepArchive が入っても、archived の記憶は連想枠に入らない", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await embedded(stores, ANCHOR_VECTOR, { decayFloorAt: FAR_FUTURE });
    const associated = await embedded(stores, ASSOCIATED_VECTOR, { decayFloorAt: SUNK });
    interposeAfterSearch(stores, 2, () => runtime.sweepArchive(ctx, { now: NOW, limit: 10 }));

    const result = await runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

    expect((await stores.memoryStore.get(ctx, associated.id))?.status).toBe("archived");
    const ids = result.memories.map((x) => x.memoryId);
    expect(ids).toContain(anchor.id);
    expect(ids).not.toContain(associated.id);
  });

  it("対照: 割り込ませなければ、同じ配置で連想枠から返る（歯が「連想が常に空」で通っていないことの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    await embedded(stores, ANCHOR_VECTOR, { decayFloorAt: FAR_FUTURE });
    const associated = await embedded(stores, ASSOCIATED_VECTOR, { decayFloorAt: SUNK });

    const result = await runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

    const entry = result.memories.find((x) => x.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
  });

  it("連想用 search のあとに forget が入っても、forgotten の記憶は連想枠に入らない", async () => {
    const { runtime, stores } = buildRuntime();
    await embedded(stores, ANCHOR_VECTOR, { decayFloorAt: FAR_FUTURE });
    const associated = await embedded(stores, ASSOCIATED_VECTOR);
    interposeAfterSearch(stores, 2, () => runtime.forget(ctx, { memoryId: associated.id }));

    const result = await runtime.recall(ctx, { ...QUERY, association: ASSOCIATION });

    expect(result.memories.map((x) => x.memoryId)).not.toContain(associated.id);
  });
});
