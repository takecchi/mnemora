import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemory } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 機能の歯（戻り値・行の中身）では見えない「ロックを取る順」と「ロックを取りすぎないこと」を、ロックそのものを外から見て縛る。実装の SQL は変えない。
 *
 * A. 先取りの中身を直接見る。別の接続が、対象の語彙のうち名前（コードポイント順）で真ん中の1行を `FOR UPDATE` で掴んでおくと、
 *    先取りは「それより前の名前を全部掴み、その1行で待つ」。その待っている瞬間に、(1) 掴まれている行の集合がちょうど名前順の先頭からその1行までであること、
 *    (2) `labels` への表ロックが弱いロックだけであること（`pg_locks`）、(3) `labels` の UPDATE トリガが1回も発火していないこと（`nextval` は巻き戻らないので、待っている最中の別の接続から読める）、
 *    (4) 無関係なラベルへの書き込みが `lock_timeout` 300ms で塞がれないこと、を見る。
 * B. 経路をまたぐ deadlock。`labels` を UPDATE するたびに眠るトリガの下で、`createMemory` が a を掴んで眠っている間に先取りの側が入る。
 *    先取りが逆順なら b を先に掴んで a を待ち、upsert は b を待つので 40P01 になる。トリガは `FOR UPDATE` の先取りでは発火しないので、窓は「相手が眠る側」に置く。
 * C. `FOR SHARE` の揺れ。先取りの後・labels の UPDATE の前に通る `INSERT INTO memories` に眠るトリガを置き、同じ語彙を持つ同じ経路の2呼び出しを同時に走らせる。
 *    先取りが `FOR UPDATE` なら後の呼び出しは前の呼び出しの commit まで待つ。`FOR SHARE` だと両方が掴んだ後で互いに UPDATE の昇格を待って 40P01 になる。
 *
 * A の名前は、コードポイント順と en-US の照合順序がずれるもの。既定の DB と、ICU `en-US` の DB（OS のロケールに依らず差が出る）の2つで走らせる。
 * この Postgres ビルドが ICU 非対応のときは、理由を出して明示的に skip する（偽の緑にしない）。
 * `pg_locks` は `database` を自分の DB の oid に絞って読み、自分専用の DB で走らせる。
 */

const SLEEP_FN = "adr1718_sleep";
const COUNT_FN = "adr1718_count_update";
const COUNT_SEQ = "adr1718_label_update_seq";

/** コードポイント順（C）と en-US の照合順序でずれる名前: C は B < _a < a < é < 😀、en-US は _a < a < B < é < 😀。 */
const NAMES = ["B", "_a", "a", "é", "😀"];
const UNRELATED = "A";

function byCodePoint(a: string, b: string): number {
  const ca = [...a].map((c) => c.codePointAt(0)!);
  const cb = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return ca[i]! - cb[i]!;
  }
  return ca.length - cb.length;
}
const SORTED = [...NAMES].sort(byCodePoint);

