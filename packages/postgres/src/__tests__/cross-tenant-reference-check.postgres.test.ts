import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 適合テスト（`describeMemoryStoreConformance`）にも同じ契約の it があるが、store の口からは「行が書かれていない」ことまでは見えない。
 * 行の有無（生 SQL で数える）と、被害側の `eraseTenant`・`purgeExpiredRecalls` は、このファイルだけが見る。
 */

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

const TA = "xref-tenant-a";
const TB = "xref-tenant-b";
const A: Ctx = { tenantId: TA };
const B: Ctx = { tenantId: TB };
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";
const OLD = new Date("2020-01-01T00:00:00.000Z");
const PURGE_ALL = { olderThan: new Date("2100-01-01T00:00:00.000Z"), limit: 100 };

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};
const recallRecord = (ctx: Ctx) =>
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
    createdAt: OLD,
  }) as never;
const event = (ctx: Ctx, memoryId: MemoryId): NewMemoryEvent =>
  ({
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: {},
  }) as never;

async function setup() {
  const { db, pool } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  const deps = {
    memoryStore: mem,
    vectorStore: new PostgresVectorStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  };
  const make = (ctx: Ctx, name: string, over: Record<string, unknown> = {}) =>
    mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: name,
        contentHash: `xref-${ctx.tenantId}-${name}`,
        ...over,
      }),
    );
  const observe = (ctx: Ctx) =>
    mem.createObservation(ctx, buildNewObservationFixture({ tenantId: ctx.tenantId }));
  return { pool, mem, deps, make, observe };
}

type Pool = Awaited<ReturnType<typeof getTestClient>>["pool"];

