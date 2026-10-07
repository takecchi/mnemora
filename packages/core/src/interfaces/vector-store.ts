import type { Attributes } from "../attributes.js";
import { matchesStoreErrorKind } from "../store-error-kind.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { EraseTenantStoreOptions, EraseTenantResult } from "./memory-store.js";
import type { ProvenanceKind } from "../provenance.js";

/**
 * `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る（docs/architecture.md §5.2）。
 *
 * **各フィールドは adapter が実際に適用しなければならない（ADR 0034）。**
 * 「絞ってもよいが絞らなくてもよい」という緩い契約ではない。
 *
 * **⚠ 後段の多層防御は「段1で絞らなくてよい」ことの根拠ではない。** `recall-runtime.ts` は、段1（ANN）と段3.5（連想枠）が
 * 受け取った候補に `subjectId`・`excludeProvenanceKinds`・`period`・`validAt`・`status`（ADR 0432 AL-1）・
 * 忘却ゲート（ADR 0153）を改めて掛けるので、adapter がこの契約を落としても混入は後段が救い、返る件数が減るだけである。
 * 段1の絞りは over-fetch の窓（k'）を無駄にしないための最適化である。
 */
export interface VectorFilter {
  /**
   * **`ctx.tenantId` と AND で掛ける。** 隔離の境界は `ctx.tenantId` である（ADR 0007）。adapter は、この欄と
   * `ctx.tenantId` の**両方**に一致する行だけを返す。2つが食い違えば0件を返し、例外は投げない。`LexicalFilter.tenantId` も同じ。
   */
  tenantId: string;
  /**
   * 指定すると、この中のどれかの status を持つ行だけを返す。未指定なら status で絞らない。⚠ 空配列なら1件も通らない（`@mnemora/postgres` と testkit の fixture で同じ）。
   */
  status?: MemoryStatus[] | undefined;
  /**
   * **狭義の `>`。** `decayFloorAt` が境界と*ちょうど同じ* Memory は含まれない。`>=` にすると忘却の境界上にある記憶が
   * 想起され続けてしまう（ADR 0004）。
   */
  decayFloorAtAfter?: Date | undefined;
  /** subject の等値一致。 */
  subjectId?: string | undefined;
  /**
   * **`subjectId` の等値絞りを、`subject_id IS NULL`（主題なし）まで広げる opt-in**（ADR 0286）。
   *
   * **契約: `subjectId` が渡されているときだけ効く。** `true` なら述語は `subject_id = ${subjectId} OR subject_id IS NULL` になる。
   * `subjectId` が `undefined`（テナント全体）のときはこの欄も無視してよい。
   *
   * **追加のみの欄である**——この欄を知らない adapter は無視してよく、無視しても「主題なしの Memory を取りこぼす」だけで、
   * **別の subject の Memory を混ぜて返す経路にはならない**。
   */
  includeSubjectless?: boolean | undefined;
  /**
   * **除外**の列挙である（ADR 0056）。**`status` とは向きが逆**——`status` は「この配列に*在る*ものだけ通す」包含だが、
   * `excludeProvenanceKinds` は「この配列に*在る*ものを落とす」除外。`RecallQuery.excludeProvenanceKinds` と同じ向き。
   *
   * **⚠ `undefined` と空配列 `[]` はどちらも no-op（何も除外しない）。** `status: []` は何にも一致しない（全件を除外する）ので、
   * これとは非対称である。
   */
  excludeProvenanceKinds?: ProvenanceKind[] | undefined;
  /**
   * **期間の下限。両端とも包含（`>=`）（ADR 0059）。** 比較対象は `COALESCE(occurredAt, recordedAt)`（「実効時刻」。ADR 0039）。
   *
   * **⚠ 同じ interface の `decayFloorAtAfter` は狭義の `>`（非包含）である。** 「〜After」という名前を持つ2つのフィールドが、
   * 境界の扱いについて逆の意味論を持つ。**名前だけで意味論を推測しないこと。**
   */
  occurredAfter?: Date | undefined;
  /**
   * 期間の上限。`occurredAfter` と対になる——同じ実効時刻の定義・同じ境界の含み方（**包含、`<=`**）。
   */
  occurredBefore?: Date | undefined;
  /**
   * 活動時計の忘却ゲート（ADR 0165 決めたこと1・12、`decay_clock: 'activity'`/`'either'`）。**狭義の `>`**
   * （`decayFloorAtAfter` と同じ意味論・同じ境界）。
   *
   * **契約: `decay_floor_seq IS NULL` の行は通す。** `NULL` は「この軸には床が無い＝活動時計では沈まない」（ADR 0165 決めたこと4）。
   */
  decayFloorSeqAfter?: number | undefined;
  /**
   * `true` のとき、`decayFloorSeqAfter`（テナント単位の `T`）に、その行の `subject_id` に対応する subject 単位のカウンタ `S_x`
   * （`tenant_subject_activity`）を足した値と比較する——`decay_floor_seq > (decayFloorSeqAfter + COALESCE(S_x, 0))`
   * （ADR 0353）。`subject_id IS NULL` の行は `T` のみと比較する。
   *
   * **既定 `false`/省略: `T` のみの単一パラメータ比較**で、`tenant_subject_activity` を参照しない。adapter は
   * `TenantSettingsStore.hasSubjectActivityCounters?` が `false`（未実装を含む）を返すテナントでは、この欄を常に `false`/省略のまま
   * 渡すべきである（EXPLAIN のプラン族を変えないため）。
   */
  decayFloorSeqUsesSubjectCounters?: boolean | undefined;
  /**
   * `decayFloorAtAfter` と `decayFloorSeqAfter` の結び方を切り替える（ADR 0165 決めたこと1、`decay_clock: 'either'`）。既定 `false`。
   *
   * **契約: `true` かつ `decayFloorAtAfter` と `decayFloorSeqAfter` の両方が与えられているときに限り、その2つだけを OR で結ぶ**
   * （`decay_floor_at > decayFloorAtAfter OR (decay_floor_seq IS NULL OR decay_floor_seq > decayFloorSeqAfter)`）。
   * **他の条件は従来どおり AND のまま。** どちらか一方しか与えられていない場合、この欄は無視される。
   */
  decayFloorAnyAxis?: boolean | undefined;
  /**
   * **「この時刻において真だった記憶」ゲート**（`RecallQuery.validAt` の doc 参照）。
   *
   * 述語: `(valid_from IS NULL OR valid_from <= validAt) AND (valid_until IS NULL OR valid_until > validAt)`。
   * - `valid_from` は閉じた左端（`<=`）。
   * - `valid_until` は**開区間の右端**（狭義の `>`）。**⚠ `occurredAfter`/`occurredBefore`（両端とも包含）とは境界の扱いが違う。**
   *   「時刻を比較する欄はすべて同じ境界」と決めつけないこと。
   * - **両方 `NULL` は「いつでも真」**（「不明」ではない）。
   */
  validAt?: Date | undefined;
  /**
   * **AND 等値の絞り込み**（ADR 0312。`RecallScope.attributes`/`RecallQuery.attributes` の doc 参照）。
   * 渡したキーすべてが、その Memory の `attributes` に同じ値で存在する場合だけ通す（`jsonb` の containment）。
   * **未指定・空オブジェクトは no-op。**
   */
  attributes?: Attributes | undefined;
  /**
   * **OR の集合絞り込み**（ADR 0323。`RecallScope.labels`/`RecallQuery.labels` の doc 参照）。
   * 渡した名前のうち1つでも `tags` に含まれれば通す。**未指定は no-op。** 渡される名前は既に現在の `taxonomy_mode` で
   * 参加資格があることが core で解決済みで、adapter は `status`（`registered`/`proposed`）を意識しなくてよい。
   */
  labels?: string[] | undefined;
}

