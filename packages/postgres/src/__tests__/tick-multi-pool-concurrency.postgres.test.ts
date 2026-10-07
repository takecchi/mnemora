import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, Runtime, StructuredRequest, TickResult } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { runMigrations } from "../migrate.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { dropTempDatabase } from "./temp-database.js";
import { requireDatabaseUrl, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * 複数のプロセスから同じ DB へ `tick` を撃つ場面を、別々の `PostgresClient`（それぞれが自分の `pg` Pool＝別々の接続）を
 * 2つ・3つ作って模す（ファイル専用の DB を作り、最後に落とす）。1つのプールの上の `Promise.all` ではなく、接続をまたぐ。
 *
 * 縛るのは2つだけ（どちらも、取り合いがどちらのプールに転んでも成り立つ）:
 * 1. 不変条件: どのジョブも高々1回だけ claim され、`leaseConflicts` は無く、embed の呼び出し回数は処理した件数と同じ。
 *    「どちらのプールが何件取るか」は転び方が毎回違うので縛らない。
 * 2. リースの CAS が接続をまたいで効く（決定的）: プール A の tick が provider の門で止まり、時計をリースより先へ進めると、別のプールの tick が
 *    再 claim して完了させ、A が遅れて `complete`／`fail` しても `leaseConflicts` に載り、行は書き換わらない。順序は時計のオフセットと門（Promise）で決める。
 * Fake・InMemory には複数のプロセスに当たるものが無いので、Postgres だけで測る。
 */

const TEST_DATABASE = "mnemora_tick_multi_pool_test";
const space = TEST_EMBEDDING_SPACE;

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

const clients: PostgresClient[] = [];
let boot: PostgresClient | undefined;

beforeAll(async () => {
  await dropTempDatabase(admin(), TEST_DATABASE);
  await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
  boot = createPostgresClient(connectionStringFor(TEST_DATABASE), { max: 2 });
  await runMigrations(boot.pool);
  await registerEmbeddingSpace(boot.pool, space);
}, 60_000);

afterAll(async () => {
  for (const c of clients.splice(0)) await closePostgresClient(c);
  if (boot) await closePostgresClient(boot);
  await dropTempDatabase(admin(), TEST_DATABASE);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 60_000);

let clockOffsetMs = 0;
let embedCalls = 0;
let embedGate: ((n: number) => Promise<void>) | null = null;
const llm = {
  name: "unused",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> => {
    throw new Error("not used");
  },
};
const embeddingProvider = {
  space,
  embed: async (_ctx: Ctx, texts: string[]) => {
    const n = (embedCalls += 1); // 門の中で別の tick が呼ぶので、自分の番号を先に控える
    if (embedGate) await embedGate(n);
    return texts.map(() => [1, 0, 0]);
  },
};

/** 別々のプール（`max` 本まで）に、それぞれ store と Runtime を組む。 */
function openPool(max: number): { client: PostgresClient; runtime: Runtime } {
  const client = createPostgresClient(connectionStringFor(TEST_DATABASE), { max });
  clients.push(client);
  const db = client.db;
  const runtime = createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    vectorStore: new PostgresVectorStore(db),
    lexicalStore: new PostgresLexicalStore(db),
    outboxStore: new PostgresOutboxStore(db),
    eventStore: new PostgresEventStore(db),
    relationStore: new PostgresRelationStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llm,
    embeddingProvider,
    hashContent: (content) => `h(${content})`,
    clock: { now: () => new Date(Date.now() + clockOffsetMs) },
  });
  return { client, runtime };
}

let tenantCounter = 0;
async function seedEmbedJobs(n: number): Promise<{ ctx: Ctx; ids: string[] }> {
  tenantCounter += 1;
  const ctx: Ctx = { tenantId: `tick-multi-pool-${tenantCounter}` };
  const store = new PostgresMemoryStore(boot!.db);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const { memory } = await store.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `multi-pool-${tenantCounter}-${i}`,
        content: `embed ${i}`,
        digest: `embed ${i}`,
        embeddingStatus: "pending",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
        decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
      }),
      ["embed"],
    );
    ids.push(memory.id);
  }
  return { ctx, ids };
}

