import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ⭐ **使用報告による「選別」が、忘却ゲートの軸で `recall()` まで届くことの歯。**
 *
 * 正典 `docs/north-star.md`「目指す姿」項目4「使われない記憶が、静かに遠ざかる。
 * ——消えるのではなく、遠ざかる。」の**ゲート軸**だけを測る。
 *
 * ## なぜこの歯を置いたか（置く前に何が無かったか）
 *
 * 【現物 2026-09-19 時点】この歯を置く前、`packages/`（`private: true` でない＝npm に
 * 出る側）には「**A は使用報告された / B はされなかった ⟹ 同じ `recall()` で B だけが
 * 落ちる**」を1本で駆動する歯が**1件も無かった**。`packages/` で選別を駆動しうる経路は
 * 2つしかなく、どちらも単独では一巡になっていなかった:
 *
 * - `MemoryStore.reinforce` の直接呼び出し（`grep -rn -- '.reinforce(' packages`）——
 *   `runtime.ts` の本番3経路のほかは、store 層の単調性・適合テスト
 *   （`fake-reinforce-monotonicity.test.ts` / `memory-store-conformance.ts` /
 *   `memory-store-reinforce-monotonicity.test.ts`。いずれも `recall(` を1度も呼ばない）と、
 *   `recall-channels.test.ts` の**変異プローブ**（`RecalledMemory` が Memory への
 *   生き参照を持たないことを見るためのもので、選別ではない）だけだった。
 * - `observe({ kind: 'memory_usage' })`（`grep -rn -- 'kind: "memory_usage"' packages`）——
 *   記憶1件で `lastReinforcedAt` が非 null になること（`runtime.test.ts`）、`recallId` が
 *   `observe` から参照できること（`recall-pipeline.test.ts` / `recall.postgres.test.ts`）、
 *   スキーマ検証（`observation.test.ts`）、purge との非干渉（`purge.test.ts`）まで。
 *
 * A/B の対比そのものは `examples/chat/src/__tests__/memory-usage-reinforce.postgres.test.ts`
 * に在るが、⛔ **`examples/chat` は `private: true` で出荷されない**うえ、測っているのは
 * `last_reinforced_at` / `decay_floor_at` / `strengthAt` という**3つの状態量まで**であり、
 * 「B が `recall()` から落ちる」ところまでは測っていない
 * （`grep -Fn -- '使われた記憶と使われなかった記憶で last_reinforced_at' examples/chat`）。
 *
 * ⟹ この歯は、その一巡を**出荷される面の上で**閉じる。
 *
 * ## ⛔ この歯が測っていないもの（順位軸 / Issue #402）
 *
 * **測るのはゲート軸（`decayFloorAt` を割ったら返らない）だけである。**スコア閾値の軸
 * （段2の `below_threshold`）は測らない。段3.5（連想枠）は閾値分割より後に走り、
 * 閾値を迂回する——`recall-runtime.ts` の
 * `grep -Fn -- '段1に置くと必ず段2の below_threshold で落ちる'` が、その迂回が
 * 意図的であることを逐語で述べている。⟹ **連想枠を既定 on にすると、段2が
 * 「閾値未満」と判定した記憶が `retrievedVia: "association"` で戻る**
 * （[Issue #402](https://github.com/takecchi/mnemora/issues/402)、OPEN）。
 *
 * ⚠ **この歯はその穴に触れない。**忘却ゲートは段1・段3.5 の両方に掛かっており
 * （`grep -Fn -- 'survivesDecayGate' packages/core/src/recall-runtime.ts` が両段に当たる。
 * `recall-association-gates.test.ts` が歯で固めている）、連想枠の既定が動いても
 * この歯が測る軸は動かない。⟹ **この歯が緑であることは「項目4 が在る」を意味しない。**
 *
 * ## 形
 *
 * `recall-decay-gate.test.ts`（ADR 0153）と同型: `packages/core` 自身のテストなので
 * `@mnemora/testkit` には依存せず（`runtime-fakes.ts` 冒頭のコメントと同じ理由）、
 * DB を要さない。違いは `Clock` を可変にしている点だけ——選別は「報告した時刻」と
 * 「その後に読み直す時刻」が別でないと現れないため。
 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
/** 使用報告を撃つ時刻。両方ともまだ生きている。 */
const T1 = new Date("2026-06-05T00:00:00.000Z");
/** 読み直す時刻。`FLOOR` を過ぎている。 */
const T2 = new Date("2026-06-20T00:00:00.000Z");
/** 作成時に両方へ与える忘却の床。`T1 < FLOOR < T2`。 */
const FLOOR = new Date("2026-06-10T00:00:00.000Z");

const ctx: Ctx = { tenantId: "tenant-1" };

/**
 * `recall-decay-gate.test.ts` の `buildRuntime` と同じ配線。違いは `clock` が
 * 可変であることだけ（`setNow` で進める）。
 */
function buildRuntime() {
  const stores = createFakeRuntimeStores();
  let now = T0;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
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
    clock: { now: () => now },
  });
  return {
    runtime,
    stores,
    setNow: (next: Date) => {
      now = next;
    },
  };
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  // ⚠ **半減期は意図的に長くする（10年）。**この歯が見たいのは忘却ゲート
  // （`decayFloorAt` を割ったか）であって、スコアの目減りではない。短い半減期にすると
  // `total = similarity × decay × tagMatch × freshness × strength` が段2の閾値を割り、
  // 「ゲートで落ちた」のか「閾値で落ちた」のか区別できない歯になる。
  const halfLifeHours = 24 * 365 * 10;
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
    recordedAt: T0,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    // 両方に同じ床を与える。この床は `T1` と `T2` の間に在る。
    decayFloorAt: FLOOR,
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — ⭐ 使用報告した記憶だけが居残り、報告しなかった記憶は同じ recall() から落ちる", () => {
  it("A を使用報告し B を報告しないと、T2 の recall() で A は返り B は filtered(decayed) になる", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    // A・B は完全に同条件（同じ recordedAt・同じ半減期・同じ床）。
    // 違いはこのあと「使用報告されるかどうか」だけである。
    const used = await createEmbeddedMemory(stores, [1, 0], { digest: "used" });
    const unused = await createEmbeddedMemory(stores, [1, 0], { digest: "unused" });

    // --- T1: まだどちらも生きている。ここで A だけを使用報告する ---
    setNow(T1);
    const first = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const firstIds = first.memories.map((m) => m.memoryId);
    // 前提: この時点では選別が起きていない。両方返る。
    expect(firstIds).toContain(used.id);
    expect(firstIds).toContain(unused.id);

    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: first.recallId,
      usedMemoryIds: [used.id],
    });
    expect(report.memoryIds).toEqual([used.id]);

    // 中間の状態: 報告した側だけ `lastReinforcedAt` が入り、床が先へ倒れている。
    // （`FakeMemoryStore.reinforce` が `defaultDecayStrategy.floorAt` で再計算する。
    //   `grep -Fn -- '減衰の起点を巻き戻さない' packages/core/src/__tests__/runtime-fakes.ts`）
    const usedAfterReport = await stores.memoryStore.get(ctx, used.id);
    const unusedAfterReport = await stores.memoryStore.get(ctx, unused.id);
    expect(usedAfterReport?.lastReinforcedAt).not.toBeNull();
    expect(unusedAfterReport?.lastReinforcedAt).toBeNull();
    expect(usedAfterReport!.decayFloorAt.getTime()).toBe(
      defaultDecayStrategy
        .floorAt({
          recordedAt: T0,
          lastReinforcedAt: T1,
          strength: usedAfterReport!.strength,
          halfLifeHours: usedAfterReport!.halfLifeHours,
        })
        .getTime(),
    );
    expect(usedAfterReport!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(unusedAfterReport!.decayFloorAt.getTime()).toBe(FLOOR.getTime());
    expect(unusedAfterReport!.decayFloorAt.getTime()).toBeLessThan(T2.getTime());

    // --- T2: 床を過ぎて読み直す。⭐ ここが本題 ---
    setNow(T2);
    const second = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const secondIds = second.memories.map((m) => m.memoryId);

    expect(secondIds).toContain(used.id);
    expect(secondIds).not.toContain(unused.id);

    // 黙って消えない（ADR 0153 / ADR 0173）——落ちたことを `omitted` が名乗る。
    expect(second.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  it("対照条件: どちらも使用報告しなければ、T2 の recall() では両方とも落ちる（歯が『A は何をしても残る』で通っていないことの検算）", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    const first = await createEmbeddedMemory(stores, [1, 0], { digest: "one" });
    const second = await createEmbeddedMemory(stores, [1, 0], { digest: "two" });

    setNow(T1);
    const before = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(before.memories.map((m) => m.memoryId)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    // ⛔ ここで `observe({ kind: 'memory_usage' })` を呼ばない——それがこの対照条件である。

    setNow(T2);
    const after = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const ids = after.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(first.id);
    expect(ids).not.toContain(second.id);
    expect(after.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 2,
      countKind: "exact",
    });
  });
});