/** `VectorStore.getVectors` が返す1件。 */
export interface VectorEntry {
  /** ベクトルの持ち主の Memory の id。 */
  memoryId: MemoryId;
  /** 保存されているベクトル。 */
  vector: number[];
}

/** `VectorStore.search` が返す1件。 */
export interface VectorHit {
  /** 当たった Memory の id。 */
  memoryId: MemoryId;
  /**
   * **コサイン距離（`1 - cosine similarity`）。** 他の距離関数ではない。下流（`recall-runtime.ts`）は `1 - distance` を
   * `similarity` として扱っており、これはコサイン距離の場合にのみ意味を持つ（ADR 0033）。adapter が別の距離関数を返すと
   * 下流のスコアリングの意味が壊れる。
   *
   * **⚠ 範囲は 0〜1 ではない。** 逆向き（cosine similarity = -1）のとき最大 2 まで出る（ADR 0036）。
   */
  distance: number;
}

/**
 * 登録していない埋め込み空間（その空間の索引の表が無い）で {@link VectorStore} を引いたことを表す（ADR 0433 決定3）。
 * `@mnemora/postgres` の `PostgresVectorStore` は、`upsert`・`search`・`searchMany`・`delete`・`getVectors` が未登録の空間で
 * 落ちるとき、Postgres の生の SQLSTATE 42P01 の代わりにこれを投げる。元の Error は `cause` に残る。
 *
 * 判定は `instanceof` ではなく {@link isEmbeddingSpaceNotRegisteredError} で行う（ADR 0418）。
 * 空間を登録してから（`@mnemora/postgres` の `registerEmbeddingSpace`）呼び直す。
 *
 * ⚠ **例外にならなかった入力は変えていない。** 未登録の空間でも例外にならない入力（形式不正な id だけの `delete`・`getVectors`、
 * 空の `searchMany`、全 space を掃く `deleteAcrossSpaces`・`eraseTenant`）は、今も例外にならない。
 * 他の adapter がこの例外を投げることは、適合テストの要件にしていない。
 */
