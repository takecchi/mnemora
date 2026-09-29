import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 *
 * `eraseTenant` は `memories`/`memory_events` 等に対して素の `DELETE`（行単位の
 * `RowExclusiveLock`）を発行するだけで、`LOCK TABLE`・`CREATE INDEX` のような
 * テーブル単位の排他は一切取らない。⟹ あるテナントを消している最中でも、
 * **別テナントの行への `INSERT`・`SELECT` は待たされない**——この歯はそれを実測する。
 *
 * `create-index-lock-mode.postgres.test.ts`（Issue #760、ADR 0059・0062）の
 * `settlesWithin` と同じ形の手法を使う。**この歯自身は `pg_locks` を読む**（自分の
 * 接続の pid に絞って、対象テーブルに対する自分のロックの mode を確認する）ため、
 * `packages/postgres/vitest.config.mts` の `SERIAL_TEST_FILES` に入れてある
 * （「`pg_locks` という文字列が本文にあるかどうか」で機械的に決めている一覧、
 * ADR 0371）。
 */

afterAll(async () => {
  await closeTestClient();
});

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
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const T = "erase-tenant-concurrent-victim";
    const OTHER = "erase-tenant-concurrent-bystander";

    // eraseTenant の DELETE が一瞬で終わらない程度の行数を、生 SQL で高速に仕込む
    // （フル pipeline の observe/tick だと LLM 往復のぶん遅すぎる——この歯が見たいのは
    // 「DELETE が進行中でも他テナントは待たされない」ことであり、内容の豊かさは要らない）。
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

    // eraseTenant を待たずに走らせ、その最中に別テナントへの書き込み・読み取りを行う。
    const erasing = eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    let eraseSettled = false;
    void erasing.then(
      () => (eraseSettled = true),
      () => (eraseSettled = true),
    );

    // 消す側のトランザクションが `memories` に書き込みのロック（`AccessShareLock` より強いもの。
    // 事前検査の SELECT が取る `AccessShareLock` と取り違えない）を持つまで待つ——ここを確かめずに
    // 別テナントの書き込みを始めると、消去の前か後に走っただけで「待たされない」と
    // 読めてしまう（変異試験で、`LOCK TABLE memories` を入れても緑のままだった）。
    const eraseHoldsMemories = async (): Promise<boolean> => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE relation = 'memories'::regclass AND locktype = 'relation'
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

    // 別接続（短い statement_timeout 付き）——ブロックされていれば必ずこの中で
    // キャンセルされる。ブロックされていなければ、statement_timeout よりずっと早く終わる。
    const bystanderClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c statement_timeout=5000",
      max: 1,
    });
    try {
      // 専用の1本の接続（`pool.connect()`）で `BEGIN` → `INSERT`（未コミット）→
      // 自分の pid のロック mode を確認 → `COMMIT`——`create-index-lock-mode
      // .postgres.test.ts` の "holder" と同じ形。単発の autocommit な `INSERT` だと
      // 完了と同時にロックも解放されてしまい、`pg_locks` で観測できる窓が無くなる。
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
        // ブロックされていれば、上に敷いた statement_timeout=5000 で必ずキャンセルされる
        // （タイムアウトすれば例外——`settlesWithin` は例外でも `true` を返すため、
        // 直後の `await write` で顕在化させる）。
        // 閾値は 1 秒——索引ありの1行 INSERT は数ミリ秒で終わる。消去側がテーブル単位の
        // ロックで2秒止める変異（`LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE` + 2秒）で
        // 赤になることを確かめてある。
        expect(await settlesWithin(write, 1000), "別テナントへの INSERT が 1 秒以内に終わらない").toBe(
          true,
        );
        await write;
        // 書き込みが終わった時点で、消去はまだ途中でなければならない（そうでなければ、
        // 「消している最中」を測っていない）。
        expect(eraseSettled, "INSERT が終わる前に消去が終わった——途中を測れていない").toBe(false);

        // 自分の接続が memories に対して取っているロックの mode を見る——
        // `RowExclusiveLock` のみで、テーブル単位の排他（`ShareLock`/`AccessExclusiveLock`）は
        // 無いことを確認する（別テナントへの INSERT が待たされない理由そのもの）。
        const { rows: lockRows } = await holder.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
           WHERE relation = 'memories'::regclass
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

    // eraseTenant 自体は正常に完了する（何度でも呼び直せる）。
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
