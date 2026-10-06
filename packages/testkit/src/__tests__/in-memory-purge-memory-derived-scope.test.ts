import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * `InMemoryMemoryStore.purgeMemory` が、本文の派生物（label の紐付け・`recalls.index_band` の目次帯）に
 * 触れる範囲。`PostgresMemoryStore` と同じ（`packages/postgres` の `purge-memory-derived-scope.postgres.test.ts`）。
 * - `registered` の label は触らない（`proposedCount` も `status` も動かさない）。紐付けは外れる。
 * - 目次帯のこの Memory のエントリは `{ memoryId, digest: 墓石 }` だけになる（`truncated` は落ちる）。
 */

const ctx: Ctx = { tenantId: "in-memory-purge-derived-scope" };

async function purge(store: InMemoryMemoryStore, id: MemoryId): Promise<void> {
  await store.purgeMemory(
    ctx,
    id,
    { content: "[purged]", digest: "[purged]" },
    {
      tenantId: ctx.tenantId,
      memoryId: id,
      kind: "purged",
      actor: { type: "system" },
      meta: {},
    },
  );
}

describe("InMemoryMemoryStore.purgeMemory が本文の派生物に触れる範囲", () => {
  it("registered の label は、proposedCount も status も動かない", async () => {
    const store = new InMemoryMemoryStore();
    const tag = `promoted-${randomUUID()}`;
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-labels-registered-${randomUUID()}`,
        status: "forgotten",
        tags: [tag],
      }),
    );
    const registered = await store.registerLabel(ctx, tag);
    expect(registered).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });

    await purge(store, memory.id);

    const after = (await store.listLabels(ctx)).find((l) => l.name === tag);
    expect(after).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });
  });

  it("目次帯のエントリが truncated: true だったとき、墓石へ書き換えたあとの形は { memoryId, digest } だけ", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-band-truncated-${randomUUID()}`,
        status: "forgotten",
        digest: "長さで切られた秘密の要旨",
      }),
    );
    const recallId = await store.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
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
      indexBand: {
        groups: [],
        totalInScope: 1,
        countKind: "exact",
        digestBand: [{ memoryId: memory.id, digest: memory.digest, truncated: true }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });

    await purge(store, memory.id);

    const record = await store.getRecall(ctx, recallId);
    expect(record?.indexBand.digestBand).toEqual([{ memoryId: memory.id, digest: "[purged]" }]);
  });
});
