import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { Db } from "./client.js";

/**
 * `ts_rank_cd` の normalization 引数。PostgreSQL のドキュメント（textsearch-controls）の
 * ビットの組み合わせのうち `32`（rank を `rank / (rank + 1)` で割って (0, 1) の範囲へ
 * 押し込める。読みやすさのためだけであり比較可能性を作るためではない）と `1`
 * （rank を `1 + ln(文書の長さ)` で割る）を足した `33`。
 *
 * **`1` を足した理由（[Issue #394](../../../docs/decisions/0308-lexical-rank-length-normalization.md)、
 * ADR 0308）**: `32` だけだと `rank` に**内容由来の分解能が無い**——クエリ語が本文中の
 * 同じ相対位置（隣接）で一致する限り、周囲にどれだけ無関係な語が続いても cover density
 * は変わらない。【実測】`"obsidian shards"`（15字）と、同じ2語を含むが292字ある散漫な
 * 英文とで、`32` だけでは `rank` が完全に同点（`0.16666667`）だった。`1` を足すと
 * 文書の長さ（lexeme 数）で割るため、短く焦点の合った文のほうが高い `rank` を持つ
 * ようになる（ADR 0308「測定」節）。
 *
 * **`2`（文書長そのもので割る）ではなく `1`（対数）を選んだ理由**: `2` は長い文書を
 * 線形に近い強さで罰する（実測で短文と292字の文の比が約22倍に開いた）。`1` は対数
 * なので同じ対比較で約3.5倍に収まる——`rank` は依然として「同一クエリ・同一 adapter
 * 内でのタイブレークにしか使わない値」（`LexicalHit.rank` の doc）であり、極端な傾斜を
 * 持ち込む理由が無い。ADR 0308「測定」節に、この2案を含む実測値を残してある。
 *
 * **⚠ これでも割れない同点が残る**——内容が真に同一な行（`content` が一致する行）は
 * 文書長も同一なので今も同点のままである（ADR 0175 の tie-break がその残余を拾う）。
 * `packages/postgres/src/__tests__/lexical-store-index.test.ts` の20,000行 seed（末尾の
 * 整数だけが違うテンプレート文）も、`to_tsvector` が末尾の整数を桁数に関わらず1語彙と
 * 数えるため文書長（lexeme 数）が変わらず、同点のまま残る——これは「直っていない」
 * ことを歯（`lexical-rank-resolution.test.ts`）で明示的に確認しており、退化ではない。
 *
 * `LexicalHit.rank` は「adapter ごとに尺度が違い、同一クエリ・同一 adapter 内でしか
 * 比較できない値」（`@mnemora/core` の `LexicalHit.rank` の doc、ADR 0084 §5）であり、
 * `recall` の段2 スコアには一切入らない——この定数は SQL の `ORDER BY`/`LIMIT`
 * （`opts.limit` による切り詰め）でのみ効く。
 */
const TS_RANK_CD_NORMALIZATION = 32 | 1;

