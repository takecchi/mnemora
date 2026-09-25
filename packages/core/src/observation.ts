import { z } from "zod";
import { AttributesSchema, StoredAttributesSchema } from "./attributes.js";
import type { Attributes } from "./attributes.js";
import type { ObservationId } from "./ids.js";

/**
 * mnemora の外で起きたことの生の記録（docs/memory-model.md §1・§10）。
 *
 * `kind` はあえて閉じたユニオンにしない（DB 側も CHECK 制約を付けない）。
 * 新しい観測の種類を追加するたびにマイグレーションを要求しない設計のため。
 * 開いているものは開いていると分かる形にする、という規約（memory-model.md §10）を
 * 型としてもそのまま反映し、`kind: string` とする。
 */
export interface Observation {
  id: ObservationId;
  tenantId: string;
  subjectId?: string | null;
  externalId?: string | null;
  kind: string;
  payload: unknown;
  occurredAt?: Date | null;
  recordedAt: Date;
  /**
   * Issue #280（Issue #202 第2弾）: `ObserveXxxInput.validFrom`/`validUntil`（下記）を
   * `occurredAt` と**同じ経路**で運ぶための、`Observation` 側の置き場。
   *
   * `occurredAt` の流れ（`ObserveXxxInput.occurredAt` → `Runtime.observe` →
   * `Observation.occurredAt` → `buildNewMemoryFromCandidate` → `NewMemory.occurredAt`、
   * `runtime.ts`/`extraction.ts`）をそのまま踏襲する——**理由は「deferred 抽出でも
   * 値が残る」ことを構造的に保証するため**。`extract: 'deferred'` を選んだ場合、抽出は
   * `outbox` 経由で後から `processExtractJob`（`runtime.ts`）が拾い、そこでは
   * `deps.memoryStore.getObservation` で**DB から読み直した** `Observation` しか
   * 手元に無い（元の `ObserveXxxInput` はとうに捨てられている）。⟹ `validFrom`/
   * `validUntil` を `Observation` に持たせず sync 経路だけの一時変数として流すと、
   * deferred 経路では値が消える——`occurredAt` が同じ理由で `Observation` の
   * 永続フィールドになっているのと対称の判断。
   */
  validFrom?: Date | null;
  /** `validFrom` の doc コメント参照。対になる終点。 */
  validUntil?: Date | null;
  /**
   * Issue #152（ADR 0312）: 呼び手が申告した任意属性を `occurredAt`/`validFrom` と同じ経路
   * （`ObserveXxxInput.attributes` → `Observation.attributes` → `buildNewMemoryFromCandidate`）
   * で運ぶための永続列。**理由は `validFrom` の doc コメントと同じ**——`extract: 'deferred'`
   * を選んだ場合、抽出は `outbox` 経由で後から `processExtractJob` が拾い、そこでは
   * `getObservation` で DB から読み直した `Observation` しか手元に無い（元の
   * `ObserveXxxInput` はとうに捨てられている）。
   *
   * **型としては省略可能だが、runtime（`handleExtractableObservation`）は常に `{}` 以上の
   * 値を書く**——`undefined` は「この observe() 呼び出しより前に作られた行」または
   * 「この型を自前で組み立てた既存の呼び出し元」だけが持ちうる状態であり、本 PR 以降の
   * 書き込みでは常に値が入る（ADR 0289 が `speaker`/`subjectId` に採った runtime 保証と
   * 同じ規律）。
   */
  attributes?: Attributes;
}

export type NewObservation = Omit<Observation, "id" | "recordedAt"> & {
  recordedAt?: Date;
};

export const ObservationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  externalId: z.string().min(1).nullable().optional(),
  kind: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  // Issue #280: `Observation.validFrom`/`validUntil` の doc コメント参照。
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),
  // Issue #152（ADR 0312）: `Observation.attributes` の doc コメント参照。格納側は
  // 検査をしない schema を使う（`AttributesSchema` は入力側専用。下記
  // `ObserveXxxInputSchema` 参照）。
  attributes: StoredAttributesSchema.optional(),
}) satisfies z.ZodType<Observation>;

export const NewObservationSchema = ObservationSchema.omit({
  id: true,
  recordedAt: true,
}).extend({
  recordedAt: z.date().optional(),
}) satisfies z.ZodType<NewObservation>;

/**
 * 抽出の既定モード（D2）。`sync` が既定（roadmap §5.2 の推奨、オーナー判断 D2）。
 * `deferred` を選んだ場合、抽出は `outbox` 経由の Scheduler を通る
 * （docs/architecture.md §3.3・§3.4）。
 */
export type ExtractMode = "sync" | "deferred";

export const ExtractModeSchema = z.enum(["sync", "deferred"]) satisfies z.ZodType<ExtractMode>;

