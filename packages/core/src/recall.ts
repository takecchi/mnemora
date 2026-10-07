import { z } from "zod";
import { AttributesSchema, StoredAttributesSchema } from "./attributes.js";
import type { Attributes } from "./attributes.js";
import type { MemoryId, RecallId } from "./ids.js";
import { ProvenanceKindSchema } from "./provenance.js";
import type { ProvenanceKind } from "./provenance.js";
import { TIME_WEIGHTING_POLICIES } from "./strategies/scoring.js";
import type { TimeWeightingPolicy } from "./strategies/scoring.js";

/**
 * 件数そのものの「無いの種類」（docs/recall.md §4）。
 * 推定値を実測値の顔で出さない、という原則の実装。
 */
export type CountKind = "exact" | "lower_bound" | "unknown";

/** `CountKind` の zod スキーマ。値を実行時に検査するときに使う（型 `CountKind` と揃えてある）。 */
export const CountKindSchema = z.enum([
  "exact",
  "lower_bound",
  "unknown",
]) satisfies z.ZodType<CountKind>;

/**
/**
 * `stage_skipped` の `reason` が `"embedding_provider_unavailable"` のときだけ付きうる、失敗の原因の種類。
 * **message・cause の本文・ベクトルの値は載せない**（利用者データや内部情報が混ざりうるため）。
 * 載るのは種類と、投げられた値の `kind` / `name`（文字列のときだけ、先頭64文字まで）だけ。
 *
 * - `"provider_threw"`: `EmbeddingProvider.embed` が throw / reject した。`embeddingProvider` が配線されて
 *   いないときも（`embed` を呼べず `TypeError` になるため）ここに入り、`errorName` が `"TypeError"` になる。
 * - `"no_vector"`: reject せず、ベクトルを返さなかった（`[]`、または配列でない要素）。
 * - `"dimension_mismatch"`: `space.dimensions` と長さが違うベクトルを返した。
 * - `"non_finite"`: `NaN` / `Infinity` を含むベクトルを返した。
 *
 * `providerErrorKind` は、投げられた値が文字列の `kind` を持つときだけ入る（`@mnemora/local-embedding` の
 * `LocalEmbeddingProviderError` など。`@mnemora/openai` の embed の失敗は `kind` を持たない）。
 * `errorName` は投げられたものが `Error` のときの `name`。どちらも `kind: "provider_threw"` のときだけ入る。
 */
export interface StageSkippedCause {
  kind: "provider_threw" | "no_vector" | "dimension_mismatch" | "non_finite";
  providerErrorKind?: string;
  errorName?: string;
}

/** 段そのものを実行しなかった（docs/recall.md §4）。「実行して0件だった」ではない。 */
export interface StageSkippedOmission {
  /** 常に `"stage_skipped"`（{@link Omission} の判別の鍵）。 */
  kind: "stage_skipped";
  /** 実行しなかった段（`candidate_generation` は段1、`rescore` は段2、`index_band` は段5、`association` は段3.5、`relation` は段3）。 */
  stage: "candidate_generation" | "rescore" | "index_band" | "association" | "relation";
  /**
   * `"vector_store_lacks_get_vectors"` / `"no_anchor"` は連想枠専用（`stage: "association"` のときだけ）。
   * - `"vector_store_lacks_get_vectors"`: `deps.vectorStore.getVectors`（任意メソッド）が実装されておらず、
   *   `query.association` を渡しても連想は実行されない。
   * - `"no_anchor"`: `getVectors` はあるが、段3までに残った候補（アンカー候補）が0件だった。
   *
   * 連想を走らせて0件だったときはこの omission を積まない。`stage_skipped` は常に「実行しなかった」ことの札。
   *
   * `"relation_store_unavailable"` は段3（必須の同伴取得、ADR 0292 決定3-b、ADR 0381）専用
   * （`stage: "relation"` のときだけ）。`withinLimit` に `status === 'contested'` かつ
   * `contestedWithId === null`（多者間の群のメンバー）が1件以上あるのに `deps.relationStore` が
   * 配線されていない場合に積む。その候補は単独の `contested` として単位を組めず落ちる
   * （`unit_assembly_dropped`）。候補が無ければ積まない。
   */
  reason:
    | "embedding_provider_unavailable"
    | "empty_query_content"
    | "vector_store_lacks_get_vectors"
    | "no_anchor"
    | "relation_store_unavailable";
  /**
   * 失敗の原因の種類（任意）。**`reason: "embedding_provider_unavailable"` のときだけ付きうる**
   * （`empty_query_content` などには付かない）。型と載せないものは {@link StageSkippedCause}。
   */
  cause?: StageSkippedCause;
}

/**
 * `FilteredOmission.condition` が分かれる2つの群の名前（ADR 0174）。
 *
 * - `"outside_scope"` — 問うている切り口そのものを定義するゲート（`expired`/`not_yet_valid` など）で落ちた。
 *   `IndexBand.totalInScope` から**引かれる**。
 * - `"within_scope"` — スコープの中に居るまま、到達しにくさのゲート（`decayed`）で落ちた。
 *   `totalInScope` から**引かれない**。
 *
 * `decayed` を `"outside_scope"` 側に置くと、減衰した記憶が `totalInScope` からも目次帯からも消え、
 * 呼び手から見て減衰が削除と区別できなくなる（`docs/north-star.md`「消えるのではなく、遠ざかる」に反する）。
 * 真偽値にせず名前のある値にしたのは、`superseded`/`forgotten` を分けたとき（ADR 0027）と同じ理由。
 */
export type ScopeRelation = "outside_scope" | "within_scope";

/** `ScopeRelation` の zod スキーマ。値を実行時に検査するときに使う（型 `ScopeRelation` と揃えてある）。 */
export const ScopeRelationSchema = z.enum([
  "outside_scope",
  "within_scope",
]) satisfies z.ZodType<ScopeRelation>;

