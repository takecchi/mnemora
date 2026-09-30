import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";
import type { TokenCounter } from "../interfaces/token-counter.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { findBudgetCut, unitChars, unitTokens, type BudgetUnit } from "../recall-budget-cut.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0431: 段4の `cut` を、旧実装（毎回 prefix を足し直す線形探索）から累積和＋二分探索へ替えても、
 * 結果が1ビットも変わらないことを縛る。旧実装は `referenceCut` に、`fits` の式ごと写してある。
 */

/** 旧実装（`recall-runtime.ts` の段4、ADR 0431 の前）をそのまま写した参照実装。 */
function referenceCut(
  allUnits: readonly BudgetUnit[],
  budget: { maxMemoryChars?: number; maxTokens?: number },
  tokenCounter: TokenCounter,
): number {
  const { maxMemoryChars, maxTokens } = budget;
  const fits = (candidateUnits: readonly BudgetUnit[]): boolean => {
    if (maxMemoryChars !== undefined) {
      const chars = candidateUnits.reduce((sum, u) => sum + unitChars(u), 0);
      if (chars > maxMemoryChars) return false;
    }
    if (maxTokens !== undefined) {
      const tokens = candidateUnits.reduce((sum, u) => sum + unitTokens(u, tokenCounter), 0);
      if (tokens > maxTokens) return false;
    }
    return true;
  };
  let cut = allUnits.length;
  while (cut > 0 && !fits(allUnits.slice(0, cut))) {
    cut -= 1;
  }
  return cut;
}

