// #980 の確かめ直し（#1774）。`InMemoryMemoryStore.recordUsageAndReinforce` の契約のうち、
// 既存の歯（`in-memory-fixtures-record-usage-and-reinforce.test.ts`＝強化が失敗したら記録も取り消す、
// `memory-store-conformance.ts`＝別テナントを拒む・活動時計）が見ていない形。
//
// - 強化の対象は「この呼び出しで実際に挿入した id だけ」。再送（全部が既に記録済み）では空配列を返し、強化もしない。
//   一部だけが新しい呼び出しでは、新しい id だけを返して強化し、既に記録済みの id は強化し直さない。
// - `at`・`opts`（`nowSeq`）は強化にそのまま届く。
// - 強化が失敗して取り消すのは「この呼び出しで挿入した行」だけで、以前の呼び出しで記録済みの行は残る。

import { describe, expect, it } from "vitest";
import type { Ctx, Memory, RecallId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-usage-contract" };
const AT1 = new Date("2026-06-02T00:00:00.000Z");
const AT2 = new Date("2026-06-03T00:00:00.000Z");

async function setup() {
  const store = new InMemoryMemoryStore();
  const mk = (hash: string) =>
    store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: hash,
        strength: 1,
        decayBaseSeq: 0,
        decayFloorSeq: 10,
        halfLifeRecalls: 360,
      }),
    );
  const m1 = await mk("usage-contract-1");
  const m2 = await mk("usage-contract-2");
  const recallId: RecallId = await store.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic" as const,
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
    explain: { stages: [] },
    returnedMemories: [],
  });
  const view = async (m: Memory) => {
    const r = (await store.get(ctx, m.id))!;
    return {
      strength: r.strength,
      lastReinforcedAt: r.lastReinforcedAt?.toISOString() ?? null,
      decayBaseSeq: r.decayBaseSeq,
    };
  };
  return { store, m1, m2, recallId, view };
}

describe("InMemoryMemoryStore.recordUsageAndReinforce: 挿入した id だけを返して強化する（#980）", () => {
  it("at・opts は強化に届く。再送は空配列を返して強化しない。一部だけ新しければ新しい id だけを返して強化する", async () => {
    const { store, m1, m2, recallId, view } = await setup();

    const r1 = await store.recordUsageAndReinforce(ctx, recallId, [m1.id], AT1, { nowSeq: 5 });
    expect(r1.insertedMemoryIds).toEqual([m1.id]);
    const afterFirst = await view(m1);
    expect(afterFirst.lastReinforcedAt).toBe(AT1.toISOString());
    expect(afterFirst.decayBaseSeq).toBe(5);

    // 再送：全部が記録済み
    const r2 = await store.recordUsageAndReinforce(ctx, recallId, [m1.id], AT2, { nowSeq: 7 });
    expect(r2.insertedMemoryIds).toEqual([]);
    expect(await view(m1)).toEqual(afterFirst);

    // 一部だけ新しい
    const r3 = await store.recordUsageAndReinforce(ctx, recallId, [m1.id, m2.id], AT2, {
      nowSeq: 7,
    });
    expect(r3.insertedMemoryIds).toEqual([m2.id]);
    expect(await view(m1)).toEqual(afterFirst);
    const m2After = await view(m2);
    expect(m2After.lastReinforcedAt).toBe(AT2.toISOString());
    expect(m2After.decayBaseSeq).toBe(7);
  });

  it("強化が失敗したとき取り消すのは、この呼び出しで挿入した行だけ（以前に記録済みの行は残り、次の呼び出しで強化し直されない）", async () => {
    const { store, m1, m2, recallId, view } = await setup();
    await store.recordUsageAndReinforce(ctx, recallId, [m1.id], AT1, { nowSeq: 5 });
    const afterFirst = await view(m1);

    await expect(
      store.recordUsageAndReinforce(ctx, recallId, [m1.id, m2.id], new Date(Number.NaN), {
        nowSeq: 6,
      }),
    ).rejects.toThrow();
    // m2 は取り消され、m1 は記録済みのまま
    const retry = await store.recordUsageAndReinforce(ctx, recallId, [m1.id, m2.id], AT2, {
      nowSeq: 7,
    });
    expect(retry.insertedMemoryIds).toEqual([m2.id]);
    expect(await view(m1)).toEqual(afterFirst);
  });
});
