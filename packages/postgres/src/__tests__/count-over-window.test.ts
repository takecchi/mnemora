import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
  seededRandom,
} from "./test-db.js";

const TENANT = "count-over-window-tenant";
const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

const BULK_INSERT_CHUNK_SIZE = 1000;

/**
 * `memories` へ、`buildNewMemoryFixture({ tenantId })` と同じ列値を一括 INSERT する。
 * `buildNewMemoryFixture` は乱数にも現在時刻にも依存しない純関数なので、1回だけ呼んで得た値を全行で使い回せる。
 * `id` だけ `createMemory` と手段が違い、呼び出し側が `randomUUID()` で払い出す
 * （`memory_embeddings_<space>` 側が同じ id を外部キーとして参照するため、先に確定させる必要がある）。
 */
async function insertMemoriesBulk(pool: Pool, ctx: Ctx, ids: readonly string[]): Promise<void> {
  const fixture = buildNewMemoryFixture({ tenantId: ctx.tenantId });
  const fixedParams = [
    ctx.tenantId,
    fixture.subjectId ?? null,
    fixture.sourceObservationId ?? null,
    fixture.extractorVersion ?? null,
    fixture.content,
    fixture.contentHash,
    fixture.digest,
    fixture.digestSource,
    fixture.provenance.kind,
    JSON.stringify(fixture.provenance),
    fixture.status ?? "active",
    fixture.supersededById ?? null,
    fixture.contestedWithId ?? null,
    fixture.tags,
    fixture.occurredAt ?? null,
    fixture.recordedAt,
    fixture.lastReinforcedAt ?? null,
    fixture.validFrom ?? null,
    fixture.validUntil ?? null,
    fixture.claimKey?.subject ?? null,
    fixture.claimKey?.predicate ?? null,
    fixture.strength,
    fixture.halfLifeHours,
    fixture.decayFloorAt,
    fixture.decayBaseSeq ?? null,
    fixture.decayFloorSeq ?? null,
    fixture.halfLifeRecalls ?? null,
    fixture.embeddingStatus,
    JSON.stringify(fixture.attributes ?? {}),
  ];
  for (let start = 0; start < ids.length; start += BULK_INSERT_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + BULK_INSERT_CHUNK_SIZE);
    await pool.query(
      `
      INSERT INTO memories (
        id, tenant_id, subject_id,
        source_observation_id, extractor_version,
        content, content_hash, digest, digest_source,
        provenance_kind, provenance,
        status, superseded_by_id, contested_with_id,
        tags,
        occurred_at, recorded_at, last_reinforced_at, valid_from, valid_until,
        claim_key_subject, claim_key_predicate,
        strength, half_life_hours, decay_floor_at,
        decay_base_seq, decay_floor_seq, half_life_recalls,
        embedding_status,
        attributes,
        created_at, updated_at
      )
      SELECT
        m.id, $2, $3,
        $4, $5,
        $6, $7, $8, $9,
        $10, $11::jsonb,
        $12, $13, $14,
        $15::text[],
        $16, $17, $18, $19, $20,
        $21, $22,
        $23, $24, $25,
        $26, $27, $28,
        $29,
        $30::jsonb,
        now(), now()
      FROM unnest($1::uuid[]) AS m(id)
      `,
      [chunk, ...fixedParams],
    );
  }
}

/**
 * `memory_embeddings_<space>` へ、`vectorStore.upsert` が書くのと同じ列を一括 INSERT する。
 *
 * `rand` は呼び出し元と共有する `seededRandom(20260905)` のインスタンスそのもので、1行につき3回、`ids` と同じ順で消費する。
 * HNSW は逐次挿入で索引を作るため、物理的な挿入順が重要である。`unnest($1::uuid[], $2::vector[])` は
 * 2つの配列を位置で対にして配列の順序どおりに行を生成し、チャンクも `ids` の先頭から順に処理するので、
 * 全体として `ids[0], ids[1], ...` の順で INSERT される。
 */
async function insertEmbeddingsBulk(
  pool: Pool,
  ctx: Ctx,
  ids: readonly string[],
  rand: () => number,
): Promise<void> {
  for (let start = 0; start < ids.length; start += BULK_INSERT_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + BULK_INSERT_CHUNK_SIZE);
    const vectors = chunk.map(() => `[${rand()},${rand()},${rand()}]`);
    await pool.query(
      `
      INSERT INTO ${TABLE} (tenant_id, memory_id, embedding, model, created_at)
      SELECT $1, t.memory_id, t.embedding, $4, now()
      FROM unnest($2::uuid[], $3::vector[]) AS t(memory_id, embedding)
      `,
      [ctx.tenantId, chunk, vectors, TEST_EMBEDDING_SPACE.model],
    );
  }
}