/**
 * `runtime.observe` が投げるエラーの接頭辞（Issue #608 項目②(b)）。
 *
 * `extract: 'deferred'` と `subjectCandidates`（{@link SubjectCandidatesInput}、下記）は
 * 同時に渡せない——deferred 抽出は `outbox` 経由で `Observation` を経由してから後で
 * 実行されるが、`subjectCandidates` はどこにも永続化されない（`SubjectCandidatesInput`
 * の doc コメント参照）ため、deferred 側は渡された候補一覧を**構造的に見られない**。
 * 「渡されたのに黙って落とす」と、呼び出し側は候補一覧が効いたと思い込むので、
 * 検証の段（`runtime.observe`、DB へ何も書く前）で明示的に例外にする——
 * `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`（recall.ts）と同じ「黙って無視しない」規律。
 */
export const SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX =
  "runtime.observe: subjectCandidates is not supported with extract: 'deferred' (subjectCandidates is never persisted, so deferred extraction cannot see it): ";

/** `observe()` の入力ユニオンの判別子（DB 上は `kind = 'usage'` に対応する点に注意）。 */
export type ObserveInputKind = "utterance" | "event" | "memory_usage" | "document";

/**
 * Issue #280（Issue #202 第2弾、マネージャー決定4）: `validFrom`/`validUntil` を
 * 呼び出し側から渡す口。`occurredAt` と同じ扱い——**抽出（LLM）に推測させない**
 * （Issue #202/#280 が明示的に射程外にしている。北極星の問い5「LLM を呼ばずに
 * 済ませられないか」にも整合する）。ADR 0037 の規律（「まず呼び出し側が渡す形を
 * 検討する」）に従い、まず口を作る。
 *
 * ⚠ **粒度の限界**: この2欄は observation 単位のスカラーである。1回の `observe()`
 * から複数の Memory 候補が抽出されると、**全候補が同じ `validFrom`/`validUntil` を
 * 共有する**——`occurredAt` が既に抱えている限界と同型（ADR 0037 が受け入れ済み）。
 */
/**
 * Issue #608 項目②(b): 呼び出し側が既存の subject 台帳から候補一覧を渡し、抽出器（LLM）に
 * その中から選ばせる口。**mnemora は subject の台帳を持たない**（`ctx.ts` 冒頭のコメント、
 * `docs/architecture.md` §3.7）ので、台帳そのものは呼び出し側が持ち、ここには「今回の
 * observe() に関係しそうな候補」だけを渡す。
 *
 * - **渡す（`subjectCandidates: [...]`、要素は1件以上）**: `buildExtractionPrompt`
 *   （extraction.ts）が候補一覧と「候補の中から選べ。無ければ `subjectId: null` を
 *   明示せよ」という指示をプロンプトへ足す。抽出後、runtime は各候補の `subjectId` が
 *   この一覧に含まれるかを検証する（`null` は一覧に無くても常に有効——「主題なし」は
 *   「一覧のどれか」とは別の値であるため）。一覧に無い文字列が返ってきたら、runtime は
 *   その値を弾き、`undefined`（未指定）へ戻す——① (ADR 0271) の「省略」経路と同じ
 *   着地点で、observation の `subjectId` へフォールバックする。
 * - **渡さない（省略・`undefined`）**: 従来どおり。`buildExtractionPrompt` の文面は
 *   1バイトも変わらない（カセットの鍵が動かない、Issue #370/#371 への配慮）。
 * - **空配列（`[]`）**: **「渡していない」と同じ**に扱う——検証しようのない空の一覧を
 *   渡された runtime が「一覧外は全部弾く」という極端な挙動（＝LLM が返す `subjectId` を
 *   常に無効化する）に倒れるのを避けるため。プロンプトも変えず、検証もしない
 *   （`extraction.ts` の `sanitizeCandidateSubjectId` 参照）。
 *
 * ⚠ **`reextract` はこの欄を使わない。**`Observation`（上記）にも `observations` テーブルにも
 * 持たせていない——`extractObservationPayload`（runtime.ts）は種類ごとに固定欄だけを
 * ペイロードへ書き出しており、`subjectCandidates` はそこに無い。`reextract` は
 * `MemoryStore.getObservation` で**DB から読み直した** `Observation` しか持たないため、
 * 元の `ObserveXxxInput.subjectCandidates` はとうに失われている。⟹ 新しい DB 列や
 * マイグレーションを増やさずに済ませるための、意図的な非対称である。
 *
 * ⛔ **`extract: 'deferred'` と同時に渡すとエラーになる**（`runtime.observe` が検証段で
 * 投げる。`SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX` 参照）。deferred 抽出は
 * `Observation` を経由するため、この欄を「渡されたのに黙って落とす」ことは行わない。
 */
export type SubjectCandidatesInput = string[];

