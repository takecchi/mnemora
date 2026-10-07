import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { dropTempDatabase } from "./temp-database.js";
import { requireDatabaseUrl } from "./test-db.js";

const DATABASE = "mnemora_recall_returned_memories_migration";
const TENANT = "tenant-recall-migration";
const ctx: Ctx = { tenantId: TENANT };
const BEFORE_FILE = "0013_recall_returned_memories_jsonb.sql";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

const scratch = mkdtempSync(join(tmpdir(), "mnemora-recall-migration-"));
let admin: Pool;
let pool: Pool;
const recallIds: Record<"two" | "one" | "none", string> = { two: "", one: "", none: "" };

async function insertOldRecall(returnedMemoryIds: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO recalls (tenant_id, query, usage, index_band, returned_memory_ids)
     VALUES ($1, '{}', '{}', '{}', $2::uuid[]) RETURNING id`,
    [TENANT, returnedMemoryIds],
  );
  return rows[0]!.id;
}

describe("migration 0013: 既存の recalls 行は、内訳を持たない行として returned_memories へ移る", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    await dropTempDatabase(admin, DATABASE);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    pool = new Pool({ connectionString: connectionStringFor(DATABASE), max: 2 });

    const beforeDir = join(scratch, "before");
    mkdirSync(beforeDir);
    for (const file of listMigrationFiles(DEFAULT_MIGRATIONS_DIR)) {
      if (file >= BEFORE_FILE) break;
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);

    recallIds.two = await insertOldRecall([ID_B, ID_A]);
    recallIds.one = await insertOldRecall([ID_C]);
    recallIds.none = await insertOldRecall([]);

    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    await dropTempDatabase(admin, DATABASE);
    await admin.end();
    rmSync(scratch, { recursive: true, force: true });
  });

  async function returnedMemoriesOf(id: string): Promise<unknown> {
    const { rows } = await pool.query<{ returned_memories: unknown }>(
      "SELECT returned_memories FROM recalls WHERE id = $1",
      [id],
    );
    return rows[0]!.returned_memories;
  }

  it("移る前に記録された memoryId は、並びを保って { memoryId } だけの配列になり、breakdownCaptured は false", async () => {
    expect(await returnedMemoriesOf(recallIds.two)).toEqual({
      breakdownCaptured: false,
      memories: [{ memoryId: ID_B }, { memoryId: ID_A }],
    });
    expect(await returnedMemoriesOf(recallIds.one)).toEqual({
      breakdownCaptured: false,
      memories: [{ memoryId: ID_C }],
    });
  });

  it("0件を返していた行は memories が空配列（null にならない）で、breakdownCaptured は false のまま", async () => {
    expect(await returnedMemoriesOf(recallIds.none)).toEqual({
      breakdownCaptured: false,
      memories: [],
    });
  });

  it("getRecall は移した行を breakdownCaptured: false で読み戻す", async () => {
    const client = createPostgresClient(connectionStringFor(DATABASE));
    try {
      const store = new PostgresMemoryStore(client.db);
      const record = await store.getRecall(ctx, recallIds.two);
      expect(record?.returnedMemories).toEqual({
        breakdownCaptured: false,
        memories: [{ memoryId: ID_B }, { memoryId: ID_A }],
      });
      expect((await store.getRecall(ctx, recallIds.none))?.returnedMemories).toEqual({
        breakdownCaptured: false,
        memories: [],
      });
    } finally {
      await closePostgresClient(client);
    }
  });

  it("旧い列 returned_memory_ids は無くなり、returned_memories は NOT NULL で既定値を持たない", async () => {
    const { rows } = await pool.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'recalls'
         AND column_name IN ('returned_memory_ids', 'returned_memories')`,
    );
    expect(rows).toEqual([
      { column_name: "returned_memories", is_nullable: "NO", column_default: null },
    ]);
  });

  it("移ったあとに書く行は、内訳を持つ行として breakdownCaptured: true で読み戻る", async () => {
    const client = createPostgresClient(connectionStringFor(DATABASE));
    try {
      const store = new PostgresMemoryStore(client.db);
      const id = await store.createRecall(ctx, {
        tenantId: TENANT,
        query: {},
        omitted: [],
        usage: {} as never,
        indexBand: {} as never,
        explain: { stages: [] },
        returnedMemories: [],
      });
      expect((await store.getRecall(ctx, id))?.returnedMemories).toEqual({
        breakdownCaptured: true,
        memories: [],
      });
    } finally {
      await closePostgresClient(client);
    }
  });
});
