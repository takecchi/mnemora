import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `eraseTenant` は素の `DELETE`（行単位の `RowExclusiveLock`）を発行するだけで、`LOCK TABLE` のようなテーブル単位の排他は取らない。
 * そのため、あるテナントを消している最中でも別テナントの行への `INSERT`・`SELECT` は待たされない。この歯はそれを実測する。
 *
 * 自分専用の DB で走らせる: 2万行を入れて消すので、大量の書き込みを共有 DB に残さないよう、`CREATE DATABASE` で作る自分専用の DB の上で走らせる。
 * `pg_locks` はクラスタ全体の表なので、読むときは必ず `database` を自分の DB の oid に絞る。
 */

const TEST_DATABASE = "mnemora_erase_tenant_concurrent_test";

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

let client: PostgresClient | undefined;

beforeAll(async () => {
  await dropTempDatabase(admin(), TEST_DATABASE);
  await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
  client = createPostgresClient(connectionStringFor(TEST_DATABASE));
  await runMigrations(client.pool);
}, 60_000);

afterAll(async () => {
  if (client) {
    await closePostgresClient(client);
  }
  await dropTempDatabase(admin(), TEST_DATABASE);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 60_000);

/** `pg_locks` を自分の DB に絞る条件（クラスタ全体の表なので、ほかの DB の行を数えない）。 */
const OWN_DATABASE = "database = (SELECT oid FROM pg_database WHERE datname = current_database())";

/** `p` が `ms` のうちに決着した（resolve/reject どちらでも）か。 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

const BULK_ROWS = 20_000;

describe("eraseTenant している最中も、別テナントの行への INSERT/SELECT は待たされない（Issue #1207 / ADR 0383）", () => {
  it("大量データを消している間、別テナントへの書き込み・読み取りが短い statement_timeout の内に完了する", async () => {
    const { db, pool } = client!;
    const T = "erase-tenant-concurrent-victim";
    const OTHER = "erase-tenant-concurrent-bystander";

    // `eraseTenant` の DELETE が一瞬で終わらない程度の行数を、生 SQL で高速に仕込む（フル pipeline だと LLM 往復のぶん遅すぎる）。
    await pool.query(
      `INSERT INTO memories (
         id, tenant_id, subject_id, source_observation_id, extractor_version,
         content, content_hash, digest, digest_source, provenance_kind, provenance,
         status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
         embedding_status, created_at, updated_at
       )
       SELECT
         gen_random_uuid(), $1, NULL, NULL, NULL,
         'bulk ' || g, 'bulk-hash-' || g, 'bulk-digest-' || g, 'llm', 'imported',
         '{"kind":"imported","batchId":"bulk"}'::jsonb,
         'active', '{}', now(), 1.0, 720, now() + interval '180 days',
         'pending', now(), now()
       FROM generate_series(1, $2) AS g`,
      [T, BULK_ROWS],
    );
    await pool.query(
      `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
       SELECT gen_random_uuid(), $1, m.id, 'created', now(), '{"type":"system"}'::jsonb, '{}'::jsonb
       FROM memories m WHERE m.tenant_id = $1`,
      [T],
    );

    const countBefore = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(countBefore.rows[0]!.n).toBe(BULK_ROWS);

    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const ctxT: Ctx = { tenantId: T };

    const erasing = eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    let eraseSettled = false;
    void erasing.then(
      () => (eraseSettled = true),
      () => (eraseSettled = true),
    );

    // 消す側のトランザクションが `memories` に書き込みのロック（事前検査の SELECT が取る `AccessShareLock` より強いもの）を持つまで待つ。
    // ここを確かめずに別テナントの書き込みを始めると、消去の前か後に走っただけで「待たされない」と読めてしまう。
    const eraseHoldsMemories = async (): Promise<boolean> => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE relation = 'memories'::regclass AND locktype = 'relation'
           AND ${OWN_DATABASE}
           AND granted AND pid <> pg_backend_pid()
           AND mode <> 'AccessShareLock'`,
      );
      return rows[0]!.n > 0;
    };
    const deadline = Date.now() + 30_000;
    while (!(await eraseHoldsMemories())) {
      expect(eraseSettled, "消去が memories に触れる前に終わった").toBe(false);
      expect(Date.now() < deadline, "消去が memories のロックを取るのを観測できなかった").toBe(
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // 別接続（短い statement_timeout 付き）。ブロックされていれば必ずこの中でキャンセルされる。
    const bystanderClient = createPostgresClient(connectionStringFor(TEST_DATABASE), {
      options: "-c statement_timeout=5000",
      max: 1,
    });
    try {
      // 専用の1本の接続で `BEGIN` → `INSERT`（未コミット）→ 自分の pid のロック mode を確認 → `COMMIT`。
      // 単発の autocommit な `INSERT` だと完了と同時にロックも解放されてしまい、`pg_locks` で観測できる窓が無くなる。
      const holder = await bystanderClient.pool.connect();
      let committed = false;
      try {
        const begin = holder.query("BEGIN");
        expect(await settlesWithin(begin, 5000)).toBe(true);
        await begin;

        const write = holder.query(
          `INSERT INTO memories (
             id, tenant_id, subject_id, source_observation_id, extractor_version,
             content, content_hash, digest, digest_source, provenance_kind, provenance,
             status, tags, recorded_at, strength, half_life_hours, decay_floor_at,
             embedding_status, created_at, updated_at
           ) VALUES (
             gen_random_uuid(), $1, NULL, NULL, NULL,
             'bystander', 'bystander-hash', 'bystander-digest', 'llm', 'imported',
             '{"kind":"imported","batchId":"bystander"}'::jsonb,
             'active', '{}', now(), 1.0, 720, now() + interval '180 days',
             'pending', now(), now()
           )`,
          [OTHER],
        );
        // ブロックされていれば、上に敷いた statement_timeout=5000 でキャンセルされる。`settlesWithin` は例外でも `true` を返すので、直後の `await write` で顕在化させる。
        // 閾値は 1 秒（索引ありの1行 INSERT は数ミリ秒で終わる）。
        expect(
          await settlesWithin(write, 1000),
          "別テナントへの INSERT が 1 秒以内に終わらない",
        ).toBe(true);
        await write;
        // 書き込みが終わった時点で、消去はまだ途中でなければならない（そうでなければ「消している最中」を測っていない）。
        expect(eraseSettled, "INSERT が終わる前に消去が終わった——途中を測れていない").toBe(false);

        const { rows: lockRows } = await holder.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
           WHERE relation = 'memories'::regclass
             AND ${OWN_DATABASE}
             AND pid = pg_backend_pid()
             AND locktype = 'relation'`,
        );
        expect(lockRows.map((r) => r.mode)).toEqual(["RowExclusiveLock"]);

        const read = holder.query("SELECT count(*) FROM memories WHERE tenant_id = $1", [OTHER]);
        expect(await settlesWithin(read, 1000), "別テナントの SELECT が 1 秒以内に終わらない").toBe(
          true,
        );
        await read;

        await holder.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) {
          await holder.query("ROLLBACK").catch(() => {});
        }
        holder.release();
      }
    } finally {
      await closePostgresClient(bystanderClient).catch(() => {});
    }

    let outcome = await erasing;
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    }
    expect(outcome.kind).toBe("executed");

    const countAfter = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(countAfter.rows[0]!.n).toBe(0);
    const otherCount = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [OTHER],
    );
    expect(otherCount.rows[0]!.n).toBe(1);
  }, 120_000);
});