interface Env {
  client: PostgresClient;
  store: PostgresMemoryStore;
  oid: number;
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function createEnv(database: string, icu: boolean): Promise<Env | { skip: string }> {
  await dropTempDatabase(admin(), database);
  try {
    await admin().query(
      icu
        ? `CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`
        : `CREATE DATABASE ${database}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (icu && /icu/i.test(message)) {
      return { skip: `この Postgres ビルドは ICU ロケールプロバイダに対応していない: ${message}` };
    }
    throw err;
  }
  const client = createPostgresClient(connectionStringFor(database));
  await runMigrations(client.pool);
  const { rows } = await admin().query("SELECT oid::int AS oid FROM pg_database WHERE datname=$1", [
    database,
  ]);
  return { client, store: new PostgresMemoryStore(client.db), oid: rows[0].oid as number };
}

async function destroyEnv(env: Env | { skip: string } | undefined, database: string) {
  if (env && "client" in env) await closePostgresClient(env.client);
  await dropTempDatabase(admin(), database);
}

async function reset(env: Env): Promise<void> {
  const { pool } = env.client;
  await removeTriggers(env);
  await pool.query("TRUNCATE TABLE memories, labels, memory_labels CASCADE");
}

async function installTrigger(
  env: Env,
  table: "labels" | "memories" | "memory_labels",
  event: "UPDATE" | "INSERT" | "DELETE",
  seconds: number,
): Promise<void> {
  const { pool } = env.client;
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${SLEEP_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(${seconds}); RETURN COALESCE(NEW, OLD); END $$`);
  await pool.query(
    `CREATE TRIGGER ${SLEEP_FN}_${table} BEFORE ${event} ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${SLEEP_FN}()`,
  );
}

async function installCounter(env: Env): Promise<void> {
  const { pool } = env.client;
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${COUNT_SEQ}`);
  await pool.query(`SELECT setval('${COUNT_SEQ}', 1, false)`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${COUNT_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('${COUNT_SEQ}'); RETURN NEW; END $$`);
  await pool.query(
    `CREATE TRIGGER ${COUNT_FN}_trg BEFORE UPDATE ON labels
       FOR EACH ROW EXECUTE FUNCTION ${COUNT_FN}()`,
  );
}

/** トリガの発火回数（`nextval` の呼び出し回数）。 */
async function updateCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT last_value::int AS v, is_called FROM ${COUNT_SEQ}`);
  return rows[0].is_called ? (rows[0].v as number) : 0;
}

async function removeTriggers(env: Env): Promise<void> {
  const { pool } = env.client;
  await pool.query(`DROP TRIGGER IF EXISTS ${SLEEP_FN}_labels ON labels`);
  await pool.query(`DROP TRIGGER IF EXISTS ${SLEEP_FN}_memories ON memories`);
  await pool.query(`DROP TRIGGER IF EXISTS ${SLEEP_FN}_memory_labels ON memory_labels`);
  await pool.query(`DROP TRIGGER IF EXISTS ${COUNT_FN}_trg ON labels`);
  await pool.query(`DROP FUNCTION IF EXISTS ${SLEEP_FN}()`);
  await pool.query(`DROP FUNCTION IF EXISTS ${COUNT_FN}()`);
  await pool.query(`DROP SEQUENCE IF EXISTS ${COUNT_SEQ}`);
}

/** 語彙を直接入れる。入れる順は名前順の逆にする（`ORDER BY` を外した先取りが、名前順と偶然そろわないようにする）。 */
async function seedLabels(env: Env, tenantId: string, names: readonly string[]): Promise<void> {
  for (const name of [...names].sort(byCodePoint).reverse()) {
    await env.client.pool.query(
      `INSERT INTO labels (id, tenant_id, name, status, proposed_count)
       VALUES (gen_random_uuid(), $1, $2, 'proposed', 1)`,
      [tenantId, name],
    );
  }
}

function failureCodes(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) => {
    if (r.status !== "rejected") return [];
    const e = r.reason as { code?: string; cause?: { code?: string } };
    return [
      e.cause?.code ?? e.code ?? `(no code) ${String((r.reason as Error).message).slice(0, 80)}`,
    ];
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newMemory(ctx: Ctx, hash: string, tags: string[]): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: hash,
    content: hash,
    tags,
  });
}

type PathName = "createMany" | "supersede" | "purge" | "scrub";
const PATHS: PathName[] = ["createMany", "supersede", "purge", "scrub"];

/** 経路ごとの「準備」と「走らせる関数」。準備のあとで語彙（`names`）が `labels` に既に在る状態になる。 */
async function preparePath(
  env: Env,
  path: PathName,
  ctx: Ctx,
  names: readonly string[],
  tag: string,
): Promise<() => Promise<unknown>> {
  const { store } = env;
  const eventFor = (memoryId: MemoryId, kind?: "purged" | "superseded") =>
    buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId, ...(kind ? { kind } : {}) });
  if (path === "createMany" || path === "supersede") {
    const lists = [names.slice(0, 3), names.slice(2)].map((l) => [...l]);
    const news = lists.map((tags, i) => ({
      input: newMemory(ctx, `${tag}-new-${i}`, tags),
      jobKinds: [] as never[],
    }));
    if (path === "createMany") {
      return () =>
        store.createMemoriesWithOutboxAndEvents(ctx, news, (memory) => eventFor(memory.id));
    }
    const old = await store.createMemory(ctx, newMemory(ctx, `${tag}-old`, []));
    return () =>
      store.supersedeWithNewMemories(
        ctx,
        news,
        [{ id: old.id, supersededByIndex: 0, event: eventFor(old.id, "superseded") }],
        undefined,
      );
  }
  const old = await store.createMemory(ctx, newMemory(ctx, `${tag}-to-purge`, [...names]));
  await store.updateStatus(ctx, old.id, "forgotten");
  if (path === "purge") {
    return () =>
      store.purgeMemory(ctx, old.id, { content: "[p]", digest: "[p]" }, eventFor(old.id, "purged"));
  }
  await env.client.pool.query(
    "UPDATE memories SET purged_at = now() WHERE tenant_id = $1 AND id = $2",
    [ctx.tenantId, old.id],
  );
  return () => store.scrubPurged!(ctx, [old.id]);
}

/** 別の接続が行ロックを掴んで、`run` がそのロックで待ち始めるまで待つ。 */
async function waitUntilSomeoneWaits(pool: Pool, oid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await pool.query(
      // `transactionid` の待ちは `pg_locks.database` が NULL なので、pid を自分の DB の接続に絞って数える。
      `SELECT count(*)::int AS n FROM pg_locks l
        WHERE NOT l.granted AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE datid = $1)`,
      [oid],
    );
    if ((rows[0].n as number) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "先取りがロックで待たなかった（10 秒待っても、掴まれた行を待つ接続が現れない）。先取りが対象の行を掴んでいない",
      );
    }
    await sleep(20);
  }
}

async function lockedNames(pool: Pool, tenantId: string): Promise<string[]> {
  const all = await pool.query("SELECT name FROM labels WHERE tenant_id = $1", [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const free = await client.query(
      "SELECT name FROM labels WHERE tenant_id = $1 FOR UPDATE SKIP LOCKED",
      [tenantId],
    );
    await client.query("ROLLBACK");
    const freeSet = new Set(free.rows.map((r) => r.name as string));
    return all.rows
      .map((r) => r.name as string)
      .filter((n) => !freeSet.has(n))
      .sort(byCodePoint);
  } finally {
    client.release();
  }
}

interface Observation {
  locked: string[];
  lockedOtherTenant: string[];
  tableLockModes: string[];
  updatesFired: number;
  unrelatedWriteCode: string | undefined;
  outcome: PromiseSettledResult<unknown>;
}

/**
 * `blockName` の行を別の接続が掴んでいる間に `run` を走らせ、`run` が待っている瞬間のロックの状態を返す。
 * 返す前に、掴みを離して `run` の完了まで待つ。
 */
async function observeWhileBlocked(
  env: Env,
  ctx: Ctx,
  otherTenantId: string,
  blockName: string,
  run: () => Promise<unknown>,
): Promise<Observation> {
  const { pool } = env.client;
  const blocker: PoolClient = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT 1 FROM labels WHERE tenant_id = $1 AND name = $2 FOR UPDATE", [
    ctx.tenantId,
    blockName,
  ]);
  const running = run().then(
    (value): PromiseSettledResult<unknown> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<unknown> => ({ status: "rejected", reason }),
  );
  try {
    await waitUntilSomeoneWaits(pool, env.oid);
    const locked = await lockedNames(pool, ctx.tenantId);
    const lockedOtherTenant = await lockedNames(pool, otherTenantId);
    const modes = await pool.query(
      `SELECT DISTINCT mode FROM pg_locks
        WHERE database = $1 AND locktype = 'relation' AND relation = 'labels'::regclass AND granted
        ORDER BY mode`,
      [env.oid],
    );
    // 数えるのは、無関係な書き込み（自分もトリガを発火させる）より前。
    const updatesFired = await updateCount(pool);
    let unrelatedWriteCode: string | undefined;
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '300ms'");
      try {
        await writer.query(
          "UPDATE labels SET proposed_count = proposed_count + 1 WHERE tenant_id = $1 AND name = $2",
          [ctx.tenantId, UNRELATED],
        );
      } catch (e) {
        unrelatedWriteCode = (e as { code?: string }).code;
      }
      await writer.query("ROLLBACK");
    } finally {
      writer.release();
    }
    await blocker.query("ROLLBACK");
    blocker.release();
    return {
      locked,
      lockedOtherTenant,
      tableLockModes: modes.rows.map((r) => r.mode as string),
      updatesFired,
      unrelatedWriteCode,
      outcome: await running,
    };
  } catch (err) {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await running;
    throw err;
  }
}

const WEAK_TABLE_LOCKS = ["AccessShareLock", "RowExclusiveLock", "RowShareLock"];

const ENVS = [
  { title: "既定の DB", database: "mnemora_label_lock_teeth_default", icu: false },
  { title: "ICU en-US の DB", database: "mnemora_label_lock_teeth_icu", icu: true },
] as const;

describe.each(ENVS)("先取りの中身（$title）", ({ database, icu }) => {
  let env: Env | { skip: string } | undefined;

  beforeAll(async () => {
    env = await createEnv(database, icu);
  }, 60_000);
  afterAll(async () => {
    await destroyEnv(env, database);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 60_000);
  beforeEach(async () => {
    if (env && "client" in env) await reset(env);
  });

  const cases = PATHS.flatMap((path) => [1, 2].map((position) => ({ path, position })));
  for (const { path, position } of cases) {
    it(`${path}: 語彙の名前順の ${position} 番目の行が掴まれている間、先取りは先頭からその行までだけを掴み、行を書かず、表ロックも取らない`, async (t) => {
      if (!env || "skip" in env) {
        t.skip(env ? env.skip : "env が無い");
        return;
      }
      const ctx: Ctx = { tenantId: "adr1718-a" };
      const other = "adr1718-a-other";
      await seedLabels(env, ctx.tenantId, [...NAMES, UNRELATED]);
      await seedLabels(env, other, [...NAMES, UNRELATED]);
      const run = await preparePath(env, path, ctx, NAMES, path);
      await installCounter(env);
      const blockName = SORTED[position]!;
      const seen = await observeWhileBlocked(env, ctx, other, blockName, run);
      await removeTriggers(env);

      expect(seen.locked).toEqual(SORTED.slice(0, position + 1));
      expect(seen.lockedOtherTenant).toEqual([]);
      expect(seen.tableLockModes.filter((m) => !WEAK_TABLE_LOCKS.includes(m))).toEqual([]);
      expect(seen.updatesFired).toBe(0);
      expect(seen.unrelatedWriteCode).toBeUndefined();
      expect(failureCodes([seen.outcome])).toEqual([]);
    }, 60_000);
  }
});

describe("経路をまたぐ deadlock（先取りと upsert）", () => {
  const database = "mnemora_label_lock_teeth_cross";
  let env: Env | { skip: string } | undefined;

  beforeAll(async () => {
    env = await createEnv(database, false);
  }, 60_000);
  afterAll(async () => {
    await destroyEnv(env, database);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 60_000);
  beforeEach(async () => {
    if (env && "client" in env) await reset(env);
  });

  it.each(PATHS)(
    "%s の先取りは、labels を名前順に掴んで眠る upsert と逆順にならず、deadlock しない",
    async (path) => {
      const e = env as Env;
      const ctx: Ctx = { tenantId: "adr1718-b" };
      await seedLabels(e, ctx.tenantId, ["a", "b"]);
      const run = await preparePath(e, path, ctx, ["a", "b"], path);
      // `a` を掴んで眠っている間に、先取りの側が入る（0.4 秒眠るトリガ。入るのは 0.15 秒後）。
      await installTrigger(e, "labels", "UPDATE", 0.4);
      const results = await Promise.allSettled([
        e.store.createMemory(ctx, newMemory(ctx, "holder", ["a", "b"])),
        sleep(150).then(run),
      ]);
      await removeTriggers(e);
      expect(failureCodes(results)).toEqual([]);
      const dropped = results.flatMap((r) =>
        r.status === "fulfilled" &&
        r.value !== null &&
        typeof r.value === "object" &&
        "dropped" in r.value
          ? (r.value as { dropped: Array<{ error: unknown }> }).dropped
          : [],
      );
      expect(dropped).toEqual([]);
    },
    60_000,
  );
});

describe("FOR UPDATE の強さ（FOR SHARE への揺れ）", () => {
  const database = "mnemora_label_lock_teeth_share";
  let env: Env | { skip: string } | undefined;

  beforeAll(async () => {
    env = await createEnv(database, false);
  }, 60_000);
  afterAll(async () => {
    await destroyEnv(env, database);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 60_000);
  beforeEach(async () => {
    if (env && "client" in env) await reset(env);
  });

  it.each(["createMany", "supersede"] as const)(
    "%s: 同じ語彙を持つ同じ経路の2呼び出しが、先取りの後の窓を広げても deadlock しない",
    async (path) => {
      const e = env as Env;
      const ctx: Ctx = { tenantId: "adr1718-c" };
      await seedLabels(e, ctx.tenantId, ["a", "b"]);
      const runs = [
        await preparePath(e, path, ctx, ["a", "b"], `${path}-1`),
        await preparePath(e, path, ctx, ["a", "b"], `${path}-2`),
      ];
      // 先取りの後・labels の UPDATE の前に通る `INSERT INTO memories` で眠る。
      await installTrigger(e, "memories", "INSERT", 0.4);
      const results = await Promise.allSettled(runs.map((run) => run()));
      await removeTriggers(e);
      expect(failureCodes(results)).toEqual([]);
      const dropped = results.flatMap((r) =>
        r.status === "fulfilled" &&
        r.value !== null &&
        typeof r.value === "object" &&
        "dropped" in r.value
          ? (r.value as { dropped: Array<{ error: unknown }> }).dropped
          : [],
      );
      expect(dropped).toEqual([]);
    },
    60_000,
  );
});

describe("purge・scrub の先取りの強さ（FOR SHARE への揺れ）", () => {
  const database = "mnemora_label_lock_teeth_share_purge";
  let env: Env | { skip: string } | undefined;

  beforeAll(async () => {
    env = await createEnv(database, false);
  }, 60_000);
  afterAll(async () => {
    await destroyEnv(env, database);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 60_000);
  beforeEach(async () => {
    if (env && "client" in env) await reset(env);
  });

  it.each(["purge", "scrub"] as const)(
    "%s: 同じ語彙を持つ別の記憶への2呼び出しが、先取りの後の窓を広げても deadlock しない",
    async (path) => {
      const e = env as Env;
      const ctx: Ctx = { tenantId: "adr1718-d" };
      await seedLabels(e, ctx.tenantId, ["a", "b"]);
      const runs = [
        await preparePath(e, path, ctx, ["a", "b"], `${path}-1`),
        await preparePath(e, path, ctx, ["a", "b"], `${path}-2`),
      ];
      // 先取りの後・labels の UPDATE の前に通る `DELETE FROM memory_labels` で眠る。
      await installTrigger(e, "memory_labels", "DELETE", 0.4);
      const results = await Promise.allSettled(runs.map((run) => run()));
      await removeTriggers(e);
      expect(failureCodes(results)).toEqual([]);
    },
    60_000,
  );
});
