import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import { assertWellFormedCtx, assertWellFormedFilter } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertNoNul, assertNoNulInScopeFilter } from "./input-check.js";
import { omittingParams } from "./omit-params.js";
import { capLexicalQueryWords } from "./lexical-query-cap.js";
import { toPgTimestampClamped } from "./mapping.js";

/**
 * `ts_rank_cd` の normalization 引数。`32`（rank を (0, 1) へ押し込める）と `1`（rank を `1 + ln(文書の長さ)` で割る）の和。
 *
 * `1` を足す（ADR 0308）: `32` だけだと、クエリ語が隣接して一致する限り、周囲に無関係な語が続いても cover density が
 * 変わらず、`rank` に内容由来の分解能が無い。`2`（文書長そのもので割る）にしない: 長い文書を線形に近い強さで罰し、
 * タイブレークにしか使わない `rank` に極端な傾斜を持ち込むため。内容が真に同一な行は文書長も同一なので、同点は残る
 * （ADR 0175 の tie-break が拾う）。
 *
 * `LexicalHit.rank` は `recall` の段2 スコアに入らず、この定数は `ORDER BY`/`LIMIT` でのみ効く。
 */
const TS_RANK_CD_NORMALIZATION = 32 | 1;

/**
 * `PostgresLexicalStore.search` が実際に打つ `SELECT` を組み立てる。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**テスト側に述語を書き写すと、本体の述語を直したとき
 * に歯だけが古い述語を測り続ける。
 *
 * `WHERE` の各条件は `PostgresVectorStore.search` と同じ形・同じ意味に揃える。`decayFloorAtAfter` は
 * `LexicalFilter` がそもそも持たない（ADR 0011）。
 *
 * **本文側と query 側で、通す関数が違う（ADR 0084）。**
 *
 * | 側 | 関数 | 何をするか |
 * |---|---|---|
 * | 本文（索引式） | `mnemora_lexical_tsvector`（`migrations/0025_*.sql`） | `to_tsvector('simple', mnemora_lexical_normalize(content))`。tsvector が1MBを超える本文だけ先頭150,000文字で作り直す |
 * | クエリ | `mnemora_lexical_query_terms`（`migrations/0008_*.sql`） | **非 ASCII の連なりを空白に落とす** |
 *
 * **非対称なのは意図である。**両方に同じ関数を通すと、日本語の残りが1つの語彙になって `websearch_to_tsquery` の
 * 既定（AND）で結ばれ、`'PROJ-1234について前に何か言ってたっけ？'` が1件も引けない。日本語の語は本文側でも
 * 文ごと1トークンなので、クエリに残しても真陽性を生まない。
 *
 * **正規表現をこのファイルに書き写さないこと。**片方だけ直してずれると、式索引が選ばれなくなる（結果は変わらず、
 * 静かに遅くなるだけ）。
 *
 * クエリ語彙は OR で結ばれ、`coverage` を返す（ADR 0092）。`mnemora_lexical_query_or` が語ごとの tsquery を `|` で
 * 結び、`mnemora_lexical_coverage` が一致した語彙数 ÷ クエリ語彙の総数を返す（`LexicalHit.coverage`）。
 * `WHERE` の左辺（索引式）が変わらなければ、OR で結んだ tsquery も同じ GIN 式索引で引ける。
 *
 * `websearch_to_tsquery` が `query` から語彙を1つも作れない場合（日本語だけ・空白だけ）は空の tsquery になり、
 * `@@` は常に `false`（0件）。`LexicalStore.search` の契約に反しない。
 *
 * **`plainto_tsquery` に落とさないこと。**隣接を要求しない AND 意味論になり、本文に `PROJ-1234 and TASK-5678` が
 * 在ると `PROJ-5678` が偽陽性で一致する。`mnemora_lexical_query_tsqueries` が各語を `"..."` で囲むのも、
 * この隣接要求を語ごとに保つため。
 *
 * **`coverage` は、行ごとにではなく1回だけ分解した語配列を使い回す。**`mnemora_lexical_coverage(content, query)` を
 * 行ごとに呼ぶと、`query` の分解（正規表現・`websearch_to_tsquery`・`DISTINCT`）を候補行の数だけやり直す
 * （相関サブクエリの `FROM` に置いた集合を返す式は、行に依存しない部分でも行ごとに再実行されるため）。
 * `WITH qc AS MATERIALIZED (...)` で1回だけ計算し、`FROM memories, qc` で全行に配る。`coverage` の式は
 * `mnemora_lexical_coverage` の本体と同じで、`query` の分解結果を `qc.terms` から受け取るだけが違う。
 *
 * **`WHERE`/`ORDER BY` 側の `mnemora_lexical_query_or(query)`（`tsQueryOr`）は `qc` に寄せない。**
 * 名前を付けない一回限りの実行では、PostgreSQL は束縛パラメータの実際の値で計画を立てる（custom plan）ので、
 * この式は IMMUTABLE な定数式として折り畳まれ、`idx_memories_lexical`（GIN）の選択・行数見積りに具体的な語彙の頻度統計が
 * 使える。`qc` の列参照にすると右辺が「他リレーションの列」になり、プランナは具体的な tsquery を見られず、
 * 既定の選択率しか使えずに `Seq Scan on memories` を選びうる。索引選択に効く式は触らず、効かない式（`coverage` の中身）だけを触る。
 *
 * `query` は `capLexicalQueryWords`（`./lexical-query-cap.ts`）を通してから使う。上限に触れたときも新しい例外には
 * しない（呼び出し側を壊さない）。
 *
 * `opts.ctxTenantId` を渡すと、`filter.tenantId` に加えてそのテナントでも絞る（AND）。`PostgresLexicalStore.search` は
 * 常に `ctx.tenantId` を渡す（隔離の境界は `ctx.tenantId`。ADR 0007）。食い違えば0件で、例外は投げない。
 * 省略すれば `filter.tenantId` だけで絞る。
 */
