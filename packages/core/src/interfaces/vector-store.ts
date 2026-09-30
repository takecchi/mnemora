import type { Attributes } from "../attributes.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { EraseTenantStoreOptions, EraseTenantResult } from "./memory-store.js";
import type { ProvenanceKind } from "../provenance.js";

/**
 * `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る
 * （docs/architecture.md §5.2）。
 *
 * **各フィールドは adapter が実際に適用しなければならない（ADR 0034）。**
 * 「絞ってもよいが絞らなくてもよい」という緩い契約ではない——`packages/testkit` の
 * `vector-store-conformance.ts` がこれを adapter 非依存の歯として検査する
 * （`status` に無いものは返らない・一致しない `subjectId` は返らない・
 * `decayFloorAtAfter` 以前のものは返らない・`excludeProvenanceKinds` に在る kind は
 * 返らない、を同一の適合テストで postgres / in-memory 両方に対して走らせる）。
 *
 * **⚠ 後段の多層防御は、ここの全フィールドを覆ってはいない。**
 * `packages/core/src/recall-runtime.ts` は段1のあとに `subjectId`・`excludeProvenanceKinds`・
 * `period`（`occurredAfter`/`occurredBefore`。ADR 0059 で本 interface に加わった）・
 * `validAt`（Issue #280。下記）を改めて見るが、**`status` と `decayFloorAtAfter` は
 * 見ない**。⟹ `status` と `decayFloorAtAfter` については、ここの契約を adapter が
 * 守ることが**唯一の防衛線**である
 * （実測: `FakeVectorStore` の `status` の絞りを落とす変異で、`recall-pipeline.test.ts` の
 * 既存の歯が実際に赤くなる。`subjectId` を落とす変異では赤くならない——後段が救うため）。
 * `subjectId`・`excludeProvenanceKinds`・`period`・`validAt` は後段にも同じ絞りが残るので、
 * adapter がこの契約を落としても後段が結果の正しさを救う（`subjectId`/
 * `excludeProvenanceKinds` は ADR 0056、`period` は ADR 0059、`validAt` は Issue #280）
 * ——ただしこれは「段1で絞らなくてよい」ことの根拠ではない。
 * 段1の絞りは over-fetch の窓（k'）を無駄にしないための最適化であり、後段フィルタが
 * 在ることは、どの場合も「filter を無視してよい」ことの根拠ではない。
 */
