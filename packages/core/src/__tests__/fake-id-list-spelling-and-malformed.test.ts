import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// id の「一覧」を取る口の綴りと形の崩れ（`@mnemora/postgres` と同じ）。core の `FakeMemoryStore` が対象。DB を使わない。
//
// - #1195 T3: `restoreSupersededBy`・`previewRestoreSupersededBy` の `onlyMemoryIds` に大文字の id を渡しても、
//   小文字の id と同じ記憶として当たる。形の崩れた id が混ざっても投げず、群に居ないものとして扱う。
// - #1289: `aggregateScope` の `digestBand.excludeMemoryIds` も同じ（大文字の id は除外される・形の崩れた id は投げない）。
// この Fake の id は小文字の `mem-N` だけで、小文字にそろえても別の id と混ざらない。
// 3実装の突き合わせは `packages/postgres/src/__tests__/store-boundary-diff.postgres.test.ts`。
// conformance suite には何も足していない。

const ctx: Ctx = { tenantId: "fake-id-list-spelling" };
const MALFORMED = "not-a-uuid" as MemoryId;
const up = (id: MemoryId) => id.toUpperCase() as MemoryId;

function newMemory(n: number): NewMemory {
  const recordedAt = new Date("2026-06-01T00:00:00.000Z");
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${n}`,
    contentHash: `h-${n}`,
    digest: `要旨 ${n}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-id-list" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365,
    }),
    embeddingStatus: "ready",
  };
}

async function group() {
  const { memoryStore: store } = createFakeRuntimeStores();
  const make = async (n: number): Promise<MemoryId> =>
    (await store.createMemory(ctx, newMemory(n))).id;
  const winner = await make(0);
  const losers: MemoryId[] = [];
  for (let n = 1; n <= 3; n++) {
    const id = await make(n);
    await store.updateStatus(ctx, id, "superseded", { supersededById: winner });
    losers.push(id);
  }
  return { store, winner, losers };
}

describe("FakeMemoryStore: restoreSupersededBy・previewRestoreSupersededBy の onlyMemoryIds", () => {
  it("preview: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが候補になる（#1195 T3）", async () => {
    const { store, winner, losers } = await group();
    const preview = await store.previewRestoreSupersededBy!(ctx, winner, {
      onlyMemoryIds: [up(losers[0]!), losers[1]!, MALFORMED],
    });
    expect(preview.candidates.map((c) => c.memoryId).sort()).toEqual(
      [losers[0]!, losers[1]!].sort(),
    );
  });

  it("実行: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが戻る（#1195 T3）", async () => {
    const { store, winner, losers } = await group();
    const { restored } = await store.restoreSupersededBy!(
      ctx,
      winner,
      { at: new Date() },
      { onlyMemoryIds: [up(losers[0]!), losers[1]!, MALFORMED] },
    );
    expect(restored.map((m) => m.id).sort()).toEqual([losers[0]!, losers[1]!].sort());
    expect((await store.get(ctx, losers[0]!))?.status).toBe("active");
    expect((await store.get(ctx, losers[1]!))?.status).toBe("active");
    expect((await store.get(ctx, losers[2]!))?.status).toBe("superseded");
  });
});

describe("FakeMemoryStore: aggregateScope の digestBand.excludeMemoryIds", () => {
  async function twoActive() {
    const { memoryStore: store } = createFakeRuntimeStores();
    const a = (await store.createMemory(ctx, newMemory(1))).id;
    const b = (await store.createMemory(ctx, newMemory(2))).id;
    return { store, a, b };
  }

  it("大文字の id は同じ記憶として除外される", async () => {
    const { store, a, b } = await twoActive();
    const result = await store.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 10, excludeMemoryIds: [up(a)] } },
    );
    expect(result.digests.map((d) => d.memoryId)).toEqual([b]);
  });

  it("形の崩れた id が混ざっても投げず、有効な2件の除外は両方とも効く", async () => {
    const { store, a, b } = await twoActive();
    const result = await store.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 10, excludeMemoryIds: [up(a), MALFORMED, b] } },
    );
    expect(result.digests).toEqual([]);
    const onlyMalformed = await store.aggregateScope(
      ctx,
      {},
      { digestBand: { limit: 10, excludeMemoryIds: [MALFORMED] } },
    );
    expect(onlyMalformed.digests.map((d) => d.memoryId).sort()).toEqual([a, b].sort());
  });
});
