import { z } from "zod";
import type { MemoryId, RecallId } from "./ids.js";
import type { ProvenanceKind } from "./provenance.js";

/**
 * 件数そのものの「無いの種類」（docs/recall.md §4）。
 * 推定値を実測値の顔で出さない、という原則の実装。
 */
export type CountKind = "exact" | "lower_bound" | "unknown";

export const CountKindSchema = z.enum([
  "exact",
  "lower_bound",
  "unknown",
]) satisfies z.ZodType<CountKind>;

// ---------------------------------------------------------------------------
// Omission（docs/recall.md §4、ADR 0008）
// ---------------------------------------------------------------------------

export interface StageSkippedOmission {
  kind: "stage_skipped";
  stage: "candidate_generation" | "rescore" | "index_band";
  reason: "embedding_provider_unavailable" | "empty_query_content" | "budget_exhausted";
}

export interface FilteredOmission {
  kind: "filtered";
  /**
   * `"superseded"` と `"forgotten"` を分けて持つ（ADR 0027）。両方とも status ゲートで
   * 落ちる点は同じだが、次の一手が違う——`superseded` はより良い抽出に置き換えられた
   * という**機構の都合**（`superseded_by_id` で置き換え先を辿れる）、`forgotten` は
   * 利用者が明示的に忘れさせたという**製品の振る舞い**（指す先を持たない）。1つの
   * `"status"` に束ねると、「利用者が忘れてほしいと言ったのか、こちらが作り直したのか」を
   * 呼び出し側が判定できなくなる。`"archived"` が既に別条件として独立している先例に倣う。
   */
  condition: "tenant" | "superseded" | "forgotten" | "archived" | "taxonomy" | "period";
  count: number;
  countKind: CountKind;
}

export interface BelowThresholdOmission {
  kind: "below_threshold";
  count: number;
  countKind: CountKind;
  nearMisses?: { memoryId: MemoryId; score: number }[];
}

export interface OverLimitOmission {
  kind: "over_limit";
  count: number;
  countKind: CountKind;
}

export interface BudgetDroppedOmission {
  kind: "budget_dropped";
  count: number;
  countKind: CountKind;
}

/**
 * `not_indexed` の理由。`embeddingStatus` のうち `'ready'` 以外の3値に対応する。
 *
 * ADR 0008 の基準（区別があると次の一手が変わるか）に照らして分ける:
 * `pending` は待てば解決する、`failed` はパイプラインの調査が要る、
 * `skipped` は意図した除外なので何もしなくてよい。
 */
export type NotIndexedReason = "pending" | "failed" | "skipped";

export const NotIndexedReasonSchema = z.enum([
  "pending",
  "failed",
  "skipped",
]) satisfies z.ZodType<NotIndexedReason>;

export interface NotIndexedOmission {
  kind: "not_indexed";
  /** なぜ索引に載っていないか。理由ごとに1件ずつ返す（`filtered` の `condition` と同じ形）。 */
  reason: NotIndexedReason;
  count: number;
  countKind: CountKind;
}

export interface AnnTruncatedOmission {
  kind: "ann_truncated";
  countKind: "unknown";
}

/**
 * ANR 索引が、scope 内にまだ見られていない候補を残したまま k' に届かなかったことの報告
 * （[ADR 0025](../../../docs/decisions/0025-ann-underfill-is-not-reported-in-omitted.md) の
 * 実測、[ADR 0026](../../../docs/decisions/0026-ann-unreached-omission.md) の決定）。
 *
 * **`ann_truncated` に相乗りさせない。** over-fetch の打ち切り（k' に達した＝もっと在るはず
 * だが LIMIT で切った）と、この事象（k' に届く前に ANN が scope の他の場所へ行ってしまい、
 * この scope の候補に届かなかった）は**別の出来事**である。同じ札に潰すと、
 * ADR 0008 が禁じている「別の理由を同じ顔にする」を自分でやることになる。
 *
 * **🔴 件数を持たせない。`countKind` は常に `'unknown'` である。**
 * 理由: この系は「何件取りこぼしたか」を原理的に知りようがない——ANN が触れなかった
 * 候補を数えるには、scope 全体を厳密に走査して ANN が返した集合と突き合わせる必要があり、
 * それをやるなら ANN を使う意味（近似で索引を使い倒す）自体が無くなる。
 * だから新しい語彙（例えば独自の "unreachable" カウント種別）を作らず、既にある
 * `CountKind` の `'unknown'` で「取りこぼしたのは確かだが、何件かは分からない」とだけ言う。
 * （`AnnTruncatedOmission` が同じ形をしているのに倣った。）
 */
