import { randomUUID } from "node:crypto";
import type { Ctx, MemoryId } from "@mnemora/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "purge-labels-scope-tenant" };

async function purge(store: PostgresMemoryStore, id: MemoryId): Promise<void> {
  await store.purgeMemory!(
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

async function memoryLabelCount(id: MemoryId): Promise<number> {
  const { db } = await getTestClient();
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM memory_labels WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${id}`,
  );
  return (result.rows[0] as { n: number }).n;
}

describe("PostgresMemoryStore.purgeMemory が label に触れる範囲", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("claim key の衝突を記した監査イベントの meta.note は、その記憶を purge したあとも残る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
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

    const result = await db.execute(
      sql`SELECT meta->>'note' AS note FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${first.id} AND kind = 'updated'`,
    );
    expect((result.rows as { note: string | null }[]).map((row) => row.note)).toEqual([note]);
    expect(JSON.parse(note)).toMatchObject({ claimKey });
  });

  it("目次帯のエントリが truncated: true だったとき、墓石へ書き換えたあとの形は { memoryId, digest } だけ", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
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

  it("registered の label は、紐付けだけが外れ、proposedCount も status も動かない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
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
    const registered = await store.registerLabel!(ctx, tag);
    expect(registered).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });
    expect(await memoryLabelCount(memory.id)).toBe(1);

    await purge(store, memory.id);

    expect(await memoryLabelCount(memory.id)).toBe(0);
    const after = (await store.listLabels!(ctx)).find((l) => l.name === tag);
    expect(after).toMatchObject({ name: tag, status: "registered", proposedCount: 1 });
  });

  it("proposed の label の proposedCount は 0 を下回らない（数え違いがあっても負にならない）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const tag = `drift-${randomUUID()}`;
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `purge-labels-floor-${randomUUID()}`,
        status: "forgotten",
        tags: [tag],
      }),
    );
    // 近似値の数え違い（紐付けは1本在るのに、proposedCount が 0）を作る。
    await db.execute(
      sql`UPDATE labels SET proposed_count = 0 WHERE tenant_id = ${ctx.tenantId} AND name = ${tag}`,
    );
    expect(await memoryLabelCount(memory.id)).toBe(1);

    await purge(store, memory.id);

    expect(await memoryLabelCount(memory.id)).toBe(0);
    const after = (await store.listLabels!(ctx)).find((l) => l.name === tag);
    expect(after).toMatchObject({ name: tag, status: "proposed", proposedCount: 0 });
  });
});
