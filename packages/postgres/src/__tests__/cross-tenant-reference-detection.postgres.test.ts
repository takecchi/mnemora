import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import {
  CROSS_TENANT_REFERENCE_KINDS,
  findCrossTenantReferences,
} from "../cross-tenant-reference-detection.js";
import { createPostgresClient, closePostgresClient } from "../client.js";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 食い違い行はストアの口からは作れない。この歯は、生 SQL（検査の外）で食い違い行を仕込み、検出が実際に捕まえること（陽性対照）と、
 * 正しい行・別テナントの正しい行・NULL の参照を数えないこと（陰性対照）を、両方見る。
 * 「0件」を報告する道具なので、陽性対照が無いと「0件」は何も言っていない。
 */

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

const TA = "xdet-tenant-a";
const TB = "xdet-tenant-b";
const A: Ctx = { tenantId: TA };
const B: Ctx = { tenantId: TB };
const OLD = new Date("2020-01-01T00:00:00.000Z");

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

async function setup() {
  const { db, pool } = await getTestClient();
  const mem = new PostgresMemoryStore(db);
  const make = (ctx: Ctx, name: string, over: Record<string, unknown> = {}) =>
    mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: name,
        contentHash: `xdet-${ctx.tenantId}-${name}`,
        ...over,
      }),
    );
  const observe = (ctx: Ctx) =>
    mem.createObservation(ctx, buildNewObservationFixture({ tenantId: ctx.tenantId }));
  return { pool, mem, make, observe };
}

/** どちらのテナントにも、4種の参照すべてについて「正しい（同じテナントを指す）行」と「参照の無い行」を置く。 */
async function seedCorrectRows(s: Awaited<ReturnType<typeof setup>>) {
  for (const ctx of [A, B]) {
    const base = await s.make(ctx, "base");
    const obs = await s.observe(ctx);
    await s.make(ctx, "plain");
    await s.make(ctx, "superseded", { status: "superseded", supersededById: base.id });
    await s.make(ctx, "sourced", { sourceObservationId: obs.id });
    await s.make(ctx, "contested", { status: "contested", contestedWithId: base.id });
    await s.mem.recordUsage(ctx, await s.mem.createRecall(ctx, recallRecord(ctx)), [base.id]);
  }
}

/** 「DB に触れる前」を確かめるための pool。どの口が呼ばれても記録し、接続は渡さない。 */
function poolThatMustNotBeTouched(): { pool: Pool; touched: string[] } {
  const touched: string[] = [];
  const pool = new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          touched.push(String(prop));
          return Promise.reject(new Error(`pool.${String(prop)} を呼んではいけない`));
        };
      },
    },
  ) as Pool;
  return { pool, touched };
}

