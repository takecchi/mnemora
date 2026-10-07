import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * この歯が守っているのは `resolveContested` の実装の詳細ではなく、他所（`restoreSuperseded` の操作単位絞り込み、
 * `groupSupersededCandidatesByOperation` の `"per_item"` 分類）が依存している契約:
 * `resolveContested(ctx, firstId, secondId, { kind: "supersede", winnerId })` は、1回の呼び出しにつき、
 * ちょうど1件の敗者（`status: "superseded"`）と、ちょうど1件の `kind: "superseded"` `memory_events` 行を作る。
 * この歯が赤くなったら実装のバグではなく、その前提を変える設計判断をしている。
 * `RestoreSupersededTarget.onlyMemoryIds`（`runtime.ts`）の doc コメントと ADR 0258 も見直すこと。
 *
 * `previewRestoreSupersededBy` には依存しない: その機能が守るべき前提を検査することになり循環するため。
 * `stores.eventStore.events` を直接読む。`@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

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
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

/** `resolve-contested.test.ts` の `createContestedPair` と同じ形。 */
async function createContestedPair(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  stores: ReturnType<typeof buildRuntime>["stores"],
  digestPrefix: string,
) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: `${digestPrefix}-A` }));
  const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: `${digestPrefix}-B` }));
  const marked = await runtime.markContested(ctx, a.id, b.id);
  expect(marked.outcome.kind).toBe("contested");
  return { a, b };
}

function supersededEventsFor(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: string) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "superseded");
}

function countSupersededEvents(stores: ReturnType<typeof createFakeRuntimeStores>) {
  return stores.eventStore.events.filter((e) => e.kind === "superseded").length;
}

/**
 * 与えた id のうち、いま `status === "superseded"` であるものの件数を数える。
 * `FakeMemoryStore` は全件走査の口を公開していない（意図的——`backing` は
 * `private readonly`）ため、対象を明示的に絞って数える。
 */
async function countSupersededAmong(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  ids: readonly string[],
) {
  const memories = await Promise.all(ids.map((id) => stores.memoryStore.get(ctx, id)));
  return memories.filter((m) => m?.status === "superseded").length;
}

describe("resolveContested の1対1不変条件（Issue #515 方向①が依存する前提）", () => {
  it("kind:'supersede' を1回呼ぶと、敗者はちょうど1件——0件でも2件でもない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores, "single");

    const statusBefore = await countSupersededAmong(stores, [a.id, b.id]);
    const eventsBefore = countSupersededEvents(stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: a.id,
    });

    expect(result.outcome.kind).toBe("resolved");
    // 🔴 「1件以上増えた」では緩すぎる——ちょうど1件であることを明示的に固定する。
    expect((await countSupersededAmong(stores, [a.id, b.id])) - statusBefore).toBe(1);
    expect(countSupersededEvents(stores) - eventsBefore).toBe(1);

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("active");
    expect(storedB?.status).toBe("superseded");
    expect(supersededEventsFor(stores, b.id)).toHaveLength(1);
    expect(supersededEventsFor(stores, a.id)).toHaveLength(0);
  });

  it("🔴 同じ勝者が2回勝っても、1回の呼び出しが作る敗者はそのつど1件のままである（ADR 0230 の再現2と同じ形）", async () => {
    const { runtime, stores } = buildRuntime();

    const { a: w, b: x } = await createContestedPair(runtime, stores, "round1");
    const statusBeforeRound1 = await countSupersededAmong(stores, [w.id, x.id]);
    const eventsBeforeRound1 = countSupersededEvents(stores);
    await runtime.resolveContested(ctx, w.id, x.id, { kind: "supersede", winnerId: w.id });

    expect((await countSupersededAmong(stores, [w.id, x.id])) - statusBeforeRound1).toBe(1);
    expect(countSupersededEvents(stores) - eventsBeforeRound1).toBe(1);

    const y = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "round2-Y" }));
    const marked2 = await runtime.markContested(ctx, w.id, y.id);
    expect(marked2.outcome.kind).toBe("contested");

    const statusBeforeRound2 = await countSupersededAmong(stores, [w.id, y.id]);
    const eventsBeforeRound2 = countSupersededEvents(stores);
    await runtime.resolveContested(ctx, w.id, y.id, { kind: "supersede", winnerId: w.id });

    expect((await countSupersededAmong(stores, [w.id, y.id])) - statusBeforeRound2).toBe(1);
    expect(countSupersededEvents(stores) - eventsBeforeRound2).toBe(1);

    // 累積では W の下に X・Y の2件が積み上がっている。この歯が緑である限り、その2件はそれぞれ別々の1回の呼び出しに
    // 対応するので、`onlyMemoryIds` を「1件ずつ」使うべき理由がここで裏付けられる。
    const storedX = await stores.memoryStore.get(ctx, x.id);
    const storedY = await stores.memoryStore.get(ctx, y.id);
    expect(storedX?.status).toBe("superseded");
    expect(storedX?.supersededById).toBe(w.id);
    expect(storedY?.status).toBe("superseded");
    expect(storedY?.supersededById).toBe(w.id);
    expect(supersededEventsFor(stores, x.id)).toHaveLength(1);
    expect(supersededEventsFor(stores, y.id)).toHaveLength(1);
  });

  it("kind:'both_active' は敗者を作らない——'supersede' 以外はこの不変条件の対象外であることを明示する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores, "both-active");

    const statusBefore = await countSupersededAmong(stores, [a.id, b.id]);
    const eventsBefore = countSupersededEvents(stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result.outcome.kind).toBe("resolved");
    expect((await countSupersededAmong(stores, [a.id, b.id])) - statusBefore).toBe(0);
    expect(countSupersededEvents(stores) - eventsBefore).toBe(0);

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("active");
    expect(storedB?.status).toBe("active");
  });
});
