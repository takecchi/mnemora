import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.reinforce`（`packages/core` 自身の runtime テスト用フェイク、
 * `runtime-fakes.ts`）が、`PostgresMemoryStore.reinforce`（ADR 0048）と同じ意味論——
 * 減衰の起点を巻き戻さない——を実際に守っていることを検査する歯（ADR 0049）。
 *
 * **`packages/testkit` の `memory-store-conformance.ts` の対象ではない。**
 * `FakeMemoryStore` は adapter 適合テストの対象である `MemoryStore` 実装
 * （`InMemoryMemoryStore`/`PostgresMemoryStore`）ではなく、`packages/core` 自身の
 * runtime テスト専用の別系統（`runtime-fakes.ts` 冒頭のコメント: core は testkit に
 * 依存しない）。`fake-referential-integrity.test.ts`（ADR 0047 の穴を core 側で埋めた
 * 前例）・`fake-event-store-list.test.ts`（ADR 0042 の同種の前例）と同じ理由・同じ形。
 *
 * **⚠ この歯を置く前は、`InMemoryMemoryStore.reinforce` を直しても `FakeMemoryStore`
 * 側は無条件代入のまま巻き戻り続け、それを測る歯がどこにも無かった。** これは
 * PR #36 / #45 / #53 で実際に起きた形と同じ——`packages/testkit` の適合テストが
 * 対象とするのは `InMemory*` であり、`packages/core` 専用の `Fake*` には届かない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const HOUR = 1000 * 60 * 60;

describe("FakeMemoryStore.reinforce — 減衰の起点を巻き戻さない（ADR 0048/0049）", () => {
  it("すでに新しい at で強化済みのところへ、古い at を渡しても起点は戻らない", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const early = new Date(memory.recordedAt.getTime() + HOUR);
    const late = new Date(memory.recordedAt.getTime() + 48 * HOUR);

    // 前提: 新しい at で強化すると実際に動く。これを先に固定しないと、reinforce が
    // 丸ごと壊れて何も書かなくなっても「巻き戻らない」だけを見る歯は緑のままになる。
    const forward = await stores.memoryStore.reinforce(ctx, memory.id, late);
    expect(forward.lastReinforcedAt?.getTime()).toBe(late.getTime());
    const floorAfterLate = forward.decayFloorAt.getTime();

    // 本題: late より古い early を渡しても、last_reinforced_at/decay_floor_at は戻らない。
    const backward = await stores.memoryStore.reinforce(ctx, memory.id, early);
    expect(backward.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(backward.decayFloorAt.getTime()).toBe(floorAfterLate);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(reread?.decayFloorAt.getTime()).toBe(floorAfterLate);
  });

  it("順方向（古い→新しい）はこれまでどおり動く", async () => {
    // ⚠ 発火しない側。巻き戻しを止める実装が「常に何も書かない」に退化していたら、
    // ここが赤くなる。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const early = new Date(memory.recordedAt.getTime() + HOUR);
    const late = new Date(memory.recordedAt.getTime() + 48 * HOUR);

    const first = await stores.memoryStore.reinforce(ctx, memory.id, early);
    expect(first.lastReinforcedAt?.getTime()).toBe(early.getTime());
    const floorAfterEarly = first.decayFloorAt.getTime();

    const second = await stores.memoryStore.reinforce(ctx, memory.id, late);
    expect(second.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(second.decayFloorAt.getTime()).toBeGreaterThan(floorAfterEarly);
  });

  it("⚠ 同じ at をもう一度渡すと no-op である（狭義の `<` の境界）", async () => {
    // ⚠ ここが `<` と `<=` の境界である。`<=` にすると同じ値を書き直すだけなので、
    // last_reinforced_at と decay_floor_at だけを見ていては区別が付かない
    // （どちらも同じ値になる）。区別が付くのは updatedAt だけ——「べき等」を
    // 「同じ値になる」ではなく「行を触らない」の意味で固定する
    // （`packages/testkit` の同種の歯・`packages/postgres` の
    // `memory-store-reinforce-monotonicity.test.ts` と同じ形）。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    // 既定値（null）ではない、具体的な起点を先に作ってから境界を検査する。
    const at = new Date(memory.recordedAt.getTime() + 48 * HOUR);

    const first = await stores.memoryStore.reinforce(ctx, memory.id, at);
    expect(first.lastReinforcedAt?.getTime()).toBe(at.getTime());

    // ⚠ `updatedAt` は壁時計を使う。2回の呼び出しが同期的に一瞬で終わると、ガードが
    // 外れて2回目も書き込む実装であっても、ミリ秒の解像度に収まって偶然同じ値になり
    // かねない。実際に時間を進めてから2回目を呼び、「書けば必ず値が変わる」状況を
    // 作ってから「変わっていない」を確かめる。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const again = await stores.memoryStore.reinforce(ctx, memory.id, at);
    expect(again.lastReinforcedAt?.getTime()).toBe(at.getTime());
    expect(again.decayFloorAt.getTime()).toBe(first.decayFloorAt.getTime());
    // 行そのものを触っていないことは updatedAt で確かめる。
    expect(again.updatedAt.getTime()).toBe(first.updatedAt.getTime());

    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("reinforce は存在しない Memory に対して失敗する（既存の挙動を壊していないことの確認）", async () => {
    const stores = createFakeRuntimeStores();
    await expect(stores.memoryStore.reinforce(ctx, "does-not-exist", new Date())).rejects.toThrow(
      /memory not found for tenant/,
    );
  });
});
