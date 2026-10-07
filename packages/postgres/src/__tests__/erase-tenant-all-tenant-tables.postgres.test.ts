import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { listEmbeddingSpaceTables } from "../embedding-space-catalog.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import {
  buildEraseTenantTestRuntime,
  seedAllTablesForTenant,
} from "./erase-tenant-test-helpers.js";

/**
 * 表名を焼き込まず、`information_schema.columns` で `tenant_id` 列を持つ表を全部数え上げる。
 * 「行を入れられなかった表」は名指しで失敗させる。後から表が増えても、その表への行の入れ方を知らなければ、
 * 「その表だけ0行のままだった」ではなく「その表に行を入れる手段が無かった」と分かる形で失敗する。
 */

afterAll(async () => {
  await closeTestClient();
});

/** `current_schema()` の中で `tenant_id` 列を持つ実テーブルを、表名の昇順で列挙する。 */
async function listTenantScopedTables(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(`
    SELECT t.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'tenant_id'
    ORDER BY t.table_name
  `);
  return result.rows.map((r) => r.table_name);
}

async function countForTenant(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  table: string,
  tenantId: string,
): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0]!.n;
}

describe("eraseTenant は tenant_id を持つ全表からこのテナントの行を消す（Issue #1207 / ADR 0383、information_schema で数え上げ）", () => {
  it("列挙した全表に1行以上入れたテナントが、eraseTenant の後は全表0行になる", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const S = "SECRET-ALL-TENANT-TABLES";
    const T = "erase-all-tables";
    const OTHER = "erase-all-tables-keep";

    const runtime = buildEraseTenantTestRuntime(db, S);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    await seedAllTablesForTenant(runtime, tenantSettingsStore, T, S);
    await seedAllTablesForTenant(runtime, tenantSettingsStore, OTHER, S);
    // 関係の行は claim key 衝突検出を on にしないと張られないので、`RelationStore.link` を直接呼んで両テナントに1組ずつ張る。
    const relationStore = new PostgresRelationStore(db);
    for (const tenantId of [T, OTHER]) {
      const { rows: ids } = await pool.query<{ id: string }>(
        "SELECT id FROM memories WHERE tenant_id = $1 ORDER BY id LIMIT 2",
        [tenantId],
      );
      expect(ids.length).toBe(2);
      await relationStore.link({ tenantId }, "contradicts", ids[0]!.id, ids[1]!.id);
      await relationStore.link({ tenantId }, "contradicts", ids[1]!.id, ids[0]!.id);
    }

    const tables = await listTenantScopedTables(pool);
    expect(tables.length).toBeGreaterThan(0);

    // 埋め込み空間の表は、並行して走る他のテストファイルも同じスキーマに作る。`listEmbeddingSpaceTables` が返す表には、
    // 次元を読んで両テナントとも行を入れる。それ以外の知らない表は、下で名指しで落ちるまま。
    const spaceTables = new Set((await listEmbeddingSpaceTables(db)).map((e) => e.table));
    for (const table of tables.filter((t) => spaceTables.has(t))) {
      for (const tenantId of [T, OTHER]) {
        await pool.query(
          `INSERT INTO ${table} (tenant_id, memory_id, embedding, model)
           SELECT m.tenant_id, m.id,
                  ('[' || array_to_string(array_fill(0.5::float8, ARRAY[a.atttypmod]), ',') || ']')::vector,
                  'erase-all-tables'
           FROM memories m
           CROSS JOIN pg_attribute a
           WHERE m.tenant_id = $1
             AND a.attrelid = $2::regclass AND a.attname = 'embedding'
           ON CONFLICT DO NOTHING`,
          [tenantId, table],
        );
      }
    }

    const notSeeded: string[] = [];
    for (const table of tables) {
      const n = await countForTenant(pool, table, T);
      if (n === 0) {
        notSeeded.push(table);
      }
    }
    expect({ notSeeded, allTables: tables }).toEqual({ notSeeded: [], allTables: tables });

    const otherBefore: Record<string, number> = {};
    for (const table of tables) {
      otherBefore[table] = await countForTenant(pool, table, OTHER);
    }

    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const ctxT: Ctx = { tenantId: T };
    let outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    }
    expect(outcome.kind).toBe("executed");

    const stillHasRows: Array<{ table: string; n: number }> = [];
    for (const table of tables) {
      const n = await countForTenant(pool, table, T);
      if (n !== 0) {
        stillHasRows.push({ table, n });
      }
    }
    expect(stillHasRows).toEqual([]);

    const otherAfter: Record<string, number> = {};
    for (const table of tables) {
      otherAfter[table] = await countForTenant(pool, table, OTHER);
    }
    expect(otherAfter).toEqual(otherBefore);
  }, 120_000);
});
