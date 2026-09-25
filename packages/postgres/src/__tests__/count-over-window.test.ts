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

/**
 * ADR 0011 の実測根拠を歯にする。
 *
 * `docs/recall.md` §3 の原案は段1のクエリに `count(*) OVER ()` を含め、これで
 * 「フィルタ条件下で候補が何件あったか」を追加クエリ無しに正確に取れる、としていた。
 * マネージャーが実測したところ、これは PostgreSQL 18.6 + pgvector 0.8.6 の HNSW 上では
 * 成立しない（`docs/decisions/0011-no-window-count-in-ann-stage.md` 参照）。
 * このテストはその事実そのものを検査する——ADR の主張が将来ひとりでに腐らないための歯。
 *
 * ⚠ **このテスト自身が走る環境は、上の実測環境（18.6）とは別。** CI では
 * `.github/workflows/ci.yml` の `postgres` ジョブ（`pgvector/pgvector:pg17` イメージ、
 * PostgreSQL 17系）でこのファイルが走る。18.6 は ADR 0011 が根拠にした元の実測環境で
 * あって、このテストが今実際に走っている環境ではない——両者を混同しないこと。
 *
 * 二つの分岐:
 * - 分岐B（既定のプランナ挙動）: `count(*) OVER ()` を入れると HNSW が捨てられ、
 *   Seq Scan + WindowAgg に落ちる（件数は正しいが索引を殺す）。
 * - 分岐A（`enable_seqscan = off` で索引を強制した場合）: 返る件数は真の総件数ではなく、
 *   ANN の探索設定（`hnsw.ef_search`）に依存する値に固定される。データ件数を変えても
 *   ほぼ変わらないことまで確認し、「データと無関係な値」であることをデータで示す。
 */

const TENANT = "count-over-window-tenant";
const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

/** 1回の INSERT 文で送る行数の目安（数百〜1000行）。 */
const BULK_INSERT_CHUNK_SIZE = 1000;

/**
 * `memories` へ、`buildNewMemoryFixture({ tenantId })` と同じ列値を一括 INSERT する。
 * `PostgresMemoryStore.createMemory`（`../memory-store.ts`）が書く列・既定値
 * （`input.xxx ?? null` の形の既定を含む）と1対1で対応させている——`tags` から
 * `proposed` ラベルを作る副作用（`upsertProposedLabels`）は無い（このテストの
 * `tags` は常に空配列なので、元々そのループは0回だった）。`buildNewMemoryFixture` は
 * 乱数にも現在時刻にも依存しない純関数なので、1回だけ呼んで得た値を全行で使い回せる。
 *
 * `id` だけ `createMemory` と手段が違う（`gen_random_uuid()` ではなく `randomUUID()`
 * で呼び出し側が払い出す）。`memory_embeddings_<space>` 側が同じ id を外部キーとして
 * 参照するため、呼び出し側で id を先に確定させる必要がある。
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
 * `memory_embeddings_<space>` へ、`vectorStore.upsert`（`../vector-store.ts`）が書くのと
 * 同じ列を一括 INSERT する。`ON CONFLICT` は無い——`memories` 同様、常に新規行しか
 * 作らないため不要。
 *
 * `rand` は呼び出し元と共有する `seededRandom(20260905)` のインスタンスそのもの——
 * 1行につき3回、**`ids` と同じ順**で消費する（元の1行ずつのループが
 * `vectorStore.upsert` の直前で呼んでいたのと同じ消費順）。
 *
 * HNSW は逐次挿入で索引を作るため、`memory_embeddings_<space>` への物理的な挿入順が
 * 元の実装と同じであることが重要。`unnest($1::uuid[], $2::vector[])` は2つの配列を
 * 位置で対にして、配列の順序どおりに行を生成する（`memory-store.ts` の
 * `recordUsage`・`contested-with-index.test.ts` の `seedContestedMemories` が
 * 同じ `unnest` の使い方をしている）。チャンクも `ids` の先頭から順に処理するので、
 * 全体として `ids[0], ids[1], ...` の順で INSERT される——この順序保存は、手元の
 * Postgres で `ORDER BY ctid`（新規テーブルでは物理挿入順を反映する）を使って
 * 実測で確認済み（Issue #758）。
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
 * Issue #758: 元は `memoryStore.createMemory` / `vectorStore.upsert` を1行ずつ
 * `count` 回呼ぶ実装だった。実測したところ、`分岐A`（3,000件→9,000件の
 * 2段 seed）の it 全体の時間のうち99.8%以上が seed に費やされ、そのほぼ全部がこの
 * 1行ずつの往復だった（3,000件で約20秒、9,000件で約60秒。クエリ本体
 * `countWithSeqScanDisabled` は数ミリ秒、`resetTestDatabase` も高々百数十ミリ秒）。
 *
 * このテストが検査したいのはプランナ／HNSW 索引の性質（ADR 0011 の主張）であって、
 * `PostgresMemoryStore`/`PostgresVectorStore` の書き込み経路そのものではない——
 * 書き込み経路の契約は `conformance.postgres.test.ts`（`@mnemora/testkit` の
 * `describeMemoryStoreConformance`/`describeVectorStoreConformance` を Postgres 実装に
 * 対して回す）が別途検査している。そのため、ここでは store を経由せず `memories` /
 * `memory_embeddings_<space>` へ直接一括 INSERT する——生成される行・挿入順が
 * 1行ずつの旧実装と同じであることは実測で確認済み（Issue #758）。
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
 * **意図的に `WHERE tenant_id = ...` を付けない。** 実測したところ、`tenant_id` で
 * 絞る形にすると、`memory_embeddings_<space>` の主キー `(tenant_id, memory_id)` が
 * 別の非 Seq Scan 経路（Bitmap Index Scan + 明示的な Sort、常に正確な件数を返す）を
 * 提供してしまい、`enable_seqscan = off` だけでは HNSW を強制できない
 * （プランナはこの経路の方が安いと判断し続ける）。この分岐Aは「HNSW 索引そのものが
 * 持つ、探索設定に依存した打ち切り」という一般的な性質の実測であり、
 * マネージャーの実測（`WHERE` 無しの `t_big` に対する検証）と同じ形にしている。
 * 分岐B（下のテスト）は実際の `PostgresVectorStore.search` と同じ `tenant_id` 付きの
 * クエリで検証しており、そちらが本PRの実装に直結する検査である。
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

    // count(*) OVER () を含めない場合: HNSW 索引を使う。
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

    // count(*) OVER () を含めると、同じ ORDER BY / LIMIT でも Seq Scan + WindowAgg に変わる。
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

    // 索引を捨てた代償として、この分岐でだけ candidate_count は真の総件数と一致する。
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
    // 真のデータ件数と一致しない（打ち切りが起きている）。
    expect(smallCapped).toBeLessThan(smallCount);

    await resetTestDatabase();
    const largeCount = 9000;
    await seed(ctx, largeCount, pool);
    const largeCapped = await countWithSeqScanDisabled(pool);
    expect(largeCapped).toBeLessThan(largeCount);

    // データ件数が 3000 -> 9000 (3倍) に増えても、同じ hnsw.ef_search なら
    // 打ち切り件数はほぼ変わらない——つまりこの数値は「データが何件あったか」を
    // 表していない、という ADR 0011 の核心を検査する。
    // 環境差を吸収するため、「3倍のデータ件数の差ほどは動かない」という緩い比較にする。
    const ratio = largeCapped / smallCapped;
    expect(ratio).toBeLessThan(2);
  }, 120_000);
});
