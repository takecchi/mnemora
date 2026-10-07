import { afterAll, describe, expect, it } from "vitest";
import {
  embeddingSpaceMemoryIdIndexName,
  embeddingSpaceTableName,
} from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * ⚠ migration の本数を焼き込まない。「0027」というファイル名にも「migration が何本目か」にも触れず、`pg_indexes` で索引そのものの存在を見る。
 * `getTestClient()` が起動時に `runMigrations` を実行済みなので、この歯が走る時点で対象の索引は既に作られている。
 */

afterAll(async () => {
  await closeTestClient();
});

async function indexExists(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  table: string,
  indexName: string,
): Promise<boolean> {
  const result = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
    [table, indexName],
  );
  return result.rows.length === 1;
}

describe("migrations/0027_erase_tenant_fk_indexes.sql が作る索引（Issue #1207 / ADR 0383）", () => {
  it("単一列索引8本が実在する", async () => {
    const { pool } = await getTestClient();
    const expected: Array<[table: string, index: string]> = [
      ["memory_events", "idx_memory_events_memory_id"],
      ["recall_usages", "idx_recall_usages_memory_id"],
      ["recall_usages", "idx_recall_usages_recall_id"],
      ["memory_labels", "idx_memory_labels_memory_id"],
      ["memories", "idx_memories_source_observation_id"],
      ["memories", "idx_memories_superseded_by_id"],
      ["memory_relations", "idx_memory_relations_from_memory_id"],
      ["memory_relations", "idx_memory_relations_to_memory_id"],
    ];
    for (const [table, index] of expected) {
      expect({ table, index, exists: await indexExists(pool, table, index) }).toEqual({
        table,
        index,
        exists: true,
      });
    }
  });

  it("memories.contested_with_id には新しい索引を足さない——既存の idx_memories_contested_with（部分索引）が実在することだけを確認する", async () => {
    const { pool } = await getTestClient();
    expect(await indexExists(pool, "memories", "idx_memories_contested_with")).toBe(true);
  });

  it("既存の埋め込み空間テーブルに (memory_id) 索引が実在する（7本目、registerEmbeddingSpace 経由）", async () => {
    const { pool } = await getTestClient();
    // `registerEmbeddingSpace` 自身がこの索引を作る経路（migration の DO ブロックとは別経路）。
    await registerEmbeddingSpace(pool, TEST_EMBEDDING_SPACE);
    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const indexName = embeddingSpaceMemoryIdIndexName(TEST_EMBEDDING_SPACE);
    expect(await indexExists(pool, table, indexName)).toBe(true);
  });
});