export interface AnnUnreachedOmission {
  kind: "ann_unreached";
  countKind: "unknown";
}

export type Omission =
  | StageSkippedOmission
  | FilteredOmission
  | BelowThresholdOmission
  | OverLimitOmission
  | BudgetDroppedOmission
  | NotIndexedOmission
  | AnnTruncatedOmission
  | AnnUnreachedOmission;

const StageSkippedOmissionSchema = z.object({
  kind: z.literal("stage_skipped"),
  stage: z.enum(["candidate_generation", "rescore", "index_band"]),
  reason: z.enum(["embedding_provider_unavailable", "empty_query_content", "budget_exhausted"]),
}) satisfies z.ZodType<StageSkippedOmission>;

const FilteredOmissionSchema = z.object({
  kind: z.literal("filtered"),
  condition: z.enum(["tenant", "superseded", "forgotten", "archived", "taxonomy", "period"]),
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
}) satisfies z.ZodType<AnnTruncatedOmission>;

const AnnUnreachedOmissionSchema = z.object({
  kind: z.literal("ann_unreached"),
  countKind: z.literal("unknown"),
}) satisfies z.ZodType<AnnUnreachedOmission>;

export const OmissionSchema = z.discriminatedUnion("kind", [
  StageSkippedOmissionSchema,
  FilteredOmissionSchema,
  BelowThresholdOmissionSchema,
  OverLimitOmissionSchema,
  BudgetDroppedOmissionSchema,
  NotIndexedOmissionSchema,
  AnnTruncatedOmissionSchema,
  AnnUnreachedOmissionSchema,
]);

// ---------------------------------------------------------------------------
// 目次帯 / 被覆不変条件（docs/recall.md §5）
// ---------------------------------------------------------------------------

/**
 * D12: `key` は `string | null` にする。`subject_id IS NULL` の群を表すため。
 * `'(none)'` のような番兵文字列は実在する subject 名と衝突しうるので採らない。
 */
export interface GroupCount {
  axis: "subject" | "taxonomy" | "time_window";
  key: string | null;
  count: number;
  countKind: CountKind;
}

export const GroupCountSchema = z.object({
  axis: z.enum(["subject", "taxonomy", "time_window"]),
  key: z.string().nullable(),
  count: z.number().int().nonnegative(),
  countKind: CountKindSchema,
}) satisfies z.ZodType<GroupCount>;

/** Phase 2 の digest 帯（recall.md §5）。Phase 1 では型だけ持ち、常に undefined。 */
export interface DigestEntry {
  memoryId: MemoryId;
  digest: string;
}

export const DigestEntrySchema = z.object({
  memoryId: z.string().min(1),
  digest: z.string(),
}) satisfies z.ZodType<DigestEntry>;

export interface IndexBand {
  groups: GroupCount[];
  totalInScope: number;
  countKind: CountKind;
  /** Phase 2。Phase 1 では常に undefined。 */
  digestBand?: DigestEntry[];
}

export const IndexBandSchema = z.object({
  groups: z.array(GroupCountSchema),
  totalInScope: z.number().int().nonnegative(),
  countKind: CountKindSchema,
  digestBand: z.array(DigestEntrySchema).optional(),
}) satisfies z.ZodType<IndexBand>;