/** Bounded, caller-selected context for extraction. Persisted with the observation.
 * An empty object opts into metadata-aware extraction without preceding messages.
 * Context is evidence for resolving references, not additional observations to extract.
 */
export const ExtractionContextSchema = z.object({
  messages: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        speaker: z.string().min(1).max(200).optional(),
      }),
    )
    .max(8)
    .optional(),
  timeZone: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA time zone")
    .optional(),
});
export type ExtractionContext = z.infer<typeof ExtractionContextSchema>;

export interface ObserveUtteranceInput {
  extractionContext?: ExtractionContext;
  kind: "utterance";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  /** {@link SubjectCandidatesInput} の doc コメント参照（Issue #608 項目②(b)）。 */
  subjectCandidates?: SubjectCandidatesInput;
  /** {@link Observation.attributes} の doc コメント参照（Issue #152、ADR 0312）。 */
  attributes?: Attributes;
  speaker?: string;
  text: string;
}

export interface ObserveEventInput {
  extractionContext?: ExtractionContext;
  kind: "event";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  /** {@link SubjectCandidatesInput} の doc コメント参照（Issue #608 項目②(b)）。 */
  subjectCandidates?: SubjectCandidatesInput;
  /** {@link Observation.attributes} の doc コメント参照（Issue #152、ADR 0312）。 */
  attributes?: Attributes;
  name: string;
  data?: Record<string, unknown>;
}

export interface ObserveDocumentInput {
  extractionContext?: ExtractionContext;
  kind: "document";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  /** {@link SubjectCandidatesInput} の doc コメント参照（Issue #608 項目②(b)）。 */
  subjectCandidates?: SubjectCandidatesInput;
  /** {@link Observation.attributes} の doc コメント参照（Issue #152、ADR 0312）。 */
  attributes?: Attributes;
  title?: string;
  content: string;
}

/**
 * 使用報告（ADR 0009）。抽出器を通らないため `extract` を持たない。
 * `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })`
 * という ADR 0009 の呼び出し形そのままの形にする。
 */
export interface ObserveMemoryUsageInput {
  kind: "memory_usage";
  recallId: string;
  usedMemoryIds: string[];
}

export type ObserveInput =
  ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput | ObserveMemoryUsageInput;

/**
 * {@link SubjectCandidatesInput} の zod 表現。要素は `z.string().min(1)`——空文字は
 * 候補として無意味（`subjectId`/`Memory.subjectId` 等、他の subject 系文字列欄と
 * 同じ `min(1)` の規約）。配列自体は空でもよい（doc コメントの「空配列」節参照——
 * 空配列は「渡していない」と同じに扱われる。zod の時点では弾かない）。
 */
const SubjectCandidatesInputSchema = z.array(z.string().min(1)).optional();

const ObserveUtteranceInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("utterance"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  speaker: z.string().min(1).optional(),
  text: z.string().min(1),
}) satisfies z.ZodType<ObserveUtteranceInput>;

const ObserveEventInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("event"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  name: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ObserveEventInput>;

const ObserveDocumentInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("document"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  title: z.string().min(1).optional(),
  content: z.string().min(1),
}) satisfies z.ZodType<ObserveDocumentInput>;

const ObserveMemoryUsageInputSchema = z.object({
  kind: z.literal("memory_usage"),
  recallId: z.string().min(1),
  usedMemoryIds: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<ObserveMemoryUsageInput>;

/**
 * **2026-09-17 追記（Issue #272、[ADR 0181](../../../docs/decisions/0181-schema-type-equals-parity.md)）**:
 * `satisfies z.ZodType<ObserveInput>` を足した。4本の枝それぞれには
 * `satisfies z.ZodType<ObserveXxxInput>` が付いているのに、まとめのこの1行にだけ
 * 付いていなかった（`OmissionSchema`（recall.ts）・`ProvenanceSchema`
 * （provenance.ts）と同じ形の欠落）。**足しても `tsc` は緑のまま。**
 */
export const ObserveInputSchema = z.discriminatedUnion("kind", [
  ObserveUtteranceInputSchema,
  ObserveEventInputSchema,
  ObserveDocumentInputSchema,
  ObserveMemoryUsageInputSchema,
]) satisfies z.ZodType<ObserveInput>;

/**
 * `observe()` の入力ユニオンの判別子を、`observations.kind` 列の値へ変換する。
 *
 * `memory_usage` だけは DB 列としては `'usage'` に対応する
 * （docs/memory-model.md §10: 「`kind = 'usage'` の Observation」）。
 * それ以外は判別子をそのまま列の値として使う。
 */
export function observeInputKindToObservationKind(kind: ObserveInputKind): string {
  switch (kind) {
    case "memory_usage":
      return "usage";
    case "utterance":
      return "utterance";
    case "event":
      return "event";
    case "document":
      return "document";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}
