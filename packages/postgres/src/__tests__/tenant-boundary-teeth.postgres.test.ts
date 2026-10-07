import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * テナントで絞る `WHERE` / `JOIN` を外すと赤になる歯を、歯の無かった口に足す。
 *
 * どの it も「別テナント B に行を作り、テナント A の ctx（または A の行）から触って、B の行が変わらない」
 * を見る。そのうえで、A 自身の操作は通ること（歯が「常に拒む」実装で緑にならないこと）も同じ it の中で見る。
 *
 * B の行が A の id を指す、A の行が B の id を指す、という形は API からは作れないので、
 * その形の入力は生 SQL で作る。
 */

const A: Ctx = { tenantId: "teeth-tenant-a" };
const B: Ctx = { tenantId: "teeth-tenant-b" };

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};
const recallRecord = (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  ({
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage,
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    ...extra,
  }) as never;
const event = (memoryId: MemoryId, kind = "updated", meta: Record<string, unknown> = {}) =>
  ({ memoryId, kind, actor: { type: "system" }, meta }) as never;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setup() {
  const { db, pool } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  const make = (ctx: Ctx, name: string, over: Record<string, unknown> = {}) =>
    mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: name,
        contentHash: `teeth-${ctx.tenantId}-${name}`,
        ...over,
      }),
    );
  return { db, pool, mem, make };
}

describe("markContestedGroup: 別テナントの記憶を群に入れられない（存在検査・UPDATE・関係の CTE の3段）", () => {
  it("A の ctx で B の3件／A2件＋B1件を渡すと拒まれ、B の行は active のまま・関係は張られない。A 自身の群は通る", async () => {
    const { pool, mem, make } = await setup();
    const b = [await make(B, "b1"), await make(B, "b2"), await make(B, "b3")];
    const a = [await make(A, "a1"), await make(A, "a2"), await make(A, "a3")];
    const members = (ms: { id: MemoryId }[]) => ms.map((m) => ({ id: m.id, event: event(m.id) }));

    await expect(mem.markContestedGroup!(A, members(b))).rejects.toThrow(/not found for tenant/);
    await expect(mem.markContestedGroup!(A, members([a[0]!, a[1]!, b[2]!]))).rejects.toThrow(
      /not found for tenant/,
    );

    const rows = await pool.query<{ status: string; contested_with_id: string | null }>(
      "SELECT status, contested_with_id FROM memories WHERE tenant_id = $1",
      [B.tenantId],
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.status === "active" && r.contested_with_id === null)).toBe(
      true,
    );
    const rels = await pool.query("SELECT 1 FROM memory_relations");
    expect(rels.rows).toHaveLength(0);
    const evs = await pool.query("SELECT 1 FROM memory_events WHERE kind = 'updated'");
    expect(evs.rows).toHaveLength(0);

    const ok = await mem.markContestedGroup!(A, members(a));
    expect(ok.members.map((m) => m.tenantId)).toEqual([A.tenantId, A.tenantId, A.tenantId]);
  });
});