// ---------------------------------------------------------------------------
// スコープの外延（マネージャー決定。docs/recall.md §2 段0・§5 の欠けていた定義の補完）
// ---------------------------------------------------------------------------

/**
 * `recall()` のスコープ = tenant + subject + 時間窓(period) + taxonomy + status ゲート。
 *
 * **マネージャー決定（本 PR）**: docs/recall.md §5 は被覆不変条件を「スコープ内の全 Memory は、
 * 返るか群カウントに乗るかのどちらか。かつ総和がスコープ内の総数と一致する」と定めるが、
 * 「スコープ」の外延がどこにも確定していなかった（§2 段0は tenant/subject/時間窓/taxonomy と
 * 書いて status に触れず、§4 の `FilteredOmission.condition` には `'status'`/`'archived'` が
 * 在るという食い違い）。この型はその補完——status ゲート（段1と同じ
 * `status IN ('active','contested')`）をスコープの一部として確定する決定を反映する。
 *
 * **tenant と subject はスコープの外側の境界であり、`filtered` としては報告しない**
 * （`FilteredOmission.condition` に `'tenant'`/`'subject'` の値が無いことと対応する。
 * ちょうど「別テナントのデータ」を omission として報告しないのと同じ理由——呼び出し側が
 * 明示した境界の外は「失われた」のではなく「そもそも問うていない」）。
 * **period・status（archived / superseded / forgotten）が実際に `filtered` として
 * 報告される次元である。** taxonomy は Phase 1 に実体が無い（labels テーブルは Phase 2、docs/memory-model.md §8）ため、
 * この集約では常に発生しない（型としての `FilteredOmission.condition: 'taxonomy'` は
 * Phase 2 向けに残す）。
 *
 * **件数はすべてこの集約1本から取る**（ADR 0011 が段1から締め出した
 * `count(*) OVER ()` の代わりに指定した経路と同じ発想）。`groups` の総和・`totalInScope`・
 * `filteredArchived`/`filteredSuperseded`/`filteredForgotten`/`filteredPeriod`/`notIndexed`
 * の各件数を、
 * 別々のクエリではなく同一の集約クエリから得ることで、書き込みが並行して起きていても
 * 「群カウントと totalInScope の総和が一致する」という被覆不変条件が構造的に崩れない。
 */
export interface ScopeAggregate {
  /** 群カウント（第3階、axis は Phase 1 では常に 'subject'）。totalInScope に一致するよう合算できる。 */
  groups: GroupCount[];
  /** スコープ内（tenant + subject? + period? + status ゲート）の総数。 */
  totalInScope: number;
  /** groups の総和が totalInScope と一致することの信頼度。Phase 1 は常に 'exact'。 */
  countKind: CountKind;
  /**
   * スコープ内だが埋め込みがまだ無い件数を、**理由ごとに分けて**持つ。
   *
   * 1つの数値に潰さないのは ADR 0008 の判定基準（その区別があると呼び出し側の次の一手が
   * 変わるか）による。**変わる**——`pending` は「待つ / 再試行する」、`failed` は
   * 「埋め込みパイプラインを疑う」、`skipped` は「意図した除外なので何もしない」。
   * これを1つの `not_indexed` に潰すと、恒久的な失敗と一時的な遅延が同じ顔になる。
   */
  notIndexed: Record<NotIndexedReason, { count: number; countKind: CountKind }>;
  /** status = 'archived' で「スコープを定義するフィルタ」により落ちた件数。 */
  filteredArchived: { count: number; countKind: CountKind };
  /**
   * status = 'superseded' で落ちた件数——**機構の都合**（より良い抽出に置き換えられた）。
   * `filteredForgotten` とは分けて持つ（ADR 0027）。ADR 0008 の判定基準（区別があると
   * 呼び出し側の次の一手が変わるか）に照らすと変わる——`superseded` は置き換え先
   * （`superseded_by_id`）を辿れば「なぜ無いのか」の説明が付くのに対し、`forgotten` は
   * 利用者が意図して忘れさせた結果であり、置き換え先を持たない。同じ札に束ねると、
   * 「利用者が忘れてほしいと言ったのか、こちらが作り直しただけなのか」を呼び出し側が
   * 判定できなくなる。`archived` が既に独立した条件になっている先例に倣う。
   */
  filteredSuperseded: { count: number; countKind: CountKind };
  /**
   * status = 'forgotten' で落ちた件数——**製品の振る舞い**（利用者が明示的に忘れさせた）。
   * `filteredSuperseded` を見よ。
   */
  filteredForgotten: { count: number; countKind: CountKind };
  /** 時間窓（period）の外にあるため落ちた件数。period 未指定なら常に0。 */
  filteredPeriod: { count: number; countKind: CountKind };
}

