import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `forget()` が `contested` の対向を破ったあと、段3（必須の同伴取得）がその破れた companion
 * をそのまま拾ってしまう穴（マネージャー調査で発見。`forget-contested-pair.test.ts`（別枝
 * `fix/forget-contested-pair`）の③）を塞ぐ歯。
 *
 * 「forget した記憶は recall に出ない」は `docs/recall.md`/ADR 0087 決定6が既に確立した約束
 * であり、段3の必須同伴取得だけがこの約束を破っていた——`getMany` の結果を検査せずそのまま
 * companion として使っていたため。**この歯は Issue #152/#153（ADR 0312 9-a）の
 * `survivesAttributesFilter` の前例と同型**: 対向が壊れていれば（status が `contested` で
 * ない、または `contestedWithId` が owner を指し返していない）、その companion を
 * `companions` に一度も現れさせない。単位組み立てから見れば「対向が見つからなかった
 * `contested`」と区別が付かず、対象の contested 候補ごと単位を組まず `consumed` のまま
 * 落ちる——`unit_assembly_dropped`（ADR 0043）が既存の経路のまま自動的に拾う。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
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

/** `runtime.markContested`（公開 API）で本物の相互ペアを作る。 */
async function setupMarkContestedPair(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  runtime: ReturnType<typeof createRuntime>,
) {
  const a = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "A" }),
  );
  const b = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "B" }),
  );
  const markResult = await runtime.markContested(ctx, a.id, b.id);
  expect(markResult).toEqual({
    supported: true,
    outcome: { kind: "contested", first: expect.anything(), second: expect.anything() },
  });
  return { a, b };
}

describe("recall() — 段3の必須同伴取得は、companion 自身が壊れていれば拾わない", () => {
  it("forget した対向は companion として出てこない。生存側も単独では出ず unit_assembly_dropped に計上される", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    // a だけをベクタ検索で拾えるようにする。b は埋め込みを持たない
    // （= 段1の候補生成には出てこない。段3の必須同伴取得だけが b への経路になる)。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    // 【直した後の期待】forgotten になった b は、もう companion として拾われない。
    expect(ids).not.toContain(b.id);
    // 【既存原則、ADR 0136/0046】対向が見つからない contested は単独でも出さない
    // ——争われている主張を、争われていない顔で出すくらいなら、何も出さない。
    expect(ids).not.toContain(a.id);
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it.each(["superseded", "archived"] as const)(
    "対向の status が %s（contested でない）でも companion として出てこない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const { a, b } = await setupMarkContestedPair(stores, runtime);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

      // forget と同じく、b の status だけを contested から動かす
      // （`markContestedPair` 経由で作った相互ペアの b 側を、別の書き込みで壊す想定）。
      await stores.memoryStore.updateStatus(ctx, b.id, status, { expectedStatus: "contested" });

      const result = await runtime.recall(ctx, { vector: [1, 0] });
      const ids = result.memories.map((m) => m.memoryId);

      expect(ids).not.toContain(b.id);
      expect(ids).not.toContain(a.id);
      expect(result.omitted).toContainEqual({
        kind: "unit_assembly_dropped",
        count: 1,
        countKind: "lower_bound",
      });
    },
  );
});
