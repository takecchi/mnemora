import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultActivityDecayStrategy } from "../strategies/decay.js";
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

describe("FakeMemoryStore.reinforce の opts.nowSeq（ADR 0165 決めたこと16、Issue #768）", () => {
  it("opts.nowSeq を渡すと、halfLifeRecalls を持つ Memory の decayBaseSeq/decayFloorSeq を進める", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 360 }),
    );
    const nowSeq = 1000;
    const at = new Date(memory.recordedAt.getTime() + HOUR);

    const reinforced = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq });

    const expectedDecayFloorSeq = defaultActivityDecayStrategy.floorAt({
      baseSeq: nowSeq,
      strength: memory.strength,
      halfLifeRecalls: memory.halfLifeRecalls!,
    });
    expect(reinforced.decayBaseSeq).toBe(nowSeq);
    expect(reinforced.decayFloorSeq).toBe(expectedDecayFloorSeq);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await memoryStore.get(ctx, memory.id);
    expect(reread?.decayBaseSeq).toBe(nowSeq);
    expect(reread?.decayFloorSeq).toBe(expectedDecayFloorSeq);
  });

  it("⚠ 同じ at をもう一度渡すと、opts.nowSeq が進んでいても活動時計側を動かさない（2軸を同じ WHERE で守る、ADR 0048/0165。Issue #730）", async () => {
    // 活動時計側の3列は壁時計の `at` と同じ条件（狭義の `<`）で守られる。「seq が進んだから活動時計側だけ書く」実装は2軸の起点をずらす。
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 360 }),
    );
    const at = new Date(memory.recordedAt.getTime() + HOUR);
    const firstSeq = 1000;
    const secondSeq = 2000;

    const first = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq: firstSeq });
    // 前提: 1回目は活動時計側も実際に進めている。
    expect(first.decayBaseSeq).toBe(firstSeq);
    // プリミティブへ即座に写し取る: 行オブジェクトへの参照を保持すると、同じオブジェクトを2回見るだけになる。
    const firstDecayFloorSeq = first.decayFloorSeq;
    const firstUpdatedAt = first.updatedAt.getTime();
    // 書けば必ず updatedAt が変わる状況を作る。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const again = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq: secondSeq });
    expect(again.decayBaseSeq).toBe(firstSeq);
    expect(again.decayFloorSeq).toBe(firstDecayFloorSeq);
    expect(again.halfLifeRecalls).toBe(360);
    expect(again.updatedAt.getTime()).toBe(firstUpdatedAt);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await memoryStore.get(ctx, memory.id);
    expect(reread?.decayBaseSeq).toBe(firstSeq);
    expect(reread?.decayFloorSeq).toBe(firstDecayFloorSeq);
    expect(reread?.updatedAt.getTime()).toBe(firstUpdatedAt);
  });
});