// ---------------------------------------------------------------------------
// 量の計測と予算（docs/recall.md §6）
// ---------------------------------------------------------------------------

/**
 * 実際に返した量の計測（docs/recall.md §6）。
 *
 * **計測（`usage`）と強制（`budget`）は別物である。**`usage` は測るだけで、
 * 何も抑止しない（docs/roadmap.md §4「計測と抑止を混同しない」）。
 */
export interface RecallUsage {
  /** 返した全量（`memories` tier + 目次帯）。 */
  chars: number;
  estimatedTokens: number;
  counter: "heuristic" | "exact";
  byTier: { full: number; digest: number; index: number };
  /**
   * 目次帯（`IndexBand`）の実費。**`budget` の対象外**であり、
   * `budget` をどれだけ小さくしてもこの分は削られない（理由は `RecallBudget` を見よ）。
   *
   * `chars - indexChars` が予算の対象になった量である——**予算の内と外が、
   * 数の形から読めるようにするために独立して返す。**（`byTier.index` と同じ値。）
   */
  indexChars: number;
  /**
   * `budget` が申告されている場合のみ。**予算の対象（`memories` tier）が、
   * 申告された予算のどれだけを使ったか。**
   *
   * **⚠ 分子は `memories` tier だけであり、目次帯を含まない。したがって
   * この値は 1 を超えない**（段4の切り詰めが予算を守ることを保証しているため）。
   *
   * 以前は分子に目次帯を含めていたため 248% のような「割合として成立しない値」が出ていた。
   * 「私が渡した予算のうち記憶がどれだけ使ったか」と「この応答は全体でいくらかかったか」は
   * **別の問い**であり、1つの数で両方に答えようとするとどちらかが嘘になる。
   * 後者は `chars` と `indexChars` を見れば分かる。
   */
  share?: number;
}

export const RecallUsageSchema = z.object({
  chars: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  counter: z.enum(["heuristic", "exact"]),
  byTier: z.object({
    full: z.number().int().nonnegative(),
    digest: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
  }),
  indexChars: z.number().int().nonnegative(),
  share: z.number().nonnegative().max(1).optional(),
}) satisfies z.ZodType<RecallUsage>;

/**
 * `recall()` に渡す予算（docs/recall.md §6）。
 *
 * **⚠ 予算が縛るのは `memories` tier（返す Memory の digest）だけである。
 * 目次帯（`IndexBand`）は予算の対象外であり、`budget` をどれだけ小さくしても削られない。**
 *
 * 理由は [ADR 0008](../../../docs/decisions/0008-absence-taxonomy.md) の芯にある——
 * 目次帯の唯一の存在理由は **「recall が0件でも、何が在るかは言える」** ことである。
 * これを予算の対象にすると、**呼び出し側が渡した数字ひとつでその保証が消える。**
 * 予算次第で消える保証は、保証ではない。
 *
 * **だから名前に `Memory` を入れている。**「recall 全体の上限」ではないことが、
 * 型を見ただけで分かるようにするためである。目次帯が実際に何文字かは
 * `RecallUsage.indexChars` で別に返る——呼び出し側は足せば全体量が分かる。
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

export const RecallBudgetSchema = z.object({
  maxMemoryChars: z.number().int().positive().optional(),
  maxMemoryTokens: z.number().int().positive().optional(),
  promptBudgetTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<RecallBudget>;

// ---------------------------------------------------------------------------
// スコア内訳（docs/recall.md §7）
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  /** ANN 経由でのみ存在。距離から変換した類似度。 */
  similarity?: number;
  decay: number;
  tagMatch: number;
  freshness: number;
  strength: number;
  total: number;
}