describe("resolveContestedGroup: 別テナントの行・関係に触れない", () => {
  it("A の ctx で B の contested 群を渡すと拒まれ、B の群と関係は contested のまま残る", async () => {
    const { pool, mem, make } = await setup();
    const b = [await make(B, "b1"), await make(B, "b2"), await make(B, "b3")];
    await mem.markContestedGroup!(
      B,
      b.map((m) => ({ id: m.id, event: event(m.id) })),
    );

    await expect(
      mem.resolveContestedGroup!(
        A,
        b.map((m) => ({ id: m.id, status: "active" as const, event: event(m.id) })),
      ),
    ).rejects.toThrow(/not found for tenant/);

    const rows = await pool.query<{ status: string }>(
      "SELECT status FROM memories WHERE tenant_id = $1",
      [B.tenantId],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["contested", "contested", "contested"]);
    const rels = await pool.query("SELECT 1 FROM memory_relations WHERE tenant_id = $1", [
      B.tenantId,
    ]);
    expect(rels.rows.length).toBeGreaterThan(0);
  });

  it("到達集合の計算は B の contested の記憶を数えない（memories 側の tenant 絞り）", async () => {
    const { pool, mem, make } = await setup();
    const a = [await make(A, "a1"), await make(A, "a2"), await make(A, "a3")];
    const bx = await make(B, "bx");
    // B の記憶を contested にする（単独 contested は API が拒むので生 SQL）。
    await pool.query("UPDATE memories SET status = 'contested' WHERE id = $1", [bx.id]);
    await mem.markContestedGroup!(
      A,
      a.map((m) => ({ id: m.id, event: event(m.id) })),
    );
    // A の群の記憶から B の contested な記憶への関係（負債の形。API では作れない）。
    await pool.query(
      `INSERT INTO memory_relations (tenant_id, from_memory_id, to_memory_id, kind)
       VALUES ($1, $2, $3, 'contradicts')`,
      [A.tenantId, a[0]!.id, bx.id],
    );

    const res = await mem.resolveContestedGroup!(
      A,
      a.map((m) => ({ id: m.id, status: "active" as const, event: event(m.id) })),
    );
    expect(res.members.map((m) => m.status)).toEqual(["active", "active", "active"]);
    const bRow = await pool.query<{ status: string }>("SELECT status FROM memories WHERE id = $1", [
      bx.id,
    ]);
    expect(bRow.rows[0]!.status).toBe("contested");
  });

  it("群の解消は、別テナントの行の関係（A の id を両端に持つ tenant B の行）を消さない", async () => {
    const { pool, mem, make } = await setup();
    const a = [await make(A, "a1"), await make(A, "a2"), await make(A, "a3")];
    await mem.markContestedGroup!(
      A,
      a.map((m) => ({ id: m.id, event: event(m.id) })),
    );
    await pool.query(
      `INSERT INTO memory_relations (tenant_id, from_memory_id, to_memory_id, kind)
       VALUES ($1, $2, $3, 'contradicts')`,
      [B.tenantId, a[0]!.id, a[1]!.id],
    );
    await mem.resolveContestedGroup!(
      A,
      a.map((m) => ({ id: m.id, status: "active" as const, event: event(m.id) })),
    );
    const left = await pool.query("SELECT 1 FROM memory_relations WHERE tenant_id = $1", [
      B.tenantId,
    ]);
    expect(left.rows).toHaveLength(1);
    const mine = await pool.query("SELECT 1 FROM memory_relations WHERE tenant_id = $1", [
      A.tenantId,
    ]);
    expect(mine.rows).toHaveLength(0);
  });
});

describe("VectorStore.delete（単発）: 別テナントの embedding を消さない", () => {
  it("A の ctx で B の memoryId を delete しても B の行は残り、A 自身の行は消える", async () => {
    const { db, make } = await setup();
    const vec = new PostgresVectorStore(db);
    const bm = await make(B, "b1");
    const am = await make(A, "a1");
    await vec.upsert(B, TEST_EMBEDDING_SPACE, bm.id, [1, 0, 0]);
    await vec.upsert(A, TEST_EMBEDDING_SPACE, am.id, [0, 1, 0]);

    await vec.delete(A, TEST_EMBEDDING_SPACE, bm.id);
    expect(await vec.getVectors(B, TEST_EMBEDDING_SPACE, [bm.id])).toHaveLength(1);

    await vec.delete(A, TEST_EMBEDDING_SPACE, am.id);
    expect(await vec.getVectors(A, TEST_EMBEDDING_SPACE, [am.id])).toHaveLength(0);
  });
});

describe("VectorStore.search: 統計ありの枝でも ctx のテナントで絞る", () => {
  it("ANALYZE 済み（統計あり）の新しいインスタンスで、ctx=A・filter.tenantId=B は0件、一致すれば A 自身が返る", async () => {
    const { db, pool, make } = await setup();
    const seedVec = new PostgresVectorStore(db);
    const bm = await make(B, "b1");
    const am = await make(A, "a1");
    await seedVec.upsert(B, TEST_EMBEDDING_SPACE, bm.id, [1, 0, 0]);
    await seedVec.upsert(A, TEST_EMBEDDING_SPACE, am.id, [1, 0, 0]);
    const table = (await import("../embedding-space-table.js")).embeddingSpaceTableName(
      TEST_EMBEDDING_SPACE,
    );
    await pool.query("ANALYZE memories");
    await pool.query(`ANALYZE ${table}`);
    const vec = new PostgresVectorStore(db); // StatsPresenceGate は新しいインスタンスごと

    const mismatched = await vec.search(A, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: B.tenantId },
    });
    expect(mismatched).toEqual([]);
    const matched = await vec.search(A, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: A.tenantId },
    });
    expect(matched.map((h) => h.memoryId)).toEqual([am.id]);
  });
});