/**
 * `PostgresLexicalStore.search` が実際に打つ `SELECT` を組み立てる。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**
 * `packages/postgres/src/__tests__/lexical-store-index.test.ts` がこの関数の
 * 返り値をそのまま `EXPLAIN` する——テスト側に述語を書き写すと、本体の述語を
 * 直したときに歯だけが古い述語を測り続ける（`memory-store.ts` の
 * `buildRequeueEmbedTargetSelect` と同じ理由・同じ形）。
 *
 * `WHERE` の各条件は `PostgresVectorStore.search`（`vector-store.ts`）と同じ形・同じ
 * 意味に揃えてある（`LexicalFilter` の doc「`VectorFilter` と同じ絞りを、同じ意味で
 * 持つ」）。**`decayFloorAtAfter` は無い**——`LexicalFilter` がそもそも持っていない
 * フィールドである（`interfaces/lexical-store.ts` の doc、ADR 0011）。
 *
 * **🔴 本文側と query 側で、通す関数が違う。**どちらも
 * `migrations/0008_memories_lexical_index.sql` に在り、実測の根拠もそこに書いてある。
 *
 * | 側 | 関数 | 何をするか |
 * |---|---|---|
 * | 本文（索引式） | `mnemora_lexical_normalize` | ASCII の連なりの**前後に空白を入れる** |
 * | クエリ | `mnemora_lexical_query_terms` | **非 ASCII の連なりを空白に落とす** |
 *
 * **非対称なのは意図である。**両方に同じ関数を通すと、日本語の残りが1つの語彙になって
 * `websearch_to_tsquery` の既定（AND）で結ばれ、
 * `'PROJ-1234について前に何か言ってたっけ？'` が**1件も引けない**
 * （ADR 0084 §2.1 の実測。**変異試験で見つけた欠陥である**）。日本語の語は本文側でも
 * 文ごと1トークンになるので、**クエリに残しても真陽性を1件も生まない**——落として失うものが無い。
 *
 * **⚠ 正規表現をこのファイルに書き写さないこと。**片方だけ直してずれると、
 * 式索引が選ばれなくなる（静かに遅くなるだけで結果は変わらないため、
 * テストで検出しない限り気づけない）。
 *
 * **🔴 クエリ語彙は OR で結ばれ、`coverage` を返す**
 * （[ADR 0092](../../../docs/decisions/0092-lexical-or-coverage.md)、
 * `migrations/0009_memories_lexical_or_coverage.sql`）。ADR 0084 はクエリ全体を
 * 1つの `websearch_to_tsquery` に渡していた（既定は AND）——英語の自然文
 * （`what did we say about PROJ-1234`）のような複数語クエリは全語を含む記憶しか
 * 返らなかった。`mnemora_lexical_query_or` はクエリを語ごとに分解し、
 * 語ごとの tsquery を `|`（OR）で結ぶ。`mnemora_lexical_coverage` は
 * 一致した語彙数 ÷ クエリ語彙の総数を返す——これが `LexicalHit.coverage` になる。
 * **`WHERE` の左辺（索引式）は0008 と1バイトも変えていない**——OR で結んだ
 * tsquery も同じ GIN 式索引で引ける（`@@` の右辺が変わるだけで、左辺の式が
 * 変わらなければ式索引は選ばれ続ける）。
 *
 * `websearch_to_tsquery` が `query` から語彙を1つも作れない場合（例:
 * **日本語だけ**・空白だけの `query`）、`mnemora_lexical_query_or` は空の tsquery を
 * 返し、`@@` は常に `false` を返す——`tenant_id`/`status` 等がどれだけ一致しても
 * 0件になる。これは `LexicalStore.search` の契約に反しない
 * （「引けなかった」であって「壊れた」ではない）。
 *
 * **⚠ `plainto_tsquery` に落とさないこと。**隣接を要求しない AND 意味論になるため、
 * 本文に `PROJ-1234 and TASK-5678` の2つが在ると `PROJ-5678` が偽陽性で一致する
 * （migrations/0008 のコメントに実測が在る）。歯: `lexical-store-identifier.test.ts`。
 * `mnemora_lexical_query_tsqueries` が各語を `"..."` で囲んで
 * `websearch_to_tsquery` へ渡すのは、この隣接要求を語ごとに保つためでもある
 * （`migrations/0009_*.sql` の doc 参照）。
 */
