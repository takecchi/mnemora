import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 段1 SQL 自体が `decayFloorSeqUsesSubjectCounters` を無視しても、core 側のテストは後置フィルタ
 * （`recall-runtime.ts` の `activityAxisAlive`）が同じ判定を再現するため赤くならない。
 * そのため `PostgresVectorStore.search` を直接呼び、後置フィルタを経由しない。
 */
describe("PostgresVectorStore.search — decayFloorSeqUsesSubjectCounters（ADR 0353、Issue #338）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("true のとき、行の subject_id に対応する tenant_subject_activity の値を足して比較する（別 subject には影響しない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    const ctx: Ctx = { tenantId: `acpc-${Date.now()}` };

    const alice = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "alice",
        decayBaseSeq: 0,
        decayFloorSeq: 9,
        halfLifeRecalls: 2,
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, alice.id, [1, 0, 0]);
    const bob = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "bob",
        decayBaseSeq: 0,
        decayFloorSeq: 9,
        halfLifeRecalls: 2,
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, bob.id, [0, 1, 0]);

    for (let i = 0; i < 10; i += 1) {
      await memoryStore.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: "bob",
        query: { text: "q" },
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
        advanceActivityClock: { scope: "subject", subjectId: "bob" },
      });
    }
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);
    expect(await tenantSettingsStore.hasSubjectActivityCounters(ctx)).toBe(true);
    expect(await tenantSettingsStore.getSubjectActivitySeqs(ctx, ["alice", "bob"])).toEqual({
      bob: 10,
    });

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [1, 1, 0], {
      limit: 10,
      filter: {
        tenantId: ctx.tenantId,
        decayFloorSeqAfter: 0,
        decayFloorSeqUsesSubjectCounters: true,
      },
    });
    const hitIds = hits.map((h) => h.memoryId);
    expect(hitIds).toContain(alice.id);
    expect(hitIds).not.toContain(bob.id);
  });

  it("false（既定）のとき、tenant_subject_activity を無視して T のみと比較する（本 ADR 以前と同じ SQL）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: `acpc-legacy-${Date.now()}` };

    const bob = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "bob",
        decayBaseSeq: 0,
        decayFloorSeq: 9,
        halfLifeRecalls: 2,
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, bob.id, [0, 1, 0]);

    for (let i = 0; i < 10; i += 1) {
      await memoryStore.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: "bob",
        query: { text: "q" },
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
        advanceActivityClock: { scope: "subject", subjectId: "bob" },
      });
    }

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [0, 1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, decayFloorSeqAfter: 0 },
    });
    expect(hits.map((h) => h.memoryId)).toContain(bob.id);
  });
});