export const ScoreBreakdownSchema = z.object({
  similarity: z.number().optional(),
  decay: z.number(),
  tagMatch: z.number(),
  freshness: z.number(),
  strength: z.number(),
  total: z.number(),
}) satisfies z.ZodType<ScoreBreakdown>;

export interface RecalledMemory {
  memoryId: MemoryId;
  digest: string;
  retrievedVia: "ann" | "tag_match" | "recency" | "mandatory_companion";
  /** 矛盾の相手として同伴取得された場合、その相手の memoryId。 */
  companionOf?: MemoryId;
  score: ScoreBreakdown;
}

export const RecalledMemorySchema = z.object({
  memoryId: z.string().min(1),
  digest: z.string(),
  retrievedVia: z.enum(["ann", "tag_match", "recency", "mandatory_companion"]),
  companionOf: z.string().min(1).optional(),
  score: ScoreBreakdownSchema,
}) satisfies z.ZodType<RecalledMemory>;

// ---------------------------------------------------------------------------
// パイプラインのトレース（docs/recall.md §2）
// ---------------------------------------------------------------------------

export type RecallStageName =
  | "scope"
  | "candidate_generation"
  | "rescore"
  | "contradiction_resolution"
  | "budget_truncation"
  | "index_band"
  | "record";

export interface StageTrace {
  stage: RecallStageName;
  executed: boolean;
  detail?: Record<string, unknown>;
}