describe("purgeExpiredRecalls: 別テナントの recall を指す usage 行を数えず・消さない", () => {
  it("B の recall を指す A の usage 行（生 SQL）は、B の purge の dryRun で数えられず、実行でも消えない", async () => {
    const { pool, mem, make } = await setup();
    const bRecall = await mem.createRecall(B, recallRecord(B));
    const am = await make(A, "a1");
    await pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id) VALUES ($1, $2, $3)",
      [A.tenantId, bRecall, am.id],
    );
    const opts = { olderThan: new Date("2100-01-01T00:00:00.000Z"), limit: 10 };

    const dry = await mem.purgeExpiredRecalls!(B, { ...opts, dryRun: true });
    expect(dry.purged).toBe(1);
    expect(dry.purgedUsages).toBe(0);

    // A の usage 行が FK で B の recall を止めうる（既知負債）ので、結果は問わない。A の行が残ることだけを見る。
    await mem.purgeExpiredRecalls!(B, opts).catch(() => undefined);
    const left = await pool.query("SELECT 1 FROM recall_usages WHERE tenant_id = $1", [A.tenantId]);
    expect(left.rows).toHaveLength(1);
  });
});

describe("listRelatedMany（kind 付き）: 別テナントの関係を返さない", () => {
  it("B が張った関係は、A の ctx では kind を渡しても空", async () => {
    const { db, make } = await setup();
    const rel = new PostgresRelationStore(db);
    const b1 = await make(B, "b1");
    const b2 = await make(B, "b2");
    await rel.link(B, "contradicts", b1.id, b2.id);

    expect(await rel.listRelatedMany(A, [b1.id], "contradicts")).toEqual([[]]);
    expect(await rel.listRelatedMany(A, [b1.id])).toEqual([[]]);
    const own = await rel.listRelatedMany(B, [b1.id], "contradicts");
    expect(own[0]!.map((r) => r.memoryId)).toEqual([b2.id]);
  });
});

describe("previewRestoreSupersededBy: superseded の理由を別テナントのイベントから拾わない", () => {
  it("同じ memory_id に tenant B の superseded イベント（生 SQL）があっても、A 自身のイベントの理由を返す", async () => {
    const { pool, mem, make } = await setup();
    const old = await make(A, "old");
    const winner = await make(A, "winner");
    await mem.updateStatusWithEvent(A, old.id, "superseded", { supersededById: winner.id }, {
      ...(event(old.id, "superseded", { reason: "A-reason" }) as object),
      at: new Date("2026-01-01T00:00:00.000Z"),
    } as never);
    await pool.query(
      `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
       VALUES (gen_random_uuid(), $1, $2, 'superseded', $3, '{"type":"system"}'::jsonb, '{"reason":"B-leak"}'::jsonb)`,
      [B.tenantId, old.id, new Date("2026-06-01T00:00:00.000Z")],
    );

    const preview = await mem.previewRestoreSupersededBy!(A, winner.id);
    expect(preview.candidates).toEqual([{ memoryId: old.id, supersededReason: "A-reason" }]);
  });
});

describe("活動時計の subject 相関（vector search の忘却ゲート）: 別テナントの同名 subject のカウンタと混ざらない", () => {
  it("A・B が同じ subject_id のカウンタ行を持つとき、A の search は A 自身の subject のカウンタで判定し、A の記憶を返す", async () => {
    const { db, mem, make } = await setup();
    const vec = new PostgresVectorStore(db);
    const clockedRecall = (ctx: Ctx) =>
      mem.createRecall(
        ctx,
        recallRecord(ctx, { advanceActivityClock: { scope: "subject", subjectId: "s" } }),
      );
    await clockedRecall(A); // S_A("s") = 1
    await clockedRecall(B);
    await clockedRecall(B);
    await clockedRecall(B); // S_B("s") = 3
    const am = await make(A, "a1", { subjectId: "s", decayBaseSeq: 0, decayFloorSeq: 7 });
    await vec.upsert(A, TEST_EMBEDDING_SPACE, am.id, [1, 0, 0]);

    // 床 7 > 5 + S_A(1) = 6 なので生きている。B のカウンタ（3）が混ざると 8 になって落ちる。
    const hits = await vec.search(A, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 10,
      filter: {
        tenantId: A.tenantId,
        decayFloorSeqAfter: 5,
        decayFloorSeqUsesSubjectCounters: true,
      },
    });
    expect(hits.map((h) => h.memoryId)).toEqual([am.id]);
  });
});
