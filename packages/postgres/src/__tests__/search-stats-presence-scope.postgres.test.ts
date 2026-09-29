import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { countMatchingQueries, requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #1415 / ADR 0374: `PostgresVectorStore` の `StatsPresenceGate`
 * （`vector-store.ts` の doc コメント参照）が、実装が約束する3つの範囲——
 * **インスタンスごと・表ごと・テナントには依らない**——を実際に守っていることを
 * 縛る歯。
 *
 * ## 観測の手立て
 *
 * `StatsPresenceGate` はプライベートな状態（`Set`）であり、テストから直接覗けない
 * ——代わりに**副作用**（統計を確認するための余分な往復が起きたかどうか）を数える。
 * `StatsPresenceGate.bothPresent` は未確認のときだけ
 * `SELECT ... reltuples ... to_regclass ...` という形の往復を1回発行する
 * （`vector-store.ts` 参照）。この往復が起きた回数を `countMatchingQueries`
 * （`test-db.ts`、`/reltuples/i` を数える）で数えることで、「確認済みと見なした
 * か・見なしていないか」を外側から観測する。
 *
 * ## 使い捨てデータベースを使う理由
 *
 * `memories-statistics.postgres.test.ts` と同じ理由——この歯は `memories`/
 * 複数の埋め込み表の統計（`ANALYZE` の有無）を精密に制御する必要があり、他の
 * テストファイルと共有する worker ごとの DB では、他ファイルが打った
 * `ANALYZE`/積んだ行数のノイズと衝突しうる。
 */

const TEST_DATABASE = "mnemora_search_stats_presence_scope_test";
const TENANT_A = `stats-presence-scope-tenant-a-${randomUUID()}`;
const TENANT_B = `stats-presence-scope-tenant-b-${randomUUID()}`;

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

function uniqueSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "stats-presence-scope-test",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

const isReltuplesQuery = (text: string): boolean => /reltuples/i.test(text);

async function seedRows(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  space: EmbeddingSpaceId,
  count: number,
  seedLabel: string,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `${seedLabel}-${i}`,
        content: `stats-presence-scope fixture memory #${i} (${seedLabel}) — ${"本文をある程度の長さにする".repeat(4)}`,
        digest: `stats-presence-scope fixture digest #${i} (${seedLabel})`,
      }),
    );
    await vectorStore.upsert(ctx, space, memory.id, [i % 7, (i * 3) % 11, (i * 5) % 13]);
  }
}

