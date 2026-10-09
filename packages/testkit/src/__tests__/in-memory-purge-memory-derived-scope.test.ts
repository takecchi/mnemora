import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";

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
  it("目次帯を墓石へ書き換えても、その recall の query は purge の前と同じ", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-recall-query-${randomUUID()}`,
        status: "forgotten",
        digest: "問いには関係の無い要旨",
      }),
    );
    const query = { text: "purge の前から在る問い" };
    const recallId = await store.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query,
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
        digestBand: [{ memoryId: memory.id, digest: memory.digest }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });

    await purge(store, memory.id);

    const record = await store.getRecall(ctx, recallId);
    expect(record?.indexBand.digestBand).toEqual([{ memoryId: memory.id, digest: "[purged]" }]);
    expect(record?.query).toEqual(query);
  });

  it("claim key の衝突を記した監査イベントの meta.note は、その記憶を purge したあとも残る", async () => {
    const store = new InMemoryMemoryStore();
    const claimKey = { subject: "user", predicate: "likes" };
    const first = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-note-first-${randomUUID()}`,
        claimKey,
      }),
    );
    const second = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-note-second-${randomUUID()}`,
        claimKey,
      }),
    );
    const note = JSON.stringify({ kind: "claim_key_conflict", claimKey });
    const contestedEvent = (memoryId: MemoryId) =>
      buildNewMemoryEventFixture({
        tenantId: ctx.tenantId,
        memoryId,
        kind: "updated",
        meta: { note },
      });
    await store.markContestedPair(
      ctx,
      { id: first.id, event: contestedEvent(first.id) },
      { id: second.id, event: contestedEvent(second.id) },
    );
    await store.updateStatus(ctx, first.id, "forgotten");

    await purge(store, first.id);

    const notes = store.events
      .filter((event) => event.memoryId === first.id && event.kind === "updated")
      .map((event) => event.meta["note"]);
    expect(notes).toEqual([note]);
    expect(JSON.parse(notes[0] as string)).toMatchObject({ claimKey });
  });

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