export class EmbeddingSpaceNotRegisteredError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は {@link isEmbeddingSpaceNotRegisteredError} で行う。 */
  readonly kind = "embedding_space_not_registered" as const;
  constructor(
    readonly space: EmbeddingSpaceId,
    options?: ErrorOptions,
  ) {
    super(
      `VectorStore: embedding space (provider "${space.provider}", model "${space.model}", ` +
        `dimensions ${space.dimensions}) is not registered — its index table does not exist. ` +
        "Register the space (registerEmbeddingSpace) before using it.",
      options,
    );
    this.name = "EmbeddingSpaceNotRegisteredError";
  }
}

/**
 * 受け取ったものが {@link EmbeddingSpaceNotRegisteredError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isEmbeddingSpaceNotRegisteredError(
  value: unknown,
): value is EmbeddingSpaceNotRegisteredError {
  return matchesStoreErrorKind(
    value,
    "embedding_space_not_registered",
    "EmbeddingSpaceNotRegisteredError",
  );
}

/**
 * VectorStore（docs/architecture.md §5.2）。
 *
 * 契約:
 * - MemoryStore が真実の源であり、VectorStore は再構築可能な派生索引である（VectorStore を失っても再 embed して復旧できるが逆はできない）。
 * - `ORDER BY` を距離式にしない、という規約は adapter 実装の責務である。
 * - 埋め込みが未完了の Memory は `Memory.embeddingStatus` を持ち、recall は `omitted.kind = 'not_indexed'` としてこれを報告する。
 */
