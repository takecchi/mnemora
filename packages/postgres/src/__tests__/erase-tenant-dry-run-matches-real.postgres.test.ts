import { afterAll, describe, expect, it } from "vitest";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";
import {
  buildEraseTenantTestRuntime,
  seedAllTablesForTenant,
} from "./erase-tenant-test-helpers.js";

/**
 * 既存の歯は、表のどれか1つを数え損ねても、ほかの表が数えられていれば緑のままになる。
 * ここでは4つの port を1つずつ直接呼び、`dryRun` の `{ deleted, reachedLimit }` が本番と完全に一致することを見る。
 * 別テナントの行を同じ DB に置くのは、`dryRun` が別テナントの行まで数えないことを見るため。
 */

afterAll(async () => {
  await closeTestClient();
});

const S = "SECRET-DRY-RUN-MATCHES-REAL";

async function seedTenants(tenantIds: string[]) {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const runtime = buildEraseTenantTestRuntime(db, S);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  const relationStore = new PostgresRelationStore(db);
  for (const tenantId of tenantIds) {
    await seedAllTablesForTenant(runtime, tenantSettingsStore, tenantId, S);
    const { rows: ids } = await pool.query<{ id: string }>(
      "SELECT id FROM memories WHERE tenant_id = $1 ORDER BY id LIMIT 2",
      [tenantId],
    );
    expect(ids.length).toBe(2);
    await relationStore.link({ tenantId }, "contradicts", ids[0]!.id, ids[1]!.id);
  }
  return {
    pool,
    stores: {
      memory: new PostgresMemoryStore(db),
      vector: new PostgresVectorStore(db),
      outbox: new PostgresOutboxStore(db),
      settings: new PostgresTenantSettingsStore(db),
    },
  };
}

async function count(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  table: string,
  tenantId: string,
): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]!.n;
}

describe("eraseTenant の dryRun は、本番で消す件数と reachedLimit を port ごとに予告する", () => {
  it("limit が十分大きいとき、4つの port とも dryRun の件数が本番の件数と一致する（別テナントが居ても）", async () => {
    const T = "dry-real-large";
    const { stores } = await seedTenants([T, "dry-real-large-other"]);
    const ctx = { tenantId: T };
    const opts = { limit: 100_000 };

    const dry = {
      memory: await stores.memory.eraseTenant(ctx, { ...opts, dryRun: true }),
      vector: await stores.vector.eraseTenant(ctx, { ...opts, dryRun: true }),
      outbox: await stores.outbox.eraseTenant(ctx, { ...opts, dryRun: true }),
      settings: await stores.settings.eraseTenant(ctx, { ...opts, dryRun: true }),
    };
    // 数えるものが無いまま一致した、という偽の緑を避ける。
    expect(dry.memory.kind).toBe("executed");
    if (dry.memory.kind !== "executed") throw new Error("unreachable");
    expect(dry.memory.deleted).toBeGreaterThan(0);
    expect(dry.vector.deleted).toBeGreaterThan(0);
    expect(dry.outbox.deleted).toBeGreaterThan(0);
    expect(dry.settings.deleted).toBe(1);

    // 本番は、埋め込みが `memories` の CASCADE で先に消えないよう、memoryStore を最後にする。
    const real = {
      vector: await stores.vector.eraseTenant(ctx, opts),
      outbox: await stores.outbox.eraseTenant(ctx, opts),
      settings: await stores.settings.eraseTenant(ctx, opts),
      memory: await stores.memory.eraseTenant(ctx, opts),
    };

    expect(real.vector).toEqual(dry.vector);
    expect(real.outbox).toEqual(dry.outbox);
    expect(real.settings).toEqual(dry.settings);
    expect(real.memory).toEqual(dry.memory);
  }, 120_000);

  it("limit で途中で止まる回でも、memoryStore の dryRun は本番と同じ件数・同じ reachedLimit を返す", async () => {
    const T = "dry-real-stop";
    const { stores } = await seedTenants([T, "dry-real-stop-other"]);
    const ctx = { tenantId: T };

    const dry = await stores.memory.eraseTenant(ctx, { limit: 10, dryRun: true });
    const real = await stores.memory.eraseTenant(ctx, { limit: 10 });

    expect(dry).toEqual({ kind: "executed", deleted: 10, reachedLimit: true });
    expect(real).toEqual(dry);
  }, 120_000);

  it("行数がちょうど limit のとき reachedLimit は true、limit が1つ多いとき false（vector と outbox の dryRun も本番と同じ）", async () => {
    const T = "dry-real-exact";
    const { pool, stores } = await seedTenants([T, "dry-real-exact-other"]);
    const ctx = { tenantId: T };
    const vectors = await count(pool, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), T);
    const jobs = await count(pool, "outbox", T);
    expect(vectors).toBeGreaterThan(0);
    expect(jobs).toBeGreaterThan(0);

    expect(await stores.vector.eraseTenant(ctx, { limit: vectors, dryRun: true })).toEqual({
      deleted: vectors,
      reachedLimit: true,
    });
    expect(await stores.vector.eraseTenant(ctx, { limit: vectors + 1, dryRun: true })).toEqual({
      deleted: vectors,
      reachedLimit: false,
    });
    expect(await stores.outbox.eraseTenant(ctx, { limit: jobs, dryRun: true })).toEqual({
      deleted: jobs,
      reachedLimit: true,
    });
    expect(await stores.outbox.eraseTenant(ctx, { limit: jobs + 1, dryRun: true })).toEqual({
      deleted: jobs,
      reachedLimit: false,
    });

    expect(await stores.vector.eraseTenant(ctx, { limit: vectors + 1 })).toEqual({
      deleted: vectors,
      reachedLimit: false,
    });
    expect(await stores.outbox.eraseTenant(ctx, { limit: jobs + 1 })).toEqual({
      deleted: jobs,
      reachedLimit: false,
    });
  }, 120_000);
});