async function outboxRows(ctx: Ctx) {
  const r = await boot!.pool.query(
    `SELECT attempts, completed_at IS NOT NULL AS done, failed_at IS NOT NULL AS failed
     FROM outbox WHERE tenant_id = $1 ORDER BY created_at`,
    [ctx.tenantId],
  );
  return r.rows as Array<{ attempts: number; done: boolean; failed: boolean }>;
}

async function readyCount(ctx: Ctx, ids: string[]): Promise<number> {
  const store = new PostgresMemoryStore(boot!.db);
  let ready = 0;
  for (const id of ids) {
    if ((await store.get(ctx, id))?.embeddingStatus === "ready") ready += 1;
  }
  return ready;
}

const sum = (ts: TickResult[], pick: (t: TickResult) => number) =>
  ts.reduce((s, t) => s + pick(t), 0);

describe("複数のプールからの tick の並行: 不変条件（ADR 0531）", () => {
  const TRIALS = 12;
  const N = 12;
  for (const [pools, max, limit] of [
    [2, 2, 50],
    [3, 1, 50],
    [3, 5, 3],
  ] as Array<[number, number, number]>) {
    it(`${pools} つのプール（各 max ${max}）が limit ${limit} で同時に tick を撃つ × ${TRIALS} 回: 全ジョブが1回ずつ、リース競合なし`, async () => {
      const opened = Array.from({ length: pools }, () => openPool(max));
      embedGate = null;
      clockOffsetMs = 0;
      const violations: string[] = [];
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const { ctx, ids } = await seedEmbedJobs(N);
        embedCalls = 0;
        const ts = await Promise.all(
          opened.map((o) => o.runtime.tick(ctx, { leaseMs: 60_000, limit })),
        );
        const total = sum(ts, (t) => t.processed);
        const rows = await outboxRows(ctx);
        if (sum(ts, (t) => t.failed) !== 0) violations.push(`trial ${trial}: failed`);
        if (sum(ts, (t) => t.leaseConflicts.length) !== 0)
          violations.push(`trial ${trial}: leaseConflicts`);
        if (rows.some((r) => r.attempts > 1))
          violations.push(`trial ${trial}: a job was claimed twice`);
        if (embedCalls !== total)
          violations.push(`trial ${trial}: embed calls ${embedCalls} != processed ${total}`);
        if (rows.filter((r) => r.done).length !== total)
          violations.push(`trial ${trial}: done rows != processed`);
        if (total < 1 || total > Math.min(N, pools * limit))
          violations.push(`trial ${trial}: total ${total} out of bounds`);
        if ((await readyCount(ctx, ids)) !== total)
          violations.push(`trial ${trial}: ready != processed`);
        for (let r = 0; r < 20; r += 1) {
          if ((await opened[0]!.runtime.tick(ctx, { leaseMs: 60_000, limit: 50 })).processed === 0)
            break;
        }
        const after = await outboxRows(ctx);
        if (!after.every((r) => r.done && r.attempts === 1))
          violations.push(`trial ${trial}: not drained exactly once`);
      }
      expect(violations).toEqual([]);
    }, 120_000);
  }
});

