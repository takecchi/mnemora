import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-recall-read-back" };

const usage = {
  chars: 123,
  estimatedTokens: 31,
  counter: "heuristic" as const,
  byTier: { full: 0, digest: 100, index: 23 },
  indexChars: 23,
};

function record(override: Partial<NewRecallRecord> = {}): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId: "subject-1",
    query: { text: "好きな食べ物", limit: 3 },
    budget: { maxMemoryChars: 500 },
    omitted: [{ kind: "not_indexed", reason: "pending", count: 2 } as never],
    usage,
    indexBand: { groups: [], totalInScope: 7, countKind: "exact" },
    explain: { stages: [{ stage: "record", executed: true }] },
    returnedMemories: [],
    ...override,
  };
}

describe("InMemoryMemoryStore.getRecall は、createRecall に渡した欄をそれぞれ読み戻す", () => {
  it("subjectId・budget・omitted・usage・indexBand・explain・query を渡した値のまま返す", async () => {
    const store = new InMemoryMemoryStore();
    const input = record();
    const recallId = await store.createRecall(ctx, input);

    const read = await store.getRecall(ctx, recallId);

    expect(read).toMatchObject({
      recallId,
      tenantId: ctx.tenantId,
      subjectId: input.subjectId,
      query: input.query,
      budget: input.budget,
      omitted: input.omitted,
      usage: input.usage,
      indexBand: input.indexBand,
      explain: input.explain,
    });
  });

  it("subjectId と budget を省いた記録は、どちらも null で読み戻す", async () => {
    const store = new InMemoryMemoryStore();
    const recallId = await store.createRecall(
      ctx,
      record({ subjectId: undefined, budget: undefined }),
    );

    const read = await store.getRecall(ctx, recallId);

    expect(read?.subjectId).toBeNull();
    expect(read?.budget).toBeNull();
  });

  it("返した記憶の内訳は、記憶ごと・並びのまま・欠かさず読み戻す", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "other" }),
    );
    const returnedMemories = [
      {
        memoryId: b.id,
        score: { similarity: 0.5, decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 0.5 },
        retrievedVia: "ann" as const,
      },
      {
        memoryId: a.id,
        score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 0 },
        retrievedVia: "mandatory_companion" as const,
        companionOf: b.id,
      },
    ];
    const recallId = await store.createRecall(ctx, record({ returnedMemories }));

    const read = await store.getRecall(ctx, recallId);

    expect(read?.returnedMemories).toStrictEqual({
      breakdownCaptured: true,
      memories: returnedMemories,
    });
  });

  it("record.tenantId が ctx と違っても、ctx のテナントの記録として書き、別のテナントからは読めない", async () => {
    const store = new InMemoryMemoryStore();
    const other: Ctx = { tenantId: "tenant-other" };
    const recallId = await store.createRecall(ctx, record({ tenantId: other.tenantId }));

    expect((await store.getRecall(ctx, recallId))?.tenantId).toBe(ctx.tenantId);
    expect(await store.getRecall(other, recallId)).toBeNull();
  });
});
