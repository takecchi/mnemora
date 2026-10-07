import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "inmemory-id-list-spelling" };
const MALFORMED = "not-a-uuid" as MemoryId;
const up = (id: MemoryId) => id.toUpperCase() as MemoryId;

async function group() {
  const store = new InMemoryMemoryStore();
  const make = async (n: number): Promise<MemoryId> =>
    (
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `h-${n}`,
          content: `本文 ${n}`,
          digest: `要旨 ${n}`,
        }),
      )
    ).id;
  const winner = await make(0);
  const losers: MemoryId[] = [];
  for (let n = 1; n <= 3; n++) {
    const id = await make(n);
    await store.updateStatus(ctx, id, "superseded", { supersededById: winner });
    losers.push(id);
  }
  return { store, winner, losers };
}

describe("InMemoryMemoryStore: restoreSupersededBy・previewRestoreSupersededBy の onlyMemoryIds", () => {
  it("preview: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが候補になる（#1195 T1）", async () => {
    const { store, winner, losers } = await group();
    const preview = await store.previewRestoreSupersededBy(ctx, winner, {
      onlyMemoryIds: [up(losers[0]!), losers[1]!, MALFORMED],
    });
    expect(preview.candidates.map((c) => c.memoryId).sort()).toEqual(
      [losers[0]!, losers[1]!].sort(),
    );
  });

  it("実行: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが戻る（#1195 T1）", async () => {
    const { store, winner, losers } = await group();
    const { restored } = await store.restoreSupersededBy(
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

describe("InMemoryMemoryStore: aggregateScope の digestBand.excludeMemoryIds", () => {
  async function twoActive() {
    const store = new InMemoryMemoryStore();
    const [a, b] = [
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "a", digest: "a" }),
      ),
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "b", digest: "b" }),
      ),
    ];
    return { store, a: a.id, b: b.id };
  }

  for (const skip of [false, true]) {
    const mode = skip ? "scopeAggregate:skip" : "既定";
    const base = skip ? { scopeAggregate: "skip" as const } : {};

    it(`${mode}: 大文字の id は同じ記憶として除外される（#1289 T1）`, async () => {
      const { store, a, b } = await twoActive();
      const result = await store.aggregateScope(
        ctx,
        {},
        { ...base, digestBand: { limit: 10, excludeMemoryIds: [up(a)] } },
      );
      expect(result.digests.map((d) => d.memoryId)).toEqual([b]);
    });

    it(`${mode}: 形の崩れた id が混ざっても投げず、有効な2件の除外は両方とも効く（#1289 T2'）`, async () => {
      const { store, a, b } = await twoActive();
      const result = await store.aggregateScope(
        ctx,
        {},
        { ...base, digestBand: { limit: 10, excludeMemoryIds: [up(a), MALFORMED, b] } },
      );
      expect(result.digests).toEqual([]);
      const onlyMalformed = await store.aggregateScope(
        ctx,
        {},
        { ...base, digestBand: { limit: 10, excludeMemoryIds: [MALFORMED] } },
      );
      expect(onlyMalformed.digests.map((d) => d.memoryId).sort()).toEqual([a, b].sort());
    });
  }
});
