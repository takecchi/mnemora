import { describe, expect, it } from "vitest";
import { eraseTenant } from "@mnemora/core";
import type { Ctx, EmbeddingSpaceId, NewRecallRecord } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * `InMemoryMemoryStore.eraseTenant` を `PostgresMemoryStore.eraseTenant` に揃える
 * （[ADR 0426](../../../../docs/decisions/0426-in-memory-erase-tenant-postgres-alignment.md)）。
 *
 * 1. `tenant_subject_activity` は `(tenant_id, subject_id)` が主キーで、テナントあたり
 *    subject の数だけ行がある。`deleted` も `limit` の budget も、その行数で数える
 *    （`packages/postgres/src/memory-store.ts` の `eraseTenantBody` 手順9）。
 * 2. `memory_embeddings_<space>.memory_id` は `memories(id) ON DELETE CASCADE`
 *    （`packages/postgres/src/vector-space.ts`）——`memories` の行を消すと、その埋め込みも
 *    同じ文で消える。消えた埋め込みはどの port の `deleted` にも数えない。
 */
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 2 };

function subjectRecall(ctx: Ctx, subjectId: string): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId,
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
    advanceActivityClock: { scope: "subject", subjectId },
  };
}

describe("InMemoryMemoryStore.eraseTenant — tenant_subject_activity を subject ごとの行で数える", () => {
  it("subject が3つなら、recalls 3行 + tenant_subject_activity 3行 = 6 を返す", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "erase-subject-activity" };
    for (const subjectId of ["s1", "s2", "s3"]) {
      await memoryStore.createRecall(ctx, subjectRecall(ctx, subjectId));
    }

    const preview = await memoryStore.eraseTenant(ctx, { limit: 1000, dryRun: true });
    expect(preview).toMatchObject({ deleted: 6, reachedLimit: false });

    const result = await memoryStore.eraseTenant(ctx, { limit: 1000 });
    expect(result).toMatchObject({ deleted: 6, reachedLimit: false });
    expect(memoryStore.subjectActivitySeq.get(ctx.tenantId)?.size ?? 0).toBe(0);
  });

  it("limit が subject の行の途中で尽きたら、budget ぶんだけ消して残りを次の呼び出しへ回す", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "erase-subject-activity-limit" };
    for (const subjectId of ["s1", "s2", "s3"]) {
      await memoryStore.createRecall(ctx, subjectRecall(ctx, subjectId));
    }

    // recalls 3行で3、tenant_subject_activity は残り budget 2 行だけ消える。
    const first = await memoryStore.eraseTenant(ctx, { limit: 5 });
    expect(first).toMatchObject({ deleted: 5, reachedLimit: true });
    expect(memoryStore.subjectActivitySeq.get(ctx.tenantId)?.size).toBe(1);

    const second = await memoryStore.eraseTenant(ctx, { limit: 5 });
    expect(second).toMatchObject({ deleted: 1, reachedLimit: false });
    expect(memoryStore.subjectActivitySeq.get(ctx.tenantId)?.size ?? 0).toBe(0);
  });
});

describe("InMemoryMemoryStore.eraseTenant — memories を消すと埋め込みも消える（ON DELETE CASCADE）", () => {
  it("消した memories の埋め込みだけが消え、他テナント・消さなかった memories の埋め込みは残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: "erase-cascade" };
    const other: Ctx = { tenantId: "erase-cascade-other" };
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      await vectorStore.upsert(ctx, SPACE, memory.id, [1, i]);
      ids.push(memory.id);
    }
    const otherMemory = await memoryStore.createMemory(
      other,
      buildNewMemoryFixture({ tenantId: other.tenantId }),
    );
    await vectorStore.upsert(other, SPACE, otherMemory.id, [1, 0]);

    // memories 3行のうち2行で budget が尽きる。
    const first = await memoryStore.eraseTenant(ctx, { limit: 2 });
    expect(first).toMatchObject({ deleted: 2, reachedLimit: true });
    const remaining = await vectorStore.getVectors(ctx, SPACE, ids);
    expect(remaining).toHaveLength(1);
    expect(await memoryStore.get(ctx, remaining[0]!.memoryId)).not.toBeNull();

    await memoryStore.eraseTenant(ctx, { limit: 1000 });
    expect(await vectorStore.getVectors(ctx, SPACE, ids)).toEqual([]);
    expect(await vectorStore.eraseTenant(ctx, { limit: 1000 })).toEqual({
      deleted: 0,
      reachedLimit: false,
    });
    expect(await vectorStore.getVectors(other, SPACE, [otherMemory.id])).toHaveLength(1);
  });

  it("dryRun では何も消さず、埋め込みも残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: "erase-cascade-dry-run" };
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    await vectorStore.upsert(ctx, SPACE, memory.id, [1, 0]);

    await memoryStore.eraseTenant(ctx, { limit: 1000, dryRun: true });
    expect(await vectorStore.getVectors(ctx, SPACE, [memory.id])).toHaveLength(1);
  });

  it("core の eraseTenant を通すと、本番の deleted.vectorStore は 0（Postgres と同じ）、dryRun は実数", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
    const tenantSettingsStore = new InMemoryTenantSettingsStore();
    const ctx: Ctx = { tenantId: "erase-cascade-core" };
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      await vectorStore.upsert(ctx, SPACE, memory.id, [1, i]);
      ids.push(memory.id);
    }
    const deps = { memoryStore, vectorStore, outboxStore, tenantSettingsStore };
    const opts = { confirmTenantId: ctx.tenantId, limit: 1000 };

    const preview = await eraseTenant(ctx, deps, { ...opts, dryRun: true });
    expect(preview).toMatchObject({ kind: "executed", deleted: { vectorStore: 2 } });

    const result = await eraseTenant(ctx, deps, opts);
    expect(result).toMatchObject({ kind: "executed", deleted: { vectorStore: 0 } });
    expect(await vectorStore.getVectors(ctx, SPACE, ids)).toEqual([]);
  });
});