export function buildLexicalSearchSelect(
  query: string,
  opts: { limit: number; filter: LexicalFilter },
): SQL {
  const conditions = [sql`tenant_id = ${opts.filter.tenantId}`];
  if (opts.filter.status !== undefined) {
    conditions.push(sql`status = ANY(${sql.param(opts.filter.status)}::text[])`);
  }
  // Issue #608 項目③(b) / ADR 0286: `PostgresVectorStore.search`（vector-store.ts）と
  // 同じ形・同じ意味（`LexicalFilter` の doc「`VectorFilter` と同じ絞りを、同じ意味で持つ」）。
  if (opts.filter.subjectId !== undefined) {
    conditions.push(
      opts.filter.includeSubjectless === true
        ? sql`(subject_id = ${opts.filter.subjectId} OR subject_id IS NULL)`
        : sql`subject_id = ${opts.filter.subjectId}`,
    );
  }
  // Issue #152/#153（ADR 0312）: `PostgresVectorStore.search`（vector-store.ts）と
  // 同じ述語・同じ意味。
  if (opts.filter.attributes !== undefined) {
    conditions.push(sql`attributes @> ${JSON.stringify(opts.filter.attributes)}::jsonb`);
  }
  // Issue #201 PR-B（ADR 0321）: `PostgresVectorStore.search`（vector-store.ts）と
  // 同じ述語・同じ意味（配列の重なり演算子）。
  if (opts.filter.labels !== undefined) {
    conditions.push(sql`tags && ${sql.param(opts.filter.labels)}::text[]`);
  }
  // ADR 0039: 実効時刻は COALESCE(occurred_at, recorded_at)。両端とも包含（>=/<=）
  // ——`PostgresVectorStore.search`（vector-store.ts）の period 絞りと同じ境界。
  if (opts.filter.occurredAfter !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) >= ${opts.filter.occurredAfter}`);
  }
  if (opts.filter.occurredBefore !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) <= ${opts.filter.occurredBefore}`);
  }
  // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`PostgresVectorStore.search`
  // （vector-store.ts）と同じ述語・同じ境界（`valid_until` は狭義の `>`）。
  if (opts.filter.validAt !== undefined) {
    conditions.push(
      sql`(valid_from IS NULL OR valid_from <= ${opts.filter.validAt}) AND (valid_until IS NULL OR valid_until > ${opts.filter.validAt})`,
    );
  }
  // ADR 0056: 空配列は no-op。`length > 0` で番わないと `<> ALL('{}')` という常に真の
  // 条件が出るだけで実害は無いが、EXPLAIN を読みにくくするので出さない
  // （`vector-store.ts` と同じ判断）。
  if (
    opts.filter.excludeProvenanceKinds !== undefined &&
    opts.filter.excludeProvenanceKinds.length > 0
  ) {
    conditions.push(
      sql`provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
    );
  }

  // 🔴 本文側と query 側で、通す関数が違う（migrations/0008_*.sql に実測の根拠が在る）。
  // 本文側は mnemora_lexical_normalize（ASCII の連なりの前後に空白を入れる）、
  // query 側は mnemora_lexical_query_terms（非 ASCII の連なりを空白に落とす。
  // mnemora_lexical_query_or の内部で呼ばれる）。日本語を残すと、その全体が1語彙に
  // なって AND で結ばれ、「PROJ-1234について前に何か言ってたっけ？」が
  // 1件も引けなくなる（ADR 0084 §2.1）。
  //
  // 🔴 ADR 0092: クエリ全体を1つの tsquery にするのではなく、語ごとに OR で結ぶ
  // （mnemora_lexical_query_or）。`WHERE` の左辺（索引式）は 0008 と同じ式のまま——
  // 変えているのは `@@` の右辺（tsquery そのものの組み立て方）だけである。
  const tsQueryOr = sql`mnemora_lexical_query_or(${query})`;
  conditions.push(sql`to_tsvector('simple', mnemora_lexical_normalize(content)) @@ ${tsQueryOr}`);
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT
      id AS memory_id,
      mnemora_lexical_coverage(content, ${query}) AS coverage,
      ts_rank_cd(
        to_tsvector('simple', mnemora_lexical_normalize(content)),
        ${tsQueryOr},
        ${TS_RANK_CD_NORMALIZATION}
      ) AS rank
    FROM memories
    WHERE ${whereClause}
    ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
    LIMIT ${opts.limit}
  `;
}

/**
 * `LexicalStore` の Postgres 実装（`@mnemora/core` の `interfaces/lexical-store.ts`、
 * ADR 0084、[ADR 0092](../../../docs/decisions/0092-lexical-or-coverage.md)、Issue #106）。
 *
 * `MemoryStore` が真実の源であり、この語彙索引（`migrations/0008_memories_lexical_index.sql`
 * の式索引）は `memories.content` の上に張った再構築可能な派生索引に過ぎない
 * （`VectorStore` と同じ非対称。`interfaces/lexical-store.ts` の doc）。
 * **書き込み口を持たない**——索引は `memories` への書き込みに自動で追随するため、
 * 同期の口が要らない（同 doc）。
 *
 * `search` の `ORDER BY` は `coverage DESC, rank DESC, recorded_at DESC, id`
 * （前半2段は ADR 0092。後半2段は
 * [ADR 0175](../../../docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)
 * （Issue #345）——`vector-store.ts` の `search()` が
 * [ADR 0170](../../../docs/decisions/0170-association-search-tiebreak-nondeterminism.md)
 * （Issue #339）で採った「距離 → `recorded_at` DESC → `memory_id`」の3段と同じ形の、
 * 語彙チャンネル版）。`LexicalHit.coverage`/`rank` の doc: どちらも大きいほど上位。
 * `coverage` はそのまま `ScoreBreakdown.lexicalMatch` に入る値であり、`rank` は同値のときの
 * タイブレークにしか使わない。`rank` の尺度は `ts_rank_cd` 固有であり、`VectorHit.distance`
 * （コサイン距離）とは比較できない（ADR 0084 §5）。
 *
 * **なぜ `id` だけでなく `recorded_at` を挟むのか**: `id` は `gen_random_uuid()` が
 * ingest のたびに新しく振るランダムな UUID であり、**同一 DB 内では決定的でも、
 * DB を作り直す（fresh ingest）と大小関係が変わる**——ADR 0170 が Issue #339 で
 * 突き止めた根本原因と同じ構造の欠陥が、語彙チャンネル側にもコードとして存在していた
 * （実害を実測したわけではない。ADR 0175「確かめていないこと」参照）。`recorded_at` は
 * テナント内の ingest 処理順に紐づく値であり、**fresh ingest をまたいでも相対順序が
 * 再現する。**`id` は最終フォールバック——`recorded_at` まで完全一致したときだけ効く。
 * **`recorded_at` が衝突した行どうしの間でだけ、非決定に戻る**（ADR 0170「引き受けた
 * 負債」1番をそのまま引き継ぐ残余。ADR 0175 決めたこと参照）。
 *
 * **⚠ `mnemora_lexical_coverage`/`ts_rank_cd` はどちらも `float8`/`real` を返す。**
 * `pg`（node-postgres）は float4/float8 を JS の `number` として返す型パーサを
 * 標準搭載しているため（`numeric` とは違い文字列に落とさない）、`row.coverage`/
 * `row.rank` は追加の変換なしに `number` として届く——`vector-store.ts` の
 * `row.distance`（同じく `pg` 経由の `float8`）と同じ扱い。
 */
export class PostgresLexicalStore implements LexicalStore {
  constructor(private readonly db: Db) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    const select = buildLexicalSearchSelect(query, opts);
    const result = await this.db.execute(select);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; coverage: number; rank: number };
      return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };
    });
  }
}