describe("StatsPresenceGate: インスタンス・表ごとの範囲（Issue #1415 / ADR 0374）", () => {
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
  }, 30_000);

  it("表ごとに覚える: 表Aを確認済みにしても、統計の無い別の表Bは相変わらず未確認として扱う（毎回の往復を払う）", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT_A };

    const spaceA = uniqueSpace("table-a");
    const spaceB = uniqueSpace("table-b");
    await registerEmbeddingSpace(pool, spaceA);
    await registerEmbeddingSpace(pool, spaceB);
    const tableA = embeddingSpaceTableName(spaceA);

    await seedRows(memoryStore, vectorStore, ctx, spaceA, 20, "table-a");
    await seedRows(memoryStore, vectorStore, ctx, spaceB, 20, "table-b");

    // 表Aと memories だけ ANALYZE する——表Bは一度も ANALYZE しない
    // （`reltuples < 0` のまま、`StatsPresenceGate` にとって「統計が無い」表）。
    await pool.query(`ANALYZE ${tableA}`);
    await pool.query(`ANALYZE memories`);

    // 1回目: 表Aへの search() ——未確認なので、reltuples の往復が1回発生する。
    const firstCallOnA = await countMatchingQueries(isReltuplesQuery, () =>
      vectorStore.search(ctx, spaceA, [1, 2, 3], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(firstCallOnA, "表Aへの1回目は未確認のはずなので、reltuples の往復が1回起きる").toBe(1);

    // 2回目: 同じ表Aへの search() ——確認済みなので、往復は増えない。
    const secondCallOnA = await countMatchingQueries(isReltuplesQuery, () =>
      vectorStore.search(ctx, spaceA, [4, 5, 6], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(secondCallOnA, "表Aは確認済みのはずなので、2回目は reltuples の往復が起きない").toBe(0);

    // 1回目: 表Bへの search() ——表Aを確認済みにしたことが、表Bの未確認を覆さない
    // ことを縛る本題。表Bは一度も ANALYZE していないので統計は無いが、この歯が
    // 見たいのは「往復が起きるかどうか」（=未確認として扱われるかどうか）だけである
    // （速さや `reltuples` の値そのものは別の歯——`search-primary-key-lookup...`——が縛る）。
    const firstCallOnB = await countMatchingQueries(isReltuplesQuery, () =>
      vectorStore.search(ctx, spaceB, [1, 2, 3], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(
      firstCallOnB,
      "表Aを確認済みにしたことは表Bの状態に影響しないはず——表Bの1回目も未確認として往復1回",
    ).toBe(1);
  }, 60_000);

  it("インスタンスをまたいで共有しない: 別の PostgresVectorStore インスタンスは、確認済みの表でも自分ではまだ未確認として扱う", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT_A };

    const space = uniqueSpace("cross-instance");
    await registerEmbeddingSpace(pool, space);

    const instance1 = new PostgresVectorStore(db);
    await seedRows(memoryStore, instance1, ctx, space, 20, "cross-instance");
    await pool.query(`ANALYZE ${embeddingSpaceTableName(space)}`);
    await pool.query(`ANALYZE memories`);

    // instance1 を確認済みにする。
    const instance1First = await countMatchingQueries(isReltuplesQuery, () =>
      instance1.search(ctx, space, [1, 2, 3], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(instance1First, "instance1 の1回目は未確認のはず").toBe(1);
    const instance1Second = await countMatchingQueries(isReltuplesQuery, () =>
      instance1.search(ctx, space, [4, 5, 6], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(instance1Second, "instance1 の2回目は確認済みのはず").toBe(0);

    // 同じ db・同じ表に対する、まったく別の PostgresVectorStore インスタンス
    // ——instance1 が確認済みでも、新しいインスタンスは覚えていない（大域・static で
    // 共有していないことの直接の証拠）。
    const instance2 = new PostgresVectorStore(db);
    const instance2First = await countMatchingQueries(isReltuplesQuery, () =>
      instance2.search(ctx, space, [7, 8, 9], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(
      instance2First,
      "instance2 は instance1 の確認済み状態を共有しないはず——1回目は未確認として往復1回",
    ).toBe(1);
  }, 60_000);

  it("テナントごとには持たない: テナントを変えても、確認済みの状態は同じインスタンス・表の中で共有される", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);

    const space = uniqueSpace("cross-tenant");
    await registerEmbeddingSpace(pool, space);

    const ctxA: Ctx = { tenantId: TENANT_A };
    const ctxB: Ctx = { tenantId: TENANT_B };
    await seedRows(memoryStore, vectorStore, ctxA, space, 20, "cross-tenant-a");
    await seedRows(memoryStore, vectorStore, ctxB, space, 20, "cross-tenant-b");
    await pool.query(`ANALYZE ${embeddingSpaceTableName(space)}`);
    await pool.query(`ANALYZE memories`);

    // テナントAで確認済みにする。
    const firstOnA = await countMatchingQueries(isReltuplesQuery, () =>
      vectorStore.search(ctxA, space, [1, 2, 3], { limit: 10, filter: { tenantId: TENANT_A } }),
    );
    expect(firstOnA, "テナントAの1回目は未確認のはず").toBe(1);

    // テナントBに切り替えても、同じインスタンス・同じ表なので、確認済みの状態は
    // そのまま——テナント単位の状態を別に持っていれば、ここで往復が1回起きてしまう。
    const firstOnB = await countMatchingQueries(isReltuplesQuery, () =>
      vectorStore.search(ctxB, space, [4, 5, 6], { limit: 10, filter: { tenantId: TENANT_B } }),
    );
    expect(
      firstOnB,
      "テナントを変えても、確認済みの状態は同じインスタンス・表で共有されるはず（往復0回）",
    ).toBe(0);
  }, 60_000);
});
