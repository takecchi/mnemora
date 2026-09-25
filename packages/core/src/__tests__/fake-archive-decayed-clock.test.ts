import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.archiveDecayed` の `opts.clock`（`ArchiveDecayedOptions.clock`、
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15）が、
 * `InMemoryMemoryStore.archiveDecayed`/`PostgresMemoryStore.archiveDecayed` と同じ
 * 意味論（`'wall'`/`'activity'`/`'either'` の2軸、`'either'` は AND）を実際に守って
 * いることを検査する歯。
 *
 * **`packages/testkit` の `memory-store-conformance.ts` の対象ではない。**
 * `FakeMemoryStore` は `packages/core` 自身の runtime テスト専用の別系統
 * （`fake-reinforce-monotonicity.test.ts` と同じ理由・同じ形）。
 *
 * Issue #768: 調査時、この Fake を `describeMemoryStoreConformance` へ一時的に通して
 * 見つけた食い違い（`archiveDecayed` が `opts.clock` を一切見ず、常に壁時計
 * （`decayFloorAt <= now`）だけで掃いていた）を、`runtime-fakes.ts` の
 * `archiveDecayed` に足した `passesClock`/`selectionOrder` の分岐で塞いだ。その塞ぎが
 * 実際に効いていることを、`memory-store-conformance.ts` の対応する3本の歯と同じ形で
 * ここに固定する。
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
    // 境界そのもの（decayFloorSeq === nowSeq）も対象に含む——`<=`、境界を含む。
    const boundary = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: now, decayFloorSeq: nowSeq }),
    );
    const notYetDecayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: now, decayFloorSeq: nowSeq + 1 }),
    );
    // decayFloorSeq が NULL（この軸を使っていない）の行は 'activity' 単独では対象外
    // （ADR 0165 決めたこと4「NULL はこの軸には床が無い」——掃引側も NULL を拾わない）。
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

    // 活動軸の昇順で 10, 20 が選ばれる。
    // ⛔ 壁時計の昇順なら seqThird（-3000）と seqSecond（-2000）が選ばれるはずで、
    //    この歯はそれを排除している。
    expect(new Set(result.archived.map((a) => a.memoryId))).toEqual(
      new Set([seqFirst.id, seqSecond.id]),
    );
    expect((await memoryStore.get(ctx, seqThird.id))?.status).toBe("active");
    expect(result.reachedLimit).toBe(true);

    // 返り値の並びは decayFloorAt 昇順のまま（選び方とは別の契約）。
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