/** 決定的な疑似乱数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitsFrom(digestLengths: number[][]): BudgetUnit[] {
  return digestLengths.map((lens) => ({
    members: lens.map((len) => ({ memory: { digest: "あ".repeat(len) } })),
  }));
}

function randomUnits(rand: () => number, n: number, maxLen: number): BudgetUnit[] {
  return unitsFrom(
    Array.from({ length: n }, () =>
      Array.from({ length: 1 + Math.floor(rand() * 2) }, () => Math.floor(rand() * (maxLen + 1))),
    ),
  );
}

const perChar = (k: number): TokenCounter => ({
  count: (text) => ({ tokens: Math.ceil(text.length / k), counter: "heuristic" }),
});

function expectSameCut(
  units: readonly BudgetUnit[],
  budget: { maxMemoryChars?: number; maxTokens?: number },
  counter: TokenCounter,
): void {
  const limits = { maxMemoryChars: budget.maxMemoryChars, maxTokens: budget.maxTokens };
  expect(findBudgetCut(units, limits, counter)).toBe(referenceCut(units, budget, counter));
}

describe("findBudgetCut は旧実装（参照実装）と同じ cut を返す", () => {
  it("予算の境界ちょうど・境界の前後 ±1 を、全単位の prefix ごとに（文字数・トークン・両方）", () => {
    const rand = rng(1);
    for (let round = 0; round < 40; round++) {
      const units = randomUnits(rand, 1 + Math.floor(rand() * 12), 30);
      const counter = perChar(1 + Math.floor(rand() * 4));
      for (let k = 0; k <= units.length; k++) {
        const chars = units.slice(0, k).reduce((s, u) => s + unitChars(u), 0);
        const tokens = units.slice(0, k).reduce((s, u) => s + unitTokens(u, counter), 0);
        for (const d of [-1, 0, 1]) {
          expectSameCut(units, { maxMemoryChars: chars + d }, counter);
          expectSameCut(units, { maxTokens: tokens + d }, counter);
          expectSameCut(units, { maxMemoryChars: chars + d, maxTokens: tokens + d }, counter);
          expectSameCut(units, { maxMemoryChars: chars + d, maxTokens: tokens + 5 }, counter);
          expectSameCut(units, { maxMemoryChars: chars + 5, maxTokens: tokens + d }, counter);
        }
      }
    }
  });

  it("ランダムな予算（未指定・0・全部入る・全部落ちる を含む）× 単位の多寡", () => {
    const rand = rng(2);
    for (let round = 0; round < 3000; round++) {
      const n = Math.floor(rand() * 40);
      const units = randomUnits(rand, n, 50);
      const counter = perChar(1 + Math.floor(rand() * 5));
      const pick = (): number | undefined => {
        const r = rand();
        if (r < 0.2) return undefined;
        if (r < 0.3) return 0;
        if (r < 0.4) return 1_000_000;
        return Math.floor(rand() * 400);
      };
      expectSameCut(units, { maxMemoryChars: pick(), maxTokens: pick() }, counter);
    }
  });

  it("単位が0件・全部が空の digest・予算が負の値でも同じ", () => {
    expectSameCut([], { maxMemoryChars: 10, maxTokens: 10 }, heuristicTokenCounter);
    expectSameCut([], {}, heuristicTokenCounter);
    const empties = unitsFrom([[0], [0, 0], [0]]);
    expectSameCut(empties, { maxMemoryChars: 0 }, heuristicTokenCounter);
    expectSameCut(empties, { maxTokens: 0 }, heuristicTokenCounter);
    expectSameCut(empties, { maxMemoryChars: -1 }, heuristicTokenCounter);
    expectSameCut(empties, { maxTokens: -1 }, heuristicTokenCounter);
    expectSameCut(unitsFrom([[3], [3]]), { maxMemoryChars: -1, maxTokens: -1 }, perChar(1));
  });

  it("既定の heuristicTokenCounter・per-unit の切り上げが実量を上回る形（ADR 0097 / Issue #829）でも同じ", () => {
    const rand = rng(3);
    for (let round = 0; round < 500; round++) {
      const units = unitsFrom(
        Array.from({ length: 1 + Math.floor(rand() * 30) }, () => [1 + Math.floor(rand() * 6)]),
      );
      expectSameCut(units, { maxTokens: Math.floor(rand() * 60) }, heuristicTokenCounter);
    }
  });

  it("tokenCounter の差し替え: 単調でない（負・NaN・Infinity・小数を返す）counter でも同じ", () => {
    const rand = rng(4);
    const weird: TokenCounter[] = [
      // 文字数によって負になる。
      { count: (t) => ({ tokens: t.length % 3 === 0 ? -2 : t.length, counter: "exact" }) },
      // 長さ 7 の digest だけ NaN。
      { count: (t) => ({ tokens: t.length === 7 ? NaN : t.length, counter: "exact" }) },
      // 長さ 5 の digest だけ Infinity。
      { count: (t) => ({ tokens: t.length === 5 ? Infinity : t.length, counter: "exact" }) },
      // Infinity と -Infinity が混ざり、和が NaN になりうる。
      {
        count: (t) => ({
          tokens: t.length === 5 ? Infinity : t.length === 6 ? -Infinity : t.length,
          counter: "exact",
        }),
      },
      // 小数（丸めが足す順に依存する値）。
      { count: (t) => ({ tokens: t.length * 0.1, counter: "exact" }) },
      { count: (t) => ({ tokens: (t.length + 1) / 3, counter: "exact" }) },
    ];
    for (const counter of weird) {
      for (let round = 0; round < 400; round++) {
        const units = randomUnits(rand, Math.floor(rand() * 25), 10);
        const budget: { maxMemoryChars?: number; maxTokens?: number } = {};
        if (rand() < 0.5) budget.maxMemoryChars = Math.floor(rand() * 150);
        if (rand() < 0.9) budget.maxTokens = Math.floor(rand() * 100) - (rand() < 0.2 ? 10 : 0);
        expectSameCut(units, budget, counter);
      }
    }
  });

  it("数える digest は旧実装が数えた集合の部分集合（文字数で先に切れる範囲の外は数えない）", () => {
    const seen = new Set<string>();
    const counter: TokenCounter = {
      count: (t) => {
        seen.add(t);
        return { tokens: t.length, counter: "exact" };
      },
    };
    // 30 文字ずつ 10 単位。文字数の上限 100 なら先頭 3 単位まで。
    const units: BudgetUnit[] = Array.from({ length: 10 }, (_, i) => ({
      members: [{ memory: { digest: `${i}`.repeat(30) } }],
    }));
    const cut = findBudgetCut(units, { maxMemoryChars: 100, maxTokens: 1000 }, counter);
    expect(cut).toBe(3);
    expect([...seen].sort()).toEqual(["0".repeat(30), "1".repeat(30), "2".repeat(30)].sort());
  });
});

describe("recall() の出力: 段4の切り詰めが、参照実装の cut の分だけ先頭を残す", () => {
  const ctx: Ctx = { tenantId: "tenant-budget-cut" };
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  function newMemory(i: number, digest: string): NewMemory {
    return {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${i}`,
      contentHash: `hash-${i}`,
      digest,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: NOW,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 24 * 365 * 10,
      }),
      embeddingStatus: "ready",
    };
  }

  async function build(tokenCounter: TokenCounter | undefined, digests: string[]) {
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
      ...(tokenCounter ? { tokenCounter } : {}),
    });
    for (let i = 0; i < digests.length; i++) {
      const m = await stores.memoryStore.createMemory(ctx, newMemory(i, digests[i]!));
      // 類似度が順に下がる（先頭ほど上位）ようにベクトルを振る。
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, m.id, [1, i * 0.001]);
    }
    return runtime;
  }

  it("ランダムな digest・予算・tokenCounter で、返る記憶は予算なしの並びの先頭 cut 件", async () => {
    const rand = rng(5);
    for (let round = 0; round < 12; round++) {
      const n = 3 + Math.floor(rand() * 25);
      const digests = Array.from({ length: n }, () => "い".repeat(1 + Math.floor(rand() * 30)));
      const divisor = 1 + Math.floor(rand() * 4);
      const counter = round % 2 === 0 ? undefined : perChar(divisor);
      const runtime = await build(counter, digests);
      const base = await runtime.recall(ctx, { vector: [1, 0], limit: n, association: null });
      const order = base.memories.map((m) => m.memoryId);
      expect(order).toHaveLength(n);
      const baseUnits: BudgetUnit[] = base.memories.map((m) => ({
        members: [{ memory: { digest: m.digest } }],
      }));
      for (let t = 0; t < 8; t++) {
        const budget: { maxMemoryChars?: number; maxMemoryTokens?: number } = {};
        if (rand() < 0.6) budget.maxMemoryChars = 1 + Math.floor(rand() * 300);
        if (rand() < 0.6) budget.maxMemoryTokens = 1 + Math.floor(rand() * 200);
        const expected = referenceCut(
          baseUnits,
          { maxMemoryChars: budget.maxMemoryChars, maxTokens: budget.maxMemoryTokens },
          counter ?? heuristicTokenCounter,
        );
        const result = await runtime.recall(ctx, {
          vector: [1, 0],
          limit: n,
          association: null,
          budget,
        });
        expect(result.memories.map((m) => m.memoryId)).toEqual(order.slice(0, expected));
      }
    }
  });
});