export interface VectorFilter {
  /**
   * **`ctx.tenantId` と AND で掛ける**（Issue #1050）。隔離の境界は `ctx.tenantId` である
   * （ADR 0007）——adapter は、この欄と `ctx.tenantId` の**両方**に一致する行だけを返す。
   * 2つが食い違えば0件を返し、例外は投げない。runtime は常に同じ値を渡す。
   * `LexicalFilter.tenantId` も同じ。
   */
  tenantId: string;
  /**
   * 指定すると、この中のどれかの status を持つ行だけを返す。未指定なら status で絞らない。⚠ 空配列なら1件も通らない（`@mnemora/postgres` と testkit の fixture で同じ）。
   */
  status?: MemoryStatus[];
  /**
   * **狭義の `>`。** `decayFloorAt` が境界と*ちょうど同じ* Memory は含まれない
   * （`packages/postgres/src/vector-store.ts` の `m.decay_floor_at > ${decayFloorAtAfter}`
   * がこの意味論の基準）。`>=` にすると忘却の境界上にある記憶が想起され続けてしまう
   * （ADR 0004 の「忘却をクエリ時に算出する」設計と整合させるため）。
   */
  decayFloorAtAfter?: Date;
  /**
   * subject の等値一致（`docs/vision.md` の「Tenant と Subject を混同しない」区別における
   * テナント内の整理の単位）。等値比較なので上のクラス doc の「索引で表現できる形」に
   * そのまま当たる——`period`（`occurredAfter`/`occurredBefore`、下記）のような連続値の
   * 範囲比較とは性質が異なる。**`period` も ADR 0059 により同じ `VectorFilter` に加わって
   * いるが、比較の形は等値ではなく単調な範囲比較（`>=`/`<=`）のままである**——
   * `docs/recall.md` が指摘した partial index の離散値向き制約は、`period` 側では
   * 式索引（`COALESCE(occurred_at, recorded_at)`）を1本追加することで受けた
   * （ADR 0023 が「降ろすにはスキーマに踏み込む判断が要る」と書いた、その判断そのもの）。
   */
  subjectId?: string;
  /**
   * **`subjectId` の等値絞りを、`subject_id IS NULL`（主題なし）まで広げる opt-in**
   * （Issue #608 項目③(b)、[ADR 0286](../../../../docs/decisions/0286-recall-include-subjectless.md)）。
   *
   * **契約: `subjectId` が渡されているときだけ効く。** `true` なら述語は
   * `subject_id = ${subjectId} OR subject_id IS NULL` になる——`subjectId` 単体の等値比較
   * （上）を狭めるのではなく**広げる**。`subjectId` が `undefined`（テナント全体）のときは
   * この欄も無視してよい（テナント全体は定義上すでに `subject_id IS NULL` を含む）。
   *
   * **追加のみの欄である**——この欄を知らない adapter は無視してよく（省略した場合と
   * 同じ、既定 `false`/`undefined` は今日どおり `subjectId` の厳密一致のまま）、無視しても
   * 「主題なしの Memory を取りこぼす」だけで、**別の subject の Memory を混ぜて返す
   * 経路にはならない**（`packages/core/src/recall-runtime.ts` の全チャンネル共通の
   * 後置フィルタが、adapter がこの欄を守らなかった場合の多層防御になっている——
   * `decayFloorAtAfter` 等と同じ規律）。
   */
  includeSubjectless?: boolean;
  /**
   * **除外**の列挙である（ADR 0056）。**上の `status` とは向きが逆**——`status` は
   * 「この配列に*在る*ものだけ通す」包含の列挙だが、`excludeProvenanceKinds` は
   * 「この配列に*在る*ものを落とす」除外の列挙。`RecallQuery.excludeProvenanceKinds`
   * （`packages/core/src/recall.ts`）と同じ語彙・同じ向きに揃えてある。
   *
   * `ProvenanceKind` は5値の閉じた離散値であり、`provenance_kind` は独立の列
   * （`packages/postgres/migrations/0001_init.sql`）なので等値比較で足りる——
   * 上のクラス doc の「索引で表現できる形」にそのまま当たる。`period` のような
   * 連続値の範囲比較とは事情が異なる（ADR 0023 が `period` を段1に降ろさなかった理由は
   * この等値比較には当たらない、という判断は ADR 0056 のもの。**`period` 自体は
   * その後 ADR 0059 で別途 `VectorFilter` に加わっている**——詳細は下記
   * `occurredAfter`/`occurredBefore` の doc を参照）。
   *
   * **⚠ `undefined` と空配列 `[]` はどちらも no-op（何も除外しない）。** これは
   * 上の `status` とは非対称である——`status: []` は SQL の `= ANY('{}')` に翻訳され
   * *何にも一致しない*（全件を除外する）が、`excludeProvenanceKinds: []` は
   * 「除外する kind が0個」という意味であり全件を通す。適合テストの歯
   * （`vector-store-conformance.ts`）がこの非対称を固定している。
   */
  excludeProvenanceKinds?: ProvenanceKind[];
  /**
   * **期間の下限。両端とも包含（`>=`）（ADR 0059）。** 比較対象は
   * `COALESCE(occurredAt, recordedAt)`——「実効時刻」の定義（ADR 0039 が4箇所に在ると
   * 数えた規則。本フィールドの追加でこれが5箇所目になる）。`RecallQuery.occurredAfter`
   * （`packages/core/src/recall.ts`）・`packages/postgres/src/memory-store.ts` の
   * `aggregateScope` が既に使っている厳密経路（`COALESCE(occurred_at, recorded_at) >=
   * occurredAfter`）と同じ命名・同じ境界の含み方に揃えてある。
   *
   * **⚠ 同じ interface の `decayFloorAtAfter`（上）は狭義の `>`（非包含）である。**
   * 「〜After」という名前を持つ2つのフィールドが、境界の扱いについて逆の意味論を持つ——
   * `decayFloorAtAfter` は忘却の起点という別の概念（ADR 0004）であり、`period` の
   * 判定規則（ADR 0039）とは出どころが異なる。**名前だけで意味論を推測しないこと。**
   *
   * `period` は連続値の範囲比較であり、`docs/recall.md` が指摘する partial index の
   * 離散値向き制約に関わる——`subjectId`/`excludeProvenanceKinds` の等値比較とは
   * 事情が異なる。ADR 0059 はこれを式索引（`COALESCE(occurred_at, recorded_at)` に対する
   * 3列索引）で受けている。
   */
  occurredAfter?: Date;
  /**
   * 期間の上限。`occurredAfter` と対になる——同じ実効時刻の定義（`COALESCE(occurredAt,
   * recordedAt)`）・同じ境界の含み方（**包含、`<=`**）。詳細は `occurredAfter` の doc を参照。
   */
  occurredBefore?: Date;
  /**
   * 活動時計の忘却ゲート（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)
   * 決めたこと1・12、`decay_clock: 'activity'`/`'either'`）。**狭義の `>`**——`decayFloorAtAfter`
   * と同じ意味論・同じ境界（`decayFloorAtAfter` の doc「名前だけで意味論を推測しないこと」の
   * 注記を、この2つの `〜After` フィールド間では守る）。
   *
   * **契約: `decay_floor_seq IS NULL` の行は通す。** `NULL` は「この軸には床が無い＝
   * 活動時計では沈まない」（ADR 0165 決めたこと4）——`decayFloorSeqAfter` を渡しても、
   * `decay_floor_seq` が無い行を落としてはならない。
   */
  decayFloorSeqAfter?: number;
  /**
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `true` のとき、`decayFloorSeqAfter`（テナント単位の `T`）に、その
   * 行の `subject_id` に対応する subject 単位のカウンタ `S_x`（`tenant_subject_activity`）
   * を足した値と比較する——`decay_floor_seq > (decayFloorSeqAfter + COALESCE(S_x, 0))`。
   * `subject_id IS NULL` の行は `S_x` が無いので `T` のみと比較する（`COALESCE(..., 0)`
   * がそのまま表す）。
   *
   * **既定 `false`/省略: 今日どおり `T` のみの単一パラメータ比較**（`decay_floor_seq >
   * decayFloorSeqAfter`）——`tenant_subject_activity` を一度も参照しない。adapter は
   * `TenantSettingsStore.hasSubjectActivityCounters?` が `false`（未実装を含む）を
   * 返すテナントでは、この欄を常に `false`/省略のまま渡すべきである——**EXPLAIN の
   * プラン族を変えないための最適化**（本欄の doc、`readHasSubjectActivityCounters` の
   * doc コメント参照）。
   */
  decayFloorSeqUsesSubjectCounters?: boolean;
  /**
   * `decayFloorAtAfter` と `decayFloorSeqAfter` の結び方を切り替える（ADR 0165 決めたこと1、
   * `decay_clock: 'either'` の表現）。既定 `false`（未指定時と同じ）。
   *
   * **契約: `true` かつ `decayFloorAtAfter` と `decayFloorSeqAfter` の両方が与えられている
   * ときに限り、その2つだけを OR で結ぶ**（`decay_floor_at > decayFloorAtAfter OR
   * (decay_floor_seq IS NULL OR decay_floor_seq > decayFloorSeqAfter)`）。**他の条件
   * （`status`/`subjectId`/`excludeProvenanceKinds`/`period`）は従来どおり AND のまま**——
   * この欄が結び方を変えるのは忘却ゲートの2軸だけである。
   *
   * `decayFloorAtAfter`/`decayFloorSeqAfter` のどちらか一方しか与えられていない場合、
   * この欄は無視される（もう片方が無いので OR にする相手がいない——単に渡された側の
   * 条件だけが効く）。
   */
  decayFloorAnyAxis?: boolean;
  /**
   * **「この時刻において真だった記憶」ゲート**（Issue #280、Issue #202 第2弾、
   * `@mnemora/core` の `RecallQuery.validAt` の doc 参照）。
   *
   * 述語: `(valid_from IS NULL OR valid_from <= validAt) AND
   * (valid_until IS NULL OR valid_until > validAt)`。
   * - `valid_from` は閉じた左端（`<=`）。
   * - `valid_until` は**開区間の右端**（狭義の `>`）——同じ interface の
   *   `decayFloorAtAfter` と同じ非包含の向き。**⚠ `occurredAfter`/`occurredBefore`
   *   （両端とも包含）とは境界の扱いが違う。**「時刻を比較する欄はすべて同じ境界」と
   *   決めつけないこと（`decayFloorAtAfter` の doc が既に警告している同型の罠）。
   * - **両方 `NULL` は「いつでも真」**（「不明」ではない）。既存行の大多数が
   *   `NULL`/`NULL` であるため（`RecallQuery.validAt` の doc 参照）。
   *
   * `period`（`occurredAfter`/`occurredBefore`、ADR 0059）と同じく**連続値の区間比較**
   * だが、`period` とは違い**新しい索引を足していない**——理由は
   * [ADR 0164](../../../../docs/decisions/0164-valid-from-until-recall.md) を参照。
   * 要旨: 既存行の大多数が両端 `NULL` でこの述語を通るため、索引で絞れる対象
   * （落ちる行）が少数であり、btree/部分索引でも計画が改善しない。
   */
  validAt?: Date;
  /**
   * **AND 等値の絞り込み**（Issue #152/#153、ADR 0312）。`RecallScope.attributes`/
   * `RecallQuery.attributes` の doc コメント参照。`jsonb` の containment（`@>`）に
   * 落ちる形——渡したキーすべてが、その Memory の `attributes` に同じ値で存在する
   * 場合だけ通す。**未指定・空オブジェクトは no-op**（絞り込み無し）。
   */
  attributes?: Attributes;
  /**
   * **OR の集合絞り込み**（Issue #201 PR-B、
   * [ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）。
   * `RecallScope.labels`/`RecallQuery.labels` の doc コメント参照。渡した名前のうち
   * 1つでも `tags` に含まれれば通す（配列の重なり、postgres 実装は `&&` 演算子）。
   * **未指定は no-op**（絞り込み無し）。渡される名前は既に「現在の `taxonomy_mode` で
   * 参加資格がある」ことが呼び出し側（core）で解決済みであり、この interface の
   * 実装は `status`（`registered`/`proposed`）を意識しなくてよい。
   */
  labels?: string[];
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
   * **コサイン距離（`1 - cosine similarity`）。** 他の距離関数（ユークリッド距離等）ではない
   * ——`packages/postgres/src/vector-space.ts` の HNSW 索引が `vector_cosine_ops` を明示しており
   * （pgvector の `<=>` 演算子＝コサイン距離）、[ADR 0033](../../../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)
   * が「距離はコサイン」を実測として記録し、`packages/core/src/__tests__/runtime-fakes.ts` の
   * `FakeVectorStore` も `cosineDistance` を使っている。下流（`recall-runtime.ts`）は
   * `1 - distance` を `similarity` として扱っており、これはコサイン距離の場合にのみ
   * 「同一なら1、無関係なら0付近」という意味を持つ——adapter が別の距離関数を返すと
   * 下流のスコアリングの意味が壊れる。
   *
   * **⚠ 範囲は 0〜1 ではない。** コサイン距離は逆向き（cosine similarity = -1）のとき
   * 最大 2 まで出る（[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md) が
   * `similarity = 1 - distance` が −1 まで負になりうることを実測として記録している）。
   *
   * 適合テスト（`packages/testkit/src/vector-store-conformance.ts`）がこの契約を
   * adapter 非依存の歯として検査する。
   */
  distance: number;
}

