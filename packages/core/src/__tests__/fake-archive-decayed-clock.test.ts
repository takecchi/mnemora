import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `memory-store-conformance.ts` には足さない: `FakeMemoryStore` は core の runtime テスト専用の別系統のため。 */

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
    contentHash: `archive-decayed-clock-${contentHashCounter}`,
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

describe("FakeMemoryStore.archiveDecayed の opts.clock（ADR 0165 決めたこと15、Issue #768）", () => {
  it("clock: 'activity' は decayFloorSeq <= nowSeq（境界を含む）の Memory だけを対象にする。decayFloorSeq が NULL の行は対象にしない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const nowSeq = 1000;

    const decayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: now, decayFloorSeq: nowSeq - 1 }),
    );
    const boundary = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: now, decayFloorSeq: nowSeq }),
    );
    const notYetDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: now, decayFloorSeq: nowSeq + 1 }),
    );
    const nullSeq = await memoryStore.createMemory(ctx, newMemory({ decayFloorAt: now }));

    const result = await memoryStore.archiveDecayed(ctx, {
      now,
      nowSeq,
      clock: "activity",
      limit: 10,
    });

    const archivedIds = new Set(result.archived.map((a) => a.memoryId));
    expect(archivedIds).toEqual(new Set([decayed.id, boundary.id]));
    expect((await memoryStore.get(ctx, notYetDecayed.id))?.status).toBe("active");
    expect((await memoryStore.get(ctx, nullSeq.id))?.status).toBe("active");
  });

  it("clock: 'activity' は limit が効くとき decayFloorSeq 昇順で選ぶ（decayFloorAt 昇順ではない）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const nowSeq = 1000;

    // 活動軸の昇順と壁時計の昇順が逆向きになるように置く。
    // seq が小さい（＝もっとも沈んでいる）ものほど decayFloorAt が新しい。
    const seqFirst = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 1_000), decayFloorSeq: 10 }),
    );
    const seqSecond = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 2_000), decayFloorSeq: 20 }),
    );
    const seqThird = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 3_000), decayFloorSeq: 30 }),
    );

    const result = await memoryStore.archiveDecayed(ctx, {
      now,
      nowSeq,
      clock: "activity",
      limit: 2,
    });

    // ⛔ 壁時計の昇順なら seqThird（-3000）と seqSecond（-2000）が選ばれるはずで、
    //    この歯はそれを排除している。
    expect(new Set(result.archived.map((a) => a.memoryId))).toEqual(
      new Set([seqFirst.id, seqSecond.id]),
    );
    expect((await memoryStore.get(ctx, seqThird.id))?.status).toBe("active");
    expect(result.reachedLimit).toBe(true);

    expect(result.archived.map((a) => a.memoryId)).toEqual([seqSecond.id, seqFirst.id]);
  });

  it("clock: 'either' は AND——両方の軸で沈んでいる Memory だけを対象にする（ゲートの OR とは逆向き）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const nowSeq = 1000;
    const decayedAt = new Date(now.getTime() - 1_000);
    const notYetAt = new Date(now.getTime() + 1_000);

    const bothDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: decayedAt, decayFloorSeq: nowSeq - 1 }),
    );
    const onlyWallDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: decayedAt, decayFloorSeq: nowSeq + 1 }),
    );
    const onlySeqDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: notYetAt, decayFloorSeq: nowSeq - 1 }),
    );

    const result = await memoryStore.archiveDecayed(ctx, {
      now,
      nowSeq,
      clock: "either",
      limit: 10,
    });

    expect(new Set(result.archived.map((a) => a.memoryId))).toEqual(new Set([bothDecayed.id]));
    expect((await memoryStore.get(ctx, onlyWallDecayed.id))?.status).toBe("active");
    expect((await memoryStore.get(ctx, onlySeqDecayed.id))?.status).toBe("active");
  });

  it("clock を省略すると従来どおり 'wall'（decayFloorAt <= now）だけで掃く（回帰）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const now = new Date("2026-06-01T00:00:00.000Z");

    const decayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 1_000) }),
    );
    const notYetDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() + 1_000) }),
    );

    const result = await memoryStore.archiveDecayed(ctx, { now, limit: 10 });

    expect(result.archived.map((a) => a.memoryId)).toEqual([decayed.id]);
    expect((await memoryStore.get(ctx, notYetDecayed.id))?.status).toBe("active");
  });
});