describe("陰性対照: 食い違いの無いデータは1件も数えない", () => {
  it("空の DB: 4種が決まった順に並び、すべて count 0・samples 空・total 0", async () => {
    const { pool } = await setup();
    const r = await findCrossTenantReferences(pool);
    expect(r.total).toBe(0);
    expect(r.findings.map((f) => f.kind)).toEqual([...CROSS_TENANT_REFERENCE_KINDS]);
    for (const f of r.findings) {
      expect(f.count, f.kind).toBe(0);
      expect(f.samples, f.kind).toEqual([]);
    }
  });

  it("2つのテナントの、正しい参照（4種）と NULL の参照だけのデータは、0件", async () => {
    const s = await setup();
    await seedCorrectRows(s);
    const refs = await s.pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM memories WHERE superseded_by_id IS NOT NULL
                                                 AND contested_with_id IS NULL) +
              (SELECT count(*) FROM memories WHERE contested_with_id IS NOT NULL) +
              (SELECT count(*) FROM memories WHERE source_observation_id IS NOT NULL) +
              (SELECT count(*) FROM recall_usages) AS n`,
    );
    expect(Number(refs.rows[0]!.n)).toBe(8);
    const r = await findCrossTenantReferences(s.pool);
    expect(r.total).toBe(0);
    for (const f of r.findings) {
      expect(f.count, f.kind).toBe(0);
    }
  });
});

describe("陽性対照: 生 SQL で仕込んだ食い違い行を、種類ごとに捕まえる", () => {
  it("4種を1本ずつ仕込むと、各種が1件・total 4。正しい行は混ざらず、id とテナントが正しい", async () => {
    const s = await setup();
    await seedCorrectRows(s);
    const a1 = await s.make(A, "a1");
    const a2 = await s.make(A, "a2");
    const a3 = await s.make(A, "a3");
    const b1 = await s.make(B, "b1");
    const bObs = await s.observe(B);
    const bRecall = await s.mem.createRecall(B, recallRecord(B));
    await s.pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())",
      [TA, bRecall, a1.id],
    );
    await s.pool.query("UPDATE memories SET source_observation_id = $1 WHERE id = $2", [
      bObs.id,
      a1.id,
    ]);
    await s.pool.query("UPDATE memories SET contested_with_id = $1 WHERE id = $2", [b1.id, a2.id]);
    await s.pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [b1.id, a3.id]);

    const r = await findCrossTenantReferences(s.pool);
    expect(r.total).toBe(4);
    const by = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
    for (const kind of CROSS_TENANT_REFERENCE_KINDS) {
      expect(by[kind]!.count, kind).toBe(1);
      expect(by[kind]!.samples, kind).toHaveLength(1);
    }
    expect(by["recall_usages"]!.samples[0]).toEqual({
      tenantId: TA,
      recallId: bRecall,
      memoryId: a1.id,
      recallTenantId: TB,
      memoryTenantId: TA,
    });
    expect(by["memories.source_observation_id"]!.samples[0]).toEqual({
      id: a1.id,
      tenantId: TA,
      targetId: bObs.id,
      targetTenantId: TB,
    });
    expect(by["memories.contested_with_id"]!.samples[0]).toEqual({
      id: a2.id,
      tenantId: TA,
      targetId: b1.id,
      targetTenantId: TB,
    });
    expect(by["memories.superseded_by_id"]!.samples[0]).toEqual({
      id: a3.id,
      tenantId: TA,
      targetId: b1.id,
      targetTenantId: TB,
    });
  });

  it("recall_usages は、recall と memory の両方が食い違う行も1行として数える（行数であって食い違いの数ではない）", async () => {
    const s = await setup();
    const a1 = await s.make(A, "a1");
    const b1 = await s.make(B, "b1");
    const bRecall = await s.mem.createRecall(B, recallRecord(B));
    await s.pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())",
      [TA, bRecall, b1.id],
    );
    await s.mem.recordUsage(A, await s.mem.createRecall(A, recallRecord(A)), [a1.id]);
    const r = await findCrossTenantReferences(s.pool);
    const f = r.findings.find((x) => x.kind === "recall_usages")!;
    expect(f.count).toBe(1);
    expect(r.total).toBe(1);
  });

  it("recall_usages は、片側だけ食い違う行（recall だけ・memory だけ）も、それぞれ捕まえる", async () => {
    const s = await setup();
    const a1 = await s.make(A, "a1");
    const b1 = await s.make(B, "b1");
    const aRecall = await s.mem.createRecall(A, recallRecord(A));
    const bRecall = await s.mem.createRecall(B, recallRecord(B));
    await s.pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())",
      [TA, aRecall, b1.id],
    );
    const onlyMemory = await findCrossTenantReferences(s.pool);
    const f1 = onlyMemory.findings.find((x) => x.kind === "recall_usages")!;
    expect(f1.count).toBe(1);
    expect(f1.samples[0]).toEqual({
      tenantId: TA,
      recallId: aRecall,
      memoryId: b1.id,
      recallTenantId: TA,
      memoryTenantId: TB,
    });
    await s.pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())",
      [TA, bRecall, a1.id],
    );
    const both = await findCrossTenantReferences(s.pool);
    expect(both.findings.find((x) => x.kind === "recall_usages")!.count).toBe(2);
  });

  it("向きが逆（B の行が A を指す）も、別のテナント組も、同じように捕まえる", async () => {
    const s = await setup();
    const a1 = await s.make(A, "a1");
    const b1 = await s.make(B, "b1");
    const c1 = await s.make({ tenantId: "xdet-tenant-c" }, "c1");
    await s.pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [a1.id, b1.id]);
    await s.pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [b1.id, c1.id]);
    const r = await findCrossTenantReferences(s.pool);
    const f = r.findings.find((x) => x.kind === "memories.superseded_by_id")!;
    expect(f.count).toBe(2);
    expect(
      f.samples.map((x) => [x.tenantId, (x as { targetTenantId: string }).targetTenantId]).sort(),
    ).toEqual(
      [
        [TB, TA],
        ["xdet-tenant-c", TB],
      ].sort(),
    );
  });
});

describe("count は sampleLimit に左右されない", () => {
  async function seedThree() {
    const s = await setup();
    const b1 = await s.make(B, "b1");
    for (const n of ["a1", "a2", "a3"]) {
      const m = await s.make(A, n);
      await s.pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [b1.id, m.id]);
    }
    return s;
  }
  const sup = (r: Awaited<ReturnType<typeof findCrossTenantReferences>>) =>
    r.findings.find((x) => x.kind === "memories.superseded_by_id")!;

  it("sampleLimit 1: count は3、samples は1件", async () => {
    const s = await seedThree();
    const r = await findCrossTenantReferences(s.pool, { sampleLimit: 1 });
    expect(sup(r).count).toBe(3);
    expect(sup(r).samples).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it("sampleLimit 0: count は3、samples は空。既定は3件すべてを返す", async () => {
    const s = await seedThree();
    const r0 = await findCrossTenantReferences(s.pool, { sampleLimit: 0 });
    expect(sup(r0).count).toBe(3);
    expect(sup(r0).samples).toEqual([]);
    const rd = await findCrossTenantReferences(s.pool);
    expect(sup(rd).samples).toHaveLength(3);
  });

  it("samples は主キー（id）の昇順で、sampleLimit はその先頭から切る", async () => {
    const s = await seedThree();
    const ids = (r: Awaited<ReturnType<typeof findCrossTenantReferences>>) =>
      sup(r).samples.map((x) => (x as { id: string }).id);
    const all = ids(await findCrossTenantReferences(s.pool));
    expect(all).toHaveLength(3);
    expect(all).toEqual([...all].sort());
    expect(ids(await findCrossTenantReferences(s.pool, { sampleLimit: 2 }))).toEqual(
      all.slice(0, 2),
    );
  });

  it("sampleLimit が負・小数・上限超過・NaN なら、DB に触れる前に RangeError", async () => {
    const untouched = poolThatMustNotBeTouched();
    for (const bad of [-1, 1.5, 1001, Number.NaN]) {
      await expect(findCrossTenantReferences(untouched.pool, { sampleLimit: bad })).rejects.toThrow(
        RangeError,
      );
    }
    expect(untouched.touched).toEqual([]);
  });

  it("sampleLimit は上限の 1000 ちょうどまで受け付け、その件数まで返す", async () => {
    const s = await seedThree();
    const r = await findCrossTenantReferences(s.pool, { sampleLimit: 1000 });
    expect(sup(r).count).toBe(3);
    expect(sup(r).samples).toHaveLength(3);
  });
});

describe("検出は読み取りだけ", () => {
  async function snapshot(pool: Pool): Promise<string> {
    const r = await pool.query<{ s: string }>(
      `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM memories m)::text ||
              (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.tenant_id, u.recall_id, u.memory_id), '[]') FROM recall_usages u)::text ||
              (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]') FROM observations o)::text ||
              (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM recalls r)::text ||
              (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM memory_events e)::text AS s`,
    );
    return r.rows[0]!.s;
  }

  async function seedMismatches(s: Awaited<ReturnType<typeof setup>>) {
    const a1 = await s.make(A, "a1");
    const b1 = await s.make(B, "b1");
    const bObs = await s.observe(B);
    const bRecall = await s.mem.createRecall(B, recallRecord(B));
    await s.pool.query(
      "INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())",
      [TA, bRecall, a1.id],
    );
    await s.pool.query(
      `UPDATE memories SET source_observation_id = $1, contested_with_id = $2,
              superseded_by_id = $2 WHERE id = $3`,
      [bObs.id, b1.id, a1.id],
    );
  }

  it("食い違い行を消さず・直さず・足さない（検出の前後で、関係する全表の中身が同じ）", async () => {
    const s = await setup();
    await seedCorrectRows(s);
    await seedMismatches(s);
    const before = await snapshot(s.pool);
    const r1 = await findCrossTenantReferences(s.pool);
    expect(r1.total).toBe(4);
    expect(await snapshot(s.pool)).toBe(before);
    // 2回目も同じ答え（1回目が直してしまっていたら、ここで0になる）。
    const r2 = await findCrossTenantReferences(s.pool);
    expect(r2.total).toBe(4);
  });

  it("READ ONLY のトランザクションの中で、書き込み系の文を1つも発行せず、接続を返す", async () => {
    const s = await setup();
    await seedMismatches(s);
    const log: string[] = [];
    const wrapped = {
      connect: async () => {
        const c = await s.pool.connect();
        return new Proxy(c, {
          get(target, prop, receiver) {
            if (prop === "query") {
              return (...args: unknown[]) => {
                const a = args[0];
                log.push(typeof a === "string" ? a : String((a as { text: string }).text));
                return (target.query as (...x: unknown[]) => unknown)(...args);
              };
            }
            const v = Reflect.get(target, prop, receiver) as unknown;
            return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          },
        });
      },
      query: (...args: unknown[]) => {
        log.push("POOL.QUERY(使ってはいけない)");
        return (s.pool.query as (...x: unknown[]) => unknown)(...args);
      },
    } as unknown as Pool;

    const r = await findCrossTenantReferences(wrapped);
    expect(r.total).toBe(4);
    expect(log[0]).toMatch(/^\s*BEGIN\b.*\bREAD ONLY\b/i);
    // 種類ごとの count とサンプルが同じスナップショットを見る（doc の約束）。
    expect(log[0]).toMatch(/\bISOLATION LEVEL REPEATABLE READ\b/i);
    expect(log).not.toContain("POOL.QUERY(使ってはいけない)");
    for (const text of log) {
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|LOCK|SET)\b/i);
    }
    // COMMIT ではなく ROLLBACK で閉じる（何かが書かれていても残らない）。
    expect(log[log.length - 1]).toMatch(/^\s*ROLLBACK\b/i);
    expect(s.pool.idleCount).toBe(s.pool.totalCount);
    expect(s.pool.waitingCount).toBe(0);
  });

  it("実在しない schema で失敗しても、接続は返り、次の呼び出しは通る", async () => {
    const s = await setup();
    await expect(
      findCrossTenantReferences(s.pool, { schema: "xdet_no_such_schema" }),
    ).rejects.toThrow();
    expect(s.pool.idleCount).toBe(s.pool.totalCount);
    expect((await findCrossTenantReferences(s.pool)).total).toBe(0);
  });

  it("安全でない schema 名は、DB に触れる前に弾く", async () => {
    const untouched = poolThatMustNotBeTouched();
    await expect(
      findCrossTenantReferences(untouched.pool, { schema: 'x"; DROP TABLE memories; --' }),
    ).rejects.toThrow(/unsafe SQL/);
    expect(untouched.touched).toEqual([]);
  });
});

describe("schema を渡すと、その専用スキーマの側を見る", () => {
  const DB = "mnemora_xdet_schema";
  const SCHEMA = "mnemora_xdet";
  let admin: Pool | undefined;
  let pool: Pool | undefined;

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await dropTempDatabase(admin, DB);
      await admin.end();
    }
  });

  it("専用スキーマにだけ食い違いがあるとき、schema 指定で1件・指定なし（public）で0件", async () => {
    admin = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    await dropTempDatabase(admin, DB);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${DB}`;
    pool = new Pool({ connectionString: url.toString(), max: 3 });
    await runMigrations(pool);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA });

    const client = createPostgresClient(url.toString(), { schema: SCHEMA });
    try {
      const store = new PostgresMemoryStore(client.db);
      const a = await store.createMemory(
        A,
        buildNewMemoryFixture({ tenantId: TA, contentHash: "xdet-s-a" }),
      );
      const b = await store.createMemory(
        B,
        buildNewMemoryFixture({ tenantId: TB, contentHash: "xdet-s-b" }),
      );
      await client.pool.query(
        `UPDATE "${SCHEMA}".memories SET superseded_by_id = $1 WHERE id = $2`,
        [b.id as MemoryId, a.id],
      );
      const a2 = await store.createMemory(
        A,
        buildNewMemoryFixture({ tenantId: TA, contentHash: "xdet-s-a2" }),
      );
      const a3 = await store.createMemory(
        A,
        buildNewMemoryFixture({ tenantId: TA, contentHash: "xdet-s-a3" }),
      );
      const bObs = await store.createObservation(B, buildNewObservationFixture({ tenantId: TB }));
      const bRecall = await store.createRecall(B, recallRecord(B));
      await client.pool.query(
        `UPDATE "${SCHEMA}".memories SET contested_with_id = $1 WHERE id = $2`,
        [b.id as MemoryId, a2.id],
      );
      await client.pool.query(
        `UPDATE "${SCHEMA}".memories SET source_observation_id = $1 WHERE id = $2`,
        [bObs.id, a3.id],
      );
      await client.pool.query(
        `INSERT INTO "${SCHEMA}".recall_usages (tenant_id, recall_id, memory_id, used_at) VALUES ($1, $2, $3, now())`,
        [TA, bRecall, a.id],
      );

      const dedicated = await findCrossTenantReferences(pool, { schema: SCHEMA });
      expect(dedicated.total).toBe(4);
      expect(dedicated.findings.map((f) => f.count)).toEqual([1, 1, 1, 1]);
      const pub = await findCrossTenantReferences(pool);
      expect(pub.total).toBe(0);
    } finally {
      await closePostgresClient(client);
    }
  });
});
