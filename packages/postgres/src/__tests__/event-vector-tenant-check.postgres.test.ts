import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** 適合テストにも同じ契約の it があるが、store の口からは「行が書かれていない」ことまでは見えない。行の有無（生 SQL で数える）と `eraseTenant` はこのファイルだけが見る。 */

afterAll(async () => {
  await closeTestClient();
});

const TA = "tenant-check-a";
const TB = "tenant-check-b";
const ctxA: Ctx = { tenantId: TA };
const ctxB: Ctx = { tenantId: TB };
const SPACE_TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

function newEvent(
  memoryId: string | null,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent {
  return { memoryId, kind, actor: { type: "system" }, meta: {} } as NewMemoryEvent;
}

async function setup() {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const a = await memoryStore.createMemory(ctxA, buildNewMemoryFixture({ tenantId: TA }));
  const b = await memoryStore.createMemory(ctxB, buildNewMemoryFixture({ tenantId: TB }));
  const deps = {
    memoryStore,
    vectorStore,
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  };
  return { pool, eventStore, vectorStore, deps, a, b };
}

async function countRows(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  table: string,
  tenantId: string,
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(r.rows[0]!.n);
}

describe("PostgresEventStore.append・PostgresVectorStore.upsert のテナント検査（ADR 0436）", () => {
  it("別テナントの記憶への append・upsert は行を書かずに投げ、eraseTenant は止められない", async () => {
    const { pool, eventStore, vectorStore, deps, a } = await setup();
    await expect(eventStore.append(ctxB, newEvent(a.id))).rejects.toThrow(
      /PostgresEventStore: memory not found for tenant/,
    );
    await expect(vectorStore.upsert(ctxB, TEST_EMBEDDING_SPACE, a.id, [1, 0, 0])).rejects.toThrow(
      /PostgresVectorStore: memory not found for tenant/,
    );
    expect(await countRows(pool, "memory_events", TB)).toBe(0);
    expect(await countRows(pool, SPACE_TABLE, TB)).toBe(0);

    const outcome = await eraseTenant(ctxA, deps, { confirmTenantId: TA, limit: 100_000 });
    expect(outcome.kind).toBe("executed");
    expect(await countRows(pool, "memories", TA)).toBe(0);
  });

  it("実在しない uuid・uuid でない id は、別テナントと同じ扱い（行を書かず、同じ message で投げる）", async () => {
    const { pool, eventStore, vectorStore } = await setup();
    for (const missing of [MISSING_UUID, "does-not-exist", ""]) {
      await expect(eventStore.append(ctxA, newEvent(missing))).rejects.toThrow(
        /memory not found for tenant/,
      );
      await expect(
        vectorStore.upsert(ctxA, TEST_EMBEDDING_SPACE, missing, [1, 0, 0]),
      ).rejects.toThrow(/memory not found for tenant/);
    }
    expect(await countRows(pool, "memory_events", TA)).toBe(0);
    expect(await countRows(pool, SPACE_TABLE, TA)).toBe(0);
  });

  it("自テナントの正しい記憶への append・upsert は通り、upsert の上書きも通る（断りすぎていない）", async () => {
    const { pool, eventStore, vectorStore, deps, a, b } = await setup();
    const appended = await eventStore.append(ctxA, newEvent(a.id));
    expect(appended.memoryId).toBe(a.id);
    expect(appended.tenantId).toBe(TA);
    await vectorStore.upsert(ctxA, TEST_EMBEDDING_SPACE, a.id, [1, 0, 0]);
    await vectorStore.upsert(ctxA, TEST_EMBEDDING_SPACE, a.id, [0, 1, 0]); // ON CONFLICT の上書き
    await vectorStore.upsert(ctxB, TEST_EMBEDDING_SPACE, b.id, [0, 0, 1]);
    expect(await countRows(pool, "memory_events", TA)).toBe(1);
    expect(await countRows(pool, SPACE_TABLE, TA)).toBe(1);
    const got = await vectorStore.getVectors(ctxA, TEST_EMBEDDING_SPACE, [a.id]);
    expect([...got.values()].map((v) => v.vector)).toEqual([[0, 1, 0]]);

    const upper = await eventStore.append(ctxA, newEvent(a.id.toUpperCase()));
    expect(upper.memoryId).toBe(a.id);

    const purged = await eventStore.append(ctxA, newEvent(null, "events_purged"));
    expect(purged.memoryId).toBeNull();

    const outcome = await eraseTenant(ctxA, deps, { confirmTenantId: TA, limit: 100_000 });
    expect(outcome.kind).toBe("executed");
    expect(await countRows(pool, "memories", TB)).toBe(1);
  });
});

/** 既に書かれた食い違う行を見つける検出 SQL（読み取りだけ）。`${table}` は `memory_embeddings_<space>` の表名。 */
const DETECT_EVENTS_SQL = `
SELECT e.id, e.tenant_id, e.memory_id, m.tenant_id AS memory_tenant_id
FROM memory_events e
JOIN memories m ON m.id = e.memory_id
WHERE e.tenant_id <> m.tenant_id`;
const detectEmbeddingsSql = (table: string): string => `
SELECT e.tenant_id, e.memory_id, m.tenant_id AS memory_tenant_id
FROM ${table} e
JOIN memories m ON m.id = e.memory_id
WHERE e.tenant_id <> m.tenant_id`;

describe("PostgresEventStore.append は event.memoryId の大文字小文字を区別しない（ADR 0475）", () => {
  it("大文字の自テナントの記憶は通り（小文字で読み戻る）、大文字の別テナントは断る", async () => {
    const { pool, eventStore, a, b } = await setup();
    const upper = await eventStore.append(ctxA, newEvent(a.id.toUpperCase()));
    expect(upper.memoryId).toBe(a.id);
    await expect(eventStore.append(ctxA, newEvent(b.id.toUpperCase()))).rejects.toThrow(
      /PostgresEventStore: memory not found for tenant/,
    );
    expect(await countRows(pool, "memory_events", TA)).toBe(1);
  });
});

describe("ADR 0436 の検出 SQL（既に書かれた、テナントの食い違う行を見つける）", () => {
  it("食い違いが無ければ0行、生 SQL で1行仕込めば各表で1行を数える", async () => {
    const { pool, eventStore, vectorStore, a, b } = await setup();
    await eventStore.append(ctxA, newEvent(a.id));
    await vectorStore.upsert(ctxA, TEST_EMBEDDING_SPACE, a.id, [1, 0, 0]);
    await vectorStore.upsert(ctxB, TEST_EMBEDDING_SPACE, b.id, [0, 0, 1]);
    expect((await pool.query(DETECT_EVENTS_SQL)).rowCount).toBe(0);
    expect((await pool.query(detectEmbeddingsSql(SPACE_TABLE))).rowCount).toBe(0);

    // 食い違う行は生 SQL で作る（外部キーはテナントを見ないので、スキーマとしては作れる）。
    await pool.query(
      `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
       VALUES (gen_random_uuid(), $1, $2, 'updated', now(), '{"type":"system"}'::jsonb, '{}'::jsonb)`,
      [TB, a.id],
    );
    await pool.query(
      `INSERT INTO ${SPACE_TABLE} (tenant_id, memory_id, embedding, model)
       SELECT $1, $2, embedding, model FROM ${SPACE_TABLE} WHERE tenant_id = $3 LIMIT 1`,
      [TB, a.id, TA],
    );
    const events = await pool.query(DETECT_EVENTS_SQL);
    expect(events.rows.map((r) => [r.tenant_id, r.memory_tenant_id])).toEqual([[TB, TA]]);
    const embeddings = await pool.query(detectEmbeddingsSql(SPACE_TABLE));
    expect(embeddings.rows.map((r) => [r.tenant_id, r.memory_tenant_id])).toEqual([[TB, TA]]);
  });
});