export function buildLexicalSearchSelect(
  query: string,
  opts: { limit: number; filter: LexicalFilter; ctxTenantId?: string | undefined },
): SQL {
  const cappedQuery = capLexicalQueryWords(query);
  const conditions: SQL[] = [];
  if (false && opts.ctxTenantId !== undefined) {
    conditions.push(sql`tenant_id = ${opts.ctxTenantId}`);
  }
  if (opts.filter.status !== undefined) {
    conditions.push(sql`status = ANY(${sql.param(opts.filter.status)}::text[])`);
  }
  if (opts.filter.subjectId !== undefined) {
    conditions.push(
      opts.filter.includeSubjectless === true
        ? sql`(subject_id = ${opts.filter.subjectId} OR subject_id IS NULL)`
        : sql`subject_id = ${opts.filter.subjectId}`,
    );
  }
  if (opts.filter.attributes !== undefined) {
    conditions.push(sql`attributes @> ${JSON.stringify(opts.filter.attributes)}::jsonb`);
  }
  if (opts.filter.labels !== undefined) {
    conditions.push(sql`tags && ${sql.param(opts.filter.labels)}::text[]`);
  }
  // 実効時刻は COALESCE(occurred_at, recorded_at)。両端とも包含（>=/<=）（ADR 0039）。
  if (opts.filter.occurredAfter !== undefined) {
    conditions.push(
      sql`COALESCE(occurred_at, recorded_at) >= ${toPgTimestampClamped(opts.filter.occurredAfter)}`,
    );
  }
  if (opts.filter.occurredBefore !== undefined) {
    conditions.push(
      sql`COALESCE(occurred_at, recorded_at) <= ${toPgTimestampClamped(opts.filter.occurredBefore)}`,
    );
  }
  // `valid_until` は狭義の `>`。
  if (opts.filter.validAt !== undefined) {
    conditions.push(
      sql`(valid_from IS NULL OR valid_from <= ${toPgTimestampClamped(opts.filter.validAt)}) AND (valid_until IS NULL OR valid_until > ${toPgTimestampClamped(opts.filter.validAt)})`,
    );
  }
  // 空配列は no-op。`length > 0` で番わないと、常に真の `<> ALL('{}')` が出て EXPLAIN を読みにくくする（ADR 0056）。
  if (
    opts.filter.excludeProvenanceKinds !== undefined &&
    opts.filter.excludeProvenanceKinds.length > 0
  ) {
    conditions.push(
      sql`provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
    );
  }

  // 索引式（本文側）と同じ式のまま、`@@` の右辺（tsquery の組み立て）だけを OR にしている。ここ（WHERE・rank）を
  // `qc` に寄せないのは、`query` の具体的な値をプランナから見える形に保つため（`buildLexicalSearchSelect` の doc 参照）。
  const tsQueryOr = sql`mnemora_lexical_query_or(${cappedQuery})`;
  conditions.push(sql`mnemora_lexical_tsvector(content) @@ ${tsQueryOr}`);
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    WITH qc AS MATERIALIZED (
      -- Issue #878: mnemora_lexical_query_tsqueries(query) を1回だけ計算し、
      -- coverage の計算（下、候補行ごとに評価される）で使い回す。
      SELECT mnemora_lexical_query_tsqueries(${cappedQuery}) AS terms
    )
    SELECT
      id AS memory_id,
      -- migrations/0009_memories_lexical_or_coverage.sql の mnemora_lexical_coverage
      -- と同じ式（一致した語彙数 / クエリ語彙の総数）。query を渡して呼ぶ代わりに、
      -- 上の qc で1回だけ計算した terms を受け取る形にしてある。式そのものは
      -- （mnemora_lexical_tsvector への差し替え以外）1バイトも変えていない
      -- （このファイル冒頭の buildLexicalSearchSelect doc 参照）。
      (
        SELECT count(*) FILTER (
                 WHERE mnemora_lexical_tsvector(content) @@ tq
               )::float8 / NULLIF(count(*), 0)
        FROM unnest(qc.terms) AS tq
      ) AS coverage,
      ts_rank_cd(
        mnemora_lexical_tsvector(content),
        ${tsQueryOr},
        ${TS_RANK_CD_NORMALIZATION}
      ) AS rank
    FROM memories, qc
    WHERE ${whereClause}
    ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
    LIMIT ${opts.limit}
  `;
}

/**
 * `LexicalStore` の Postgres 実装（ADR 0084、ADR 0092）。
 *
 * `MemoryStore` が真実の源で、語彙索引（`memories.content` 上の式索引）は再構築可能な派生索引に過ぎない。
 * **書き込み口を持たない**（索引は `memories` への書き込みに自動で追随する）。
 *
 * `search` の `ORDER BY` は `coverage DESC, rank DESC, recorded_at DESC, id`（ADR 0092、ADR 0175）。
 * `coverage` はそのまま `ScoreBreakdown.lexicalMatch` に入る値で、`rank` は同値のときのタイブレークにしか使わない。
 * `rank` の尺度は `ts_rank_cd` 固有で、`VectorHit.distance` とは比較できない（ADR 0084）。
 *
 * `id` だけでなく `recorded_at` を挟む理由: `id` は `gen_random_uuid()` のランダムな UUID で、DB を作り直す
 * （fresh ingest）と大小関係が変わる。`recorded_at` は ingest の処理順に紐づき、fresh ingest をまたいでも相対順序が
 * 再現する。`id` は最終フォールバックで、`recorded_at` が衝突した行どうしの間でだけ非決定に戻る。
 *
 * **`coverage` の尺度**: クエリを語に分け（重複は1語）、本文の tsvector に当たった語の数 ÷ 語の総数。1/n 刻みで、
 * 日本語（非 ASCII）の語は引かない。testkit の `InMemoryLexicalStore` と同じ式で、`PostgresTrigramLexicalStore` の
 * 日本語側（閾値で 0/1 の二値）とは違う（ADR 0553）。
 */
export class PostgresLexicalStore implements LexicalStore {
  constructor(private readonly db: Db) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    assertNoNul("PostgresLexicalStore.search", "query", query);
    assertNoNulInScopeFilter("PostgresLexicalStore.search", opts.filter, "opts.filter");
    const select = buildLexicalSearchSelect(query, { ...opts, ctxTenantId: ctx.tenantId });
    // 例外の message（`cause` の連鎖を含む）から、SQL に付けた値（params）を落とす（ADR 0505）。
    const result = await omittingParams(() => this.db.execute(select));
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; coverage: number; rank: number };
      return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };
    });
  }
}