export interface VectorStore {
  /**
   * `memoryId` の埋め込みを書く（同じ `memoryId` なら上書き）。
   *
   * ⚠ **`vector` の中身は検証しない。壊れたベクトルの扱いは adapter によって違う**:
   *
   * | `vector` | `@mnemora/postgres` | `@mnemora/testkit` の `InMemoryVectorStore` |
   * |---|---|---|
   * | 長さが `space.dimensions` と違う・空 | 例外（pgvector の `expected N dimensions` など）。前の埋め込みは残る | そのまま保存する。`search` ではその行の距離が `NaN` になる |
   * | `NaN`・`Infinity`・float4 に収まらない値（`1e308` など）を含む | 例外（DB に触れる前の `RangeError`。ADR 0424） | 同じ（ADR 0424） |
   * | 成分がすべて `0` | 保存する（ADR 0040。`search` の距離は比較不能） | 同じ |
   *
   * ⚠ **`Runtime.tick` の embed ジョブは（ADR 0393）、`upsert` へ渡す前にベクトルの長さが `embeddingProvider.space.dimensions` と
   * 等しく、成分がすべて有限であることを確かめる。** 違えば `upsert` を呼ばずにジョブを失敗にし、`embeddingStatus: 'failed'`
   * （`recall()` では `not_indexed`）にする（メッセージに位置と値を含む）。上の表は、**Runtime を通らずに store を直接呼んだとき**の
   * 振る舞いを指す。**store が保証するのは、長さが `space.dimensions` と一致し、成分がすべて有限のベクトルを渡したときの振る舞いだけである。**
   *
   * **`memoryId` の Memory が `ctx.tenantId` の Memory でなければ、行を書かずに `memory not found for tenant: <id>` を
   * 含むメッセージの `Error` を投げる**（ADR 0436。ADR 0398 の `RelationStore.link` と同じ作法。クラス名の接頭辞は
   * `PostgresVectorStore:`／`InMemoryVectorStore:`）。実在しない id・別のテナントの Memory の id・uuid の形でない id
   * （`@mnemora/postgres`）を区別しない。
   * 他テナントの Memory に行を書けると、その行が指された側の `eraseTenant` を `blocked_by_foreign_reference` で止める。
   */
  upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
  /**
   * 距離昇順で最大 `opts.limit` 件を返す。
   *
   * **`query` の長さが `space.dimensions` と違うときは「比較不能」として扱う**（`RecallQuery.vector` の doc 参照）。
   * **`search` は候補を結果から落とさず、距離を比較が通らない値（`NaN`）にして返す**（ADR 0040 のゼロベクトルと同じ契約の形。
   * `recall()` の段2（ADR 0044）がこれを `omitted.score_not_comparable` に数える）。`NaN` という値そのものは揃えない。
   * **`query` が有限でない成分（`NaN`・`Infinity`）を含むときも同じく「比較不能」であり、`search` は例外を投げない。**
   * この interface は長さの一致を検証せず、一致しなかったときに `search` が新しい例外を投げることはない。
   * ⚠ `upsert` の `vector` の長さが違うときは、この契約の外である（`PostgresVectorStore` は `upsert` で例外、
   * `InMemoryVectorStore` はそのまま保存して `search` で `NaN`。上の表）。
   * ⚠ ADR 0393: 埋め込み provider がクエリに有限でない成分を返した場合は、`Runtime.recall` がここへ渡す前に弾いて
   * `embedding_provider_unavailable` にする。この段落が指すのは `search`/`searchMany` を直接呼ぶ場合と、
   * 長さ違いの `RecallQuery.vector` の直接指定である。
   *
   * **⚠ 距離が完全に一致する行が複数あるときの順序も、adapter の責務である**（ADR 0170）。
   * `recall-runtime.ts` の段2・段3.5（ADR 0151）は `search()` が返す配列の**先頭から `limit`/`maxCount` 件を切り詰め**、
   * 距離が同点の候補は `search()` が返した順序を保つ。⟹ **同点候補が adapter ごとに違う順序で返ると、`recall()` の結果が
   * 同じ入力・同じスコアに対して変わりうる。**
   *
   * `PostgresVectorStore` は距離 → `recorded_at` DESC → `memory_id` の3段で tie-break する。
   * **`memory_id` だけに頼る tie-break は不十分**（`memory_id` は内容と無関係に ingest のたびに振られるので、同一内容の重複記録では
   * DB を作り直すたびに並びが変わる）。**adapter を新しく書くときは、距離だけでなく完全なタイブレークまで含めて決定的な順序を返すこと。**
   *
   * ⚠ **距離はベクトルを float4 に丸めてから比べる。** `PostgresVectorStore`（pgvector の `vector` 型）は成分を float4 で持ち、
   * クエリも float4 に変換する。`InMemoryVectorStore` も、保存するベクトルとクエリを `Math.fround` で丸める。
   * ⟹ **何が「距離の同点」になるかは、2実装で同じである。** ただし距離の値そのものの下の桁は揃わない。
   */
  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]>;
  /**
   * 複数のクエリベクトルを、**同じ `opts`（`limit`・`filter`）で** `search()` した場合と同じ結果を、1回の往復に束ねて返す。
   *
   * **任意メソッドである。** これが無くても `VectorStore` として成立し、`recall-runtime.ts` の段3.5 はアンカーごとに
   * `search()` を1回ずつ呼ぶ経路へ戻る。**正しさは変わらず、変わるのは往復数だけ。**
   *
   * **契約: 各 `queries[i]` に対する結果は、`search(ctx, space, queries[i].vector, opts)` を単独で呼んだ場合と、
   * 集合・順序ともに完全に一致しなければならない。** `filter`・`limit` は全クエリで共通の1つだけを受け取る。
   * クエリごとに違う `filter`/`limit` を渡したい呼び出しは、この口の対象外である（`search()` を個別に呼ぶこと）。
   *
   * **`queries` の `key` は呼び出し側が選ぶ不透明な識別子である。** 返り値の `Map` は `queries` と同じ `key` の集合を持つ
   * （対応するクエリの結果が0件でも `key` 自体はエントリとして存在する）。`queries` が空配列なら、空の `Map` を返す。
   *
   * **タイブレークの契約は `search()` と同じ**（距離 → `recorded_at` DESC → `memory_id`。ADR 0170）。
   *
   * **例外の有無も `search()` に揃える**: `search()` が投げない入力では、`searchMany` も投げない。`key` はどんな文字列でもよい
   * （NUL（U+0000）を含んでいてもよい）。`limit` の負数・非整数・`NaN`、filter の日時の Invalid Date では、`search()` と同じく投げる。
   *
   * **契約: `queries` に同じ `key` が2回以上あるときは、最後のクエリの結果だけを返す**（後勝ち）。返す `Map` の並びは、
   * その key が**最初に現れた位置**である——結果は `new Map(queries.map((q) => [q.key, search(ctx, space, q.vector, opts)]))` と同じ。
   * ただし、同じ key のうち**前のクエリだけが投げる入力**（そのベクトルだけが DB に拒まれる値。float4 の範囲を超える有限の値など）では、
   * この式は投げるが、`searchMany` は投げずに返す。どの key の結果も、`search()` と同じく `limit` を超えない。
   */
  searchMany?(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>>;
  /**
   * 対象の vector が存在しなければ何もしない（`void`、べき等）。`memoryId` が adapter の期待する形式でない場合も同じ「何もしない」になる。
   */
  delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
  /**
   * `ctx.tenantId` に属する `memoryIds` の埋め込み行を、この adapter が持つ**全 space**から消す（ADR 0382）。
   *
   * **必須メソッドである。** `Runtime.purge` が埋め込みモデルを移した後も残る旧 space の行を後始末するには、
   * 呼び出し側が space の一覧を持たずに済む形が要る。任意にすると、対応していない adapter では別 space の embedding が消えない。
   *
   * **契約**:
   * - 対象の行が存在しなければ何もしない（`void`、べき等）。
   * - `memoryIds` に adapter の期待する形式でない id が混ざっていても、その id は「存在しない」の一種として扱い、例外を投げない。
   * - `ctx.tenantId` に属さない行は消さない——他テナントの行が偶然同じ `memoryId` を持っていても触れない。
   * - `memoryIds` が空配列なら、何もせずに返る。
   * - 実装がテーブルを space ごとに分けていなくてもよい。契約が要求するのは「呼び出し側が space を知らなくても全 space から消える」ことだけ。
   */
  deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void>;
  /**
   * `ctx.tenantId` に属する行を、この adapter が持つ**全 space**から跡形なく消す（ADR 0383）。
   * `deleteAcrossSpaces` が「特定の `memoryId` の集合」を対象にするのに対し、こちらは「このテナントの行全部」が対象。
   * `eraseTenant`（`erase-tenant.ts`）が、`MemoryStore.eraseTenant?`/`OutboxStore.eraseTenant?`/`TenantSettingsStore.eraseTenant?` と
   * 束ねて呼ぶ口の1つ。
   *
   * 🔴 **任意メソッドである。** 必須にすると第三者の adapter を壊す破壊的変更になる。`deleteAcrossSpaces`（必須。ADR 0382）と違い、
   * テナント消去はまれな操作で、対応していない adapter は `eraseTenant`（独立関数）の `{ kind: "store_unsupported" }` で
   * 名指しされる（`MemoryStore.eraseTenant` の doc 参照）。
   *
   * **契約**:
   * - `opts.limit` を目安に、全 space のテーブルから、このテナントの行を削除する。space 間の順序は問わない。
   * - `opts.dryRun === true` のときは削除を一切行わず、削除していたら消えていたであろう件数だけを返す。
   * - `result.reachedLimit === true` なら、呼び出し側は同じ `opts` で呼び直すこと。何度呼んでも安全。
   * - `ctx.tenantId` に属さない行は消さない。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult>;
  /**
   * アンカーとなる Memory のベクトルをまとめて取得する（連想枠）。
   *
   * **任意メソッドである。** これが無くても `VectorStore` として成立する。`recall-runtime.ts` の段3.5（連想）はこれが無い場合、
   * `omitted` に `stage_skipped{stage:"association", reason:"vector_store_lacks_get_vectors"}` を積んでスキップするだけで、
   * `recall()` 自体は成立する。
   *
   * **存在しない `memoryId` は黙って結果から落とす。** 呼び出し全体を弾かない。`memoryIds` のうち adapter の期待する形式でないものも、
   * 無い id と同じく静かに落とす。全件が存在しない/形式に合わなければ空配列を返す。
   *
   * **tenant 境界を必ず掛けること。** `ctx.tenantId` に属さない `memoryId` は、それが実在しても「存在しない」と同じ扱い（返さない）。
   * これを緩めると連想の段がテナントを跨いで記憶を漏らす経路になる（`search` の `filter.tenantId` と同じ境界）。
   *
   * 返す順序は `memoryIds` の順序と一致している必要はない。
   */
  getVectors?(ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]): Promise<VectorEntry[]>;
}
