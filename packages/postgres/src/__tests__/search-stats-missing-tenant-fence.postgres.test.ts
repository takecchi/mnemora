import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { assertSafeIdentifier, embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `search()`/`searchMany()` が `memories` を引くとき、埋め込みの行のテナントと `memories` の行の
 * テナントが食い違っていれば、その行は返さない（`m.tenant_id = e.tenant_id`）。
 * 統計が無い場面（`memories` を主キーで引く `LATERAL`+`OFFSET 0` の形）では `JOIN ... ON` が無いので、
 * この条件は外側の `WHERE` に足してある。足し忘れると、統計の有無で境界が変わる。
 * 統計がある場面は素の `JOIN ... ON` の中に同じ条件がある。両方を見る。
 *
 * 埋め込みの行は `memories(id)` だけに外部キーを張っている（テナントは見ない）ので、`memory_id` が
 * 別のテナントの記憶を指す行は、表へ直接書けば作れる。`upsert` 経由では作れない（それが通常の口）。
 * ここは、その行があっても境界が保たれることだけを見る。
 *
 * 統計が無い状態は、この歯専用の埋め込み空間を作り、`ANALYZE` を打たないことで作る
 * （`search-many-primary-key-lookup.postgres.test.ts` と同じ作り方）。統計がある状態は、別の
 * 空間で `ANALYZE` を打って作る。
 */

const TENANT_A = `fence-a-${randomUUID()}`;
const TENANT_B = `fence-b-${randomUUID()}`;
const ctxA: Ctx = { tenantId: TENANT_A };
const ctxB: Ctx = { tenantId: TENANT_B };

function newSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "test-issue-1181",
    model: `tenant-fence-${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function seedCrossTenantRow(
  space: EmbeddingSpaceId,
  analyze: boolean,
): Promise<{ vectorStore: PostgresVectorStore }> {
  const { db, pool } = await getTestClient();
  const table = embeddingSpaceTableName(space);
  await registerEmbeddingSpace(pool, space);
  assertSafeIdentifier(table);
  const memoryStore = new PostgresMemoryStore(db);
  const memoryOfB = await memoryStore.createMemory(
    ctxB,
    buildNewMemoryFixture({ tenantId: TENANT_B, contentHash: `fence-${randomUUID()}` }),
  );
  // テナント A の行（`tenant_id = A`）が、テナント B の記憶を指している。
  await pool.query(
    `INSERT INTO ${table} (tenant_id, memory_id, embedding, model) VALUES ($1, $2, '[1,2,3]', 'm')`,
    [TENANT_A, memoryOfB.id],
  );
  if (analyze) {
    await pool.query(`ANALYZE ${table}`);
    await pool.query("ANALYZE memories");
  }
  // 統計が無い側は、⚠ `ANALYZE` を打たない。
  return { vectorStore: new PostgresVectorStore(db) };
}

describe("別テナントの記憶を指す埋め込みの行は、統計の有無によらず返さない", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  for (const [label, analyze] of [
    ["統計が無い", false],
    ["統計がある", true],
  ] as const) {
    it(`${label}: searchMany は、テナント A で引いても、テナント B の記憶を返さない`, async () => {
      const space = newSpace(`many-${analyze}`);
      const { vectorStore } = await seedCrossTenantRow(space, analyze);

      const result = await vectorStore.searchMany(ctxA, space, [{ key: "a", vector: [1, 2, 3] }], {
        limit: 10,
        filter: { tenantId: TENANT_A },
      });

      expect(result.get("a")).toEqual([]);
    });

    it(`${label}: search は、テナント A で引いても、テナント B の記憶を返さない`, async () => {
      const space = newSpace(`one-${analyze}`);
      const { vectorStore } = await seedCrossTenantRow(space, analyze);

      const result = await vectorStore.search(ctxA, space, [1, 2, 3], {
        limit: 10,
        filter: { tenantId: TENANT_A },
      });

      expect(result).toEqual([]);
    });
  }
});