async function count(pool: Pool, text: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${text}) q`, params);
  return Number(r.rows[0]!.n);
}

/** A の行のうち、B の id を指すものの数（4種の列と recall_usages）。 */
async function foreignReferenceCount(pool: Pool): Promise<number> {
  return count(
    pool,
    `SELECT 1 FROM memories m
       JOIN memories t ON t.id IN (m.superseded_by_id, m.contested_with_id)
      WHERE m.tenant_id = '${TA}' AND t.tenant_id <> m.tenant_id
     UNION ALL
     SELECT 1 FROM memories m JOIN observations o ON o.id = m.source_observation_id
      WHERE m.tenant_id = '${TA}' AND o.tenant_id <> m.tenant_id
     UNION ALL
     SELECT 1 FROM recall_usages u
       LEFT JOIN recalls r ON r.id = u.recall_id
       LEFT JOIN memories m ON m.id = u.memory_id
      WHERE u.tenant_id = '${TA}' AND (r.tenant_id <> u.tenant_id OR m.tenant_id <> u.tenant_id)`,
  );
}

describe("別テナントの参照は、口ごとに行を書かずに拒む（ADR 0439）", () => {
  it("recordUsage・recordUsageAndReinforce: B の recall・B の memory を指す usage 行は書かれない", async () => {
    const { pool, mem, make } = await setup();
    const a1 = await make(A, "a1");
    const b1 = await make(B, "b1");
    const aRecall = await mem.createRecall(A, recallRecord(A));
    const bRecall = await mem.createRecall(B, recallRecord(B));
    const at = new Date("2026-06-01T00:00:00.000Z");

    await expect(mem.recordUsage(A, bRecall, [a1.id])).rejects.toThrow(
      /PostgresMemoryStore: recall not found for tenant: /,
    );
    await expect(mem.recordUsage(A, aRecall, [b1.id])).rejects.toThrow(
      /PostgresMemoryStore: memory not found for tenant: /,
    );
    await expect(mem.recordUsage(A, aRecall, [a1.id, b1.id])).rejects.toThrow(
      /PostgresMemoryStore: memory not found for tenant: /,
    );
    await expect(mem.recordUsageAndReinforce(A, bRecall, [a1.id], at)).rejects.toThrow(
      /recall not found for tenant/,
    );
    await expect(mem.recordUsageAndReinforce(A, aRecall, [b1.id], at)).rejects.toThrow(
      /memory not found for tenant/,
    );
    expect(await count(pool, "SELECT 1 FROM recall_usages")).toBe(0);

    expect((await mem.recordUsage(A, aRecall, [a1.id])).insertedMemoryIds).toEqual([a1.id]);
    expect((await mem.recordUsage(A, aRecall, [a1.id.toUpperCase()])).insertedMemoryIds).toEqual(
      [],
    );
    expect(await count(pool, "SELECT 1 FROM recall_usages")).toBe(1);
  });

  it("createMemory・createMemoryWithOutbox: B の observation・B の memory を指す行は書かれない", async () => {
    const { pool, mem, make, observe } = await setup();
    const b1 = await make(B, "b1");
    const bObs = await observe(B);
    const aObs = await observe(A);
    const a1 = await make(A, "a1");

    const attempts: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "src",
        { sourceObservationId: bObs.id },
        /PostgresMemoryStore: observation not found for tenant: /,
      ],
      [
        "contested",
        { status: "contested", contestedWithId: b1.id },
        /PostgresMemoryStore: memory not found for tenant: /,
      ],
      [
        "superseded",
        { status: "superseded", supersededById: b1.id },
        /PostgresMemoryStore: memory not found for tenant: /,
      ],
    ];
    for (const [name, over, message] of attempts) {
      await expect(make(A, `bad-${name}`, over)).rejects.toThrow(message);
      await expect(
        mem.createMemoryWithOutbox(
          A,
          buildNewMemoryFixture({ tenantId: TA, contentHash: `xref-bad-${name}-outbox`, ...over }),
          ["embed"],
        ),
      ).rejects.toThrow(message);
    }
    expect(await foreignReferenceCount(pool)).toBe(0);
    expect(await count(pool, "SELECT 1 FROM memories WHERE tenant_id = $1", [TA])).toBe(1);
    expect(await count(pool, "SELECT 1 FROM outbox WHERE tenant_id = $1", [TA])).toBe(0);

    const ok1 = await make(A, "ok-src", { sourceObservationId: aObs.id });
    const ok2 = await make(A, "ok-contested", { status: "contested", contestedWithId: a1.id });
    const ok3 = await make(A, "ok-superseded", { status: "superseded", supersededById: a1.id });
    expect([ok1.sourceObservationId, ok2.contestedWithId, ok3.supersededById]).toEqual([
      aObs.id,
      a1.id,
      a1.id,
    ]);
    const upper = await make(A, "ok-upper", { sourceObservationId: aObs.id.toUpperCase() });
    expect(upper.sourceObservationId).toBe(aObs.id);
  });

  it("updateStatus・updateStatusWithEvent: B の memory を supersededById に書けない", async () => {
    const { pool, mem, make } = await setup();
    const a1 = await make(A, "a1");
    const a2 = await make(A, "a2");
    const b1 = await make(B, "b1");

    await expect(
      mem.updateStatus(A, a1.id, "superseded", { supersededById: b1.id }),
    ).rejects.toThrow(/PostgresMemoryStore: memory not found for tenant: /);
    await expect(
      mem.updateStatus(A, a1.id, "superseded", { supersededById: b1.id, expectedStatus: "active" }),
    ).rejects.toThrow(/PostgresMemoryStore: memory not found for tenant: /);
    await expect(
      mem.updateStatusWithEvent(A, a1.id, "superseded", { supersededById: b1.id }, event(A, a1.id)),
    ).rejects.toThrow(/PostgresMemoryStore: memory not found for tenant: /);
    expect((await mem.get(A, a1.id))?.status).toBe("active");
    expect(await foreignReferenceCount(pool)).toBe(0);
    expect(await count(pool, "SELECT 1 FROM memory_events WHERE tenant_id = $1", [TA])).toBe(0);

    expect(
      (await mem.updateStatus(A, a1.id, "superseded", { supersededById: a2.id })).supersededById,
    ).toBe(a2.id);
    await expect(
      mem.updateStatus(A, a1.id, "superseded", { supersededById: a2.id, expectedStatus: "active" }),
    ).rejects.toThrow(/status/i);
    const viaEvent = await mem.updateStatusWithEvent(
      A,
      a2.id,
      "superseded",
      { supersededById: a1.id },
      event(A, a2.id),
    );
    expect(viaEvent.memory.supersededById).toBe(a1.id);
  });

  it("supersedeWithNewMemories: news の B を指す参照で、news も supersede も書かれない", async () => {
    const { pool, mem, make, observe } = await setup();
    const a1 = await make(A, "a1");
    const b1 = await make(B, "b1");
    const bObs = await observe(B);
    const before = await count(pool, "SELECT 1 FROM memories WHERE tenant_id = $1", [TA]);

    const overs: Array<Partial<NewMemory>> = [
      { sourceObservationId: bObs.id },
      { status: "contested", contestedWithId: b1.id },
      { status: "superseded", supersededById: b1.id },
    ];
    for (const [i, over] of overs.entries()) {
      await expect(
        mem.supersedeWithNewMemories!(
          A,
          [
            {
              input: buildNewMemoryFixture({
                tenantId: TA,
                contentHash: `xref-sw-${i}`,
                ...over,
              }),
              jobKinds: ["embed"],
            },
          ],
          [{ id: a1.id, supersededByIndex: 0, event: event(A, a1.id) }],
        ),
      ).rejects.toThrow(/not found for tenant/);
    }
    expect(await count(pool, "SELECT 1 FROM memories WHERE tenant_id = $1", [TA])).toBe(before);
    expect((await mem.get(A, a1.id))?.status).toBe("active");
    expect(await foreignReferenceCount(pool)).toBe(0);
  });

  it("resolveContestedPair・resolveContestedGroup: B の memory を supersededById に書けない", async () => {
    const { pool, mem, make } = await setup();
    const [a1, a2, a3] = [await make(A, "a1"), await make(A, "a2"), await make(A, "a3")];
    const b1 = await make(B, "b1");
    await mem.markContestedPair!(
      A,
      { id: a1.id, event: event(A, a1.id) },
      { id: a2.id, event: event(A, a2.id) },
    );

    await expect(
      mem.resolveContestedPair!(
        A,
        { id: a1.id, status: "superseded", supersededById: b1.id, event: event(A, a1.id) },
        { id: a2.id, status: "active", event: event(A, a2.id) },
      ),
    ).rejects.toThrow(/PostgresMemoryStore: memory not found for tenant: /);
    expect((await mem.get(A, a1.id))?.status).toBe("contested");
    expect(await foreignReferenceCount(pool)).toBe(0);
    const ok = await mem.resolveContestedPair!(
      A,
      { id: a1.id, status: "superseded", supersededById: a2.id, event: event(A, a1.id) },
      { id: a2.id, status: "active", event: event(A, a2.id) },
    );
    expect(ok.first.supersededById).toBe(a2.id);

    const g = [await make(A, "g1"), await make(A, "g2"), await make(A, "g3")];
    await mem.markContestedGroup!(
      A,
      g.map((m) => ({ id: m.id, event: event(A, m.id) })),
    );
    const resolve = (by: MemoryId) =>
      mem.resolveContestedGroup!(
        A,
        g.map((m, i) => ({
          id: m.id,
          status: i === 0 ? ("active" as const) : ("superseded" as const),
          ...(i === 0 ? {} : { supersededById: by }),
          event: event(A, m.id),
        })),
      );
    await expect(resolve(b1.id)).rejects.toThrow(
      /PostgresMemoryStore: memory not found for tenant: /,
    );
    expect((await mem.get(A, g[1]!.id))?.status).toBe("contested");
    expect(await foreignReferenceCount(pool)).toBe(0);
    const done = await resolve(g[0]!.id);
    expect(done.members.filter((m) => m.supersededById === g[0]!.id)).toHaveLength(2);
    void a3;
  });

  it("uuid でない id・実在しない uuid は、別テナントと同じ message で、DB へ投げる前に弾く", async () => {
    const { mem, make } = await setup();
    const a1 = await make(A, "a1");
    const aRecall = await mem.createRecall(A, recallRecord(A));
    for (const bad of ["not-a-uuid", "", MISSING_UUID]) {
      await expect(mem.recordUsage(A, bad, [a1.id])).rejects.toThrow(/recall not found for tenant/);
      await expect(mem.recordUsage(A, aRecall, [bad])).rejects.toThrow(
        /memory not found for tenant/,
      );
      await expect(make(A, `bad-src-${bad}`, { sourceObservationId: bad })).rejects.toThrow(
        /observation not found for tenant/,
      );
      await expect(
        make(A, `bad-sup-${bad}`, { status: "superseded", supersededById: bad }),
      ).rejects.toThrow(/memory not found for tenant/);
      await expect(
        mem.updateStatus(A, a1.id, "superseded", { supersededById: bad }),
      ).rejects.toThrow(/memory not found for tenant/);
    }
  });
});

describe("C1 の経路: A が B を参照する行を書けないので、B の消去と保持期間の掃除は止まらない（ADR 0439）", () => {
  it("あらゆる口で B を指そうとした後も、B の purgeExpiredRecalls は落ちず、B の eraseTenant は止まらない", async () => {
    const { pool, mem, deps, make, observe } = await setup();
    const a1 = await make(A, "a1");
    const a2 = await make(A, "a2");
    const b1 = await make(B, "b1");
    const b2 = await make(B, "b2");
    const bObs = await observe(B);
    const aRecall = await mem.createRecall(A, recallRecord(A));
    const bRecall = await mem.createRecall(B, recallRecord(B));
    const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

    await swallow(mem.recordUsage(A, bRecall, [a1.id]));
    await swallow(mem.recordUsage(A, aRecall, [b1.id]));
    await swallow(make(A, "x-src", { sourceObservationId: bObs.id }));
    await swallow(make(A, "x-contested", { status: "contested", contestedWithId: b1.id }));
    await swallow(make(A, "x-superseded", { status: "superseded", supersededById: b1.id }));
    await swallow(mem.updateStatus(A, a2.id, "superseded", { supersededById: b2.id }));
    await swallow(
      mem.updateStatusWithEvent(A, a2.id, "superseded", { supersededById: b2.id }, event(A, a2.id)),
    );
    expect(await foreignReferenceCount(pool)).toBe(0);

    const purged = await mem.purgeExpiredRecalls!(B, PURGE_ALL);
    expect(purged.purged).toBe(1);

    const outcome = await eraseTenant(B, deps, { confirmTenantId: TB, limit: 100_000 });
    expect(outcome.kind).toBe("executed");
    expect(await count(pool, "SELECT 1 FROM memories WHERE tenant_id = $1", [TB])).toBe(0);
    expect(await count(pool, "SELECT 1 FROM memories WHERE tenant_id = $1", [TA])).toBeGreaterThan(
      0,
    );
  });
});

/** ADR 0439「引き受けた負債」に書いた検出 SQL（読み取りだけ）。ADR の文面と同じものを実行して縛る。 */
const DETECTION_SQL: Record<string, string> = {
  recall_usages: `SELECT u.tenant_id, u.recall_id, u.memory_id, r.tenant_id AS recall_tenant_id, m.tenant_id AS memory_tenant_id