/** 条件（status・期間・主題など）で落ちた候補（docs/recall.md §4）。条件ごとに1件ずつ返す。 */
export interface FilteredOmission {
  /** 常に `"filtered"`（{@link Omission} の判別の鍵）。 */
  kind: "filtered";
  /**
   * 落ちた条件。
   *
   * - `"superseded"` と `"forgotten"` は分けて持つ（ADR 0027）。`superseded` は置き換えという機構の都合
   *   （`superseded_by_id` で辿れる）、`forgotten` は利用者が明示的に忘れさせた製品の振る舞い。
   *   束ねると、呼び出し側がどちらかを判定できなくなる。
   * - **`"tenant"` は union に在るが、生成するコードが無い。意図的に、恒久的に来ない**（ADR 0117）。
   *   tenant はスコープの外側の境界で、`filtered` としては報告しない（`ScopeAggregate` の doc）。
   * - `"taxonomy"`: `RecallQuery.labels` による絞り込みが落とした Memory を数える（ADR 0318、ADR 0323）。
   * - `"decayed"`（ADR 0153）: `decayFloorAt` を過ぎた Memory。`"archived"` に相乗りさせない。
   *   `archived` は `status` 列のゲート、`decayed` は `decay_floor_at` 列のゲートで、次の一手も違う
   *   （`archived` は `restoreArchived`、`decayed` は強化すれば `decayFloorAt` が延びて次の recall で当たらなくなる）。
   *   `countKind` は常に `"exact"`（ADR 0173）。件数は `ScopeAggregate.filteredDecayed` が、段1へ押し下げているのと
   *   同じ述語で数える。「ANN が k' の窓の中で落とした件数」ではない（窓の内側の件数は ADR 0011 の限界として不明）。
   *   `scopeRelation` は `"within_scope"` で、`IndexBand.totalInScope` から除かれない。
   * - `"expired"`: `validUntil <= validAt`。`"not_yet_valid"`: `validFrom > validAt`
   *   （`RecallQuery.validAt` ゲート、既定 `now`）。1つの `"invalid"` に束ねない（ADR 0027 と同じ判断）。
   *   `countKind` は常に `"exact"`（段1へ押し下げているため `aggregateScope` で厳密集計できる）。
   */
  condition:
    | "tenant"
    | "superseded"
    | "forgotten"
    | "archived"
    | "taxonomy"
    | "period"
    | "decayed"
    | "expired"
    | "not_yet_valid";
  /**
   * この `condition` が `IndexBand.totalInScope` の内側と外側のどちらの群に属するか（ADR 0174）。
   * 決める唯一の場所は `FILTERED_CONDITION_SCOPE_RELATION`（式を2箇所に書くとずれる。ADR 0038）。
   */
  scopeRelation: ScopeRelation;
  /** この種類で落ちた候補の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/**
 * `FilteredOmission.condition` のどの値がどちらの `ScopeRelation` かを決める唯一の場所（ADR 0174）。
 * `omitted` を組み立てる側（`recall-runtime.ts`）はここから読むだけにする。式を2箇所に書くと、
 * 片方だけ直して黙ってずれる（ADR 0038）。
 *
 * `Record<FilteredOmission["condition"], ScopeRelation>` の型が、`condition` に値を足したときの更新漏れを
 * 型エラーにする。
 *
 * - `decayed` → `"within_scope"`、それ以外 → `"outside_scope"`（理由は `ScopeRelation`）。
 */
export const FILTERED_CONDITION_SCOPE_RELATION: Record<
  FilteredOmission["condition"],
  ScopeRelation
> = {
  tenant: "outside_scope",
  superseded: "outside_scope",
  forgotten: "outside_scope",
  archived: "outside_scope",
  taxonomy: "outside_scope",
  period: "outside_scope",
  expired: "outside_scope",
  not_yet_valid: "outside_scope",
  decayed: "within_scope",
};

/**
 * **排他性契約（[ADR 0203](../../../docs/decisions/0203-memories-omitted-exclusivity.md)）:
 * `nearMisses`（および `count` が数える集合）は、`RecallResult.memories` に実際に返った memoryId を含まない。**
 * 段3.5（連想）や段3（必須の同伴取得）が候補を後から `memories` へ昇格させたときは、昇格した分を
 * `count`/`nearMisses` の両方から取り下げる。
 */
export interface BelowThresholdOmission {
  /** 常に `"below_threshold"`（{@link Omission} の判別の鍵）。 */
  kind: "below_threshold";
  /** 段2の閾値を下回って落ちた候補の件数（`memories` へ昇格した分は取り下げる。上の doc）。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
  /**
   * **`count` 全件のサンプルではない。** `belowThreshold` のうち上位5件だけを積む（ADR 0203）。
   * 6件目以降は `count` にだけ数として残り、個体としては現れない。
   */
  nearMisses?: { memoryId: MemoryId; score: number }[];
}

/**
 * **`stage`（[ADR 0188](../../../docs/decisions/0188-association-over-limit-omission.md)）**:
 * この上限切り捨てがどの段で起きたかを言う。次の一手を変える欄なので必須。
 *
 * - `"rescore"` — 段2。`RecallQuery.limit` を超えた分。次の一手: `limit` を増やす、あるいはページングする。
 * - `"association"` — 段3.5。`RecallAssociationQuery.maxCount` を超えた分。次の一手: `maxCount` を増やす
 *   （`limit` を増やしても直らない）。
 * - `"relation"`（ADR 0292 決定3-a、ADR 0381）— 段3。多者間の `contested` 群が群ごとの上限件数
 *   （{@link RecallQuery.relationMaxCount}、省略時は {@link DEFAULT_RECALL_ASSOCIATION}.maxCount と同じ値）を
 *   超えた分。次の一手: `RecallQuery.relationMaxCount` を増やす（ADR 0396）。`limit` や
 *   `association.maxCount` を増やしても直らない。
 */
export interface OverLimitOmission {
  /** 常に `"over_limit"`（{@link Omission} の判別の鍵）。 */
  kind: "over_limit";
  /** どの段の上限で切られたか（上の doc）。 */
  stage: "rescore" | "association" | "relation";
  /** 上限を超えて落ちた候補の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/** 返却量の予算（`RecallQuery.budget`）に収まらず落ちた候補（docs/recall.md §4）。スコアではなく量の問題である。 */
export interface BudgetDroppedOmission {
  /** 常に `"budget_dropped"`（{@link Omission} の判別の鍵）。 */
  kind: "budget_dropped";
  /** この種類で落ちた候補の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/**
 * `not_indexed` の理由。`embeddingStatus` のうち `'ready'` 以外の3値に対応する。
 * 区別があると次の一手が変わるので分ける（ADR 0008）: `pending` は待てば解決する、`failed` はパイプラインの調査が要る、
 * `skipped` は意図した除外なので何もしなくてよい。
 *
 * `failed` でも、ベクトル行が在ることがある（ADR 0053 の追記）。埋め込みジョブが `VectorStore.upsert` を終えた後の
 * `ready` の書き込み（または ANALYZE）が失敗すると `failed` が書かれ、その記憶は `memories` に返りつつ同じ呼び出しの
 * `not_indexed{ reason: "failed" }` にも数えられる。`Runtime.reembed(ctx, { statuses: ["failed"], limit })` で
 * 積み直してジョブを処理すれば `ready` に戻る。
 */
export type NotIndexedReason = "pending" | "failed" | "skipped";

/** `NotIndexedReason` の zod スキーマ。値を実行時に検査するときに使う（型 `NotIndexedReason` と揃えてある）。 */
export const NotIndexedReasonSchema = z.enum([
  "pending",
  "failed",
  "skipped",
]) satisfies z.ZodType<NotIndexedReason>;

/** 記憶は在るが、埋め込みが無いので ANN で引けなかった候補（docs/recall.md §4）。記憶が失われたのではない。 */
export interface NotIndexedOmission {
  /** 常に `"not_indexed"`（{@link Omission} の判別の鍵）。 */
  kind: "not_indexed";
  /** なぜ索引に載っていないか。理由ごとに1件ずつ返す（`filtered` の `condition` と同じ形）。 */
  reason: NotIndexedReason;
  /** この `reason` の Memory の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/**
 * この札が立っている理由（[ADR 0069](../../../docs/decisions/0069-ann-truncated-says-nothing-about-loss.md)）。
 *
 * 「証明できたので立てない」はこの union に無い。証明できた場合は omission を積まない
 * （沈黙は「値」ではなく「不在」で表す）。値にすると「安全だと分かった」と「判定できなかった」が同じ形で返る。
 */
export type AnnTruncationCertainty = "loss_possible" | "undecidable";

/** ANN の窓（k'）の外に、本来 top-k に入るべき候補が残っていたかもしれない（docs/recall.md §4、ADR 0069）。証明できたときは積まない。 */
export interface AnnTruncatedOmission {
  /** 常に `"ann_truncated"`（{@link Omission} の判別の鍵）。 */
  kind: "ann_truncated";
  /** 常に `"unknown"`（件数は分からない）。 */
  countKind: "unknown";
  /**
   * なぜこの札が立っているか（ADR 0069）。
   * - `loss_possible` — 窓の外の候補が top-k へ入りえた。`safetyRatio` が付く。
   * - `undecidable` — 判定そのものができなかった（上界が宣言されていない等）。「損しなかった」ではない。
   *   `undecidableReason` が付く。
   */
  certainty: AnnTruncationCertainty;
  /**
   * `R = bar / (sim_k' × M_max)`。**`certainty: 'loss_possible'` のときだけ在り、必ず 1 未満。**
   * 1 以上なら窓の外は原理的に top-k へ入れず、この omission 自体が積まれない。
   * **小さいほど危ない**（0.5 なら「窓の外の候補が非 similarity 項で2倍稼げば入れた」）。
   */
  safetyRatio?: number;
  /**
   * この判定が立っている前提（ADR 0069 §6・§8）。検証できていないものを含む。
   * 空配列は「前提なしの保証」を意味する。
   */
  assumptions?: readonly string[];
  /** `certainty: 'undecidable'` のときだけ。**なぜ判定できなかったか。** */
  undecidableReason?: string;
}

/**
 * 近似索引（ANN）が、scope 内にまだ見られていない候補を残したことの報告
 * （[ADR 0026](../../../docs/decisions/0026-ann-unreached-omission.md)、
 * [ADR 0193](../../../docs/decisions/0193-ann-unreached-covers-full-window.md)）。
 *
 * `ann_truncated` とは別の問いに答える。あちらは「窓の外は k 位を抜けないと証明できるか」で、その証明は
 * 窓の中身が scope の真の上位 k' 件であることを前提にする。こちらは「近似索引は scope の候補を拾いきったか」で、
 * 窓が満杯でも拾いきれているとは限らない（`ann-truncation.ts`）。窓の満杯/未満を問わず判定するので、
 * `ann_truncated` と `ann_unreached` は同時に立ちうる。
 *
 * **件数を持たせない。`countKind` は常に `'unknown'`。** ANN が触れなかった候補を数えるには scope 全体を
 * 厳密に走査する必要があり、それでは ANN を使う意味が無くなる。新しい語彙を作らず、既にある `'unknown'` で
 * 「取りこぼしたのは確かだが、何件かは分からない」とだけ言う。
 *
 * `severity` は任意（[ADR 0288](../../../docs/decisions/0288-ann-unreached-severity.md)）。返り値型への必須
 * フィールドの追加は破壊的変更に数える（`docs/migration-v1.md` 項目9・10、ADR 0178）ので、型は任意にして
 * runtime は必ず値を入れる（ADR 0282 と同じ形）。
 */
export interface AnnUnreachedOmission {
  /** 常に `"ann_unreached"`（{@link Omission} の判別の鍵）。 */
  kind: "ann_unreached";
  /** 常に `"unknown"`（件数は分からない）。 */
  countKind: "unknown";
  /** どの程度拾いきれなかったか（{@link AnnUnreachedSeverity}）。 */
  severity?: AnnUnreachedSeverity;
}

/**
 * {@link AnnUnreachedOmission.severity} の値（[ADR 0288](../../../docs/decisions/0288-ann-unreached-severity.md)）。
 *
 * - `"warning"`: ANN 窓が実際に到達可能な下限（`annStageTrace.detail` の `annReturnedFewerThanReachable` と同じ式）
 *   に届かなかった。
 * - `"info"`: それ以外。窓は満杯で、`eligible > kPrime` という構造だけで鳴っている。
 *
 * `"info"` は「損が無い」の保証ではない。窓を満杯にしたまま真の近傍を取りこぼす事象は射程の外（ADR 0288）。
 */
export type AnnUnreachedSeverity = "info" | "warning";

/**
 * 段2の閾値比較が**どちらにも決まらなかった**候補（[ADR 0044](../../../docs/decisions/0044-score-not-comparable-omission.md)）。
 *
 * `total >= scoreThreshold` で残す側と `total < scoreThreshold` で `below_threshold` に数える側は補集合ではない。
 * どちらかの値が `NaN` だと両方の比較が false になり、`omitted` が空でも取りこぼしが無いとは言えなくなる。
 * `ann_unreached` と違って件数は数えられる。`countKind` はリテラルで名乗らず、三分割が網羅であることの
 * 確認結果から引き継ぐ。
 */
export interface ScoreNotComparableOmission {
  /** 常に `"score_not_comparable"`（{@link Omission} の判別の鍵）。 */
  kind: "score_not_comparable";
  /** スコアが閾値と比較できなかった（`NaN` など）候補の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/**
 * 段3で組んだ「単位」から、候補が**どの単位にも入らないまま消えた**ことの報告
 * （[ADR 0043](../../../docs/decisions/0043-unit-assembly-dropped-omission.md)）。
 *
 * 段3は `contested` の対向を同伴させるために候補を単位にまとめる。その繰り返しは `contestedWithId` が一対一であることを
 * 前提にしており（`docs/memory-model.md` §5）、破れていると候補が返り値にも他のどの `omitted` にも現れず黙って消える。
 * この欄は「黙らせない」ためだけに在り、消えたことの良し悪しは決めない。
 *
 * `countKind` は `'lower_bound'`（別の候補が二重に単位へ入っているとその分の消失が隠れる）。
 */
export interface UnitAssemblyDroppedOmission {
  /** 常に `"unit_assembly_dropped"`（{@link Omission} の判別の鍵）。 */
  kind: "unit_assembly_dropped";
  /** 段3で単位を組むときに漏れた候補の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}。推定を実測の顔で出さない）。 */
  countKind: CountKind;
}

/**
 * 語彙チャンネルが窓（k'）を埋めたまま打ち切ったことの報告（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md) §7）。
 *
 * `ann_truncated` に相乗りさせない。あちらは `safetyRatio` による損失可能性の判定まで作り込んだ札で
 * （[ADR 0069](../../../docs/decisions/0069-ann-truncated-says-nothing-about-loss.md)）、語彙チャンネルにはその機構が無い。
 * 同じ札にすると「証明を試みた結果」と「証明の機構を持たない」が同じ顔で返る。
 *
 * 件数を持たない。`countKind` は常に `'unknown'`（窓の外の件数には全件を数え直す必要がある。ADR 0011、ADR 0024）。
 */
export interface LexicalTruncatedOmission {
  /** 常に `"lexical_truncated"`（{@link Omission} の判別の鍵）。 */
  kind: "lexical_truncated";
  /** 常に `"unknown"`（件数は分からない）。 */
  countKind: "unknown";
}

/** recall が返さなかったものの理由（docs/recall.md §4、ADR 0008）。`kind` で判別する。 */
export type Omission =
  | StageSkippedOmission
  | FilteredOmission
  | BelowThresholdOmission
  | OverLimitOmission
  | BudgetDroppedOmission
  | NotIndexedOmission
  | AnnTruncatedOmission
  | AnnUnreachedOmission
  | LexicalTruncatedOmission
  | ScoreNotComparableOmission
  | UnitAssemblyDroppedOmission;

export const StageSkippedCauseSchema = z.object({
  kind: z.enum(["provider_threw", "no_vector", "dimension_mismatch", "non_finite"]),
  providerErrorKind: z.string().optional(),
  errorName: z.string().optional(),
}) satisfies z.ZodType<StageSkippedCause>;

const StageSkippedOmissionSchema = z.object({
  kind: z.literal("stage_skipped"),
  stage: z.enum(["candidate_generation", "rescore", "index_band", "association", "relation"]),
  reason: z.enum([
    "embedding_provider_unavailable",
    "empty_query_content",
    "vector_store_lacks_get_vectors",
    "no_anchor",
    "relation_store_unavailable",
  ]),
  cause: StageSkippedCauseSchema.optional(),
}) satisfies z.ZodType<StageSkippedOmission>;

const FilteredOmissionSchema = z.object({
  kind: z.literal("filtered"),
  condition: z.enum([
    "tenant",
    "superseded",
    "forgotten",
    "archived",
    "taxonomy",
    "period",
    "decayed",
    "expired",
    "not_yet_valid",
  ]),
  scopeRelation: ScopeRelationSchema,
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<FilteredOmission>;

const BelowThresholdOmissionSchema = z.object({
  kind: z.literal("below_threshold"),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
  nearMisses: z.array(z.object({ memoryId: z.string().min(1), score: z.number() })).optional(),
}) satisfies z.ZodType<BelowThresholdOmission>;

const OverLimitOmissionSchema = z.object({
  kind: z.literal("over_limit"),
  stage: z.enum(["rescore", "association", "relation"]),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<OverLimitOmission>;

const BudgetDroppedOmissionSchema = z.object({
  kind: z.literal("budget_dropped"),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<BudgetDroppedOmission>;

const NotIndexedOmissionSchema = z.object({
  kind: z.literal("not_indexed"),
  reason: NotIndexedReasonSchema,
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<NotIndexedOmission>;

const AnnTruncatedOmissionSchema = z.object({
  kind: z.literal("ann_truncated"),
  countKind: z.literal("unknown"),
  certainty: z.enum(["loss_possible", "undecidable"]),
  // 3欄は「その certainty のときだけ在る」が、zod では相関を強制しない。相関は `decideAnnTruncation` が
  // 構成するときに満たしており、`superRefine` を重ねると同じ規則が2箇所に載って食い違いうる（ADR 0011）。
  safetyRatio: z.number().optional(),
  assumptions: z.array(z.string()).readonly().optional(),
  undecidableReason: z.string().optional(),
}) satisfies z.ZodType<AnnTruncatedOmission>;

/** `AnnUnreachedSeverity` の zod スキーマ。 */
export const AnnUnreachedSeveritySchema = z.enum([
  "info",
  "warning",
]) satisfies z.ZodType<AnnUnreachedSeverity>;

const AnnUnreachedOmissionSchema = z.object({
  kind: z.literal("ann_unreached"),
  countKind: z.literal("unknown"),
  // ADR 0288: 任意欄（非破壊。docs/migration-v1.md 項目9・10、ADR 0178）。
  severity: AnnUnreachedSeveritySchema.optional(),
}) satisfies z.ZodType<AnnUnreachedOmission>;

const LexicalTruncatedOmissionSchema = z.object({
  kind: z.literal("lexical_truncated"),
  countKind: z.literal("unknown"),
}) satisfies z.ZodType<LexicalTruncatedOmission>;

const ScoreNotComparableOmissionSchema = z.object({
  kind: z.literal("score_not_comparable"),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<ScoreNotComparableOmission>;

const UnitAssemblyDroppedOmissionSchema = z.object({
  kind: z.literal("unit_assembly_dropped"),
  count: z.number().int().positive(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<UnitAssemblyDroppedOmission>;

export const OmissionSchema = z.discriminatedUnion("kind", [
  StageSkippedOmissionSchema,
  FilteredOmissionSchema,
  BelowThresholdOmissionSchema,
  OverLimitOmissionSchema,
  BudgetDroppedOmissionSchema,
  NotIndexedOmissionSchema,
  AnnTruncatedOmissionSchema,
  AnnUnreachedOmissionSchema,
  LexicalTruncatedOmissionSchema,
  ScoreNotComparableOmissionSchema,
  UnitAssemblyDroppedOmissionSchema,
]) satisfies z.ZodType<Omission>;

/**
 * `key` は `string | null`。`subject_id IS NULL` の群（`axis: 'subject'`）や、参加資格のあるラベルを1つも持たない群
 * （`axis: 'taxonomy'` の残差群）を表す。`'(none)'` のような番兵文字列は実在する subject 名・ラベル名と衝突しうるので採らない。
 *
 * `axis: 'taxonomy'` は `RecallQuery.taxonomyGroups: true` を渡したときだけ生成される（既定は `"subject"` のみ。ADR 0323）。
 *
 * **被覆不変条件は軸で違う。** `axis: 'subject'` の `count` の総和は必ず `totalInScope` と一致する
 * （1 Memory が持つ主題は高々1つ）。**`axis: 'taxonomy'` は多対多なので、`count` の単純合計は `totalInScope` と
 * 一致しない（超えうる）。** 保証されるのは「取りこぼしが無いこと」で、スコープ内の Memory は必ず
 * (a) 少なくとも1つのラベル群、または (b) 残差群（`key: null`）のどちらかに数えられる（(a)(b) は排他的、
 * ラベル群どうしは排他的ではない）。詳細は ADR 0323「決定6」、`docs/recall.md` §5。
 */
export interface GroupCount {
  /** 何で群に分けたか（`subject` は主題、`taxonomy` はラベル）。 */
  axis: "subject" | "taxonomy";
  /** 群の鍵（主題の id、またはラベルの名前）。`null` は主題の無い群・どのラベルにも入らない残差群。 */
  key: string | null;
  /** この群に入るスコープ内の Memory の件数。 */
  count: number;
  /** `count` がどこまで正確か（{@link CountKind}）。 */
  countKind: CountKind;
}

/** `GroupCount` の zod スキーマ。 */
export const GroupCountSchema = z.object({
  axis: z.enum(["subject", "taxonomy"]),
  key: z.string().nullable(),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<GroupCount>;

/** 目次帯の1行（recall.md §5）。 */
export interface DigestEntry {
  /** 帯に載せた Memory の id。 */
  memoryId: MemoryId;
  /** その Memory の `digest`（`truncated` なら切り詰めたもの）。 */
  digest: string;
  /** 帯に載せる際に DIGEST_BAND_MAX_ENTRY_CHARS で切り詰めた場合のみ true。切っていなければ省略する。 */
  truncated?: boolean;
}

/** `DigestEntry` の zod スキーマ。 */
export const DigestEntrySchema = z.object({
  memoryId: z.string().min(1),
  digest: z.string(),
  truncated: z.boolean().optional(),
}) satisfies z.ZodType<DigestEntry>;

/** 目次帯がどの上限で切れたか。`both` は同じ件で件数上限と文字数予算の両方に同時に当たったとき。 */
export type DigestBandLimitedBy = "entry_limit" | "char_budget" | "both";

/** `DigestBandLimitedBy` の zod スキーマ。 */
export const DigestBandLimitedBySchema = z.enum([
  "entry_limit",
  "char_budget",
  "both",
]) satisfies z.ZodType<DigestBandLimitedBy>;

/**
 * 目次帯の被覆度（recall.md §5、ADR 0008）。
 *
 * 2階建てを潰さない（`'none'` というリテラルを足して1つの値にしない）:
 * - `IndexBand.digestBandCoverage` 自体が無い ＝ 帯を作っていない。
 * - `digestBandCoverage` は在るが `limitedBy` が無い ＝ 帯を作ったが、どの上限にも当たらなかった（候補が全件載った）。
 *
 * 潰すと「帯を作らなかった」と「帯を作ったうえで空だった／全部載った」が区別できなくなる。
 */
export interface DigestBandCoverage {
  /** 実際に帯へ載せた件数。 */
  shown: number;
  /** 帯に載せる資格があった件数（スコープ内 かつ `memories` に返していないもの）。 */
  eligible: number;
  /** `eligible` の信頼度。 */
  countKind: CountKind;
  /** どの上限で切れたか。切れていなければ省略する。 */
  limitedBy?: DigestBandLimitedBy;
}

/** `DigestBandCoverage` の zod スキーマ。 */
export const DigestBandCoverageSchema = z.object({
  shown: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  countKind: CountKindSchema,
  limitedBy: DigestBandLimitedBySchema.optional(),
}) satisfies z.ZodType<DigestBandCoverage>;

/** 目次帯（段5、docs/recall.md §5）——返さなかった分も含めた、スコープ全体の群ごとの件数と要旨。 */
export interface IndexBand {
  /** 群ごとの件数（{@link GroupCount}）。 */
  groups: GroupCount[];
  /** スコープ内の Memory の総数。 */
  totalInScope: number;
  /** `totalInScope` がどこまで正確か（{@link CountKind}）。 */
  countKind: CountKind;
  /**
   * `recall()` が返さなかった Memory（スコープ内だが `memories` に載っていないもの）の1件1行の要旨。
   * `memories` に入った分は `RecalledMemory.digest` に在るので載せない（`excludeMemoryIds` で除く）。
   * 決定的な順序で、`digestBandCoverage` の被覆規則に従って切り詰めたもの。
   */
  digestBand?: DigestEntry[];
  /** `digestBand` の被覆度。`digestBand` を組んだときだけ在る。 */
  digestBandCoverage?: DigestBandCoverage;
}

/** `IndexBand` の zod スキーマ。 */
export const IndexBandSchema = z.object({
  groups: z.array(GroupCountSchema),
  totalInScope: z.number().int().nonnegative(),
  countKind: CountKindSchema,
  digestBand: z.array(DigestEntrySchema).optional(),
  digestBandCoverage: DigestBandCoverageSchema.optional(),
}) satisfies z.ZodType<IndexBand>;

/**
 * `RecallQuery.digestBandLimit` の既定値（帯に載せる件数の上限）。
 *
 * この値が実際に帯を止めるとは限らない。帯は、この件数上限と {@link DIGEST_BAND_MAX_CHARS}
 * （呼び出し側からは変えられない）の**先に当たったほう**で切れる（`packDigestBand`）。
 * digest が長いテナントほど、この値に届く前に {@link DIGEST_BAND_MAX_CHARS} が先に効く
 * （`docs/recall.md` §6「目次帯の量を把握し、調整する」）。
 * どちらが効いたかは `IndexBand.digestBandCoverage.limitedBy` で読める。
 */
export const DEFAULT_DIGEST_BAND_LIMIT = 50;

/**
 * 帯全体の文字数予算。呼び出し側からは変えられない（`RecallQuery` に欄を持たない）。
 * `digestBandLimit` にどれだけ大きい値を渡されても、帯全体はこれを超えない。
 * digest が短くない限り、実際に帯を止めているのはこちらで、`digestBandLimit` を下げても帯は縮まないことが多い
 * （{@link DEFAULT_DIGEST_BAND_LIMIT}、`docs/recall.md` §6）。
 */
export const DIGEST_BAND_MAX_CHARS = 4000;

/**
 * 帯に載せる1件の digest の文字数上限。呼び出し側からは変えられない。この値で切り詰められた digest は
 * `truncated: true` を持つ。
 *
 * **暫定値。** 実 digest の長さの実測が足りず、この値を弁別できない。見直す根拠は「多くの digest がこの値の前後で
 * 切られている」という実測であり、勘で変えない。
 */
export const DIGEST_BAND_MAX_ENTRY_CHARS = 120;

/**
 * `recall()` のスコープ = tenant + subject + 時間窓(period) + taxonomy + status ゲート（docs/recall.md §2 段0・§5）。
 *
 * - tenant と subject はスコープの外側の境界で、`filtered` としては報告しない（呼び出し側が明示した境界の外は
 *   「失われた」のではなく「そもそも問うていない」）。`FilteredOmission.condition` の `"tenant"` は union に在るが
 *   生成されない（ADR 0117）。
 * - period・status（archived / superseded / forgotten）・validity（expired / not_yet_valid）・taxonomy は
 *   `filtered` として報告され、`totalInScope` から除かれる（ADR 0323）。
 * - `attributes`（`RecallQuery.attributes`）は tenant/subject と同じ側で、`filtered` として報告しない
 *   （専用の値を足さない。ADR 0312）。`totalInScope` は絞り込みの内側だけを数える。
 *   taxonomy はこちらではなく period/validity 側なので読み違えないこと。
 *
 * **件数はすべてこの集約1本から取る。** `groups` の総和・`totalInScope`・`filtered*`・`notIndexed` を別々のクエリではなく
 * 同一の集約クエリから得ることで、書き込みが並行しても「群カウントと totalInScope の総和が一致する」被覆不変条件が
 * 構造的に崩れない（ADR 0011 が段1から締め出した `count(*) OVER ()` の代わりの経路）。
 * この「総和が一致する」は `axis: 'subject'` の群カウントについてで、`axis: 'taxonomy'` は別の保証を持つ（`GroupCount`）。
 */
export interface ScopeAggregate {
  /**
   * 群カウント（第3階）。既定では `axis: 'subject'` のみ。`RecallQuery.taxonomyGroups: true` を渡したときだけ
   * `axis: 'taxonomy'` の群も追加される（ADR 0323）。
   */
  groups: GroupCount[];
  /** スコープ内（tenant + subject? + period? + status ゲート + validity? ゲート）の総数。 */
  totalInScope: number;
  /**
   * groups の総和が totalInScope と一致することの信頼度。`RecallQuery.scopeAggregate` に `"skip"` を渡した呼び出しでは
   * `'unknown'`（`groups: []`・`totalInScope: 0` とともに）。渡さない・`"exact"` を渡した呼び出しは常に `'exact'`（ADR 0384）。
   */
  countKind: CountKind;
  /**
   * スコープ内だが埋め込みがまだ無い件数を、理由ごとに分けて持つ。1つに潰すと、恒久的な失敗と一時的な遅延が
   * 同じ顔になる（ADR 0008）。`pending` は待つ / 再試行する、`failed` は埋め込みパイプラインを疑う、
   * `skipped` は意図した除外なので何もしない。
   */
  notIndexed: Record<NotIndexedReason, { count: number; countKind: CountKind }>;
  /** status = 'archived' で「スコープを定義するフィルタ」により落ちた件数。 */
  filteredArchived: { count: number; countKind: CountKind };
  /**
   * status = 'superseded' で落ちた件数（機構の都合）。`filteredForgotten` とは分けて持つ（ADR 0027）。
   * `superseded` は置き換え先（`superseded_by_id`）を辿れるが、`forgotten` は利用者が意図して忘れさせた結果で
   * 置き換え先を持たない。束ねると、呼び出し側が「忘れてほしいと言ったのか、作り直しただけなのか」を判定できない。
   */
  filteredSuperseded: { count: number; countKind: CountKind };
  /** status = 'forgotten' で落ちた件数（製品の振る舞い）。`filteredSuperseded` を見よ。 */
  filteredForgotten: { count: number; countKind: CountKind };
  /** 時間窓（period）の外にあるため落ちた件数。period 未指定なら常に0。 */
  filteredPeriod: { count: number; countKind: CountKind };
  /**
   * `validUntil` が `scope.validAt` 以前で落ちた件数（`FilteredOmission.condition: 'expired'`）。
   * `scope.validAt` が `undefined`（ゲート無効）なら常に0。`countKind` は常に `'exact'`。
   */
  filteredExpired: { count: number; countKind: CountKind };
  /**
   * `validFrom` が `scope.validAt` より後で落ちた件数（`FilteredOmission.condition: 'not_yet_valid'`）。
   * `scope.validAt` が `undefined` なら常に0、`countKind` は常に `'exact'`。
   */
  filteredNotYetValid: { count: number; countKind: CountKind };
  /**
   * `RecallQuery.labels` による絞り込みで落ちた件数（`FilteredOmission.condition: 'taxonomy'`。ADR 0323）。
   * `scope.labels` が `undefined`（絞り込み無し）なら常に0。`countKind` は常に `'exact'`。
   *
   * `totalInScope` から**除かれた**件数（`filteredDecayed` とは違う）。`filteredDecayed` より先に評価され、
   * taxonomy で除外された Memory は `filteredDecayed` の対象集合にも入らない。
   *
   * **任意フィールド。** 必須にすると、`aggregateScope` を自作する第三者 adapter（`@mnemora/core` は npm 公開済み）が
   * コンパイルできなくなる。実装しない adapter では、`recall-runtime.ts` が不在を「0件」として扱う（ADR 0318）。
   */
  filteredTaxonomy?: { count: number; countKind: CountKind };
  /**
   * 忘却ゲート（`decay_floor_at` / `decay_floor_seq`）が落とした件数（`FilteredOmission.condition: 'decayed'`。ADR 0173）。
   * `RecallScope.decayFloorAtAfter`/`decayFloorSeqAfter` がどちらも `undefined`（`includeFullyDecayed: true`）なら常に0。
   * `countKind` は常に `'exact'`。
   *
   * 他の `filtered*` 欄と違い、**`totalInScope` の内訳（部分集合）である**。忘却ゲートは「スコープの外延」の次元に
   * 入っておらず、減衰しきった Memory はスコープ内に在って群カウントにも目次帯にも現れる。
   * 群カウントの総和 = `totalInScope` という被覆不変条件は、この欄を足しても崩れない。
   */
  filteredDecayed: { count: number; countKind: CountKind };
  /**
   * `AggregateScopeOptions.excludeProvenanceKinds`（非空）が渡されたときだけ、その kind の行のうち、スコープ内で索引済み
   * （`embeddingStatus = 'ready'`）のものの件数（ADR 0390）。`recall()` はこれを `eligible`
   * （= `totalInScope` − `notIndexed` 合計）から引き、段1が ANN から除外した行を分母から外す。
   *
   * **任意フィールド**（`filteredTaxonomy?` と同じ理由）。省かれたときは除外を渡さない場合と同じ判定になる。
   */
  excludedProvenanceIndexedCount?: number;
  /**
   * 目次帯（`IndexBand.digestBand`）に載せる候補（スコープ内 かつ `AggregateScopeOptions.digestBand.excludeMemoryIds` に
   * 含まれないもの）を、決定的な順序で最大 `digestBand.limit` 件。`opts.digestBand` が渡されなかった場合は空配列。
   *
   * **切り詰めない。** 1件の切り詰め（`DIGEST_BAND_MAX_ENTRY_CHARS`）と帯全体の文字数予算（`DIGEST_BAND_MAX_CHARS`）は
   * `packDigestBand` が行い、ここは生の digest をそのまま持つ。
   * 件数は `aggregateScope` の1回の呼び出しから取る。別クエリにすると、群カウントと帯が別スナップショットになり、
   * 並行する書き込みのもとで被覆不変条件が崩れる。
   */
  digests: DigestEntry[];
  /**
   * 帯に載せる資格があった総数（`digests` と同じ条件、`digestBand.limit` を掛ける前）。
   * `opts.digestBand` が渡されなかった場合は `{ count: 0, countKind: 'exact' }`。
   */
  digestEligible: { count: number; countKind: CountKind };
}

/**
 * 実際に返した量の計測（docs/recall.md §6）。
 * 計測（`usage`）と強制（`budget`）は別物で、`usage` は測るだけで何も抑止しない（docs/roadmap.md §4）。
 */
export interface RecallUsage {
  /** 返した全量（`memories` tier + 目次帯）。 */
  chars: number;
  /** 返した全量のトークン数（`RuntimeDeps.tokenCounter` で数えた値）。 */
  estimatedTokens: number;
  /**
   * `estimatedTokens` が推定（`"heuristic"`）か実測（`"exact"`）か。
   *
   * `estimatedTokens` を出した1回の計測（返した digest を連結し目次帯の JSON を足した文字列を `tokenCounter.count()` に
   * 1回渡したもの）の印である。段4の予算判定は digest ごとに数えるので、テキストによって印を変える `TokenCounter` では
   * 予算判定に使った印と食い違いうる（ADR 0487）。
   */
  counter: "heuristic" | "exact";
  /** 返した量の段ごとの内訳（文字数）。 */
  byTier: {
    /** 現状は常に `0`（`full` tier を返す経路が無い）。 */
    full: number;
    /** 返した `memories` の digest の合計文字数。連想枠が返した分も含む。 */
    digest: number;
    /** 目次帯の JSON の文字数（`indexChars` と同じ値）。 */
    index: number;
    /**
     * `memories` のうち連想枠が返した digest の合計文字数の内訳。`digest` に既に含まれる量の一部で、加算するものではない。
     *
     * 存在条件は「連想枠を実際に走らせたか」（ADR 0337 で既定 on）。`association` を省略した通常の呼び出しでも在り、
     * 欄が無いのは `RecallQuery.association: null` で止めた呼び出しだけ。連想が0件だった run では `0` として現れる
     * （「走らせたが0件」と「走らせなかった」を同じ顔にしない）。
     */
    association?: number;
  };
  /**
   * 目次帯（`IndexBand`）の実費（`byTier.index` と同じ値）。**`budget` の対象外**で、`budget` をどれだけ小さくしても
   * 削られない（`RecallBudget`）。`chars - indexChars` が予算の対象になった量。
   */
  indexChars: number;
  /**
   * `budget` が申告されている場合のみ。予算の対象（`memories` tier）が、申告された予算のどれだけを使ったか。
   * 「渡した予算のうち記憶がどれだけ使ったか」と「応答全体でいくらかかったか」は別の問いで、後者は `chars` と
   * `indexChars` を見る。
   *
   * **この値は 1 を超えうる。超えたときは `budgetExceeded` が `true` になる**（ADR 0097）。
   *
   * 分子・分母は予算の申告のしかたで決まる:
   * - `maxMemoryTokens` か `promptBudgetTokens` が申告されている ⟹ 分母はその小さいほう、分子は返した digest を
   *   `"\n"` で連結して `tokenCounter.count()` を1回だけ呼んだトークン数。
   * - どちらも無く `maxMemoryChars` だけ ⟹ 分母は `maxMemoryChars`、分子は返した digest の合計文字数。
   *
   * 超えるのは、トークン予算のとき、段4の強制側が digest ごとに `count()` を呼んだ合計で判定するのに対し、
   * 分子は連結後に1回だけ `count()` するため、数え方が違うから。改行の分だけ後者が上回ると、段4は「予算内」と
   * 判定して両方残すのに、測り直すと予算を超える。この不一致は直さない（どちらの数え方を正とするかは別の判断として
   * 見送った。ADR 0083、ADR 0097）。
   */
  share?: number;
  /**
   * 申告された予算次元のうち、いずれか1つでも実際に超えたか。
   *
   * - 予算が1次元も申告されていない ⟹ この欄自体が無い（`undefined`。`budget: {}` も同じ。存在条件は `share` と同じ）。
   * - 申告されていて、どの次元も超えていない ⟹ `false`。
   * - 申告されていて、どれか1次元でも超えた ⟹ `true`。
   *
   * 「測っていない」を `false` にしない。不在（`undefined`）で表す。
   *
   * **`share` からは導出しない。** 強制側は digest ごとに `count()` するので `share` の分子（連結した1本に対して1回）と
   * 加法的に一致せず、`share` の分母はトークン予算が申告されると `maxMemoryChars` を丸ごと失うため。
   * 返した memories を、申告された全予算次元（`maxMemoryChars` / `maxMemoryTokens` / `promptBudgetTokens`）に対して
   * 個別に測り直し、どれか1つでも超えていれば `true` にする。
   *
   * 限界: 真偽値なので `heuristic` な推定が実態からどれだけ外れているかは分からない。強制と計測で数え方が違う
   * 穴（`share`）もここでは直していない（ADR 0083）。
   */
  budgetExceeded?: boolean;
}

/** `RecallUsage` の zod スキーマ。 */
export const RecallUsageSchema = z.object({
  chars: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  counter: z.enum(["heuristic", "exact"]),
  byTier: z.object({
    full: z.number().int().nonnegative(),
    digest: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    association: z.number().int().nonnegative().optional(),
  }),
  indexChars: z.number().int().nonnegative(),
  // `.max(1)` を外してある（ADR 0097）。`share` は 1 を超えうる（doc 参照）。
  share: z.number().nonnegative().optional(),
  // additive: share の計算も既存欄の意味も変えない。
  budgetExceeded: z.boolean().optional(),
}) satisfies z.ZodType<RecallUsage>;

/**
 * `recall()` に渡す予算（docs/recall.md §6）。
 *
 * **予算が縛るのは `memories` tier（返す Memory の digest）だけ。** 目次帯（`IndexBand`）は予算の対象外で、
 * `budget` をどれだけ小さくしても削られない。目次帯の存在理由は「recall が0件でも、何が在るかは言える」ことで
 * （[ADR 0008](../../../docs/decisions/0008-absence-taxonomy.md)）、予算の対象にすると呼び出し側の数字ひとつでその
 * 保証が消えるため。名前に `Memory` を入れているのは、recall 全体の上限ではないことを型から分かるようにするため。
 * 目次帯の実費は `RecallUsage.indexChars` で別に返る。
 */
export interface RecallBudget {
  /** `memories` tier の合計文字数の上限。目次帯は含まない。 */
  maxMemoryChars?: number;
  /** `memories` tier の合計トークン数の上限。目次帯は含まない。 */
  maxMemoryTokens?: number;
  /**
   * 呼び出し側が申告する「プロンプト全体の」トークン予算。
   * `memories` tier の切り詰めにのみ使う（mnemora はプロンプトを組み立てないため、
   * 全体を測ることは原理的にできない。docs/recall.md §6「正直に書くべき限界」）。
   */
  promptBudgetTokens?: number;
}

/** `RecallBudget` の zod スキーマ。 */
export const RecallBudgetSchema = z.object({
  maxMemoryChars: z.number().int().positive().optional(),
  maxMemoryTokens: z.number().int().positive().optional(),
  promptBudgetTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<RecallBudget>;

/** 候補1件のスコアの内訳（docs/recall.md §7）。既定の戦略では `total = affinity × decay × tagMatch × freshness × strength`（`affinity` は `similarity` と `lexicalMatch` の大きいほう。どちらも無ければ 1）。 */
export interface ScoreBreakdown {
  /** ANN 経由でのみ存在。距離から変換した類似度。 */
  similarity?: number;
  /**
   * 語彙チャンネルが引き当てた候補にのみ存在する（ADR 0084）。`LexicalHit.coverage`（一致したクエリ語彙数 ÷
   * クエリ語彙の総数）がそのまま入る（ADR 0092）。値域は `(0, 1]`。
   *
   * 被覆率が同値の候補どうしの順序は `decay` / `freshness` が決める。低選択率のクエリ（ありふれた語1つ）では被覆率が
   * 大量の候補で `1` に揃うため、この順序の任意さは残る（ADR 0084 §8、ADR 0092）。
   * adapter が返す `LexicalHit.rank` はこの項に入らない（`interfaces/lexical-store.ts`）。
   */
  lexicalMatch?: number;
  /** 減衰の係数（既定の戦略の壁時計では `0.5^(経過時間 / halfLifeHours)`。強さそのものは掛けない）。 */
  decay: number;
  /** タグの一致の係数（既定の戦略では `1 + 0.1 × クエリのタグと一致した数`）。 */
  tagMatch: number;
  /** 鮮度の係数（既定の戦略では `occurredAt`、無ければ `recordedAt` を起点に減衰させ、上限で丸める。
   * `timeWeighting` が `"eventAwareFreshness"` で `occurredAt` が無いときは上限の値）。 */
  freshness: number;
  /** 候補の Memory の `strength`。 */
  strength: number;
  /** 順位と閾値の比較に使う合計のスコア。 */
  total: number;
  /**
   * `total` の比較可能性を名乗る欄（[ADR 0282](../../../docs/decisions/0282-score-breakdown-affinity-measured.md)）。
   *
   * `similarity`/`lexicalMatch` のどちらか一方でも在れば `true`、両方とも無いときだけ `false`。両方無いと `affinity` が
   * 中立の `1` に退化し、クエリとの関連度を測っていないのに他の項次第で `total` が高く見えることがある（連想枠）。
   * **`false` の記憶の `total` を、`true` の記憶の `total` と比較しないこと。** 同じ値どうしの比較は妨げない。
   *
   * `undefined`（欄が無い）は「関連度を測っていない」ではなく、`defaultScoringStrategy` を経由していない
   * （自作の `ScoringStrategy` が埋めていない）という別の意味で、型の上では区別できない。
   * `undefined` は「関連度を測ったか分からない」としてのみ扱い、比較可能とも不可能とも仮定しないこと。
   */
  affinityMeasured?: boolean;
}

/** `ScoreBreakdown` の zod スキーマ。 */
export const ScoreBreakdownSchema = z.object({
  similarity: z.number().optional(),
  lexicalMatch: z.number().optional(),
  decay: z.number(),
  tagMatch: z.number(),
  freshness: z.number(),
  strength: z.number(),
  total: z.number(),
  affinityMeasured: z.boolean().optional(),
}) satisfies z.ZodType<ScoreBreakdown>;

/**
 * 連想枠・必須の同伴取得（`retrievedVia: "mandatory_companion"` / `"association"`）が返す記憶の `score`
 * （[ADR 0352](../../../docs/decisions/0352-association-score-without-total.md)）。
 *
 * `ScoreBreakdown` との違いは `total`・`similarity`・`lexicalMatch` を持たないことだけ。affinity を測っていない候補
 * （`affinityMeasured: false`）の `total` は中立の `1` に退化した値を含み、他の記憶の `total` と比較すると
 * 遠ざかったはずの記憶が高く見えることがあるため。
 *
 * `affinityMeasured: false` は常にこのリテラルで、判別の鍵。`RecalledMemory.score` / `RecallRecordMemory.score` は
 * `ScoreBreakdown | AffinityUnmeasuredScore` の判別可能な union で、`score.affinityMeasured === false` で絞り込むと
 * こちらになる。`true` / `undefined` のときは安全側に `ScoreBreakdown` へ倒す（`total` を落とすのは、
 * 測っていないと明示された記憶だけ）。`decay`/`tagMatch`/`freshness`/`strength` は `ScoreBreakdown` と同じ意味・同じ値。
 */
export interface AffinityUnmeasuredScore {
  /** 常に `false`（判別の鍵）。 */
  affinityMeasured: false;
  /** 減衰の係数。{@link ScoreBreakdown.decay} と同じ意味。 */
  decay: number;
  /** タグの一致の係数。{@link ScoreBreakdown.tagMatch} と同じ意味。 */
  tagMatch: number;
  /** 鮮度の係数。{@link ScoreBreakdown.freshness} と同じ意味。 */
  freshness: number;
  /** 候補の Memory の `strength`。{@link ScoreBreakdown.strength} と同じ意味。 */
  strength: number;
}

/** `AffinityUnmeasuredScore` の zod スキーマ。 */
export const AffinityUnmeasuredScoreSchema = z.object({
  affinityMeasured: z.literal(false),
  decay: z.number(),
  tagMatch: z.number(),
  freshness: z.number(),
  strength: z.number(),
}) satisfies z.ZodType<AffinityUnmeasuredScore>;

/**
 * `RecalledMemory.score` / `RecallRecordMemory.score` の型（ADR 0352）。判別の鍵は `affinityMeasured`。
 * `false` なら {@link AffinityUnmeasuredScore}（`total` を持たない）、それ以外なら {@link ScoreBreakdown}。
 * `ScoringStrategy`（`strategies/scoring.ts`）の戻り値型はこの union ではなく `ScoreBreakdown` のまま。
 */
export type RecalledScore = ScoreBreakdown | AffinityUnmeasuredScore;

/** `RecalledScore` の zod スキーマ。 */
export const RecalledScoreSchema = z.union([ScoreBreakdownSchema, AffinityUnmeasuredScoreSchema]);

/** `recall()` が返した記憶1件。 */
export interface RecalledMemory {
  /** 記憶の id。 */
  memoryId: MemoryId;
  /** 記憶の `digest`（要旨）。 */
  digest: string;
  /**
   * どの経路でこの記憶が候補に入ったか。
   *
   * ANN と語彙（`"lexical"`）の両方が同じ記憶を引き当てたときは `"ann"` になる（候補集合へ入れた**最初の**チャンネル。
   * ADR 0084 §6）。「このチャンネルだけが見つけた」ことを表す欄ではない。語彙チャンネルも当てたかは
   * `score.lexicalMatch` の有無が名乗る。
   *
   * `"association"` は「クエリに直接は当たらなかったが、クエリで引けた記憶（アンカー）の近傍として引いた」候補。
   * 既定 on（ADR 0337）で、`query.association` を省略しても {@link DEFAULT_RECALL_ASSOCIATION} で現れる。
   * `query.association: null` を明示した呼び出しでは現れない。この union を網羅的に `switch` している呼び出し側は、
   * 新しい値を扱わないまま通る可能性がある。
   *
   * 実装を伴わない値を union に置かない（ADR 0084、ADR 0144）。型に名前が在ると呼び出し側は「使える」と読み、
   * 実装が無いと黙って何も起きない。
   */
  retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
  /** 矛盾の相手として同伴取得された場合、その相手の memoryId。 */
  companionOf?: MemoryId;
  /**
   * この記憶が `contested` で、かつその相手（`Memory.contestedWithId`）が同じ recall 結果に含まれるとき、
   * その相手の memoryId（[ADR 0335](../../../docs/decisions/0335-recalled-memory-contested-with.md)）。
   *
   * `companionOf` とは別の欄。`companionOf` は同伴取得で引き込まれた側だけが持つ（`docs/recall.md` §8）ので、
   * 意味を変えずに新設した。この欄は取得経路を問わず「対が両方とも返っているか」だけを表し、
   * `retrievedVia` の値に関わらず在りうる（矛盾する2件が `"ann"`/`"lexical"` で自然に両方入ったときも付く）。
   * 相手が最終的な結果集合（budget による切り詰め後）に含まれないときは付かない。
   */
  contestedWith?: MemoryId;
  /** `retrievedVia: "association"` のときだけ在る。どのアンカー（`memoryId`）を起点に連想したか。 */
  associationOf?: MemoryId;
  /**
   * この記憶が「本人が述べた事実」なのか「AI の推論」なのか。
   *
   * `provenance` 全体ではなく `kind` だけを返す。求められているのは区別であって中身の追加ではなく、`kind` だけを
   * 平らに持てば欄を足す圧力が掛からない。`model` / `promptVersion` / `basis` / `confidence` が要るなら
   * `MemoryStore.get()` を引く。欄名は `RecallQuery.excludeProvenanceKinds` と同じ語彙。
   * `basisLost`（ADR 0342）も同じ原理で、`kind === "inferred"` のとき派生した1bitの印だけを返し、`basis` 自体は返さない。
   */
  provenanceKind: ProvenanceKind;
  /**
   * スコアの内訳。`affinityMeasured: false` のときは {@link AffinityUnmeasuredScore}（`total`/`similarity`/`lexicalMatch` を
   * 持たない）、それ以外は {@link ScoreBreakdown}（{@link RecalledScore}、ADR 0352）。
   */
  score: RecalledScore;
  /**
   * この記憶を実際に述べた人（[ADR 0289](../../../docs/decisions/0289-recalled-memory-speaker-subject.md)）。
   *
   * `provenance.kind === "stated"` のときだけ値が入りうる。`stated` でも `speaker` を述べていなければ `null`。
   * それ以外の kind は常に `null`。型の上では省略可能だが、`recall-runtime.ts` は常に値か `null` を書く
   * （`undefined` にもキーの省略にもしない）。「無い（`null`）」と「書き忘れ（`undefined`）」を実行時に混ぜないため
   * （ADR 0257、ADR 0289）。
   */
  speaker?: string | null;
  /**
  /**
   * この記憶が「誰との」やり取りに紐づくか（ADR 0289）。
   *
   * その Memory 自身の `subjectId` を引き継ぐ。`undefined` のときも `null` に揃える。統合（`consolidate`）が subject を
   * またいだ場合は `Memory.subjectId` と同じく `null` になり、この欄は帰属が消える問題を直すものではない。
   * 型の上では省略可能だが、`recall-runtime.ts` は常に値か `null` を書く（`speaker` と同じ保証）。
   *
   * 限界: 空文字の `subjectId` は入力では受け付けるが、この出力の schema（{@link RecalledMemorySchema} の `subjectId` は
   * `min(1)`）を通らない。`ctx.subjectId: ""` で書いた記憶を返すと `""` になり、`recall()` の `outputValidation` が
   * `ok: false`（`memories.<n>.subjectId`）になる。schema は緩めていない。
   */
  subjectId?: string | null;
  /**
   * この記憶を取り込んだ壁時計の時刻（[ADR 0298](../../../docs/decisions/0298-recalled-memory-recorded-occurred-at.md)）。
   * `Memory.recordedAt` を引き継ぐ。型の上では省略可能だが、`recall-runtime.ts` は常に値を書く。
   * 複数件の中でどれが後の発言かの並び替えに使う想定。`occurredAt` が無い記憶でも必ず在る。
   */
  recordedAt?: Date;
  /**
   * この記憶が指す出来事・事実が実際にいつのものか（ADR 0298）。`Memory.occurredAt` を引き継ぎ、`undefined` のときも
   * `null` に揃える（`memory.ts` の `occurredAt`/`recordedAt` の区別、ADR 0145）。
   *
   * `null` は「出来事の時点が分からない・述べられていない」で、`recordedAt` で埋めない（2つの時計は意味が違う）。
   * 「訂正の順序」を読みたい呼び出し側が `recordedAt` へフォールバックするかは呼び出し側の判断で、core は代わりに埋めない
   * （ADR 0298）。型の上では省略可能だが、`recall-runtime.ts` は常に値か `null` を書く。
   */
  occurredAt?: Date | null;
  /**
   * この記憶の `Memory.attributes`（呼び手が申告した属性。ADR 0312）。
   *
   * 「詳細は `get()` の問い」という原則（`provenanceKind`）の例外: `RecallQuery.attributes` で絞ったのに絞りに使った軸の
   * 値が返らないと、呼び出し側が「なぜこれが返ったか」を検証できない。絞り込みに使える軸は載せ、使えない詳細は `get()` に残す。
   * 型の上では省略可能だが、`recall-runtime.ts` は常に `{}` 以上の値を書く（`Memory.attributes` が `undefined` の
   * 古い行・adapter でも `{}`）。
   */
  attributes?: Attributes;
  /**
   * この記憶が `provenanceKind === "inferred"` で、かつその `basis.memoryIds` の少なくとも1件が失われているときだけ
   * `true`（[ADR 0342](../../../docs/decisions/0342-recalled-memory-basis-lost.md)）。
   * 根拠が消えても隠さず、「根拠を失った推論」として印を付けて返す（docs/memory-model.md §2。削除はしない）。
   *
   * 「失われている」は次のどれか1つでも当たるとき:
   * - `MemoryStore.getMany` の結果に無い（存在しない・他テナント・adapter が期待する形式でない）。
   * - `status === "forgotten"`。
   * - `purgedAt` が非 `null`。
   *
   * `archived`/`superseded`/`contested` は失われていない扱い（本文が残り、復帰する経路がある。docs/memory-model.md §11）。
   *
   * **`basis.observationIds` は確かめない。** Observation は追記専用で、forget/purge の経路が無く、一括取得口も無い
   * （ADR 0257 の「探していない」。ADR 0342 に限界として記録）。
   *
   * `false` にはせず、基準を満たさないときはキー自体を出す側に倒さない（`companionOf` と同じ `?: true` の作法）。
   * `basis` の中身は返さない（詳細が要るなら `MemoryStore.get()`）。
   */
  basisLost?: true;
}

/** `RecalledMemory` の zod スキーマ。 */
export const RecalledMemorySchema = z.object({
  memoryId: z.string().min(1),
  digest: z.string(),
  retrievedVia: z.enum(["ann", "lexical", "mandatory_companion", "association"]),
  companionOf: z.string().min(1).optional(),
  contestedWith: z.string().min(1).optional(),
  associationOf: z.string().min(1).optional(),
  provenanceKind: ProvenanceKindSchema,
  score: RecalledScoreSchema,
  speaker: z.string().min(1).nullable().optional(),
  subjectId: z.string().min(1).nullable().optional(),
  recordedAt: z.date().optional(),
  occurredAt: z.date().nullable().optional(),
  attributes: StoredAttributesSchema.optional(),
  basisLost: z.literal(true).optional(),
}) satisfies z.ZodType<RecalledMemory>;

/**
 * `explain.stages` の段の名前。`scope` は段0、`candidate_generation` は段1、`rescore` は段2、`contradiction_resolution` は段3、`association` は段3.5、`budget_truncation` は段4、`index_band` は段5、`record` は段6（docs/recall.md §2・§9）。
 *
 * この union への値の追加は破壊的変更に数えない。`association` の trace は `query.association !== null` のときだけ
 * `stages` に積まれる（`null` で off にした run は、`candidate_generation` の ANN/語彙チャンネルが要求されていないとき
 * に trace を積まないのと同じ形。docs/recall.md §2「`explain.stages` の読み方」）。
 */
export type RecallStageName =
  | "scope"
  | "candidate_generation"
  | "rescore"
  | "contradiction_resolution"
  | "association"
  | "budget_truncation"
  | "index_band"
  | "record";

/** `explain.stages` の1段ぶんの記録。 */
export interface StageTrace {
  /** 段の名前（{@link RecallStageName}）。 */
  stage: RecallStageName;
  /**
   * 意味は段ごとに違う。**`false` は「段を飛ばした」とは限らない**（`docs/recall.md` §2「`explain.stages` の読み方」）。
   * - `candidate_generation`: その経路（`detail.channel`）が走らなかった。必ず `stage_skipped(candidate_generation)` の
   *   `Omission` と対になる。
   * - `rescore`: 採点する候補が0件だった（段は飛ばしていない）。`stage_skipped` は名乗らない。
   * - `association`: `stage_skipped(association, ...)` と対になるときだけ `false`。アンカーから検索して
   *   `detail.hits`/`detail.selected` が0件だったときは `true`（探したが0件と、探さなかったを区別する）。
   * - それ以外の段: 常に `true`。
   */
  executed: boolean;
  /** 段ごとの付帯情報（形は段ごとに違う。docs/recall.md §2「`explain.stages` の読み方」）。 */
  detail?: Record<string, unknown>;
}

/** `StageTrace` の zod スキーマ。 */
export const StageTraceSchema = z.object({
  stage: z.enum([
    "scope",
    "candidate_generation",
    "rescore",
    "contradiction_resolution",
    "association",
    "budget_truncation",
    "index_band",
    "record",
  ]),
  executed: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<StageTrace>;

/**
 * `recall()` への入力。
 *
 * 既定で `provenance.kind = 'inferred'` を含める。除外する場合は `excludeProvenanceKinds` に `['inferred']` を渡す。
 *
 * **subject で絞るなら、`ctx.subjectId` に置く。この型に `subjectId` は無い。**
 * **クエリの未知のキーは、例外にも警告にもならず黙って捨てられる**（`RecallQuerySchema` は `.strict()` ではない）。
 * `recall(ctx, { text, subjectId: "alice" })` と書くと `subjectId` は捨てられ、テナント全体から引いた結果が何事も無く返る。
 * キーの綴り違い（`scoreTreshold` など）も無視される。TypeScript の余剰プロパティ検査が止めるのはオブジェクトリテラルを
 * 直接渡したときだけで、変数経由・スプレッド・JavaScript からの呼び出しは素通りする。絞れたかは
 * `explain.stages` の `scope` の `detail.subjectId` で確かめられる（絞れていなければ `null`）。
 */
export interface RecallQuery {
  /**
  /**
   * クエリの本文。埋め込み（`vector` を渡さないとき）と語彙チャンネルに使う。空文字は `ZodError` になる。
   *
   * 空白だけの文字列は `ZodError` にならない。前後の空白を `trim()` してから使い、`trim()` 後に空なら
   * `stage_skipped(candidate_generation, "empty_query_content")` を積む。
   */
  text?: string | undefined;
  /**
   * クエリの埋め込みベクトル。長さが対象の `space.dimensions`（`EmbeddingSpaceId`）と一致することはこの型では
   * 検証しない。**一致させるのは呼び出し側の責任**。
   *
   * 長さが違うときは「比較不能」として扱う。新しい throw は増えず、候補は `search` の結果から落とさずに距離を `NaN` に
   * 差し替え、段2（ADR 0044）が `omitted` の `score_not_comparable` に数える。`memories` には出ない。
   * [ADR 0040](../../../docs/decisions/0040-zero-vector-never-returned.md)（ゼロベクトルが絡む候補は結果に出ない）と同じ形の契約で、
   * `packages/postgres`・`packages/testkit`・`packages/core` の3実装が同じ振る舞いをする。
   *
   * 限界: `VectorStore.upsert` に長さの違うベクトルを直接渡したときは対象外（Postgres は例外、Fake はそのまま保存する）。
   * `Runtime.tick` の embed ジョブは `upsert` の前に長さを確かめる（ADR 0393）。
   *
   * 長さの検査を受けるのは `text` から provider が作った問い合わせベクトルだけ（ADR 0393）。この `vector` を直接渡したときは
   * 長さを確かめず、上の `score_not_comparable` のまま。有限性は別で、`NaN`・`Infinity`・`-Infinity` を成分に含む `vector` は
   * {@link RecallQuerySchema}（`z.array(z.number())`）で `ZodError` になり、`score_not_comparable` には数えられない。
   * provider が返した問い合わせベクトルの長さが違うときは `embedding_provider_unavailable` になる。
   */
  vector?: number[] | undefined;
  /**
   * クエリのタグ。スコアの `tagMatch` にだけ効く（絞り込みではない）。
   *
   * `tagMatch = 1 + 0.1 × m` の `m` は、この配列の要素ごとに記憶の `tags` に完全一致で含まれるかを数える（ADR 0474）。
   * この配列の重複は重複のまま数える（`["a", "a"]` は `a` を持つ記憶に 1.2、`["a"]` は 1.1）。記憶側の `tags` の重複は1回に数える。
   * `"a"` と `"A"`、前後の空白は別の語（正規化しない）。
   */
  tags?: string[] | undefined;
  /**
   * 母集合を段1（候補生成）で減らす、AND 等値の絞り込み（ADR 0312）。
   *
   * `tags` とは別の軸。`tags` は LLM の推論で加点にしかならず母集合を減らさないが、`attributes` は呼び手の申告で
   * 母集合を減らす。由来の違う2つを同じ絞り込み意味論に混ぜない。
   *
   * 意味論は AND 等値だけ（ADR 0312 決定5）。渡したキーすべてが、その Memory の `attributes` に同じ値で存在する場合だけ
   * 候補に残る（`jsonb` の `@>` 包含と同じ形）。OR・キーの不在を表す形は、この版では提供しない。
   * **空オブジェクト（`{}`）は「絞り込み無し」を意味する。**
   *
   * `subjectId` と同じく「スコープの定義」の一部で、この欄で落ちた Memory は `omitted`（`FilteredOmission`）に出ない
   * （`ScopeAggregate`）。`FilteredOmission.condition` に専用の値を足す案は採らない（ADR 0312）。
   *
   * 段1（ANN・語彙の両チャンネル）と段3.5（連想枠）の両方へ押し下げ、`MemoryStore.aggregateScope` にも同じ述語で渡る。
   * `totalInScope` はこの絞り込みの内側を数える。連想枠だけ絞りが漏れた過去（ADR 0172）を繰り返さないよう、
   * `RecallScope.attributes` を唯一の出所にする。
   *
   * 渡したキー数・キー長・値長には上限があり（`AttributesSchema`）、超過は `parse()` の時点で例外になる
   * （`ObserveXxxInput.attributes` と同じ検査）。キーが自前の `__proto__`（`JSON.parse` が作る）なら `parse()` の前に
   * `ZodError` で断る（ADR 0496。zod の record は黙って落とし、絞り込みが外れる）。
   */
  attributes?: Attributes | undefined;
  /**
   * taxonomy によるラベルの絞り込み（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）。
   *
   * `MemoryStore.listLabels?`/`registerLabel?`（ADR 0318）が管理する統制語彙で絞り込む。**意味論は OR**: 渡した名前のうち、
   * 現在の `TenantSettingsStore.getTaxonomyMode?`（既定 `'open'`）で参加資格のあるものを1つでも `tags` に持つ Memory だけを残す。
   *
   * 参加資格の規則（`docs/memory-model.md` §8）:
   * - `taxonomy_mode: 'open'`（既定）: `registered`・`proposed` の両方が参加資格を持つ。
   * - `taxonomy_mode: 'strict'`: `registered` のみ。`proposed`（または未登録）は参加資格のある名前の集合から外れる（ADR 0323 決定2）。
   *
   * **参加資格のある名前が1つも残らなかった場合、絞り込みは「何にも一致しない」述語になる**（結果は0件、
   * 落ちた Memory は `FilteredOmission.condition: 'taxonomy'` に計上される）。絞り込みを諦めて全件通す側には倒さない
   * （`docs/memory-model.md` §8）。**空配列（`labels: []`）は「絞り込み無し」**で、この欄を渡さなかったときと同じく全件が通る。
   * 「0件」になるのは、名前を1つ以上渡してそのどれも参加資格を持たなかった場合。
   *
   * 名前は文字列の完全一致で比べる（`['project']` は `tags: ['Project']` に当たらない）。大文字小文字・全角半角・
   * Unicode の正規化形・前後の空白は同じものとして扱わない（`docs/memory-model.md` §8）。
   *
   * `MemoryStore.listLabels?` を実装していない adapter では、絞り込みを黙って諦めて全件へ広げず、`taxonomy_mode` に応じて倒す
   * （ADR 0323 決定2）:
   * - `'open'`（既定・フォールバック含む）: 渡した名前をそのまま参加資格ありとして使う。
   * - `'strict'`: 検証できないため参加資格ゼロと見なす（0件になる）。`open` 側へ広げてテナントの明示した方針を破らない。
   *
   * 段1（ANN・語彙の両チャンネル）と段3.5（連想枠）へ押し下げ、`MemoryStore.aggregateScope` にも同じ述語で渡る。
   * **必須の同伴取得（段3）では検査しない**（`tags` と同じ扱い、ADR 0323 決定3）。
   * 落ちた分は `FilteredOmission.condition: 'taxonomy'` として報告される（`attributes` と違い、スコープを定義するゲートとして）。
   * `totalInScope` はこの絞り込みの内側を数える。
   */
  labels?: string[] | undefined;
  /**
   * `IndexBand.groups` に `axis: 'taxonomy'` の群を作るかどうかの明示的な opt-in（ADR 0323 決定5）。
   *
   * 既定 `false`（省略）。`true` にすると、テナントの語彙全体（現在の `taxonomy_mode` で参加資格のあるラベル名すべて）を
   * 候補にした群カウントが `groups` に追加される。`labels` とは独立で、グルーピングだけが増える。
   *
   * この軸の被覆不変条件は `subject` 軸と違う。ラベルは多対多なので `axis: 'taxonomy'` の `count` の総和は
   * `totalInScope` を超えうる（`GroupCount`、`docs/recall.md` §5、ADR 0323 決定6）。
   * `MemoryStore.listLabels?` を実装していない adapter では静かに無視される（`taxonomy` 軸のエントリが生成されない）。
   */
  taxonomyGroups?: boolean | undefined;
  /**
   * 段3（`contradiction_resolution`）の多者間の同伴取得の、群ごとの上限件数
   * （[ADR 0396](../../../docs/decisions/0396-recall-relation-max-count.md)）。
   *
   * 多者間の `contested` 群（`RuntimeDeps.relationStore` で辿る）が見つかったとき、群ごとに何件まで同伴として載せるか。
   * 超えた分は `validFrom` の新しい順→`id` の順で切られ、群ごとに1件の `over_limit { stage: "relation" }` に積まれる。
   * owner（元々候補に居た記憶）は数えない（`detail.companionsAdded` と同じ規約）。
   *
   * 省略すると {@link DEFAULT_RECALL_ASSOCIATION}.maxCount。**正の整数、上限1000**（`RecallQuerySchema` が検査する）。
   *
   * 探索の安全弁（群ごとに訪れた数の上限）はこの欄の10倍に連動する。連動させないと、安全弁を超える値を指定しても
   * 探索がそこで止まり、指定した値が効かない（常に `countKind: "lower_bound"` になる）。上限を1000にしたのは安全弁
   * （`listRelated` を呼ぶ回数の上限）を頭打ちにするため。`association.maxCount`（連想枠）とは別の欄で、連動しない。
   */
  relationMaxCount?: number | undefined;
  /** 実効時刻（`occurredAt`、無ければ `recordedAt`）がこの時刻以後の記憶だけを対象にする（境界を含む）。 */
  occurredAfter?: Date | undefined;
  /** 実効時刻（`occurredAt`、無ければ `recordedAt`）がこの時刻以前の記憶だけを対象にする（境界を含む）。 */
  occurredBefore?: Date | undefined;
  /** 段2で残す上限の件数（正の整数）。省略すると {@link DEFAULT_RECALL_LIMIT}。超えた分は `over_limit` になる。 */
  limit?: number | undefined;
  /**
   * 段1で取り込む候補数の倍率（`k' = max(1, round(limit × overFetchFactor))`、既定は {@link DEFAULT_OVER_FETCH_FACTOR}。
   * `docs/recall.md` §3）。段3.5（連想枠）の過取得（`maxCount × overFetchFactor`）にも同じ値を使う。
   *
   * **上限は置かず、丸めもしない。** schema が検査するのは「有限の正数」だけで、`k'` はそのまま store の `search` の
   * `limit` に渡る。**保証するのは `k'`（と `maxCount × overFetchFactor`）が 2^63 未満のときだけ。**
   * これ以上だと `@mnemora/postgres` は DB の例外（`bigint` の範囲外）を、`@mnemora/testkit` の fixture は
   * 「`limit must fit in a Postgres bigint`」の `Error` を投げ、`recall()` ごと reject する
   * （例: `limit` 10 なら `overFetchFactor` が約 9.2e17 以上）。2^63 未満でも大きな値はそのまま大きな `LIMIT` になる。
   */
  overFetchFactor?: number | undefined;
  /** recall は既定で inferred を含める。除外したい provenance.kind を明示する。 */
  excludeProvenanceKinds?: ProvenanceKind[] | undefined;
  /**
   * 段1（候補生成）で走らせるチャンネル（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)）。
   *
   * 省略時は {@link DEFAULT_RECALL_CHANNELS}（ANN 1本）。**空配列 `[]` は `ZodError` になる**（`.min(1)`。「省略」と同じ扱いにはならない）。
   *
   * **`"lexical"` を渡したのに `RuntimeDeps.lexicalStore` が配線されていないとき、`recall()` は投げる**
   * （{@link LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX}）。黙って0件を返すと「語彙で探したが1件も無かった」と
   * 「語彙で探していない」が同じ顔になる。`embedding_provider_unavailable` とは別の族で、あちらは実行時の失敗
   * （次に呼べば成功しうる）なので `omitted` に落ちるが、こちらは配線の誤りで何度呼んでも成功しない。
   * degrade させると、呼び出し側は「使っているつもりで一度も使えていない」製品を出荷する。
   *
   * 値の一覧をここに散文で書かない。唯一の出所は {@link RECALL_CHANNELS}（散文で数え直すと、値が増えたとき黙って嘘になる。ADR 0082）。
   */
  channels?: RecallChannel[] | undefined;
  /** 返却量の予算（{@link RecallBudget}）。収まらない分は `budget_dropped` になる。省略すれば予算で絞らない。 */
  budget?: RecallBudget | undefined;
  /**
   * 段2（再スコア）で候補を残すか捨てるかの閾値（docs/recall.md §2 段2）。既定値 `DEFAULT_SCORE_THRESHOLD`（0.1）。
   * 強い根拠がある値ではなく、明らかに無関係な候補（類似度が低い、または大きく減衰した候補）を落とす最低限の閾値。
   *
   * **負にすると、段2の並びが単調でなくなりうる**（値の範囲は検査していない。ADR 0433 決定2）。類似度が負の候補の
   * `ScoreBreakdown.total` は負になる（`similarity` は −1 まで下がる）。閾値が負だとその候補が段2を通り、並びは `total` の降順なので、
   * 負の `total` どうしでは `decay` が小さい（古く弱い）ものほど 0 に近く上位に来る。負にする理由が無ければ 0 以上にすること
   * （docs/recall.md §9.2）。
   */
  scoreThreshold?: number | undefined;
  /**
   * 帯に載せる件数の上限。既定 `DEFAULT_DIGEST_BAND_LIMIT`。
   *
   * **この値を下げても、帯が縮むとは限らない。** 帯は、この件数上限と `DIGEST_BAND_MAX_CHARS`（呼び出し側からは変えられない）の
   * 先に当たったほうで切れる（`packDigestBand`）。digest が長いと `DIGEST_BAND_MAX_CHARS` が先に効き、
   * 「`DIGEST_BAND_MAX_CHARS` ÷ 帯1件のコスト」未満にするまで帯は縮まない（`docs/recall.md` §6「目次帯の量を把握し、調整する」）。
   * どちらが効いたかは `IndexBand.digestBandCoverage.limitedBy` で、帯の占有は `RecallUsage.indexChars / RecallUsage.chars` で読める
   * （`budget` ではこの分は削れない）。
   *
   * **`0` は渡せない（`positive()`）。** 目次帯の存在理由は「recall が0件でも何が在るかは言える」ことで
   * （`RecallBudget`、docs/recall.md §6）、渡した数字ひとつでその保証が消えてはならない（`RecallQuery.limit` と同じ作法）。
   */
  digestBandLimit?: number | undefined;
  /**
   * 段5（`MemoryStore.aggregateScope`）の件数集計を止める、明示的な opt-in
   * （[ADR 0384](../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md) 案C）。
   *
   * 既定 `"exact"`（省略時と同じ）。`aggregateScope` は `GROUP BY subject_id` で群カウント・`totalInScope`・`filtered*`・
   * `notIndexed` を厳密に数える。
   *
   * `"skip"` を渡すと、`aggregateScope` はこれらの件数を実際に数えない。`IndexBand.groups` は空配列、`IndexBand.totalInScope` は `0`、
   * `IndexBand.countKind`（と `ScopeAggregate` の各 `countKind`）は `"unknown"` になる。`omitted` の `filtered(...)` は
   * 件数が数えられない以上どれも積まれない。「スコープ内で何が落ちたか」の説明力を手放す代わりに集計の費用を払わない取引である。
   *
   * 目次帯（`digestBand`）は `"skip"` でも出る（digest 候補の取得は件数集計とは別の経路）。ただし `digestEligible` も
   * 件数なので `countKind: "unknown"`・`count: 0` になり、「帯に何が載っているか」は分かるが「あと何件あるか」は分からない。
   *
   * `"skip"` を頼まれても集計して `countKind: "exact"` を返す adapter は、conformance suite が許さない
   * （`packages/testkit/src/memory-store-conformance.ts`）。`"skip"` を頼まれたら `groups` は空・`totalInScope` は `0`・
   * `countKind` は `"unknown"` を返さなければならない。受け取って黙って無視する実装を作らないため（ADR 0024）。
   *
   * **`"skip"` では、ANN が scope の候補を拾いきったかを判定できない**（母数 `eligible` が数えられないため `ann_unreached` は
   * 鳴らない）。`ann_unreached` が無いことは「拾いきった」を意味しない。ANN の段が走っていて件数が取れなかったときは、
   * `explain.stages` の ANN（`detail.channel === "ann"`）の `detail.annReachability: "unknown"` がそう名乗る
   * （既定 `"exact"` の出力にはこのキーは付かない。ADR 0390）。
   */
  scopeAggregate?: "exact" | "skip" | undefined;
  /**
   * 忘却ゲート（decay floor gate）の明示的な opt-out（[ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）。
   *
   * 既定（省略 = `false`）では、`decayFloorAt` を過ぎた（完全に減衰しきった）Memory は recall の候補から外れる。
   * ANN チャンネル（段1）は `VectorFilter.decayFloorAtAfter` に「いま」を押し下げ、語彙チャンネルは `LexicalFilter` を増やさず
   * core の後置フィルタで同じ述語（`memory.decayFloorAt > now`）を適用する（ADR 0153「決めたこと」3）。
   * 「使われない記憶が、静かに遠ざかる」を、掃引（`status='archived'`）を呼んでいない期間にも効かせるため。
   *
   * `true` を渡すと、減衰しきった Memory も候補に残り続ける。このときの `explain.stages` の `candidate_generation` の
   * `detail.decayGate` は `"disabled"` になる（既定は ANN が `"pushed_down"`、語彙が `"post_filtered"`）。
   */
  includeFullyDecayed?: boolean | undefined;
  /**
   * 「この時刻において真だった記憶」を問う。
   *
   * 述語: `(validFrom IS NULL OR validFrom <= validAt) AND (validUntil IS NULL OR validUntil > validAt)`。
   * - `validFrom` は閉じた左端（`<=`）。
   * - `validUntil` は開区間の右端（狭義の `>`）。`includeFullyDecayed` の `VectorFilter.decayFloorAtAfter` が採る狭義 `>` に
   *   境界の扱いを揃えた。`validUntil` の瞬間そのものは、もう真ではない側に入る。
   * - **`validFrom`/`validUntil` が両方 `null` の Memory は「いつでも真」と扱う**（「不明」ではない）。「不明」と解釈すると
   *   既存のほぼ全ての記憶を落としてしまう（ADR 0145）。
   *
   * **省略時の既定は `now`**（ゲートは既定で効く。`includeFullyDecayed` と同じ opt-out 型）。`validUntil` を過ぎた記憶は
   * 定義上もう真ではなく、黙って返すのは誤りである。`validUntil` を過ぎた記憶・`validFrom` が未来の記憶は、`validAt` を
   * 省略しても落ちる（`omitted` の `filtered(expired)`/`filtered(not_yet_valid)`。ADR 0164 決定4）。
   *
   * 段1（ANN・語彙の両チャンネル）へ押し下げる（`VectorFilter.validAt`/`LexicalFilter.validAt`。`includeFullyDecayed` と違い
   * 語彙チャンネルも SQL の `WHERE` で絞る）。新しい索引は足していない（ADR 0164）。
   */
  validAt?: Date | undefined;
  /**
   * `validAt` ゲートの明示的な opt-out（`includeFullyDecayed` と対称）。
   * `true` を渡すと `validFrom`/`validUntil` を一切見ない。**`validAt` を同時に渡しても無視される。**
   */
  includeOutsideValidity?: boolean | undefined;
  /**
   * 連想枠。**既定 on**（[ADR 0337](../../../docs/decisions/0337-recall-association-default-on.md)）。
   * 省略すると {@link DEFAULT_RECALL_ASSOCIATION} が適用される。明示的に off にしたいときは **`null` を渡す**
   * （`undefined` ＝省略、とは別の状態）。`null` を渡した呼び出しでは連想は一切走らず、`RecallUsage.byTier.association` も現れない。
   *
   * `DEFAULT_RECALL_ASSOCIATION.maxCount` は確定値ではなく、いまの時点で最も根拠のある仮値
   * （変えるときに直す箇所は ADR 0337「これが覆るとしたら」）。詳細は {@link RecallAssociationQuery}。
   */
  association?: RecallAssociationQuery | null | undefined;
  /**
   * `ctx.subjectId` の等値絞りを、明示的な `null`（主題なし）まで広げる opt-in
   * （[ADR 0286](../../../docs/decisions/0286-recall-include-subjectless.md)）。
   *
   * この欄は `ctx.subjectId` を置き換えない。述語を `subject_id = X` から `subject_id = X OR subject_id IS NULL` へ広げるだけ。
   * 既定（省略・`false`）では `subjectId: null` の Memory は、`ctx.subjectId` を指定した recall から見えない。
   * `true` を渡すと、`ctx.subjectId` と一致する Memory に加え `subjectId: null` の Memory も候補に含める。
   * **`ctx.subjectId` 自体を省略した呼び出し（テナント全体）ではこの欄は無視される**（すでに主題なしを含む上位集合のため）。
   *
   * 段1（`VectorFilter.includeSubjectless`/`LexicalFilter.includeSubjectless`）と段5の `MemoryStore.aggregateScope`
   * （`RecallScope.includeSubjectless`）へ渡る。全チャンネル共通の後置フィルタ（段1・段3.5）も同じ述語を見るので、
   * adapter がこの欄を無視しても、取りこぼすことはあっても別の subject の Memory を混ぜることはない。
   */
  includeSubjectless?: boolean | undefined;
  /**
   * `decay_clock` が `'wall'` 以外のテナントで、この recall がどのカウンタを `+1` するかを選ぶ
   * （[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。
   *
   * - `"tenant"`（既定・省略時）: テナント単位のカウンタ `T`（`tenant_activity.activity_seq`）を `+1` する。
   * - `"subject"`: `ctx.subjectId` が指定されているときだけ、その subject のカウンタ `S_x`（`tenant_subject_activity`）を
   *   `+1` する（`T` には触れない）。`ctx.subjectId` が無いときは `"tenant"` と同じ。
   *
   * 読み取り（忘却ゲート・段2の再スコア・掃引）は、この欄の値に関わらず常に「その Memory の subject の有効ないま」
   * （`T + S_x`。`subjectId` が無い記憶は `T` のみ）を使う。この欄が変えるのは前進（+1）の対象だけ。
   * 既定 `"tenant"` の呼び出しだけを続ける限り `tenant_subject_activity` は書き込まれず、読み取り側の SQL も
   * 相関サブクエリを足さない（`TenantSettingsStore.hasSubjectActivityCounters?` が `false` のまま）。
   */
  activityCounting?: "tenant" | "subject" | undefined;
  /**
   * 段2（再スコア）の時間項の方針を明示的に選ぶ（[ADR 0300](../../../docs/decisions/0300-time-weighting-policy-opt-in.md)）。
   *
   * 省略時は `"legacy"`（`DEFAULT_TIME_WEIGHTING_POLICY`、`ScoringInput.timeWeighting` と同じ既定）。
   * `"legacy"` の `freshness` は `occurredAt ?? recordedAt` を起点にした減衰係数で、`decay` と同じ半減期を使う。
   * `occurredAt` が無い記憶（恒常的な事実・好み）は、使われ続けていても `recordedAt` の古さで `freshness` だけが沈み続ける
   * （時間の二重減衰）。
   *
   * `"eventAwareFreshness"` を渡すと、`occurredAt` が無い記憶の `freshness` を 1（頭打ちの上限 `MAX_FRESHNESS`、ADR 0036）に
   * 固定する。`occurredAt` が在る記憶は `"legacy"` と同じ式のまま。
   *
   * 忘却ゲート（`includeFullyDecayed`）・`validAt` ゲート（`includeOutsideValidity`）とは独立。この欄は段2の順位付けだけを動かし、
   * 期限切れ・減衰しきった記憶は今までどおり除外される。
   */
  timeWeighting?: TimeWeightingPolicy | undefined;
}

/**
 * 段1で走らせられるチャンネルの、唯一の出所（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)）。
 *
 * ここに `"recent"` は無い。実装を伴わない値をユニオンに置かない（型に名前が在るのに何も起きない欠陥を増やさない。ADR 0144）。
 * 必要になったときに、実装と一緒に足す。リクエスト側のユニオンを広げても既存の呼び出し側は壊れない。
 */
export const RECALL_CHANNELS = ["ann", "lexical"] as const;

/** {@link RECALL_CHANNELS} の要素型。 */
export type RecallChannel = (typeof RECALL_CHANNELS)[number];

/** `RecallQuery.channels` の既定値。**ANN 1本**。 */
export const DEFAULT_RECALL_CHANNELS: readonly RecallChannel[] = ["ann"];

/**
 * 語彙チャンネルが走った run で、`ann_truncated` が `undecidable` に落ちる理由（ADR 0084 §7）。
 *
 * ADR 0069 の損失可能性の判定は「ANN の窓の外の候補の similarity は `sim_k'` 以下」を前提にする。
 * 語彙チャンネルが走るとこの前提が崩れる（窓の外の候補が `lexicalMatch` で `affinity = 1` を名乗りうる）ので、
 * 沈黙せず判定不能だと名乗る。
 */
export const ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE =
  "語彙チャンネルが走ったため、ANN の窓の外の候補が lexicalMatch で affinity を稼ぎうる。" +
  "ADR 0069 の上界（窓の外の similarity <= sim_k'）が前提として成り立たない。";

/**
 * `channels` に `"lexical"` が在るのに `LexicalStore` が配線されていないときに `recall()` が投げる例外の、
 * メッセージの接頭辞（ADR 0084 §4）。定数で出しているのは、呼び出し側が文字列を書き写さずに識別できるようにするため
 * （`UNSUPPORTED_KIND_ERROR_PREFIX` と同じ。ADR 0082）。
 */
export const LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX =
  "recall: channels included 'lexical' but no LexicalStore is wired: ";

/** RecallQuery.scoreThreshold の既定値。強い根拠のない裁量値。 */
export const DEFAULT_SCORE_THRESHOLD = 0.1;

/**
 * `RecallQuery.association` の入力。省略すると {@link DEFAULT_RECALL_ASSOCIATION} が適用される（既定 on。ADR 0337）。
 * 一切走らせたくないときは `RecallQuery.association: null` を渡す。
 *
 * 「何が似ているか」を新しく定義しない。ANN が使っているコサイン類似度を、クエリの代わりにアンカー（クエリで引けた記憶）を
 * 起点に使うだけ。
 */
export interface RecallAssociationQuery {
  /** 連想枠に入れる最大件数。**必須**（量の上限を呼び出し側に必ず明示させる。`digestBandLimit` が0を許さないのと似た理由）。 */
  maxCount: number;
  /**
   * 起点にするアンカーの数。既定 {@link DEFAULT_ASSOCIATION_ANCHOR_COUNT}。
   *
   * **`RecallQuery.limit`（既定 {@link DEFAULT_RECALL_LIMIT}）が天井になる。** アンカーは段3までに残った候補のうち
   * `limit` の内側に入った分から取る。`anchorCount` だけを上げても、`limit` を超えた候補は起点にならない。
   * 実際のアンカー数は `min(anchorCount, limit, 段2を通った候補数)`。連想の裾野を広げたいなら `limit` と `anchorCount` の
   * 両方を上げること。ただし `limit` を上げると段1の取り込み幅 `kPrime`（= `limit` × {@link DEFAULT_OVER_FETCH_FACTOR}）も
   * 広がるので、費用は連想枠だけの話では済まない。
   *
   * **計算量は O(`anchorCount` × `limit`)。** アンカー1つごとに `kPrime` 件まで ANN 検索で引くので、両方上げると積で増える。
   * アンカーごとの件数を席に要る分まで絞ることは、結果（`memories` の順序・score と `omitted` の件数）が変わるので
   * しなかった（docs/recall.md §9.2、ADR 0443 決定3）。
   *
   * **既定の 3 は固定で、テナントの規模に追随しない**。記憶が増えるほど、連想の起点になれる候補の割合は下がる。
   * 1万行の合成テナントでは、probe 自身のアンカーが段1の ANN 窓（`kPrime`）に入らず、既定のままでは gold へほとんど
   * 届かなかった（0〜1/12）。中身はアンカー数の不足だけではなく、`anchorCount` や `limit` を上げても確実には戻らない
   * （ADR 0332 §3）。規模に見合う値も、実運用のテナントで同じことが起きるかも測っていない。
   * アンカーごとの ANN 検索の往復は、`VectorStore.searchMany?` があれば1回に束ねる。
   */
  anchorCount?: number;
  /**
   * アンカーとの類似度の下限。既定 {@link DEFAULT_ASSOCIATION_MIN_SIMILARITY}。
   *
   * 既存の `scoreThreshold`（既定 {@link DEFAULT_SCORE_THRESHOLD} = 0.1）とは独立の値。`scoreThreshold` は
   * `ScoreBreakdown.total`（複合値）に対する閾値、`minSimilarity` は生のコサイン類似度（`1 - distance`。負にもなりうる）に
   * 対する閾値で、尺度が違う。流用すると、どちらかを見直すときにもう片方を巻き込む。
   *
   * **負の値にすると、連想枠の席の順位が単調でなくなる**（値の範囲は検査していない。ADR 0433 決定2）。席の順位キーは
   * `アンカー類似度 × decay × tagMatch × freshness × strength` で、類似度が負の候補では、積の絶対値が小さい
   * （古く弱い）ほど 0 に近く上位に来る。既定は負の類似度を通さないので、この逆転は `minSimilarity` を負にしたときだけ起きる。
   * 負にする理由が無ければ 0 以上にすること（docs/recall.md §9.2）。
   */
  minSimilarity?: number;
}

/** `RecallAssociationQuery` の zod スキーマ。 */
export const RecallAssociationQuerySchema = z.object({
  maxCount: z.number().int().positive(),
  anchorCount: z.number().int().positive().optional(),
  minSimilarity: z.number().optional(),
}) satisfies z.ZodType<RecallAssociationQuery>;

/** `RecallAssociationQuery.anchorCount` の既定値。 */
export const DEFAULT_ASSOCIATION_ANCHOR_COUNT = 3;

/**
 * `RecallAssociationQuery.minSimilarity` の既定値。
 *
 * 強い根拠のない裁量値。コサイン類似度は埋め込みモデル・データ分布に強く依存するので、実データでの分布を測ってから
 * 見直す（見直す根拠は「多くの連想候補がこの値の前後で切られている」という実測で、勘で変えない）。
 * `scoreThreshold`（0.1）のような緩い閾値にしないのは、連想は「クエリしていないのに手元に来る」性質上、無関係なものを
 * 混ぜるコストがクエリ結果より高いため。
 */
export const DEFAULT_ASSOCIATION_MIN_SIMILARITY = 0.5;

/**
 * `RecallQuery.association` を省略したときに適用される既定値（[ADR 0337](../../../docs/decisions/0337-recall-association-default-on.md)）。
 *
 * `maxCount: 10` は10万行級で再検証された値ではなく、いまの時点で最も根拠のある仮値。`haystackSize=62` の小規模では
 * gold 到達 12/12（費用 `memoryChars` +4.32%、ADR 0168）だったが、10万行級の実測（ADR 0332）は確定しておらず、
 * `maxCount=10` を積極的に支持する新しい実測ではない。実運用の分布で見直すべき値で、勘で変えない。
 *
 * `examples/chat` はこの定数を継がず、`DEFAULT_MNEMORA_PATH_ASSOCIATION`（`examples/chat/src/mnemora-path.ts`）が同じ値を独自に
 * 持つ。どちらかを直したら他方も直すか検討すること（ADR 0337）。
 * `anchorCount`/`minSimilarity` は個別の既定に委ね、ここでは上書きしない。
 */
export const DEFAULT_RECALL_ASSOCIATION: RecallAssociationQuery = {
  maxCount: 10,
};

/** RecallQuery.limit の既定値。 */
export const DEFAULT_RECALL_LIMIT = 10;

/** RecallQuery.overFetchFactor の既定値（docs/recall.md §3: k' = k × overFetchFactor）。 */
export const DEFAULT_OVER_FETCH_FACTOR = 4;

/** `RecallQuery` の zod スキーマ。 */
export const RecallQuerySchema = z.object({
  text: z.string().min(1).optional(),
  vector: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
  attributes: AttributesSchema.optional(),
  occurredAfter: z.date().optional(),
  occurredBefore: z.date().optional(),
  limit: z.number().int().positive().optional(),
  overFetchFactor: z.number().positive().optional(),
  excludeProvenanceKinds: z.array(ProvenanceKindSchema).optional(),
  // 一覧を書き写さない。RECALL_CHANNELS から導く（ADR 0084、ADR 0082）。
  channels: z.array(z.enum(RECALL_CHANNELS)).min(1).optional(),
  budget: RecallBudgetSchema.optional(),
  scoreThreshold: z.number().optional(),
  digestBandLimit: z.number().int().positive().optional(),
  // ADR 0384 案C: 既定は省略（"exact" と同じ）。
  scopeAggregate: z.enum(["exact", "skip"]).optional(),
  includeFullyDecayed: z.boolean().optional(),
  validAt: z.date().optional(),
  includeOutsideValidity: z.boolean().optional(),
  // 数え方は前進の対象だけを選ぶ引数で、読み取りには影響しない（ADR 0353）。
  activityCounting: z.enum(["tenant", "subject"]).optional(),
  // .nullable() は明示的な off（ADR 0337）、.optional() は省略（`DEFAULT_RECALL_ASSOCIATION` が適用される）。
  association: RecallAssociationQuerySchema.nullable().optional(),
  includeSubjectless: z.boolean().optional(),
  // 一覧を書き写さない。TIME_WEIGHTING_POLICIES から導く（ADR 0300）。
  timeWeighting: z.enum(TIME_WEIGHTING_POLICIES).optional(),
  labels: z.array(z.string()).optional(),
  taxonomyGroups: z.boolean().optional(),
  // 上限1000の理由は `RecallQuery.relationMaxCount` の doc。
  relationMaxCount: z.number().int().positive().max(1000).optional(),
}) satisfies z.ZodType<RecallQuery>;

/**
 * `MemoryStore.aggregateScope` に渡すスコープ。`subjectId` を省略すると「テナント全体」を意味する。
 */
export interface RecallScope {
  /** スコープの主題（`ctx.subjectId`）。無ければテナント全体。 */
  subjectId?: string | undefined;
  /** `RecallQuery.occurredAfter` のまま。 */
  occurredAfter?: Date | undefined;
  /** `RecallQuery.occurredBefore` のまま。 */
  occurredBefore?: Date | undefined;
  /** `RecallQuery.validAt` ゲートが有効なときの基準時刻。ゲート無効（`includeOutsideValidity`）なら `undefined`。 */
  validAt?: Date | undefined;
  /**
   * 忘却ゲートの壁時計側の基準時刻（[ADR 0173](../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md)）。
   * `RecallQuery.includeFullyDecayed` とテナントの `decay_clock`（ADR 0165）で、ゲート無効なら `undefined`。
   *
   * ここに並ぶ3欄は `VectorFilter.decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis` と同じ名前・同じ意味・同じ境界
   * （狭義の `>`）。名前を揃えているのは、段1の押し下げと段5の集約が同じ述語を見ていることが、
   * `omitted.filtered(decayed)` の件数を信じられる唯一の根拠だから（ADR 0173）。
   */
  decayFloorAtAfter?: Date | undefined;
  /**
   * 忘却ゲートの活動時計側の基準（ADR 0165 の `activity_seq`）。`decayFloorSeq` が NULL の Memory は
   * 「この軸には床が無い」ので常に生き残る（`VectorFilter.decayFloorSeqAfter` と同じ規則）。
   */
  decayFloorSeqAfter?: number | undefined;
  /**
   * `decay_clock: 'either'`（ADR 0165）のとき `true`。2軸を **OR** で結ぶ（どちらかが生きていれば通す）。
   * `VectorFilter.decayFloorAnyAxis` と同じく、両方の基準が渡されているときだけ効く。
   * `MemoryStore.archiveDecayed` の `'either'` は **AND** で向きが逆（`ArchiveDecayedOptions.clock`）。ここはゲート側なので OR。
   */
  decayFloorAnyAxis?: boolean | undefined;
  /**
   * `VectorFilter.decayFloorSeqUsesSubjectCounters` と同じ意味（[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。
   * `true` なら `decayFloorSeqAfter`（`T`）に、その Memory の `subjectId` に対応する `S_x` を足した値と比較する。
   */
  decayFloorSeqUsesSubjectCounters?: boolean | undefined;
  /**
   * `RecallQuery.includeSubjectless` がそのまま入る（[ADR 0286](../../../docs/decisions/0286-recall-include-subjectless.md)）。
   * `true` なら `subjectId` の等値絞りに `subject_id IS NULL` を OR で足す。`VectorFilter`/`LexicalFilter` と
   * `MemoryStore.aggregateScope` に同じ `scope` が渡る。`subjectId` が `undefined`（テナント全体）のときは無視される。
   */
  includeSubjectless?: boolean | undefined;
  /**
   * `RecallQuery.attributes` がそのまま入る（ADR 0312）。空オブジェクトなら `recall-runtime.ts` が `undefined` に正規化する。
   * **軸の唯一の出所**: 段1・段3.5の `VectorFilter.attributes`/`LexicalFilter.attributes` と `MemoryStore.aggregateScope` は
   * この欄を読むだけで自前の式を持たない（2箇所に式を書くと食い違う。ADR 0038）。
   */
  attributes?: Attributes | undefined;
  /**
   * `RecallQuery.labels` を、現在の `taxonomy_mode` での参加資格（`registered` は常に、`proposed` は `taxonomy_mode: 'open'` のときだけ）で
   * 絞り込んだ結果（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）。意味論は OR。
   *
   * `attributes` と違い、`filtered` として報告される（`FilteredOmission.condition: 'taxonomy'`）。`totalInScope` は絞り込みの内側だけを数える。
   *
   * **3つの状態を区別する**:
   * - `undefined`: 絞り込み無し（全件通過）。`RecallQuery.labels` が未指定または空配列。
   * - 空配列 `[]`: 絞り込みは要求されたが、参加資格のある名前が1つも残らなかった（ADR 0323 決定2）。
   *   **「何にも一致しない」述語として働く**（`undefined` とは逆の結果）。`docs/memory-model.md` §8。
   * - 非空配列: その名前のいずれかを `tags` に持つ Memory だけを通す。
   *
   * 段1（`VectorFilter.labels`/`LexicalFilter.labels`）と段3.5へ押し下げ、`MemoryStore.aggregateScope` にも同じ `scope` が渡る
   * （`attributes` と同じ規律。ADR 0038）。**必須の同伴取得（段3）では検査しない**（`tags` が同伴取得を素通しするのと同じ。ADR 0323 決定3）。
   */
  labels?: string[] | undefined;
  /**
   * `RecallQuery.taxonomyGroups: true` のときだけ、`IndexBand.groups` に `axis: 'taxonomy'` の群を作るための候補ラベル名
   * （現在の `taxonomy_mode` で参加資格のある、テナントの語彙全体。ADR 0323）。
   *
   * `labels` とは独立。`undefined` は「グルーピングしない」。空配列は「グルーピングは要求されたが、現在参加資格のあるラベルが0件」を
   * 表す有効な値で、残差群 `{ axis: 'taxonomy', key: null, ... }` だけが載りうる。`labels` フィルタが指定されているときは
   * その絞り込みの内側を数える。この軸の `count` の総和は `totalInScope` を超えうる（`GroupCount`、ADR 0323 決定6）。
   */
  taxonomyGroupCandidates?: string[] | undefined;
}

/** `RecallScope` の zod スキーマ。 */
export const RecallScopeSchema = z.object({
  subjectId: z.string().min(1).optional(),
  occurredAfter: z.date().optional(),
  occurredBefore: z.date().optional(),
  validAt: z.date().optional(),
  decayFloorAtAfter: z.date().optional(),
  decayFloorSeqAfter: z.number().optional(),
  decayFloorAnyAxis: z.boolean().optional(),
  decayFloorSeqUsesSubjectCounters: z.boolean().optional(),
  includeSubjectless: z.boolean().optional(),
  attributes: StoredAttributesSchema.optional(),
  labels: z.array(z.string()).optional(),
  taxonomyGroupCandidates: z.array(z.string()).optional(),
}) satisfies z.ZodType<RecallScope>;

/** `recall()` の戻り値を zod で検証した結果の1項目（ADR 0098）。`path` は不正だったフィールドのドット連結（例: `"usage.estimatedTokens"`）。 */
export interface RecallOutputValidationIssue {
  /** 不正だった欄のドット連結のパス。 */
  path: string;
  /** zod の issue の `code`。 */
  code: string;
  /** zod の issue の `message`。 */
  message: string;
}

/** `RecallOutputValidationIssue` の zod スキーマ。 */
export const RecallOutputValidationIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
}) satisfies z.ZodType<RecallOutputValidationIssue>;

/**
 * `recall()` の戻り値を zod で検証した結果（ADR 0098）。
 *
 * **この欄の「無い」は3種類ある（潰さない。ADR 0008）:**
 * - `RecallResult.outputValidation` 自体が無い（`undefined`）— 検証していない（`RecallRuntimeDeps.outputValidation: "off"`）。
 * - `{ ok: true, issues: [] }` — 検証して通った。
 * - `{ ok: false, issues: [...] }` — 検証して落ちた。`issues` は `ok: false` のときだけ非空。
 *
 * **`usage.share > 1` はこの検証が弾く対象ではない**（ADR 0097）。`RecallResultSchema` は `.max(1)` を持たないので
 * `share: 1.1` は `ok: true` として通る。この検証は壊れた値を見えるようにするためにあり、`usage` を丸めたり書き換えたりしない。
 */
export interface RecallOutputValidation {
  /** 検証に通ったなら `true`。 */
  ok: boolean;
  /** 検証に落ちた箇所（`ok` なら空配列）。 */
  issues: RecallOutputValidationIssue[];
}

/** `RecallOutputValidation` の zod スキーマ。 */
export const RecallOutputValidationSchema = z.object({
  ok: z.boolean(),
  issues: z.array(RecallOutputValidationIssueSchema),
}) satisfies z.ZodType<RecallOutputValidation>;

/** `recall()` の戻り値。 */
export interface RecallResult {
  /** 記録された recall の識別子。observe() の usage 報告で使う。 */
  recallId: RecallId;
  /** 返した記憶（順位の順）。 */
  memories: RecalledMemory[];
  /**
   * 返さなかった記憶の分類（`docs/recall.md` §4）。**`memories` と memoryId で排他**: ある memoryId が `memories` に載っているなら、
   * この配列のどの Omission もその memoryId を名指しで含まない（[ADR 0203](../../../docs/decisions/0203-memories-omitted-exclusivity.md)）。
   * memoryId を明示的に持つのは `BelowThresholdOmission.nearMisses` だけで、外部から個体単位で検証できるのもそこだけ。
   * 他の `kind` は件数だけを持ち（あるいは件数も持たず）、どの記憶を指しているかを言わない。
   * `over_limit(stage:"rescore")` も、段3の必須同伴取得が候補を昇格させたとき `count` から差し引かれる（全件昇格すれば
   * Omission 自体が消える）が、外部から検証はできない。`over_limit(stage:"association")`/`budget_dropped`/
   * `score_not_comparable` 等は対象外。
   */
  omitted: Omission[];
  /** 目次帯（{@link IndexBand}）。 */
  index: IndexBand;
  /** 返した量の計測（{@link RecallUsage}。測るだけで抑止しない）。 */
  usage: RecallUsage;
  /** 段ごとの記録（{@link StageTrace}）。 */
  explain: { stages: StageTrace[] };
  /**
   * `recall()` の戻り値（この欄自身を除く）を zod で検証した結果（ADR 0098）。
   *
   * 省略時（`undefined`）は「検証していない」（`RecallRuntimeDeps.outputValidation: "off"`）で、「検証して通った」とは違う
   * （{@link RecallOutputValidation} の3状態）。**既定（`RecallRuntimeDeps.outputValidation` を省略したとき）は `"report"` で、
   * 検証に落ちても `recall()` は例外を投げない**（`outputValidation.ok` で判断する）。投げさせたい場合は
   * `"throw"` を渡す（`RecallOutputValidationError`）。
   */
  outputValidation?: RecallOutputValidation;
}

/** `RecallResult` の zod スキーマ。 */
export const RecallResultSchema = z.object({
  recallId: z.string().min(1),
  memories: z.array(RecalledMemorySchema),
  omitted: z.array(OmissionSchema),
  index: IndexBandSchema,
  usage: RecallUsageSchema,
  explain: z.object({ stages: z.array(StageTraceSchema) }),
  outputValidation: RecallOutputValidationSchema.optional(),
}) satisfies z.ZodType<RecallResult>;

/**
 * `recalls` へ永続化する、返した記憶1件ぶんの内訳（[ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md)）。
 * 「後から再現できないもの」だけを持つ。`digest` と `provenanceKind` は `MemoryStore.get(ctx, memoryId)` で再現できるので持たない
 * （同じことを言う道を2つ作らない。ADR 0155 決定1）。
 */
export interface RecallRecordMemory {
  /** 返した記憶の id。 */
  memoryId: MemoryId;
  /**
   * 返した時点のスコアの内訳。`RecalledMemory.score` と同じ判別（{@link RecalledScore}、ADR 0352）。
   *
   * ADR 0352 より前に永続化された行は、`association` 経由の記憶でも `total`/`similarity`/`lexicalMatch` を含む
   * `ScoreBreakdown` の形のまま残っている。`getRecall` はこの欄を zod で検証せず（ADR 0282 決定4）、書かれた形をそのまま返す。
   * 過去の行を作り直すマイグレーションはしない。
   */
  score: RecalledScore;
  /** どの経路で引いたか（`RecalledMemory.retrievedVia` と同じ）。 */
  retrievedVia: RecalledMemory["retrievedVia"];
  /** 同伴として引いたとき、その持ち主の id（`RecalledMemory.companionOf` と同じ）。 */
  companionOf?: MemoryId;
  /** 連想で引いたとき、そのアンカーの id（`RecalledMemory.associationOf` と同じ）。 */
  associationOf?: MemoryId;
}

/**
 * `MemoryStore.getRecall` が返す `returnedMemories` の形（[ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md)）。
 *
 * `breakdownCaptured` で「無い」と「空」を区別する（ADR 0008）。マイグレーション以前に書かれた行は内訳を持たず、
 * `breakdownCaptured: false` で `memories` は `memoryId` だけを持つ。それ以降に書かれた行は常に `breakdownCaptured: true` で、
 * `memories` が空配列なら「その recall が0件しか返さなかった」。この2つを同じ `[]` の顔にしない。
 */
export type RecallRecordReturnedMemories =
  | { breakdownCaptured: true; memories: RecallRecordMemory[] }
  | { breakdownCaptured: false; memories: Array<{ memoryId: MemoryId }> };

/**
 * `MemoryStore.createRecall` への入力。`recalls` テーブル1行分のスナップショット（docs/memory-model.md §10）。
 * 段6が必須である理由は docs/recall.md §2・§4。`returnedMemories` は書き込み時点で常に内訳を持つ
 * （内訳が無いのは {@link RecallRecordReturnedMemories} 側の、マイグレーション以前の行だけ）。
 */
export interface NewRecallRecord {
  /** recall を呼んだテナント。 */
  tenantId: string;
  /** recall のスコープの主題。無ければ `null`。 */
  subjectId?: string | null | undefined;
  /**
   * 発行された recall クエリ/オプションのスナップショット（JSON にシリアライズ可能な形）。
   * `recall()` は検証した後のクエリをそのまま渡すので `Date` の欄を含みうる。読み戻した値は adapter によって違う（{@link RecallRecord.query}）。
   */
  query: unknown;
  /** 渡された予算。無ければ `null`。 */
  budget?: RecallBudget | null | undefined;
  /** 返さなかったものの理由（`RecallResult.omitted`）。 */
  omitted: Omission[];
  /** 返した量の計測。 */
  usage: RecallUsage;
  /** 目次帯。 */
  indexBand: IndexBand;
  /** 段ごとの記録。 */
  explain: { stages: StageTrace[] };
  /** 返した記憶と、その時点の内訳。 */
  returnedMemories: RecallRecordMemory[];
  /**
   * `true` のとき、`MemoryStore.createRecall` の実装は `recalls` への INSERT と**同一トランザクションで**
   * `tenant_activity.activity_seq`（テナント単位のカウンタ `T`）を `+1` しなければならない（[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5）。
   * 既定 `false`（省略時は `activity_seq` は動かない）。
   *
   * `{ scope: "subject"; subjectId }` を渡すと、実装は `T` ではなく `tenant_subject_activity`（`subjectId` の行、`S_x`）を
   * 同じトランザクションで `+1` する（`T` には触れない。[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。
   * `RecallQuery.activityCounting: "subject"` かつ `ctx.subjectId` が指定された recall のときだけ、呼び出し側がこの形を渡す。
   *
   * **1単位 = `recall()` 1回。** `observe()` はこのカウンタに触れない（ADR 0165 決めたこと6。書き込みは「想起される機会」ではない）。
   *
   * **呼び出し側の責務**: `false` 以外を渡すのは、そのテナントの `decay_clock` が `'wall'` 以外のときに限る。
   * この欄自体は `decay_clock` を読まない。
   */
  advanceActivityClock?: boolean | { scope: "subject"; subjectId: string } | undefined;
  /** 書き込む行の `createdAt`。省略時は実装が壁時計（`new Date()`）を使う。`recall-runtime.ts` は `clock.now()` を渡す。 */
  createdAt?: Date | undefined;
}

/**
 * `MemoryStore.getRecall` の戻り値。`recalls` 行1件ぶん全部（[ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md)）。
 * 見つからなければ `null`（例外にしない。`MemoryStore.get`/`getObservation` と同じ規律）。
 */
export interface RecallRecord {
  /** recall の id。 */
  recallId: RecallId;
  /** recall を呼んだテナント。 */
  tenantId: string;
  /** recall のスコープの主題。無ければ `null`。 */
  subjectId: string | null;
  /**
   * 記録したクエリ（`recall()` が検証した後の `RecallQuery`）。
   *
   * JSON で往復しない値は、adapter によって違う値で読み戻る。型は `unknown` のままで、どちらかに揃える約束はしない。
   *
   * | 値 | `@mnemora/postgres`（`jsonb` に保存） | `@mnemora/testkit` の fixture |
   * |---|---|---|
   * | `occurredAfter`・`occurredBefore`・`validAt`（渡したときは `Date`） | ISO 8601 の文字列 | `Date` |
   * | `vector` の要素の `-0` | `0` | `-0` |
   * | キーの順 | `jsonb` の順（渡した順ではない） | 渡した順 |
   *
   * `RecallQuery` の検証は `NaN`・`Infinity` を拒むので、JSON で往復しない値はこの表のものだけ。
   * 読み戻した日付を使う側は、`new Date(value)` を通すと両方で同じ値になる。
   */
  query: unknown;
  /** 渡された予算。無ければ `null`。 */
  budget: RecallBudget | null;
  /** 返さなかったものの理由。 */
  omitted: Omission[];
  /** 返した量の計測。 */
  usage: RecallUsage;
  /** 目次帯。 */
  indexBand: IndexBand;
  /** 段ごとの記録。 */
  explain: { stages: StageTrace[] };
  /** 返した記憶（内訳を持たない古い行もある。{@link RecallRecordReturnedMemories}）。 */
  returnedMemories: RecallRecordReturnedMemories;
  /** 記録した時刻。 */
  createdAt: Date;
}

/** `not_indexed` の理由の全列挙（`recall()` が理由ごとに Omission を1件ずつ返すのに使う）。 */
export const NOT_INDEXED_REASONS: readonly NotIndexedReason[] = ["pending", "failed", "skipped"];