/**
 * このテストが検査したいのはプランナ／HNSW 索引の性質であって、store の書き込み経路ではない
 * （書き込み経路の契約は `conformance.postgres.test.ts` が別途検査している）。
 * 1行ずつ `createMemory`/`upsert` を呼ぶと seed が実行時間の大半を占めるので、store を経由せず直接一括 INSERT する。
 */
async function seed(ctx: Ctx, count: number, pool: Pool): Promise<void> {
  const rand = seededRandom(20260905);
  const ids: string[] = Array.from({ length: count }, () => randomUUID());
  await insertMemoriesBulk(pool, ctx, ids);
  await insertEmbeddingsBulk(pool, ctx, ids, rand);
  // 統計情報が無いと、プランナが誤った行数見積もりで意図しない索引を選んでしまう。
  await pool.query(`ANALYZE ${TABLE}`);
  await pool.query("ANALYZE memories");
}

/**
 * `enable_seqscan = off` で索引を強制した状態で、ANN の全走査結果を件数だけ数える。
 * 別接続・別トランザクションで実行し、`ROLLBACK` で設定変更を後に残さない。
 *
 * **意図的に `WHERE tenant_id = ...` を付けない。** `tenant_id` で絞ると、`memory_embeddings_<space>` の主キー
 * `(tenant_id, memory_id)` が別の非 Seq Scan 経路（Bitmap Index Scan + 明示的な Sort、常に正確な件数を返す）を
 * 提供してしまい、`enable_seqscan = off` だけでは HNSW を強制できない。
 * 分岐Bは実際の `PostgresVectorStore.search` と同じ `tenant_id` 付きのクエリで検証している。
 */
async function countWithSeqScanDisabled(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await client.query("SET LOCAL hnsw.ef_search = 40");
    const result = await client.query(
      `SELECT count(*) AS candidate_count FROM (
         SELECT memory_id FROM ${TABLE}
         ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       ) s`,
    );
    return Number(result.rows[0].candidate_count);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("count(*) OVER () は HNSW 上で成立しない（ADR 0011）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("分岐B: count(*) OVER () を含めると、既定のプランナは HNSW を捨てて Seq Scan + WindowAgg を選ぶ", async () => {
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };
    const rowCount = 3000;
    await seed(ctx, rowCount, pool);

    const withoutWindow = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT memory_id, embedding <=> '[0.5,0.5,0.5]'::vector AS distance
       FROM ${TABLE}
       WHERE tenant_id = $1
       ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       LIMIT 10`,
      [TENANT],
    );
    const planWithoutWindow = withoutWindow.rows
      .map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"])
      .join("\n");
    expect(planWithoutWindow).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);

    const withWindow = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT memory_id,
              embedding <=> '[0.5,0.5,0.5]'::vector AS distance,
              count(*) OVER () AS candidate_count
       FROM ${TABLE}
       WHERE tenant_id = $1
       ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       LIMIT 10`,
      [TENANT],
    );
    const planWithWindow = withWindow.rows
      .map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"])
      .join("\n");
    expect(planWithWindow).toMatch(/Seq Scan/);
    expect(planWithWindow).toMatch(/WindowAgg/);
    expect(planWithWindow).not.toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);

    const rows = await pool.query(
      `SELECT count(*) OVER () AS candidate_count
       FROM ${TABLE}
       WHERE tenant_id = $1
       ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       LIMIT 10`,
      [TENANT],
    );
    expect(Number(rows.rows[0].candidate_count)).toBe(rowCount);
  }, 120_000);

  it("分岐A: 索引を強制すると、返る件数は真の総件数ではなく ANN の探索設定に固定される", async () => {
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    const smallCount = 3000;
    await seed(ctx, smallCount, pool);
    const smallCapped = await countWithSeqScanDisabled(pool);
    expect(smallCapped).toBeLessThan(smallCount);

    await resetTestDatabase();
    const largeCount = 9000;
    await seed(ctx, largeCount, pool);
    const largeCapped = await countWithSeqScanDisabled(pool);
    expect(largeCapped).toBeLessThan(largeCount);

    // データ件数が 3 倍に増えても打ち切り件数がほぼ変わらないことで、この数値が「データが何件あったか」を表していないことを示す。
    // 環境差を吸収するため、「3倍のデータ件数の差ほどは動かない」という緩い比較にする。
    const ratio = largeCapped / smallCapped;
    expect(ratio).toBeLessThan(2);
  }, 120_000);
});