FROM recall_usages u
JOIN recalls r ON r.id = u.recall_id
JOIN memories m ON m.id = u.memory_id
WHERE u.tenant_id <> r.tenant_id OR u.tenant_id <> m.tenant_id`,
  source_observation_id: `SELECT m.id, m.tenant_id, m.source_observation_id, o.tenant_id AS observation_tenant_id
FROM memories m
JOIN observations o ON o.id = m.source_observation_id
WHERE m.tenant_id <> o.tenant_id`,
  contested_with_id: `SELECT m.id, m.tenant_id, m.contested_with_id, t.tenant_id AS target_tenant_id
FROM memories m
JOIN memories t ON t.id = m.contested_with_id
WHERE m.tenant_id <> t.tenant_id`,
  superseded_by_id: `SELECT m.id, m.tenant_id, m.superseded_by_id, t.tenant_id AS target_tenant_id
FROM memories m
JOIN memories t ON t.id = m.superseded_by_id
WHERE m.tenant_id <> t.tenant_id`,
};

describe("ADR 0439 の検出 SQL: 食い違いが無ければ0行、仕込んだ1行は1行", () => {
  it("4本とも、正しい参照だけのデータでは0行を返す", async () => {
    const { pool, mem, make, observe } = await setup();
    const a1 = await make(A, "a1");
    const aObs = await observe(A);
    await make(A, "a2", { status: "superseded", supersededById: a1.id });
    await make(A, "a3", { sourceObservationId: aObs.id });
    await make(A, "a4", { status: "contested", contestedWithId: a1.id });
    await mem.recordUsage(A, await mem.createRecall(A, recallRecord(A)), [a1.id]);
    for (const [name, text] of Object.entries(DETECTION_SQL)) {
      expect(await count(pool, text), name).toBe(0);
    }
  });

  it("生 SQL で別テナントを指す行を1本ずつ仕込むと、対応する検出 SQL が1行を数える", async () => {
    const { pool, mem, make, observe } = await setup();
    const a1 = await make(A, "a1");
    const b1 = await make(B, "b1");
    const bObs = await observe(B);
    const bRecall = await mem.createRecall(B, recallRecord(B));
    await pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id) VALUES ($1, $2, $3)",
      [TA, bRecall, a1.id],
    );
    await pool.query("UPDATE memories SET source_observation_id = $1 WHERE id = $2", [
      bObs.id,
      a1.id,
    ]);
    await pool.query(
      "UPDATE memories SET contested_with_id = $1, superseded_by_id = $1 WHERE id = $2",
      [b1.id, a1.id],
    );
    for (const [name, text] of Object.entries(DETECTION_SQL)) {
      expect(await count(pool, text), name).toBe(1);
    }
  });
});

describe("別テナントを指す行（ADR 0439 より前に書かれた形。生 SQL で仕込む）に、restoreSupersededBy は触れない", () => {
  it("B の行が A の anchor を superseded_by_id に持っていても、A の restore・preview は A の行だけを扱う", async () => {
    // 適合テストの同種の歯はこの形を API で作っていたが、API からは作れなくなったので、テナントで絞る歯は生 SQL で形を作るここが持つ。
    const { pool, mem, make } = await setup();
    const anchorA = await make(A, "anchor-a");
    const anchorB = await make(B, "anchor-b");
    const supersededA = await make(A, "superseded-a", {
      status: "superseded",
      supersededById: anchorA.id,
    });
    const supersededB = await make(B, "superseded-b", {
      status: "superseded",
      supersededById: anchorB.id,
    });
    await pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [
      anchorA.id,
      supersededB.id,
    ]);

    const preview = await mem.previewRestoreSupersededBy!(A, anchorA.id);
    expect(preview.candidates.map((c) => c.memoryId)).toEqual([supersededA.id]);

    const result = await mem.restoreSupersededBy!(A, anchorA.id, {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result.restored.map((m) => m.id)).toEqual([supersededA.id]);
    const bAfter = await mem.get(B, supersededB.id);
    expect(bAfter?.status).toBe("superseded");
    expect(bAfter?.supersededById).toBe(anchorA.id);
  });
});
