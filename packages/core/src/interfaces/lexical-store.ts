import type { Attributes } from "../attributes.js";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { ProvenanceKind } from "../provenance.js";

/**
 * `search` の `filter`。`VectorFilter` と**同じ絞りを、同じ意味で**持つ（ADR 0084）。
 *
 * **⚠ `VectorFilter` を再利用せず、別の型として書いている。** `VectorFilter` は「ベクタ索引に降ろせる絞り」という
 * 文脈を持っており、語彙索引の adapter がそれを実装するのは読み手を惑わせる。
 *
 * **`decayFloorAtAfter` は持たない。** `VectorFilter` はこれを持つが、読み取りフィルタとして使われていない（ADR 0011）。
 *
 * **各フィールドは adapter が実際に適用しなければならない**（`VectorFilter` と同じ契約。ADR 0034）。
 */
export interface LexicalFilter {
  /**
   * **`ctx.tenantId` と AND で掛ける。** 隔離の境界は `ctx.tenantId` である（ADR 0007）。adapter は、この欄と
   * `ctx.tenantId` の**両方**に一致する行だけを返す。2つが食い違えば0件を返し、例外は投げない。`VectorFilter.tenantId` と同じ。
   */
  tenantId: string;
  /** `VectorFilter.status` と同じ意味（未指定なら絞らない。空配列なら1件も通らない）。 */
  status?: MemoryStatus[] | undefined;
  /** 指定すると、この `subjectId` の行だけを返す（`includeSubjectless` で、主題の無い行も含められる）。未指定なら主題で絞らない。 */
  subjectId?: string | undefined;
  /**
   * `VectorFilter.includeSubjectless` と同じ欄・同じ意味（ADR 0286）。`subjectId` が渡されているときだけ効き、
   * 主題の無い行も通す。追加のみの欄であり、知らない adapter は無視してよい。
   */
  includeSubjectless?: boolean | undefined;
  /** この中の `provenance.kind` を持つ行を除く。未指定・空配列なら除かない。 */
  excludeProvenanceKinds?: ProvenanceKind[] | undefined;
  /** 実効時刻（`occurredAt`、無ければ `recordedAt`）がこの時刻以後の行だけを返す（境界を含む。ADR 0039）。 */
  occurredAfter?: Date | undefined;
  /** 実効時刻（`occurredAt`、無ければ `recordedAt`）がこの時刻以前の行だけを返す（境界を含む。ADR 0039）。 */
  occurredBefore?: Date | undefined;
  /** `VectorFilter.validAt` と同じ絞り・同じ意味（`RecallQuery.validAt` の doc 参照）。語彙チャンネルにも直接効く。 */
  validAt?: Date | undefined;
  /** `VectorFilter.attributes` と同じ欄・同じ意味（ADR 0312）。 */
  attributes?: Attributes | undefined;
  /** `VectorFilter.labels` と同じ欄・同じ意味（ADR 0323）。 */
  labels?: string[] | undefined;
}

/** `LexicalStore.search` が返す1件。 */
export interface LexicalHit {
  /** 当たった Memory の id。 */
  memoryId: MemoryId;
  /**
   * **一致したクエリ語彙の数 ÷ クエリから作れた語彙の総数**（ADR 0092）。値域は `(0, 1]`。
   * 一致した語彙が無い候補は `search` が返さない。
   *
   * **🔴 `recall` の段2 は `ScoreBreakdown.lexicalMatch` にこの値をそのまま入れる。**
   *
   * **⚠ 尺度は store ごとに同じではない。** tsvector 版・InMemory は上の式どおりの 1/n 刻み。
   * pg_trgm 版は、ASCII 側は同じ式だが、日本語側は `word_similarity` が閾値以上なら 1、そうでなければ 0 の二値で、
   * `GREATEST` で合成する（`word_similarity` の値は `coverage` ではなく `rank` に入る）。ADR 0553。
   */
  coverage: number;
  /**
   * **`coverage` が同値の候補どうしを adapter がどう並べたか、というタイブレークの値。大きいほど上位。**
   *
   * **🔴 この値はスコアに入らない。** `recall` の段2 が使うのは `coverage` であり、`rank` ではない（ADR 0092）。
   * `rank` の尺度は adapter ごとに違い、**コサイン類似度と比較可能な量ではない。**
   * 比較してよいのは**同一クエリ・同一 adapter が返した `LexicalHit` 同士だけ**である。`explain` にもこの値が出る。
   */
  rank: number;
}

/**
 * LexicalStore — recall の**語彙候補生成チャンネル**（ADR 0084）。
 *
 * 契約:
 * - **`MemoryStore` が真実の源であり、語彙索引は再構築可能な派生索引である**（`VectorStore` と同じ非対称）。
 * - **クエリ語彙は OR で結ばれる**（ADR 0092）。クエリから作れる語彙の**どれか1つでも一致すれば**候補になる。
 *   **⟹ 一致した語彙が1つも無い候補は返さない**（`LexicalHit.coverage` は常に `(0, 1]`）。
 * - **返り値は `coverage` の降順である。同値なら `rank` の降順でタイブレークする。** `limit` はその上位から切る。
 * - `filter` の各フィールドを adapter が実際に適用する（`LexicalFilter` の doc）。
 * - **`query` は正規化前の生のクエリ文字列である。** どう分かち書きするかは adapter の責務で、core は関与しない。
 *   **⟹ adapter は、自分の索引では原理的に一致しえない種類の語を query から落としてよい。**
 *   postgres 実装は日本語の語を落とす（ADR 0084 §2.1.1）。**⚠ ただし「落としてよい」は「落とすべき」ではない。**
 *   何を落としたかは adapter が説明できること。
 *
 * **🔴 書き込み口（`upsert` / `delete`）を持たない。** Phase 1 の postgres 実装は `memories.content` そのものの上に
 * 式索引を張るので、索引は本体の書き込みに自動で追随し、同期の口が要らない。
 * **⟹ これは「外部の検索エンジンを語彙 adapter にできる」ことを意味しない。** `memories` の外に索引を持つ実装は、
 * この interface だけでは同期できない。その口が要る実装が現れたら足す（ADR 0084 §8）。
 */
export interface LexicalStore {
  /**
   * `coverage` 降順・同値なら `rank` 降順で最大 `opts.limit` 件を返す。
   *
   * **⚠ `coverage`/`rank` の両方が完全に一致する行が複数あるときの順序も、adapter の責務である**（ADR 0175。
   * `VectorStore.search` の ADR 0170 と同じ形の契約）。
   * 段2 は候補を全順序で並べ直すので、効くのはその手前の `opts.limit` による切り詰めである。同点候補のうちどの `limit` 件を
   * 返すかが変われば、段2に届く候補集合そのものが変わり、`recall()` の結果が同じ入力に対して変わりうる。
   *
   * `PostgresLexicalStore` は `coverage` → `rank` → `recorded_at` DESC → `id` の4段で tie-break する。
   * **`id` だけに頼る tie-break は不十分**（`id` は内容と無関係に ingest のたびに振られるので、同一内容の重複記録では
   * DB を作り直すたびに並びが変わる）。**adapter を新しく書くときは、完全なタイブレークまで含めて決定的な順序を返すこと。**
   */
  search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]>;
}