describe("複数のプールをまたぐリースの CAS（ADR 0531。決定的）", () => {
  for (const lateOutcome of ["complete", "fail"] as const) {
    it(`プール A の tick が止まり、プール B が再 claim して完了させる。A が遅れて ${lateOutcome} しても leaseConflicts に載り、行は B の完了のまま`, async () => {
      const A = openPool(2);
      const B = openPool(2);
      const { ctx, ids } = await seedEmbedJobs(1);
      embedCalls = 0;
      clockOffsetMs = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => (entered = r));
      embedGate = async (n) => {
        if (n !== 1) return;
        entered();
        await gate;
        if (lateOutcome === "fail") throw new Error("A's provider died late");
      };
      try {
        const aP = A.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "A" });
        await enteredP;
        const within = await B.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "B" });
        expect([within.processed, within.failed, within.leaseConflicts.length]).toEqual([0, 0, 0]);
        clockOffsetMs = 5000; // リースの外
        const bT = await B.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "B" });
        expect([bT.processed, bT.failed, bT.leaseConflicts.length]).toEqual([1, 0, 0]);
        const mid = await outboxRows(ctx);
        expect(mid).toEqual([{ attempts: 2, done: true, failed: false }]);
        release();
        const aT = await aP;
        expect([aT.processed, aT.failed]).toEqual([0, 0]);
        expect(aT.leaseConflicts.map((x) => [x.kind, x.attemptedOutcome])).toEqual([
          ["embed", lateOutcome],
        ]);
        expect(await outboxRows(ctx)).toEqual([{ attempts: 2, done: true, failed: false }]);
        const lastError = await boot!.pool.query(
          `SELECT last_error FROM outbox WHERE tenant_id = $1`,
          [ctx.tenantId],
        );
        expect(lastError.rows).toEqual([{ last_error: null }]);
        expect(await readyCount(ctx, ids)).toBe(1);
        expect(embedCalls).toBe(2);
      } finally {
        embedGate = null;
        clockOffsetMs = 0;
      }
    }, 60_000);
  }

  for (const lateOutcome of ["complete", "fail"] as const) {
    it(`A が遅れて ${lateOutcome} するのが、B がまだ処理中の間でも、attempts の CAS で弾かれ、行は B の処理中のまま（B の完了で終わる）`, async () => {
      const A = openPool(2);
      const B = openPool(2);
      const { ctx } = await seedEmbedJobs(1);
      embedCalls = 0;
      clockOffsetMs = 0;
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => (releaseA = r));
      let enteredA!: () => void;
      const enteredAP = new Promise<void>((r) => (enteredA = r));
      let releaseB!: () => void;
      const gateB = new Promise<void>((r) => (releaseB = r));
      let enteredB!: () => void;
      const enteredBP = new Promise<void>((r) => (enteredB = r));
      embedGate = async (n) => {
        if (n === 1) {
          enteredA();
          await gateA;
          if (lateOutcome === "fail") throw new Error("A's provider died late");
        } else if (n === 2) {
          enteredB();
          await gateB;
        }
      };
      try {
        const aP = A.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "A" });
        await enteredAP;
        clockOffsetMs = 5000;
        const bP = B.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "B" });
        await enteredBP; // B が再 claim して provider の中で止まっている（行は attempts 2・未完了）
        expect(await outboxRows(ctx)).toEqual([{ attempts: 2, done: false, failed: false }]);
        releaseA(); // A が先に遅れて終端を付けに来る
        const aT = await aP;
        expect(aT.processed).toBe(0);
        expect(aT.leaseConflicts.map((x) => x.attemptedOutcome)).toEqual([lateOutcome]);
        expect(await outboxRows(ctx)).toEqual([{ attempts: 2, done: false, failed: false }]);
        releaseB();
        const bT = await bP;
        expect([bT.processed, bT.failed, bT.leaseConflicts.length]).toEqual([1, 0, 0]);
        expect(await outboxRows(ctx)).toEqual([{ attempts: 2, done: true, failed: false }]);
      } finally {
        embedGate = null;
        clockOffsetMs = 0;
      }
    }, 60_000);
  }

  it("リースが切れた1本を、別の2つのプールが同時に取りに来ても、取れるのは1つだけ。遅れた A は leaseConflicts", async () => {
    const A = openPool(2);
    const B = openPool(2);
    const C = openPool(2);
    const { ctx } = await seedEmbedJobs(1);
    embedCalls = 0;
    clockOffsetMs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    embedGate = async (n) => {
      if (n !== 1) return;
      entered();
      await gate;
    };
    try {
      const aP = A.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "A" });
      await enteredP;
      clockOffsetMs = 5000;
      const [bT, cT] = await Promise.all([
        B.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "B" }),
        C.runtime.tick(ctx, { leaseMs: 1000, claimedBy: "C" }),
      ]);
      // どちらのプールが取るかは転ぶ。取れるのは1つだけで、取り損ねた側は何も処理せず、何も起きない
      expect(bT.processed + cT.processed).toBe(1);
      expect(bT.failed + cT.failed + bT.leaseConflicts.length + cT.leaseConflicts.length).toBe(0);
      release();
      const aT = await aP;
      expect(aT.processed).toBe(0);
      expect(aT.leaseConflicts.map((x) => x.attemptedOutcome)).toEqual(["complete"]);
      expect(await outboxRows(ctx)).toEqual([{ attempts: 2, done: true, failed: false }]);
      expect(embedCalls).toBe(2);
    } finally {
      embedGate = null;
      clockOffsetMs = 0;
    }
  }, 60_000);
});
