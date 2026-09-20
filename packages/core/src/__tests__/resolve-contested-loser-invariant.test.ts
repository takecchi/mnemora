import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 🔴 この歯が守っているのは `resolveContested` の実装の詳細ではない。
 *
 * [Issue #515](https://github.com/takecchi/mnemora/issues/515) 方向①
 * （[ADR 0258](../../../../docs/decisions/0258-restore-superseded-operation-scope.md)）
 * ——`restoreSuperseded` を「1回の操作」単位に絞る設計——は、次の前提の上に立っている:
 *
 * > `resolveContested(ctx, firstId, secondId, { kind: "supersede", winnerId })` は、
 * > 1回の呼び出しにつき、ちょうど1件の敗者（`status: "superseded"`）と、ちょうど
 * > 1件の `kind: "superseded"` `memory_events` 行を作る。
 *
 * `RestoreSupersededTarget.onlyMemoryIds`（`runtime.ts`）の doc コメントは、
 * `supersededReason === "contested_resolved"` の候補を「1件 = 1回の操作」として
 * 扱ってよいと書いている。この前提が崩れると（例: 将来 `resolveContested` が
 * 2件以上を同時に解決する形へ拡張されたとき）、その扱いが黙って崩れる——
 * この歯が無ければ、その変更をした人は自分が何を壊したか気づけない。
 *
 * ⟹ ここで固定するのは「振る舞いの詳細」ではなく「他所（`restoreSuperseded` の
 * 操作単位絞り込み、`groupSupersededCandidatesByOperation` の `"per_item"` 分類）が
 * 依存している契約」である。**この歯が赤くなったら、実装のバグではなく、上の
 * 前提そのものを変える設計判断をしている**——その変更をするときは、この歯を
 * 直すだけでなく `RestoreSupersededTarget.onlyMemoryIds` の doc コメントと
 * ADR 0258 も見直すこと。
 *
 * `previewRestoreSupersededBy` には依存しない——これから実装する機能（方向①）が、
 * その機能が守るべき前提を検査することになり循環するため。`stores.eventStore.events`
 * を直接読む（`resolve-contested.test.ts` と同じ手段）。
 *
 * `@mnemora/testkit` には依存しない（`resolve-contested.test.ts` と同じ理由。
 * `runtime-fakes.ts` 冒頭のコメント参照）。
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

    // ROUND1: W vs X → W 勝ち。
    const { a: w, b: x } = await createContestedPair(runtime, stores, "round1");
    const statusBeforeRound1 = await countSupersededAmong(stores, [w.id, x.id]);
    const eventsBeforeRound1 = countSupersededEvents(stores);
    await runtime.resolveContested(ctx, w.id, x.id, { kind: "supersede", winnerId: w.id });

    // 1回目の呼び出し単体の増分がちょうど1件であることを確認する。
    expect((await countSupersededAmong(stores, [w.id, x.id])) - statusBeforeRound1).toBe(1);
    expect(countSupersededEvents(stores) - eventsBeforeRound1).toBe(1);

    // ROUND2: 同じ W が、別の相手 Y と再び contested になり、再び勝つ。
    const y = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "round2-Y" }));
    const marked2 = await runtime.markContested(ctx, w.id, y.id);
    expect(marked2.outcome.kind).toBe("contested");

    const statusBeforeRound2 = await countSupersededAmong(stores, [w.id, y.id]);
    const eventsBeforeRound2 = countSupersededEvents(stores);
    await runtime.resolveContested(ctx, w.id, y.id, { kind: "supersede", winnerId: w.id });

    // ⟹ 2回目の呼び出し「単体」の増分も、累積ではなくちょうど1件のままである。
    expect((await countSupersededAmong(stores, [w.id, y.id])) - statusBeforeRound2).toBe(1);
    expect(countSupersededEvents(stores) - eventsBeforeRound2).toBe(1);

    // 累積では W の下に X・Y の2件が積み上がっている——これが ADR 0230/Issue #515 が
    // 報告した「別々の操作の敗者が同じ supersededById の下に積み上がる」状態そのもの。
    // ⟹ この歯が緑である限り、その2件はそれぞれ別々の1回の呼び出しに対応する
    // ——`onlyMemoryIds` を「1件ずつ」使うべき理由がここで裏付けられる。
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
