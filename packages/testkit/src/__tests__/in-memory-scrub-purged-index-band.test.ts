import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

function recallWithBand(
  tenantId: string,
  digestBand: { memoryId: string; digest: string; truncated?: boolean }[],
): NewRecallRecord {
  return {
    tenantId,
    subjectId: "s",
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact", digestBand },
    explain: { stages: [] },
    returnedMemories: [],
  };
}

async function bandOf(store: InMemoryMemoryStore, ctx: Ctx, recallId: string) {
  const rec = await store.getRecall(ctx, recallId);
  return rec?.indexBand.digestBand;
}

describe("InMemoryMemoryStore.scrubPurged — recalls.indexBand の digest（ADR 0512）", () => {
  it("purge 済みの行のエントリだけ伏せる。未 purge の forgotten・生きている記憶・他テナントの帯は触らない。べき等", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "band-a" };
    const other: Ctx = { tenantId: "band-b" };
    const purged = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "band-a", contentHash: "p", status: "forgotten" }),
    );
    const unpurged = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "band-a", contentHash: "u", status: "forgotten" }),
    );
    const live = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "band-a", contentHash: "l" }),
    );
    await store.purgeMemory(
      ctx,
      purged.id,
      { content: "[purged]", digest: "[purged]" },
      buildNewMemoryEventFixture({ tenantId: "band-a", memoryId: purged.id, kind: "purged" }),
    );
    const band = [
      { memoryId: purged.id, digest: "秘密", truncated: true },
      { memoryId: unpurged.id, digest: "未purge" },
      { memoryId: live.id, digest: "生きている" },
    ];
    const mine = await store.createRecall(ctx, recallWithBand("band-a", band));
    const theirs = await store.createRecall(other, recallWithBand("band-b", band));

    await store.scrubPurged(ctx, [purged.id, unpurged.id, live.id]);

    expect(await bandOf(store, ctx, mine)).toEqual([
      { memoryId: purged.id, digest: "[purged]" },
      { memoryId: unpurged.id, digest: "未purge" },
      { memoryId: live.id, digest: "生きている" },
    ]);
    expect(await bandOf(store, other, theirs)).toEqual(band);

    await store.scrubPurged(ctx, [purged.id]);
    expect(await bandOf(store, ctx, mine)).toEqual([
      { memoryId: purged.id, digest: "[purged]" },
      { memoryId: unpurged.id, digest: "未purge" },
      { memoryId: live.id, digest: "生きている" },
    ]);
  });
});
