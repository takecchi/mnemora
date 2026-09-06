import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import {
  describeEventStoreConformance,
  describeMemoryStoreConformance,
  describeOutboxStoreConformance,
  describeTenantSettingsStoreConformance,
  describeVectorStoreConformance,
} from "@mnemora/testkit";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  rowToMemoryEvent,
  rowToOutboxJob,
  type MemoryEventRow,
  type OutboxJobRow,
} from "../mapping.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `packages/testkit` の適合テストを、本物の Postgres 実装に対して実行する
 * （roadmap.md 段階2の完了条件: 「testkit の適合テストが postgres 実装に対してすべて通る」）。
 *
 * 擬似物（in-memory）ではなく実際に繋がっていることは、`docs/decisions/0001-orm-drizzle.md`
 * が要求する外部キー・一意制約・partial index が実際に効くかどうかで検証される
 * （in-memory 実装は制約を一切模していないため、この種の不整合はここでしか見つからない）。
 */

describeMemoryStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  },
  prepareRecallId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `);
    return (result.rows[0] as unknown as { id: string }).id;
  },
  listEventsForMemory: async (ctx: Ctx, memoryId: string) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      SELECT * FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
    return result.rows.map((row) => rowToMemoryEvent(row as unknown as MemoryEventRow));
  },
});

describeEventStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresEventStore(db);
  },
  prepareMemoryId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    return memory.id;
  },
});

describeVectorStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresVectorStore(db);
  },
  prepareMemoryId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    return memory.id;
  },
});

describeOutboxStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresOutboxStore(db);
  },
  seedJob: async (ctx: Ctx, input) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.kind},
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${input.availableAt ?? new Date()},
        0,
        now()
      )
      RETURNING *
    `);
    return rowToOutboxJob(result.rows[0] as unknown as OutboxJobRow);
  },
});

describeTenantSettingsStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresTenantSettingsStore(db);
  },
  setDefaultHalfLifeHours: async (ctx: Ctx, hours: number) => {
    const { db } = await getTestClient();
    await db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, default_half_life_hours, taxonomy_mode, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${hours}, 'open', now(), now())
      ON CONFLICT (tenant_id) DO UPDATE SET default_half_life_hours = EXCLUDED.default_half_life_hours
    `);
  },
});

afterAll(async () => {
  await closeTestClient();
});
