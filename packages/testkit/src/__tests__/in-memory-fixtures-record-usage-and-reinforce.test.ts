import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const AT = new Date("2026-06-01T00:00:00.000Z");

async function setup() {
  const store = new InMemoryMemoryStore();
  const memory = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h1" }),
  );
  const recallId = await store.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  });
  return { store, memory, recallId };
}

describe("InMemoryMemoryStore.recordUsageAndReinforce（Issue #961）", () => {
  it("新しく挿入した id だけを返し、それを強化する。2回目は空で、強化もしない", async () => {
    const { store, memory, recallId } = await setup();

    const first = await store.recordUsageAndReinforce!(ctx, recallId, [memory.id], AT);
    expect(first).toEqual({ insertedMemoryIds: [memory.id] });
    expect((await store.get(ctx, memory.id))?.lastReinforcedAt).toEqual(AT);

    const later = new Date(AT.getTime() + 60_000);
    const second = await store.recordUsageAndReinforce!(ctx, recallId, [memory.id], later);
    expect(second).toEqual({ insertedMemoryIds: [] });
    expect((await store.get(ctx, memory.id))?.lastReinforcedAt).toEqual(AT);
  });

  it("強化が失敗すると（Invalid Date）使用の記録も残らず、正しい at でやり直すと両方が起きる", async () => {
    const { store, memory, recallId } = await setup();

    await expect(
      store.recordUsageAndReinforce!(ctx, recallId, [memory.id], new Date(Number.NaN)),
    ).rejects.toThrow(/Invalid Date/);
    expect((await store.get(ctx, memory.id))?.lastReinforcedAt ?? null).toBeNull();

    const retried = await store.recordUsageAndReinforce!(ctx, recallId, [memory.id], AT);
    expect(retried).toEqual({ insertedMemoryIds: [memory.id] });
    expect((await store.get(ctx, memory.id))?.lastReinforcedAt).toEqual(AT);
  });
});
