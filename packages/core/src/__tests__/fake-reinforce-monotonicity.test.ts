import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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
    // ⚠ ここが `<` と `<=` の境界。`<=` にすると同じ値を書き直すだけなので、last_reinforced_at と decay_floor_at だけを見ていては
    // 区別が付かない。区別が付くのは updatedAt だけ——「べき等」を「同じ値になる」ではなく「行を触らない」の意味で固定する。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const at = new Date(memory.recordedAt.getTime() + 48 * HOUR);

    const first = await stores.memoryStore.reinforce(ctx, memory.id, at);
    expect(first.lastReinforcedAt?.getTime()).toBe(at.getTime());
    // ⚠ プリミティブへ即座に写し取る。FakeMemoryStore も行オブジェクトへの参照をそのまま返すため、`first` を後段の再代入まで保持すると
    // 同じオブジェクトを2回見るだけになり、比較が常に真になって歯が死ぬ。
    const firstDecayFloorAt = first.decayFloorAt.getTime();
    const firstUpdatedAt = first.updatedAt.getTime();

    // ⚠ `updatedAt` は壁時計を使う。2回の呼び出しが同期的に一瞬で終わると、ガードが
    // 外れて2回目も書き込む実装であっても、ミリ秒の解像度に収まって偶然同じ値になり
    // かねない。実際に時間を進めてから2回目を呼び、「書けば必ず値が変わる」状況を
    // 作ってから「変わっていない」を確かめる。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const again = await stores.memoryStore.reinforce(ctx, memory.id, at);
    expect(again.lastReinforcedAt?.getTime()).toBe(at.getTime());
    expect(again.decayFloorAt.getTime()).toBe(firstDecayFloorAt);
    expect(again.updatedAt.getTime()).toBe(firstUpdatedAt);

    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.updatedAt.getTime()).toBe(firstUpdatedAt);
  });

  for (const [label, offsetMs] of [
    ["作成時刻より前の at", -10 * 24 * HOUR],
    ["作成時刻ちょうどの at（狭義の `<` の境界）", 0],
  ] as const) {
    it(`未強化の記憶に${label}を渡すと、活動時計の欄も含めて何も書かない（Issue #1093）`, async () => {
      const stores = createFakeRuntimeStores();
      const memory = await stores.memoryStore.createMemory(
        ctx,
        newMemory({ halfLifeRecalls: 100, decayBaseSeq: 0, decayFloorSeq: 100 }),
      );
      // Fake は行への参照を返すので、比べる値は先にプリミティブへ写し取る（上の歯と同じ理由）。
      const before = {
        lastReinforcedAt: memory.lastReinforcedAt ?? null,
        decayFloorAt: memory.decayFloorAt.getTime(),
        decayBaseSeq: memory.decayBaseSeq,
        decayFloorSeq: memory.decayFloorSeq,
        updatedAt: memory.updatedAt.getTime(),
      };

      await stores.memoryStore.reinforce(
        ctx,
        memory.id,
        new Date(memory.recordedAt.getTime() + offsetMs),
        { nowSeq: 50 },
      );

      const reread = await stores.memoryStore.get(ctx, memory.id);
      expect({
        lastReinforcedAt: reread?.lastReinforcedAt ?? null,
        decayFloorAt: reread?.decayFloorAt.getTime(),
        decayBaseSeq: reread?.decayBaseSeq,
        decayFloorSeq: reread?.decayFloorSeq,
        updatedAt: reread?.updatedAt.getTime(),
      }).toEqual(before);
    });
  }

  it("reinforce は存在しない Memory に対して失敗する（既存の挙動を壊していないことの確認）", async () => {
    const stores = createFakeRuntimeStores();
    await expect(stores.memoryStore.reinforce(ctx, "does-not-exist", new Date())).rejects.toThrow(
      /memory not found for tenant/,
    );
  });
});
