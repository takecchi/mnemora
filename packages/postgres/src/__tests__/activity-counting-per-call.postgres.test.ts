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
 * [ADR 0352](../../../docs/decisions/0352-activity-counting-per-call.md)
 * （Issue #338）: `packages/core` の `activity-counting-per-call.test.ts`（in-memory の
 * `Fake` 実装）が既に確かめた「recall のたびの前進」の意味論を、**本物の Postgres の
 * SQL**（段1 ANN ゲートの相関サブクエリ）に対しても確かめる。
 *
 * `packages/core` 側のテストは、後置フィルタ（`recall-runtime.ts` の
 * `activityAxisAlive`）という多層防御があるため、**段1 SQL 自体が
 * `decayFloorSeqUsesSubjectCounters` を無視しても検出できない**（実際に確かめた——
 * `effectiveNowSeqFor` を壊さず `scope.decayFloorSeqUsesSubjectCounters` だけを
 * `false` に固定する変異を core 側のテストに当てたところ、後置フィルタが同じ判定を
 * 再現するため赤くならなかった）。この歯は `PostgresVectorStore.search` を直接呼び、
 * 後置フィルタを経由せずに段1 SQL 単体の挙動を確かめる。
 */
describe("PostgresVectorStore.search — decayFloorSeqUsesSubjectCounters（ADR 0352、Issue #338）", () => {
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

    // 床 9（狭義の `>` なので nowSeq=9 でちょうど沈む）。
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

    // S_bob = 10（bob のカウンタだけを進める。tenant_activity には触れない）。
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

    // decayFloorSeqUsesSubjectCounters: true で、T=0 を渡す。bob（S_bob=10、床9）は
    // 9 <= 10 なので沈む。alice（S_alice=0、床9）は 9 > 0 なので生き残る。
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

    // decayFloorSeqUsesSubjectCounters を渡さない（省略）。T=0 のみと比較するので、
    // S_bob=10 を無視して bob は生き残る——本 ADR 以前と1バイトも変わらない SQL。
    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [0, 1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, decayFloorSeqAfter: 0 },
    });
    expect(hits.map((h) => h.memoryId)).toContain(bob.id);
  });
});