export const StageTraceSchema = z.object({
  stage: z.enum([
    "scope",
    "candidate_generation",
    "rescore",
    "contradiction_resolution",
    "budget_truncation",
    "index_band",
    "record",
  ]),
  executed: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<StageTrace>;

// ---------------------------------------------------------------------------
// RecallQuery / RecallResult（docs/recall.md §1）
// ---------------------------------------------------------------------------

/**
 * `recall()` への入力。
 *
 * docs/recall.md はパイプラインの段（§2）と各種オプションの効果を規定するが、
 * `RecallQuery` 自体の網羅的な型は明記していない。ここでの型は、各段の記述
 * （スコープ確定・候補生成・予算・countKind の近似許可）から素直に導いたもので、
 * フィールド名は本 PR の裁量である。
 *
 * D5: 既定で `provenance.kind = 'inferred'` を含める。除外する場合は
 * `excludeProvenanceKinds` に `['inferred']` を渡す。
 */
export interface RecallQuery {
  text?: string;
  vector?: number[];
  tags?: string[];
  occurredAfter?: Date;
  occurredBefore?: Date;
  limit?: number;
  overFetchFactor?: number;
  /** D5: recall は既定で inferred を含める。除外したい provenance.kind を明示する。 */
  excludeProvenanceKinds?: ProvenanceKind[];
  budget?: RecallBudget;
  /**
   * 段2（再スコア）で候補を残すか捨てるかの閾値（docs/recall.md §2 段2）。
   *
   * docs/recall.md はこの閾値の具体的な値・単位を規定していない
   * （`ScoreBreakdown.total` がどの範囲に収まるかはスコアリング戦略次第であり、
   * 埋め込みモデルが返す類似度の分布にも依存する）。本 PR の裁量として、
   * 既定値 `DEFAULT_SCORE_THRESHOLD`（0.1）を置く——強い根拠がある値ではなく、
   * 「明らかに無関係な候補（類似度が低い、または大きく減衰した候補）を落とす」
   * という最低限の閾値である。呼び出し側が上書きできる。
   */
  scoreThreshold?: number;
}

/** RecallQuery.scoreThreshold の既定値。強い根拠のない Phase 1 の裁量値（本ファイルの doc 参照）。 */
export const DEFAULT_SCORE_THRESHOLD = 0.1;

/** RecallQuery.limit の既定値。 */
export const DEFAULT_RECALL_LIMIT = 10;

/** RecallQuery.overFetchFactor の既定値（docs/recall.md §3: k' = k × 4）。 */
export const DEFAULT_OVER_FETCH_FACTOR = 4;

export const RecallQuerySchema = z.object({
  text: z.string().min(1).optional(),
  vector: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
  occurredAfter: z.date().optional(),
  occurredBefore: z.date().optional(),
  limit: z.number().int().positive().optional(),
  overFetchFactor: z.number().positive().optional(),
  excludeProvenanceKinds: z
    .array(z.enum(["stated", "inferred", "consolidated", "reflected", "imported"]))
    .optional(),
  budget: RecallBudgetSchema.optional(),
  scoreThreshold: z.number().optional(),
}) satisfies z.ZodType<RecallQuery>;

/**
 * `MemoryStore.aggregateScope` に渡すスコープ。docs/architecture.md §5.1 は型を明記していないため、
 * §2 の段0（スコープ確定）・段5（目次帯は段0のスコープ全体を使う）の記述から
 * 素直に導いた最小限の型を置く。
 *
 * `subjectId` を省略すると「テナント全体」を意味する（`ctx.subjectId` が無い呼び出し）。
 * `taxonomy` フィールドが無いのは意図的——Phase 1 に taxonomy の実体（labels テーブル）が
 * 無い（docs/memory-model.md §8、labels/memory_labels は Phase 2）ため、スコープの
 * taxonomy 次元は Phase 1 では常に無条件（フィルタが存在しない）である
 * （PR 本文の「決めたこと」参照）。
 */
export interface RecallScope {
  subjectId?: string;
  occurredAfter?: Date;
  occurredBefore?: Date;
}

export const RecallScopeSchema = z.object({
  subjectId: z.string().min(1).optional(),
  occurredAfter: z.date().optional(),
  occurredBefore: z.date().optional(),
}) satisfies z.ZodType<RecallScope>;

export interface RecallResult {
  /** 記録された recall の識別子。observe() の usage 報告で使う。 */
  recallId: RecallId;
  memories: RecalledMemory[];
  omitted: Omission[];
  index: IndexBand;
  usage: RecallUsage;
  explain: { stages: StageTrace[] };
}

export const RecallResultSchema = z.object({
  recallId: z.string().min(1),
  memories: z.array(RecalledMemorySchema),
  omitted: z.array(OmissionSchema),
  index: IndexBandSchema,
  usage: RecallUsageSchema,
  explain: z.object({ stages: z.array(StageTraceSchema) }),
}) satisfies z.ZodType<RecallResult>;

// ---------------------------------------------------------------------------
// 段6（記録）の書き込み口（docs/recall.md §2 段6、ADR 0008）
// ---------------------------------------------------------------------------

/**
 * `MemoryStore.createRecall` への入力。`recalls` テーブル1行分のスナップショット
 * （docs/memory-model.md §10）。段6が必須である理由（`recallId` が無いと
 * `observe({kind:'memory_usage'})` が紐付け先を持たない）は docs/recall.md §2・§4 を参照。
 */
export interface NewRecallRecord {
  tenantId: string;
  subjectId?: string | null;
  /** 発行された recall クエリ/オプションのスナップショット（JSON にシリアライズ可能な形）。 */
  query: unknown;
  budget?: RecallBudget | null;
  omitted: Omission[];
  usage: RecallUsage;
  indexBand: IndexBand;
  explain: { stages: StageTrace[] };
  returnedMemoryIds: MemoryId[];
}

/** `not_indexed` の理由の全列挙（`recall()` が理由ごとに Omission を1件ずつ返すのに使う）。 */
export const NOT_INDEXED_REASONS: readonly NotIndexedReason[] = ["pending", "failed", "skipped"];