/**
 * VectorStore — Phase 1（docs/architecture.md §5.2）。
 *
 * 契約:
 * - MemoryStore が真実の源であり、VectorStore は再構築可能な派生索引である
 *   （非対称。VectorStore を失っても MemoryStore から再 embed して復旧できるが逆はできない）。
 * - `ORDER BY` を距離式にしない、という規約は adapter 実装の責務であり、`testkit` は
 *   `EXPLAIN` で索引が使われることを検査する。
 * - 埋め込みが未完了の Memory は `Memory.embeddingStatus` を持ち、recall は
 *   `omitted.kind = 'not_indexed'` としてこれを報告する。
 */
export interface VectorStore {
  /**
   * `memoryId` の埋め込みを書く（同じ `memoryId` なら上書き）。
   *
   * ⚠ **`vector` の中身は検証しない。壊れたベクトルの扱いは adapter によって違う**
   * （[Issue #1070](https://github.com/takecchi/mnemora/issues/1070)）:
   *
   * | `vector` | `@mnemora/postgres` | `@mnemora/testkit` の `InMemoryVectorStore` |
   * |---|---|---|
   * | 長さが `space.dimensions` と違う・空 | 例外（pgvector の `expected N dimensions` など）。前の埋め込みは残る | そのまま保存する。`search` ではその行の距離が `NaN` になる |
   * | `NaN`・`Infinity` を含む | 例外（pgvector が拒む） | そのまま保存する |
   * | 成分がすべて `0` | 保存する（ADR 0040。`search` の距離は比較不能） | 同じ |
   *
   * ⚠ **2026-09-30 追記（ADR 0393）: `Runtime.tick` の embed ジョブは、`upsert` へ渡す前に
   * ベクトルの長さが `embeddingProvider.space.dimensions` と等しいことを確かめる。**違えば
   * `upsert` を呼ばずにジョブを失敗にし、`embeddingStatus: 'failed'`（`recall()` では
   * `not_indexed`）にする——provider が第三者の実装でも、store が `@mnemora/postgres` でも
   * `InMemoryVectorStore` でも同じである。上の表の「長さが違う・空」の行は、**Runtime を通らずに
   * store を直接呼んだとき**の振る舞いを指す。
   *
   * 確かめるのは**長さだけ**である。`NaN`・`Infinity` を含むベクトルは今も確かめずに渡すので、
   * provider がそれを返すと、`@mnemora/postgres` ではジョブが失敗して `embeddingStatus: 'failed'`
   * （`recall()` では `not_indexed`）になり、`InMemoryVectorStore` では `'ready'` のまま保存される
   * （`recall()` では `score_not_comparable`）。同じ Memory の embed ジョブが2本走り、有限でない
   * ベクトルを返す遅い方が後に終わると、`InMemoryVectorStore` では先に書かれた正しいベクトルが
   * 上書きされる（`@mnemora/postgres` では遅い方が失敗し、正しいベクトルが残る）。
   * **保証するのは、長さが `space.dimensions` と一致し、成分がすべて有限のベクトルを渡したときの
   * 振る舞いだけである**（長さの一致は Runtime の embed ジョブが守り、有限性は守らない）。
   *
   * ⚠ **`memoryId` がほかのテナントの Memory を指していても、テナントの一致は約束として
   * 検査しない**（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051)）。
   * `@mnemora/postgres` は受け付けて呼んだテナントの行として書くが、`search` は `memories` と
   * テナントで突き合わせるので、その行は検索に出ない。`InMemoryVectorStore` は「memory not
   * found」で拒む。`docs/memory-model.md` §5 の 2026-09-27 追記を参照。
   */
  upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
  /**
   * 距離昇順で最大 `opts.limit` 件を返す。
   *
   * **`query` の長さが `space.dimensions` と違うときは
   * 「比較不能」として扱う**（`RecallQuery.vector` の doc コメント参照、Issue #867 / 案B）。
   * ⚠ **`upsert` の `vector` の長さが違うときは、この契約の外である**——`PostgresVectorStore`
   * は `upsert` の時点で例外を投げ（pgvector の `expected N dimensions`）、`packages/testkit`
   * の `InMemoryVectorStore` はそのまま保存して、`search` でその行の距離を `NaN` にする。
   * 2実装は揃っていない（`RecallQuery.vector` の doc の「覆えていない範囲」、
   * [Issue #1070](https://github.com/takecchi/mnemora/issues/1070)）。
   * この interface は長さの一致を検証しない——一致させるのは呼び出し側の責任だが、
   * 一致しなかったときに `search` が新しい例外を投げることはない。**`search` は候補を
   * 結果から落とさず、距離を比較が通らない値（`NaN`）にして返す**——
   * [ADR 0040](../../../../docs/decisions/0040-zero-vector-never-returned.md) の
   * ゼロベクトルと同じ契約の形であり、`recall()` の段2（ADR 0044）がこれを
   * `omitted.score_not_comparable` に数える。3実装（`packages/postgres` の pgvector 経由の
   * ゼロベクトル差し替え、`packages/testkit`/`packages/core` の Fake の長さ不一致検査）は
   * 同じ振る舞いをする（実装の詳細である `NaN` という値そのものは揃えない——ADR 0040
   * 決定1と同じ自由度）。**`query` が有限でない成分（`NaN`・`Infinity`）を含むときも
   * 同じく「比較不能」であり、`search` は例外を投げない**（埋め込み provider がクエリに
   * そうした値を返した場合。`PostgresVectorStore` は同じゼロベクトルへの差し替えで満たす）。
   *
   * **⚠ 距離が完全に一致する行が複数あるときの順序も、adapter の責務である**
   * （Issue #339 / [ADR 0170](../../../../docs/decisions/0170-association-search-tiebreak-nondeterminism.md)）。
   * `recall-runtime.ts` の段2（再スコア）・段3.5（連想枠、ADR 0151）は、どちらも
   * `search()` が返す配列の**先頭から `limit`/`maxCount` 件を切り詰める**——
   * `Array.prototype.sort` は安定（ES2019+）なので、距離が同点の候補は
   * `search()` が返した順序をそのまま保つ。⟹ **同点候補が adapter ごとに違う順序で
   * 返ると、`recall()` の結果が同じ入力・同じスコアに対して変わりうる。**
   *
   * `PostgresVectorStore` は距離 → `recorded_at` DESC → `memory_id` の3段で
   * tie-break する（`packages/postgres/src/vector-store.ts` のクラス doc 参照）。
   * **`memory_id` だけに頼る tie-break（ADR 0167 が最初に足した形）は不十分**
   * だった——`memory_id` はテナントの内容とは無関係な、ingest のたびに新しく
   * 振られる値であり、同一内容が重複記録される場面（例: `examples/chat` の
   * `compare` が使う合成会話）では、DB を作り直すたびに同点候補の並び順が変わる。
   * **adapter を新しく書くときは、距離だけでなく完全なタイブレークまで含めて
   * 決定的な順序を返すこと。**
   *
   * ⚠ **2026-09-28 追記（[Issue #1268](https://github.com/takecchi/mnemora/issues/1268)）: 距離はベクトルを float4 に
   * 丸めてから比べる。**`PostgresVectorStore`（pgvector の `vector` 型）は成分を float4 で持ち、クエリも float4 に
   * 変換する。`@mnemora/testkit` の `InMemoryVectorStore` も、保存するベクトルとクエリを `Math.fround` で丸める
   * （以前は丸めず、距離の差が float4 の桁より小さい2件の並びと、`limit` で切った集合が Postgres と割れていた）。
   * ⟹ **何が「距離の同点」になるかは、2実装で同じである。**ただし距離の値そのものの下の桁は揃わない
   * ——pgvector は積と和を float4 で重ねてから最後だけ倍精度で割り、fixture は丸めた成分を倍精度で計算する。
   * 【実測 2026-09-28】`vector-search-float4-tie.postgres.test.ts`（並びと同点）、
   * `in-memory-fixtures-vector-float4.test.ts`（fixture の丸め）、`recall-association-float4-parity.postgres.test.ts`
   * （同点を `search()` の順のまま保つ段3.5 の、`recall()` の最終の並びまで揃うこと）。
   */
  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]>;
  /**
   * 複数のクエリベクトルを、**同じ `opts`（`limit`・`filter`）で** `search()` した場合と
   * 同じ結果を、1回の往復に束ねて返す（連想枠のアンカーごとの ANN 検索、Issue #377）。
   *
   * **任意メソッドである。**`getVectors?`（下）と同じ判断——これが無くても `VectorStore`
   * としては成立する。`recall-runtime.ts` の段3.5（連想、ADR 0151）はこれが無い場合、
   * アンカーごとに `search()` を1回ずつ呼ぶ既存の経路（往復数がアンカー数に比例する）へ
   * 戻る——**正しさは変わらない。変わるのは往復数だけ。**
   *
   * **契約: 各 `queries[i]` に対する結果は、`search(ctx, space, queries[i].vector, opts)` を
   * 単独で呼んだ場合と、集合・順序ともに完全に一致しなければならない。** `filter`・`limit`
   * は全クエリで共通の1つだけを受け取る——`recall-runtime.ts` が段3.5で複数アンカーへ
   * 発行する `search()` 呼び出しは、`filter`/`limit` が全アンカーで同一で、変わるのは
   * クエリベクトルだけであるため（段0と同じ scope の filter を毎回同じ形で撒く設計、
   * ADR 0172/0286/0312/0323 の積み重ね）——クエリごとに違う `filter`/`limit` を渡したい
   * 呼び出しは、この口の対象外である（`search()` を個別に呼ぶこと）。
   *
   * **`queries` の `key` は呼び出し側が選ぶ不透明な識別子である**（`recall-runtime.ts` は
   * `MemoryId`＝アンカーの `memoryId` をそのまま使う）。返り値の `Map` は `queries` と
   * 同じ `key` の集合を持つ（`search()` と同じく、対応するクエリの結果が0件でも
   * `key` 自体はエントリとして存在する——`Map` から欠落するのは `queries` に無い
   * `key` だけ）。`queries` が空配列なら、空の `Map` を返す（往復を発生させる必要は無い）。
   *
   * **タイブレークの契約は `search()` と同じ**——`PostgresVectorStore.searchMany` は
   * 各クエリを独立した `search()` 呼び出しと同じ3段（距離 → `recorded_at` DESC →
   * `memory_id`、Issue #339 / ADR 0170）で並べる。
   *
   * **例外の有無も `search()` に揃える**（[Issue #1285](https://github.com/takecchi/mnemora/issues/1285)）:
   * `search()` が投げない入力では、`searchMany` も投げない。`key` はどんな文字列でもよい（NUL（U+0000）を含んで
   * いてもよい）——`PostgresVectorStore` は key を SQL に送らず、`queries` の添字で結果を引き直す。
   * `limit` の負数・非整数・`NaN`、filter の日時の Invalid Date では、`search()` と同じく投げる。
   * ⚠ 2026-09-28 までは `PostgresVectorStore` が key を `text` として SQL に送っていたので、NUL を含む key で
   * 投げていた（`search()` には key が無いので投げない）。
   *
   * **契約: `queries` に同じ `key` が2回以上あるときは、最後のクエリの結果だけを返す**（後勝ち、
   * [Issue #1284](https://github.com/takecchi/mnemora/issues/1284)）。それより前の同じ key のクエリは、結果に
   * 現れない。返す `Map` の並びは、その key が**最初に現れた位置**である——結果は
   * `new Map(queries.map((q) => [q.key, search(ctx, space, q.vector, opts)]))` と同じ。ただし、同じ key のうち
   * **前のクエリだけが投げる入力**（そのベクトルだけが DB に拒まれる値。float4 の範囲を超える有限の値など）では、
   * この式は投げるが、`searchMany` は投げずに返す——前のクエリは SQL に送らないため。
   * どの key の結果も、`search()` と同じく `limit` を超えない。投げる入力は、2026-09-28 より前と比べて減る側にしか
   * 変わらない（前のクエリのベクトルだけが DB に拒まれる値だった入力は、以前は投げ、今は投げない）。
   * `Runtime` はアンカーの `memoryId` を key にするので、同じ key を渡さない。
   * ⚠ 2026-09-28 までは、`PostgresVectorStore` がその key のクエリすべての結果を1つの配列に続けて積んでいた
   * （件数は結果の和で、`limit` を超えうる）。
   * 【実測 2026-09-28】`packages/postgres/src/__tests__/vector-search-many-diff.postgres.test.ts`
   * （`search()` を並べたものとの差分の歯。例外の有無も比べる。同じ key の場面は、上の `new Map(…)` と同じく畳んで比べる）。
   */
  searchMany?(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>>;
  /**
   * 対象の vector が存在しなければ何もしない（`void`、べき等）。`memoryId` が adapter
   * の期待する形式でない場合も同じ「何もしない」という結果になる。core の `MemoryId` は
   * 単なる `string` であり形式を強制しないため、adapter が期待する形式に合わない
   * `memoryId` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   */
  delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
  /**
   * `ctx.tenantId` に属する `memoryIds` の埋め込み行を、この adapter が持つ**全 space**
   * （`upsert`/`search` が `space` ごとに別々に区切っている単位のすべて）から消す
   * （Issue #1425、[ADR 0382](../../../../docs/decisions/0382-vector-store-delete-across-spaces.md)）。
   *
   * **必須メソッドである。** `Runtime.purge` が埋め込みモデルを移した後も残る旧 space の
   * 行を後始末するには、呼び出し側（`packages/core`）が「このテナントが過去に使った
   * space の一覧」を持たずに済む形——adapter 自身が知っている全 space を対象にする形
   * ——が要る。任意メソッドにすると、対応していない adapter では別 space の embedding が
   * 結局消えないという限界が残る（ADR 0382「検討した代替案」参照）。
   *
   * **契約**:
   * - 対象の行が存在しなければ何もしない（`void`、べき等）——`delete` と同じ
   *   「無い」の扱い。
   * - `memoryIds` に adapter の期待する形式でない id が混ざっていても、その id は
   *   「存在しない」の一種として扱い、例外を投げない（`delete` の `isUuidLike` と
   *   同じ規律）。
   * - `ctx.tenantId` に属さない行は消さない——他テナントの行が偶然同じ `memoryId` を
   *   持っていても触れない（`search`/`getVectors` と同じテナント境界）。
   * - `memoryIds` が空配列なら、何もせずに返る（往復を発生させる必要は無い）。
   * - 実装がテーブルを space ごとに分けていない（1テーブルに全 space を持つ）場合、
   *   このメソッドは実質 `delete` の全 space 版と同じ1回の削除になってよい——契約が
   *   要求するのは「呼び出し側が space を知らなくても全 space から消える」ことだけで、
   *   実装がテーブルを何本持つかは関知しない。
   */
  deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void>;
  /**
   * `ctx.tenantId` に属する行を、この adapter が持つ**全 space**から跡形なく消す
   * （Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）。
   * `deleteAcrossSpaces` が「特定の `memoryId` の集合」を対象にするのに対し、
   * こちらは「このテナントの行全部」が対象——`packages/core/src/erase-tenant.ts` の
   * 独立関数 `eraseTenant` が、`MemoryStore.eraseTenant?`/`OutboxStore.eraseTenant?`/
   * `TenantSettingsStore.eraseTenant?` と束ねて呼ぶ4つの口の1つ。
   *
   * 🔴 **任意メソッドである。**必須にすると `VectorStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる——`deleteAcrossSpaces`（決定的に必須にした ADR 0382）とは
   * 判断が違う。**理由**: `deleteAcrossSpaces` は `Runtime.purge`（既存の、日常的に
   * 呼ばれる操作）の一部として「対応していない adapter では別 space の embedding が
   * 結局消えない」という限界が常時効いてしまうため必須にしたが、`eraseTenant`（この
   * 独立関数）はテナント消去というまれな操作であり、対応していない adapter は
   * `eraseTenant`（独立関数）の `{ kind: "store_unsupported" }` で名指しされる——
   * 「口が無い」ことが呼び出し側に見える形で伝わり、劣化した代替を試みることもない
   * （ADR 0050 が必須化した理由が当たらない構造は `MemoryStore.eraseTenant` の doc
   * コメントと同じ）。破壊的変更の許可自体は v1.X.0 で出ている
   * （オーナー回答 ask_human 6911db12）が、対応していない第三者 adapter を壊す理由が
   * ここでは弱い、とADR 0383が判断した。
   *
   * **契約**:
   * - `opts.limit` を目安に、adapter が持つ全 space のテーブルから、このテナントの行を
   *   削除する。space 間の順序は問わない——space どうしは互いを参照しない。
   * - `opts.dryRun === true` のときは削除を一切行わず、削除していたら消えていたであろう
   *   件数だけを返す。
   * - `result.reachedLimit === true` なら、呼び出し側は同じ `opts` で呼び直すこと。
   *   何度呼んでも安全（空になった space は0件を返すだけ）。
   * - `ctx.tenantId` に属さない行は消さない（`delete`/`deleteAcrossSpaces` と同じ
   *   テナント境界）。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult>;
  /**
   * アンカーとなる Memory のベクトルをまとめて取得する（連想枠、Issue #200）。
   *
   * **任意メソッドである。**`MemoryStore.purgeMemory?`/`purgeExpiredEvents?`/
   * `archiveDecayed?`（`packages/core/src/interfaces/memory-store.ts`）と同じ判断——
   * これが無くても `VectorStore` としては成立する。`recall-runtime.ts` の段3.5
   * （連想）はこれが無い場合、`omitted` に
   * `stage_skipped{stage:"association", reason:"vector_store_lacks_get_vectors"}`
   * を積んでスキップするだけであり、`recall()` 自体はそのまま成立する
   * （北極星の問い2「これを無効にしても Memory Framework として成立するか」を
   * 型で担保する）。
   *
   * **存在しない `memoryId` は黙って結果から落とす。**`MemoryStore.getMany` と同じ
   * 「存在しないものは存在しないの一種」の扱い（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）——呼び出し全体を弾かない。`memoryIds` のうち
   * adapter の期待する形式でないものも、無い id と同じく静かに結果から落とす。
   * 全件が存在しない/形式に合わなければ空配列を返す。
   *
   * **tenant 境界を必ず掛けること。**`ctx.tenantId` に属さない `memoryId` は、
   * それが実在しても「存在しない」と同じ扱い（返さない）——`search` が
   * `filter.tenantId` と AND で掛ける `ctx.tenantId` と同じ境界であり（Issue #1050）、
   * これを緩めると連想の段がテナントを跨いで記憶を漏らす経路になる。
   *
   * 返す順序は `memoryIds` の順序と一致している必要はない——呼び出し側
   * （`recall-runtime.ts`）は `memoryId` をキーに引き直す。
   */
  getVectors?(ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]): Promise<VectorEntry[]>;
}
