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
import { registerEmbeddingSpace } from "../vector-space.js";
import { requireDatabaseUrl, TEST_EMBEDDING_SPACE } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";
import {
  buildEraseTenantTestRuntime,
  seedAllTablesForTenant,
} from "./erase-tenant-test-helpers.js";

/**
 * ADR 0430 決定1: 同じテナントへの `eraseTenant` の同時呼び出しは、port ごとのトランザクションの
 * 先頭で取るテナント単位の advisory lock で直列になる。
 *
 * 直す前は、相手が同じ行を先に消すと `drainById` が0行を返し、「予算未満なら表は空」と
 * 読んで `memories` へ進み、行が残っているのに 23503（外部キー違反）で reject した。
 * 2つの別々の pool（別々の接続）から `limit: 3` で同時に呼び、両方が全部0を返すまで繰り返す。
 *
 * 自分専用の DB で走らせる（`erase-tenant-concurrent-other-tenant.postgres.test.ts` と同じ形）。
 */

const TEST_DATABASE = "mnemora_erase_tenant_same_tenant_test";
const TRIALS = 6;

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

let clientA: PostgresClient | undefined;
let clientB: PostgresClient | undefined;

beforeAll(async () => {
  await dropTempDatabase(admin(), TEST_DATABASE);
  await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
  clientA = createPostgresClient(connectionStringFor(TEST_DATABASE));
  clientB = createPostgresClient(connectionStringFor(TEST_DATABASE));
  await runMigrations(clientA.pool);
  await registerEmbeddingSpace(clientA.pool, TEST_EMBEDDING_SPACE);
}, 60_000);

afterAll(async () => {
  if (clientA) await closePostgresClient(clientA);
  if (clientB) await closePostgresClient(clientB);
  await dropTempDatabase(admin(), TEST_DATABASE);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 60_000);

function depsFor(c: PostgresClient) {
  return {
    memoryStore: new PostgresMemoryStore(c.db),
    vectorStore: new PostgresVectorStore(c.db),
    outboxStore: new PostgresOutboxStore(c.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(c.db),
  };
}

describe("同じテナントへの eraseTenant の同時呼び出しは reject しない（ADR 0430）", () => {
  it("limit: 3 で2つの pool から同時に呼び、全部0になるまで繰り返しても reject が0回", async () => {
    const S = "erase-same-tenant";
    const runtime = buildEraseTenantTestRuntime(clientA!.db, S);
    const settings = new PostgresTenantSettingsStore(clientA!.db);
    const depsA = depsFor(clientA!);
    const depsB = depsFor(clientB!);
    const rejections: unknown[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const T = `${S}-t${trial}`;
      await seedAllTablesForTenant(runtime, settings, T, S);
      const ctx: Ctx = { tenantId: T, subjectId: `${S}-subject` };
      const call = async (deps: ReturnType<typeof depsFor>) => {
        try {
          const r = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 3 });
          return r.kind === "executed" ? Object.values(r.deleted).reduce((a, b) => a + b, 0) : -1;
        } catch (err) {
          rejections.push(err);
          return -2;
        }
      };
      for (let round = 0; round < 200; round++) {
        const [a, b] = await Promise.all([call(depsA), call(depsB)]);
        if (a === 0 && b === 0) break;
      }
    }
    expect(
      rejections.map((e) => (e instanceof Error ? e.message.slice(0, 200) : String(e))),
    ).toEqual([]);
  }, 300_000);
});
