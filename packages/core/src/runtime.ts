import { z } from "zod";
import { abortReason, isAbort, runAbortable } from "./abort.js";
import type { AbortOptions } from "./abort.js";
import { assertNoProtoAttributesKey } from "./attributes-guard.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./interfaces/clock.js";
import { DEFAULT_CORRECTION_CANDIDATE_LIMIT } from "./correction-candidates.js";
import type {
  CorrectionCandidate,
  FindCorrectionCandidatesInput,
  FindCorrectionCandidatesResult,
} from "./correction-candidates.js";
import type { ApplyCorrectionInput, ApplyCorrectionResult } from "./apply-correction.js";
import type { Ctx } from "./ctx.js";
import type { EventActor, NewMemoryEvent } from "./event.js";
import { DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT, deriveClaimKeys } from "./claim-key.js";
import { sanitizeCandidateAuxFields, type DroppedAuxField } from "./llm-aux-fields.js";
import { normalizeContentForComparison } from "./content-comparison.js";
import type { ClaimKey, ClaimKeyOptions } from "./claim-key.js";
import {
  buildNewMemoryFromCandidate,
  describeExtractionFailure,
  extractCandidates,
} from "./extraction.js";
import type {
  ExtractedMemoryCandidate,
  ExtractionFailure,
  ExtractionOutcome,
} from "./extraction.js";
import { assertLLMContentNotBlank } from "./llm-content.js";
import { resolveCandidateSubjectId, resolveCommonSubjectId } from "./memory-subject.js";
import { classifyValidity } from "./validity.js";
import { heuristicTokenCounter } from "./heuristic-token-counter.js";
import { describeFailure, omitParamsFromError } from "./failure-description.js";
import { assertWellFormedCtx, assertWellFormedIdentifier } from "./identifier.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { EventStore } from "./interfaces/event-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import {
  isContestedGroupMembershipMismatchError,
  isMemoryPurgeConflictError,
  isMemoryStatusConflictError,
  isSourceMemoryForgottenError,
  isSourceMemoryStatusChangedError,
  PURGE_TOMBSTONE_CONTENT,
  PURGE_TOMBSTONE_DIGEST,
} from "./interfaces/memory-store.js";
import type {
  ArchiveDecayedOptions,
  MemoryStore,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "./interfaces/memory-store.js";
import { isOutboxLeaseConflictError } from "./interfaces/outbox-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "./interfaces/outbox-store.js";
import type { OutboxJobKind } from "./interfaces/scheduler.js";
import {
  readActivitySeq,
  readDecayClock,
  readDefaultHalfLifeRecalls,
  readHasSubjectActivityCounters,
  readSubjectActivitySeq,
  readSubjectActivitySeqs,
} from "./interfaces/tenant-settings-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import type { LexicalStore } from "./interfaces/lexical-store.js";
import type { RelationStore } from "./interfaces/relation-store.js";
import type { MemoryId, ObservationId, RecallId } from "./ids.js";
import type { Memory, MemoryStatus, NewMemory } from "./memory.js";
import type {
  ObserveDocumentInput,
  ObserveEventInput,
  ObserveInput,
  ObserveUtteranceInput,
  ObserveInputKind,
} from "./observation.js";
import {
  CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX,
  ObserveInputSchema,
  observeInputKindToObservationKind,
  SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX,
} from "./observation.js";
import type { NewObservation, Observation } from "./observation.js";
import type { OutboxJobRecord } from "./outbox.js";
import { runRecall } from "./recall-runtime.js";
import type { RecallQuery, RecallRecord, RecallResult } from "./recall.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";
import {
  detectLanguageMismatchFromProfile,
  profileObservationLanguage,
  type ObservationLanguageProfile,
} from "./language-mismatch.js";
import { observationPayloadText } from "./observation-text.js";
import { classifyReextractTargets, classifySupersedeFailure } from "./strategies/reextract.js";
import type { ReextractSkip } from "./strategies/reextract.js";
import {
  buildConsolidatedMemory,
  buildConsolidationPrompt,
  computeAffinity,
  ConsolidationLLMResultSchema,
} from "./strategies/consolidate.js";
import type { ConsolidationLLMResult } from "./strategies/consolidate.js";
import {
  buildReflectedMemory,
  buildReflectionPrompt,
  ReflectionLLMResultSchema,
} from "./strategies/reflect.js";
import type { ReflectionLLMResult } from "./strategies/reflect.js";
import { listRelatedLevel } from "./relation-level.js";

export interface RuntimeConfig {
  /**
   * 抽出器のバージョン。冪等キー `(observationId, extractorVersion)` の一部になる。
   * 省略時（`undefined`・`null`）は `"v1"`。空文字・空白だけの値は既定に倒れず、`createRuntime` が
   * 組み立ての時点で `Error` を投げて拒む（書くと、読み戻したときに `MemorySchema` を通らないため。ADR 0630）。
   * 前後に空白のある値（`" v1 "`）は拒まず、そのまま書く。
   */
  extractorVersion?: string | undefined;
  /**
   * `provenance.inferred.model` に書き込むモデル識別子。呼び出し側の LLMProvider の実体に合わせる。
   * 省略時（`undefined`・空文字）は `"unknown"`。空白だけの値はそのまま書く。
   */
  llmModelId?: string | undefined;
  /**
   * `provenance.inferred.promptVersion`。抽出プロンプトを変えたら上げる。省略時（`undefined`・空文字）は `"v1"`。
   * 空白だけの値はそのまま書く。
   */
  promptVersion?: string | undefined;
  /**
   * digest フォールバック（機械的な先頭文字列切り出し）の最大文字数。既定 200。
   * ⚠ 値は検査しない（今の振る舞い）。0・負の数・`NaN` を渡すと、本文が収まらない限り
   * digest は `"…"` だけになる（本文は `content` にそのまま残る）。
   * 切るのは書記素の境界で、長さが結合文字・ZWJ 絵文字・国旗の途中に落ちたら、その書記素の手前で止める（ADR 0467。
   * これから書く digest だけが変わる。保存済みの digest は書き換えない）。
   */
  digestFallbackLength?: number | undefined;
  /**
   * `tick` の既定 claimedBy 値。複数ワーカーを区別したい場合に指定する。省略時は `"runtime.tick"`。
   * ⚠ 空文字は既定に倒れず、そのまま `OutboxStore.claimBatch` に渡る（`ClaimOutboxJobsOptions.claimedBy` の doc）。
   */
  defaultClaimedBy?: string | undefined;
  /**
   * `extract`（`observe()` の sync 経路・`tick()` の `extract` ジョブ経路の両方）が Memory を1件作るたびに、その `memoryId` を種にした `consolidate` / `reflect` の outbox ジョブも積むかどうか
   * （[ADR 0157](../../../docs/decisions/0157-tick-drives-consolidate-and-reflect.md)）。既定は `false`（積まない）。`false` でも `consolidate()`/`reflect()` は、呼び出し側が明示的に呼べば動く。
   * `true` にすると、積む job kinds が `["embed"]` から `["embed", "consolidate", "reflect"]` になり、payload は `embed` と同じ `{ memoryId }`。`tick()` はそれを `{ target: { seedMemoryId: memoryId } }` として処理する。
   *
   * `tick()` が呼ぶ `consolidate`・`reflect` は、種の Memory の `subjectId` が `null` でなければ `ctx.subjectId` をそれで置き換える（ADR 0317）。`tick()` はジョブを subject で絞って claim できず、
   * 食い違うと近傍探索が別の subject から候補を集め、統合後・反映後の `Memory.subjectId` が `null` に畳まれるため。種の `subjectId` が `null`、または種が見つからないときは、渡された `ctx` のまま呼ぶ。
   * 明示的に `consolidate`/`reflect` を呼ぶ側の挙動は変わらない（呼び手が自分の `ctx.subjectId` で制御する）。
   */
  autoQueueConsolidateReflectOnExtract?: boolean | undefined;
  /**
   * `subjectCandidates` を渡さない（省略・空配列）抽出——一覧を渡さなかった `observe()`、`extract: 'deferred'` の `tick`、
   * `reextract`——で、LLM が返した候補の `subjectId` を受けるかどうか。
   *
   * 既定は `false`（捨てる）。捨てると Memory の主題は `observation.subjectId`（無ければ主題なし）になる。
   * 観察文に仕込んだ「この記憶の主題は bob」で、別の subject に記憶を書かせられるのを塞ぐ（ADR 0442）。
   * `true` にすると、LLM が返した `subjectId` をそのまま受ける。**信用できない本文を抽出するなら `true` にしないこと。**
   *
   * `subjectCandidates` を渡した `observe()` には効かない（一覧に照らして検証する。一覧内は採り、一覧外は弾く）。
   * ⚠ 捨てた値は `ObserveResult` に出ない（`rejectedSubjectIds` は一覧を渡した呼び出しの欄のまま）。
   */
  acceptLlmSubjectIdWithoutCandidates?: boolean | undefined;
}

const DEFAULT_EXTRACTOR_VERSION = "v1";
const DEFAULT_LLM_MODEL_ID = "unknown";
const DEFAULT_PROMPT_VERSION = "v1";
const DEFAULT_DIGEST_FALLBACK_LENGTH = 200;
const DEFAULT_CLAIMED_BY = "runtime.tick";
const DEFAULT_TICK_LIMIT = 50;
/** `tick` が `now - leaseMs` に許す下限（Postgres の `timestamptz` の下限、4714-11-24 BC）。これより前は、どの store も保存できない（ADR 0514）。 */
const MIN_STORABLE_TIMESTAMP_MS = -210_866_803_200_000;
/**
 * 群の `updated/contested` イベントの `note` に入れる、`memberIds`・`matches` の先頭の件数（ADR 0431）。
 * 超えたときは `memberIdsTruncated`・`matchesTruncated` が `true` になり、全体の件数は `memberCount`・`matchCount` が持つ。
 */
const CONTESTED_GROUP_NOTE_SAMPLE_LIMIT = 10;

/** UTF-16 コード単位の昇順（ロケールに依らず決定的）。 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `consolidate` / `reflect` の `{ seedMemoryId }` 形で、種の `digest` を検索語にして近傍を集めてよいか。
 * forget と purge は利用者が「使わないでほしい」と言った記憶で、その `digest` で近傍を束ねると、消した情報が別の形で効き続ける。
 * `contested` / `superseded` の種は利用者が消したものではないので、近傍を集める。
 */
function isWithdrawnSeed(seed: Memory): boolean {
  return seed.status === "forgotten" || (seed.purgedAt ?? null) !== null;
}

/**
 * `tick` が処理する分岐を持つ outbox job kind（ADR 0082）。「tick が何を処理するか」の唯一の出所で、
 * `claimBatch` の `kinds` の既定値も `jobHandlers` もここを指す。`jobHandlers` は
 * `Record<TickSupportedJobKind, JobHandler>` なので、kind を足してハンドラを足し忘れると（逆も）型検査が落ちる。
 * 散文で kind を数え直さないこと（次に kind が増えたとき黙って嘘になる。コメントは検査されない）。
 *
 * `OutboxJobKind` は開いたユニオンで、ここに無い kind を積むのは正しい使い方（利用者が別経路で処理する）。
 * ここに無い kind を `tick` に渡したときの倒れ方は {@link TickResult.unsupported}。
 */
export const TICK_SUPPORTED_JOB_KINDS = ["extract", "embed", "consolidate", "reflect"] as const;

/** {@link TICK_SUPPORTED_JOB_KINDS} の要素型。 */
export type TickSupportedJobKind = (typeof TICK_SUPPORTED_JOB_KINDS)[number];

/**
 * `tick` が `fail()` へ書き込む `last_error` の接頭辞。対応していない kind だったことは
 * {@link TickResult.unsupported} が第一の伝達路で、こちらは後から outbox 行だけを見た人のための二の路。
 */
export const UNSUPPORTED_KIND_ERROR_PREFIX = "runtime.tick: unsupported outbox job kind: ";

type JobHandler = (ctx: Ctx, job: OutboxJobRecord, signal?: AbortSignal) => Promise<void>;

/** {@link createRuntime} に渡す依存。store・provider は利用者が用意する（`@mnemora/postgres`・`@mnemora/openai` など）。 */
export interface RuntimeDeps {
  /** 記憶・観測・recall の記録を読み書きする store。 */
  memoryStore: MemoryStore;
  /** `tick` が outbox のジョブを claim・完了・失敗にする store。 */
  outboxStore: OutboxStore;
  /** 埋め込みのベクトルを保存し、ANN で引く store。 */
  vectorStore: VectorStore;
  /**
   * 語彙候補生成チャンネル（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)）。**省略可能。**
   * 省略したまま `RecallQuery.channels` に `"lexical"` を渡すと `recall()` は投げる
   * （`recall.ts` の `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`）。黙って0件を返さない理由は `RecallQuery.channels` の doc。
   */
  lexicalStore?: LexicalStore | undefined;
  /**
   * `memory_relations` を読む store（ADR 0292）。**省略可能。** 省略すると、`detectClaimKeyContested` の
   * `contested_group` 分岐が組み立てる `members` は「新しく重なった相手」だけになり、2者間の対の相方吸収・既存群の合併は行われない。
   * `resolveContestedGroup` の読み側の事前確認（`Runtime.resolveContestedGroup` の doc）も行わず、store 側の CAS だけに任せる。
   */
  relationStore?: RelationStore | undefined;
  /** 監査ログ（`memory_events`）を読み書きする store。 */
  eventStore: EventStore;
  /** テナントの設定（既定の半減期・減衰の時計・保持期間など）を読む store。 */
  tenantSettingsStore: TenantSettingsStore;
  /** 抽出・統合・内省・claim key に使う LLM。 */
  llmProvider: LLMProvider;
  /** 記憶とクエリの埋め込みに使う provider。ベクトルはこの `space` の空間として `vectorStore` に書かれる（`@mnemora/postgres` では、先に `registerEmbeddingSpace` で登録しておく）。 */
  embeddingProvider: EmbeddingProvider;
  /**
   * 省略時は `systemClock`。注入した時計は、runtime が積む outbox 行の `availableAt`・`createdAt` と、監査ログの `at` にも届く
   * （ADR 0355・ADR 0559）。壁時計より過去の時計でも、`tick` は積んだジョブを取れる。`restoreArchived` の `restored` の `at` も
   * 注入した時計で、`sweepArchive` の `archived` だけは呼び出し側が渡す `opts.now` を使う。
   * 今も壁時計のままの列は {@link Clock} の doc を見る。
   */
  clock?: Clock | undefined;
  /** SHA-256 hex 等、content からハッシュを計算する関数（core は計算しない）。 */
  hashContent: (content: string) => string;
  /** runtime の設定（{@link RuntimeConfig}）。省略すると既定値で動く。 */
  config?: RuntimeConfig | undefined;
  /**
   * `usage`（docs/recall.md §6）の計測に使う。省略時は `heuristicTokenCounter`（文字数ベースの推定、`counter: 'heuristic'`）。
   * 差し替えた実装の `count()` が返す `tokens` が有限で 0 以上の number でなければ、`recall()` は `RangeError` で断る（ADR 0497。契約は {@link TokenCounter}）。
   */
  tokenCounter?: TokenCounter | undefined;
  /**
   * `recall()` の戻り値を zod で検証するときの倒れ方（ADR 0098）。省略時は `"report"`
   * （`DEFAULT_RECALL_OUTPUT_VALIDATION`）で、投げない。`RecallRuntimeDeps.outputValidation` へそのまま渡る。
   */
  outputValidation?: RecallOutputValidationMode | undefined;
  /**
   * `processEmbedJob` が `embed(ctx, [...])` へ送る文字列を `Memory` から差し替える任意のフック（ADR 0305）。
   * 上限超過で `failed` になった Memory を回復する口である: `reembed()` は failed を pending に戻して embed ジョブを積み直すだけで、
   * 次の `processEmbedJob` はまた同じ `memory.content` を送って同じ理由で failed に戻る。
   *
   * 省略時は `memory.content` をそのまま送る。指定しても `Memory.content` 自体は変わらない（DB に書き戻る content は常に元のまま）。
   * 例: 先頭を切って短くする関数を渡し、`runtime.reembed(ctx, { statuses: ['failed'], limit })` →
   * `runtime.tick(ctx, { kinds: ['embed'], leaseMs })` の順に呼ぶと、対象は `'ready'` に戻る。
   *
   * core はモデルごとの入力上限・トークン数を持たない（ADR 0305、ADR 0090）。何をどれだけ切ったかの印も残さない
   * （残すには `Memory` に列を足す migration が要る）。印が要る呼び出し側は、別テーブル・ログ等に自前で残すこと。
   *
   * フックが例外を投げたら、`processEmbedJob` は `embeddingStatus` を `'failed'` にしてから再送出する。
   *
   * ⚠ **戻り値は検査も変換もしない。** 空文字・NUL・孤立サロゲート・巨大な文字列、型の外の値（`undefined`・数・オブジェクト・`null`）も
   * そのまま `embed()` に渡り、受け入れるかどうかは provider が決める（落ちれば `embeddingStatus: 'failed'`・job も failed。受け入れれば `'ready'`）。
   * `OpenAIEmbeddingProvider` は空文字を含む呼び出しを API の 400 で落とす（packages/openai/README.md）。
   * `reembed()` で `failed` を戻した後の `tick` では、このフックがもう一度呼ばれる。
   */
  embeddingInput?: ((memory: Memory) => string) | undefined;
}

/** `Runtime.observe` の戻り値。 */
export interface ObserveResult {
  /** 記録した Observation の id（`externalId` で冪等に再送したときは既存の Observation の id）。 */
  observationId: ObservationId;
  /**
   * sync 抽出で実際に作られた（または既存の冪等な行として返された）Memory の id。`deferred` の場合、または冪等な再送（`created: false`）の場合は空配列で、以前作られた id は遡って探さない。
   * 要素は候補ごとに1つで、候補の順に並ぶ。**同じ本文（`content`）の候補が複数あると、同じ id が候補の数だけ入る**（冪等キー `(tenant_id, source_observation_id, extractor_version, content_hash)` は本文だけから作るため、
   * 2件目以降は1件目の行に当たり、その `provenanceKind`・`confidence`・`subjectId`・`tags` は書かれない）。重複を除いた集合が要るときは呼び手が `new Set(memoryIds)` にする。
   *
   * ⚠ `MemoryStore.createMemoriesWithOutboxAndEvents?` を持たない adapter では、候補を書いてから `created` を積む（1つのトランザクションではない）。書いた直後、`created` を積む前にその1件が `forget` → `purge` されると、
   * この配列に purge した id が入り、監査ログには `forgotten`・`purged` の**後に** `created` が積まれる（`digestSnapshot` は purge 前の digest）。持つ store（`@mnemora/postgres`・testkit の fixture）は
   * 全候補の記憶と `created` を1つのトランザクションで書くので、この窓は無い（[ADR 0410](../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)）。
   */
  memoryIds: MemoryId[];
  /**
   * この呼び出しの中で抽出がどうなったか。`boolean` にしない: 2値に潰すと、LLM 呼び出しが失敗して全文フォールバックへ倒れた
   * 第三の状態が「抽出した」と同じ顔になる。`llm_failed_whole_observation` なら provider の復旧後に抽出をやり直す一手があり、
   * `ok` にはそれが無い（ADR 0008）。
   */
  extraction: ExtractionOutcome;
  /**
   * `extraction === "llm_failed_whole_observation"` のときに LLM 呼び出しが失敗した理由。それ以外（`"ok"` / `"skipped"`）は必ず `null`。
   *
   * `ExtractionOutcome` は3値のまま変えず（値を足すと、`extraction` を分岐する網羅性チェックの無い箇所が黙って既定側へ落ちるため）、
   * 失敗の中身（provider が名乗った `kind` と人が読むメッセージ）はこの欄で運ぶ。
   * 省略可能にしない。必須にして、`ObserveResult` を組み立てる全経路を TypeScript に列挙させ、埋め忘れた経路が黙って
   * `undefined`（＝間違った*有る*）になるのを防ぐ。
   */
  extractionFailure: ExtractionFailure | null;
  /**
   * `subjectCandidates` を渡したとき、LLM が返した `subjectId` のうち**一覧に無かった**ため弾いた値（弾いた順）。
   * 弾かれた候補自体は observation の `subjectId` へフォールバックして作られる（`sanitizeCandidateSubjectId`、extraction.ts）ので、
   * この欄が無くても Memory は正しく作られる。「黙って戻さない」ための監査用の記録である。
   *
   * ⛔ 省略可能にする（他の欄と違い必須にしない）。必須にすると、`ObserveResult` を自前で組み立てている呼び出し側のリテラルが
   * コンパイルを通らなくなる。新しい任意プロパティの追加に留める（`docs/decisions/0178-public-api-surface-gate.md`）。
   *
   * - `subjectCandidates` を渡さなかった（省略・空配列）呼び出しでは、この欄は無い（`undefined`）。
   *   「判定していない」と「渡したが0件だった」をキーの有無で区別する。
   * - 渡した場合は常に配列（弾いた候補が無ければ `[]`）。
   * - 冪等な再送（同じ `externalId` の Observation が既に在り、抽出をやり直さない呼び出し）でも、渡していればこの欄は付く
   *   （値は `[]`。再送は抽出も検出も走らせない。ADR 0454）。`extraction: 'skipped'` と `memoryIds: []` が再送の印。
   * - 識別子として保存できない `subjectId`（NUL・孤立サロゲートを含むもの）は、一覧を渡していなくても弾き、
   *   observation の `subjectId` へフォールバックする（ADR 0456）。一覧を渡していない呼び出しでは、その記録はこの欄に載らない。
   */
  rejectedSubjectIds?: string[];
  /**
   * `claimKey: { enabled: true }` を渡したとき、`deriveClaimKeys`（claim-key.ts）の呼び出しが失敗した理由。
   * 失敗しても Memory の作成は止まらず、各候補の `claimKey` が `null` のまま作られる（`rejectedSubjectIds` と同じ監査用の記録）。
   *
   * ⛔ 省略可能にする（`rejectedSubjectIds` と同じ理由）。
   * - `claimKey.enabled` を渡さなかった（省略、または `enabled: false`）呼び出しでは、この欄は無い（`undefined`）。
   * - `claimKey.enabled: true` を渡した場合は常に値を持つ（成功なら `null`）。
   * - 冪等な再送でも、渡していればこの欄は付く（値は `null`。ADR 0454）。`extraction: 'skipped'` と `memoryIds: []` が再送の印。
   */
  claimKeyFailure?: ExtractionFailure | null;
  /**
   * `claimKey: { enabled: true, detectContested: true }` を渡したとき、鍵が付いた Memory ごとの検出結果（`detectClaimKeyContested` 参照）。
   * LLM を一度も呼ばず、列と索引だけで判定する。
   *
   * ⛔ 省略可能にする（`rejectedSubjectIds`/`claimKeyFailure` と同じ理由）。
   * - `claimKey.detectContested` を渡さなかった（省略、または `false`）呼び出しでは、この欄は無い（`undefined`）。
   *   「検出していない」と「検出したが対象の候補が無かった」をキーの有無で区別する。
   * - `detectContested: true` を渡した場合は常に配列。`claimKey` が付かなかった候補（鍵の導出が失敗した・実行しなかった）は含まれず、
   *   付いた鍵の数だけ要素がある（0件なら `[]`）。
   * - 冪等な再送でも、渡していればこの欄は付く（値は `[]`。ADR 0454）。`extraction: 'skipped'` と `memoryIds: []` が再送の印。
   */
  contestedDetection?: ContestedDetectionOutcome[];
  /**
   * 冪等な再送（同じ `externalId` の Observation が既に在り、抽出をやり直さない呼び出し）のときだけ付く（ADR 0639）。
   * 新しく作った呼び出しには、この欄は無い（`undefined`）。`memoryIds: []`・`extraction: 'skipped'` は再送でも変わらない。
   *
   * 読み方（`resend.memories` は、その Observation から作られた記憶の、いまの状態）:
   * - `memories` が空 ＝ まだ抽出されていない。`extract: 'deferred'` で tick 待ち、`extract: 'sync'` の observe が abort された後で
   *   リースが切れる前、extract ジョブが failed、または抽出が0件だった、のどれか。
   *   ⚠ **限界: ジョブ（outbox）の状態はこの欄には入れない。** `memories: []` からは「まだ抽出されていない」ことしか分からず、
   *   tick 待ち・リース中・failed・抽出0件は区別できない。`OutboxStore` に observation ごとのジョブを読む口は無い。
   * - 全部が `status: 'forgotten'` ＝ forget のために、この再送は何も作り直さなかった。
   * - `purged: true` ＝ purge 済み（`status` は `'forgotten'` のまま）。
   *
   * ⛔ 省略可能にする（`rejectedSubjectIds` などと同じ理由。追加の任意プロパティに留める）。
   */
  resend?: ObserveResend;
}

/** `ObserveResult.resend`。冪等な再送のときの内訳（ADR 0639）。後から任意の欄を足せる形にしてあり、足すときも既存の欄は変えない。 */
export interface ObserveResend {
  /**
   * 既存の Observation から作られた記憶。`MemoryStore.listBySourceObservationAllVersions` の写しで、
   * 版（`extractorVersion`）も `status` も問わず全部。`memoryId` の昇順（文字列の比較。`localeCompare` ではない）。
   * 件数の上限は無い。
   */
  memories: ObserveResendMemory[];
}

/** `ObserveResend.memories` の1件。 */
export interface ObserveResendMemory {
  memoryId: MemoryId;
  status: MemoryStatus;
  /** purge 済み（`Memory.purgedAt` が `null` でない）なら `true`。`status` から推さない（purge 済みの `status` は `'forgotten'` のまま）。 */
  purged: boolean;
}

/**
 * `detectClaimKeyContested` が Memory 1件について返す結果（ADR 0185、ADR 0378）。`matchCount` は「同じ tenant・同じ subjectId・同じ claim key・有効期間が重なる・`contentHash` が違う」他の Memory の件数
 * （この Memory 自身を除く）で、`MemoryStore.findActiveByClaimKey?`（`active`）と `findContestedByClaimKey?`（`contested`。任意メソッド）の一致を合わせたもの。後者を実装しない adapter では `active` のみ。
 *
 * - `matchCount === 0` ⟹ `no_conflict`。
 * - `matchCount === 1` **かつその1件が `active`** ⟹ `contested`（`Runtime.markContested` を実際に呼んだ結果を `markContested` に運ぶ。`ineligible`/`conflict` もありうる。再試行はしない）。
 * - `matchCount >= 2`、**または `matchCount === 1` だがその1件が既に `contested`** ⟹ 原則 `unresolved_conflict`。`markContested` を呼ばず（`memory_relations` が無いと、1対1の `contestedWithId` では3件以上を表現できない）、
 *   根拠を `memory_events` へ残すだけで、**`superseded` へは一切進めず**、既に `contested` な相手の `status`/`contestedWithId` にも触れない。1件だけで既に `contested` の場合にここへ入れるのは、
 *   `markContested` へ進むと `ineligible` になり、検出中の Memory が `active` のまま痕跡も残らないため。
 *   `deps.relationStore` と `deps.memoryStore.markContestedGroup` の両方が配線されていて、群のメンバー（穴Aの吸収・既存群の合併を含む）が**3件以上**になれば `contested_group`
 *   （`Runtime.markContestedGroup` を実際に呼んだ結果を運ぶ。ADR 0381）。
 */
export interface ContestedDetectionOutcome {
  /** 検出の対象にした、新しく作った Memory の id。 */
  memoryId: MemoryId;
  /** その Memory の claim key。 */
  claimKey: ClaimKey;
  /** 同じ鍵で矛盾しうる他の Memory（`active` + `contested`）の件数（この Memory 自身を除く。上の doc）。 */
  matchCount: number;
  /** 何をしたか（`matchCount` ごとの分岐は上の doc）。 */
  result:
    | { kind: "no_conflict" }
    | { kind: "contested"; withMemoryId: MemoryId; markContested: MarkContestedResult }
    | { kind: "unresolved_conflict"; matchMemoryIds: MemoryId[] }
    | {
        kind: "contested_group";
        memberIds: MemoryId[];
        markContestedGroup: MarkContestedGroupResult;
      };
}

/**
 * この呼び出しで「正典が要求する1トランザクション」が使えたかどうか（[ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md)）。
 *
 * - `'store_supported'` — `MemoryStore.supersedeWithNewMemories`（任意メソッド）が在り、新 Memory の作成と旧行の supersede をその口へ渡した。
 * - `'store_unsupported'` — 口が無い adapter だったので、作成と supersede を別々の書き込みとして行った
 *   （docs/memory-model.md §11 行5 は**満たされていない**）。
 * - `'not_attempted'` — **書き込みを1件も試みていない。** `reextract` の安全弁（LLM がまた失敗した／候補が0件）で早期 return した場合と、
 *   利用者の意思で退けた記憶を持つ Observation で抽出をやり直さなかった場合。⛔ 上の2つのどちらかに寄せない:
 *   「口が無かった」と「そもそも書いていない」を潰すと、呼び手は「§11 行5 が破れた」と「破れる機会が無かった」を区別できない。
 *   名前は `ConsolidationResult` の `not_attempted`（ADR 0087）に揃えた。
 *
 * 🔴 **この値は原子性の証拠ではなく、口の有無の写しである。** adapter が口を実装したと宣言したことしか意味せず、
 * 実装していても実際にはトランザクションを張っていない adapter（`packages/testkit` の `InMemoryMemoryStore`）は見抜けない。
 * 原子性を実際に測るのは、適合テストと `packages/postgres` の並行の歯である。
 *
 * ⛔ 省略可能（`?`）にしない。`undefined` が「口が無かった」と「この欄より前の版の戻り値」の両方を意味してしまう。
 */
export type WriteAtomicity = "store_supported" | "store_unsupported" | "not_attempted";

/**
 * `runtime.reextract` の結果（ADR 0028、ADR 0029）。`ObserveResult.extraction` の `'skipped'` と `skipped` フィールドは別の語彙で、前者は「抽出そのものを行ったか」、後者は「既存 Memory を supersede しなかった理由」。
 * `extraction` は基本 `'ok'` か `'llm_failed_whole_observation'` だが、利用者の意思で退けた記憶を持つ Observation では `'skipped'`（observe の再送が抽出をやり直さないときと同じ意味。条件は `Runtime.reextract` の doc）。
 *
 * ⚠ 「observationId が存在しない（または他テナントの id だった）」場合を表す値は無く、`getObservation` が `null` を返すと、素の `Error`（`runtime.reextract: observation not found: <id>`。型付き例外でも `RangeError` でもない）で
 * reject し、書き込みは一切しない。`forget`/`purge` 等は存在しない id を構造化された outcome（`not_found`）で返し、`getRecall` は `null` を返すが、`reextract` は例外を投げる。この不揃いは解消していない
 * （`not_found` 相当の outcome を足す案は公開の型の変更、型付き例外に変える案は投げる例外の種類の変更になるため採っていない）。呼び出し側は `try`/`catch` で扱う。
 */
export interface ReextractResult {
  /** 抽出し直した Observation の id。 */
  observationId: ObservationId;
  /** {@link WriteAtomicity}。⛔ 省略可能にしない。 */
  atomicity: WriteAtomicity;
  /**
   * 今回の抽出で作られた（または冪等に既存の行として返された）Memory の id。
   * `outcome !== 'ok'`、または候補が0件だった場合は空配列。
   */
  memoryIds: MemoryId[];
  /**
   * 🔴 安全弁により supersede された既存 Memory の id。
   * - LLM がまた失敗した場合（`outcome: 'llm_failed_whole_observation'`）は必ず空配列（失敗を根拠に既存の記憶を置き換えない）。
   * - 候補が0件だった場合も必ず空配列。
   * - 対象は同じ `(sourceObservationId, extractorVersion)` を持つ **`status: 'active'`** の Memory のうち、今回作られた content_hash の集合に
   *   含まれないものだけ（`forgotten` は絶対に含めない。`contested` も対象外。ADR 0028）。
   * - 🔴 supersede は `expectedStatus: "active"` の compare-and-swap で書く（ADR 0030。store が `supersedeWithNewMemories` を持てば
   *   その `supersede[].expectedStatus`、持たなければ `updateStatusWithEvent`）。読み（`listBySourceObservation`）と書きの間に status が変わっていた
   *   Memory は、ここには**入らない**（`skipped` に `status_changed_concurrently` として出る）。
   * - 🔴 **置き換えた側（`supersededById`）は、今回の抽出で `active` になる行である**（ADR 0454）。冪等キーは status を問わないので、
   *   候補が同じ版の `superseded`／`archived` な既存行にぶつかると、その行が `memoryIds` に載る。ぶつからない先頭の候補
   *   （新しく作る行・既に active な行）を置き換えた側にする。**候補が全部、非 `active` の既存行にぶつかるときは、何も supersede せず、
   *   この配列は空**（ぶつかった行は `skipped` に `status_not_active` で載る）。
   */
  supersededMemoryIds: MemoryId[];
  /**
   * 既存 Memory を supersede しなかった理由（ADR 0029）。`contested` で飛ばした・`forgotten` で飛ばした・置き換えるものが無かった、がすべて `supersededMemoryIds: []` という同じ顔になるのを避ける。
   * `status_changed_concurrently`（読んだ後に status が変わって弾かれた）も載る（ADR 0030）。件数は持たない（`ReextractSkip` に `count` が無い。`StageSkippedOmission` に倣った形）。
   *
   * `usedWholeObservationFallback`・`candidates.length === 0` の早期 return は既存を見る前に return するので `{ kind: 'not_examined', ... }`（「何も飛ばさなかった」ではなく「既存を見ていない」）。
   * 退けた記憶を持つ Observation の早期 return は、既存を見た上で LLM を呼ぶ前に return し、退けた記憶ごとに `status_not_active`（`status` は今の status）を1件ずつ積む（`not_examined` は入らず、同じ Observation の
   * 他の `active` な記憶は載らない）。このとき `extraction: "skipped"`・`atomicity: "not_attempted"`・`memoryIds: []`・`supersededMemoryIds: []`・`extractionFailure: null`。
   * 判定は `extractorVersion` を問わず（[ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）、`skipped` に版の欄は足さない（`memoryId` から `MemoryStore.get` で版をたどれる）。
   * LLM を待つ間に元の記憶が退けられたときも同じ形で返る（[ADR 0406](../../../docs/decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)）。LLM を呼んだ**後**に打ち切った点だけが違うが、戻り値からは区別できない。
   */
  skipped: ReextractSkip[];
  /** 抽出がどう終わったか（{@link ExtractionOutcome}）。 */
  extraction: ExtractionOutcome;
  /** `ObserveResult.extractionFailure` と同じ意味の欄（ADR 0076）。`extraction !== "llm_failed_whole_observation"` のときは必ず `null`。 */
  extractionFailure: ExtractionFailure | null;
}

/**
 * `runtime.forget` の対象。`{ memoryId }`（単数）と `{ memoryIds }`（複数）は同じ意味論で、`{ memoryId }` は1要素の配列と同じ扱い。
 */
export type ForgetTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/**
 * `runtime.forget` が対象1件ごとに返す結果。6つの `kind` は、呼び出し側の次の一手がそれぞれ違う（ADR 0008）。
 *
 * - `"forgotten"`: 今回の呼び出しで実際に `status` を `forgotten` へ動かし、`memory_events` にも `kind: 'forgotten'` を積んだ。
 *   `previousStatus` は動かす直前に観測した status。
 * - `"already_forgotten"`: 対象は最初から（または同じ呼び出し内の先行する要素の処理によって）`forgotten` だった。
 *   **書き込みは一切起きていない。** 同じ Memory を2回 forget しても `memory_events` は1件のまま。
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い（一度も存在しなかった、または他テナントの id）。
 *   `"already_forgotten"` と混同しない（前者は監査ログを遡れ、後者は遡れるものが無い）。
 * - `"conflicted"`: compare-and-swap が破れた（`getMany` で読んだ時点の status と、書きに行った時点の status が一致しなかった）。
 *   **自動で再試行しない。** 呼び出し側は `observedStatus` を見て、必要なら自分で `forget` を呼び直す。
 * - `"failed"`: 競合以外の例外（DB 接続断等）で書き込みそのものが失敗した。`error` に例外のメッセージを運ぶ。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: 同じ呼び出しの中で、**それより前の要素が `"failed"` になったため、この要素はまだ見ていない。**
 *   `"not_found"` や `"already_forgotten"` に潰さない（それらは「見た上でそう判定した」。`ReextractSkip` の `not_examined` と同じ区別）。
 *   呼び出し側は `"failed"` の原因を解消してから、`"not_attempted"` になった id だけを含めて `forget` を呼び直せる。
 */
export type ForgetOutcome =
  | { memoryId: MemoryId; kind: "forgotten"; previousStatus: MemoryStatus }
  | { memoryId: MemoryId; kind: "already_forgotten" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363）: drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、
       * `cause` の連鎖と SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/** `runtime.forget` の任意オプション。 */
export interface ForgetOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。「ユーザーの訂正で
   * 落ちた」と「運用の都合で落とした」を後から区別するためにある。省略時、
   * `meta` に `reason` キー自体を持たせない（`""` と「省略」を区別する）。
   */
  reason?: string | undefined;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
}

/**
 * `runtime.forget` の結果。`forgottenCount` のような派生値を持たない:
 * `outcomes` を数えれば得られる値を欄として複製すると、同じことを言う道が2つ在り、どちらか一方だけ直してずれる。
 */
export interface ForgetResult {
  /**
   * 入力（`ForgetTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる——1回目の処理結果が
   * 2回目の判定に反映される（例: 1回目が `"forgotten"` なら2回目は
   * `"already_forgotten"` になる）。
   */
  outcomes: ForgetOutcome[];
}

/**
 * `runtime.consolidate` の対象（ADR 0089。`{ seedMemoryId }` は ADR 0152）。
 *
 * `{ memoryIds }` は正規化せず、**重複も入力順もそのまま保つ**。`{ query, maxCandidates }` は `recall(ctx, query)` を1回呼んで得た `memories` の id を順に採る（`maxCandidates` があれば先頭からその件数で切る）。
 *
 * - **`{ query }` は `retrievedVia` によらず全部採る。** 連想枠は既定 on（ADR 0337）なので、`query.association` を省略すると、クエリに当たっていない「連想で返った」`active` な記憶も統合元として適格になる。
 *   当たったものだけを畳みたいなら `query.association: null` を渡す。contested の同伴（`mandatory_companion`）は `status_not_active` で弾かれる。`{ seedMemoryId }` は `computeAffinity` の閾値で絞るので、
 *   連想や同伴で返った記憶（`similarity` も `lexicalMatch` も持たない）は入らない。
 * - **`{ memoryIds }` は忘却の床（`decayFloorAt`）を見ない。** `{ query }`・`{ seedMemoryId }` の近傍は `recall()` の忘却のゲートを通る。
 * - どの形でも、いま有効期間（`validFrom`/`validUntil`）の外にある記憶は統合元にしない（`sources` に `"expired"`/`"not_yet_valid"`）。統合先は有効期間を持たない（ADR 0164）ので、期限切れの内容が期限の無い `active` として
 *   `recall()` に戻るのを避ける。`{ seedMemoryId }` の種（`recall()` を通らずに候補に入る）や、`{ query }` に `includeOutsideValidity: true`・過去の `validAt` を渡して集めた記憶にも効く。
 * - 統合先は eligible の有効期間の**積**を引き継ぐ（`intersectValidity`。[ADR 0368](../../../docs/decisions/0368-consolidate-reflect-validity-intersection.md)）。**代償**: 期限の無い F と将来の期限を持つ E を統合すると、
 *   統合先は E の期限を持ち、F は `superseded` になって、期限後は F 由来の内容も `recall()` に出なくなる（F の行は残る）。
 *
 * `{ seedMemoryId }` は「この記憶に似ているものを mnemora 自身が集めて、1つに畳め」（ADR 0152）。「似ている」の判定は mnemora 側が行うが、対象を自分で列挙して選ぶこと（active な記憶を走査してどれから畳むかを決める。
 * ADR 0089、`docs/roadmap.md` §5.7）はしない。**起点（`seedMemoryId`）は必ず呼び手が渡す。**
 * - 種の `digest` で `recall(ctx, { text })` を1回呼ぶ（`{ query }` と同じ経路で、新しい「似ている」の判定を作らない）。`affinity`（`max(similarity, lexicalMatch)`。{@link computeAffinity}）が `minAffinity`
 *   （既定 {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）未満の候補は落とす。
 * - **種は `minAffinity` の判定を受けず、必ず先頭に含める**（種の embedding がまだ無ければ ANN 段に載らず `recall()` の結果に現れないため）。`maxCandidates` は `[seedMemoryId, ...近傍]` を先頭から切る
 *   （`maxCandidates >= 1` なら種は残る）。
 * - 種が無い、または forget・purge された記憶なら、`recall()` を呼ばず、対象は `[seedMemoryId]` の1件のみになる（後続の `getMany` が `not_found`/`status_not_active` に分類。`llmCalls: 0`）。
 *   消した記憶の `digest` で近傍を束ねると、消した情報が別の形で効き続けるため。自動 job（ADR 0157）も同じ。`contested` / `superseded` の種は利用者が消したものではないので、近傍を集める。
 * - **近傍は `ctx` の scope で集める。** `ctx.subjectId` を付けなければテナント全体から集まり、近傍が別の subject にまたがると統合後の `subjectId` は `null` に畳まれる。帰属を保つなら `ctx.subjectId` に種の `subjectId` を渡す（ADR 0310）。
 *
 * ⚠ **「同じ対象で2回呼んだら2回目は書き込みゼロ」（ADR 0089）は `{ memoryIds }` でしか成り立たない。** `{ seedMemoryId }` は呼ぶたびに `recall()` で**現在の** active 集合から近傍を拾い直す。1回目で `recall()` の窓から
 * 溢れて `active` のまま残った近傍は、2回目に eligible として拾われ、LLM が再度呼ばれて新しい統合先ができる（1回目の統合先自身が巻き込まれて `superseded` になることもある）。`{ query, maxCandidates }` も `recall()` を呼び直す点は同じ。
 * 詳細は [ADR 0152](../../../docs/decisions/0152-consolidate-seed-neighborhood.md)・[ADR 0089](../../../docs/decisions/0089-runtime-consolidate-shape.md)。
 *
 * ⚠ **`maxCandidates` の値は検査しない。** 保証するのは、正の整数 `n` なら「`recall()` が返した順（`{ seedMemoryId }` では種が先頭）の先頭 `n` 件」、省略なら「その全件」だけ。それ以外（`0`・負・非整数・`NaN`）の対象は未定義で、
 * 例外は投げず `Array.prototype.slice` に渡す（`-1` は末尾の1件を除く全部、`1.5` は1件、`0` と `NaN` は0件）。`dryRun` でなければ選ばれた対象に統合を書く。この解釈は将来変わりうるので頼らないこと。
 * `Runtime.findCorrectionCandidates` の `limit`（正の整数以外を `RangeError` で拒む）とは揃えていない。
 */
export type ConsolidateTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number | undefined }
  | {
      seedMemoryId: MemoryId;
      maxCandidates?: number | undefined;
      minAffinity?: number | undefined;
      /**
       * 種の digest で内部的に呼ぶ `recall()` へそのまま渡す `RecallQuery.activityCounting`
       * （[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。`{ query }` 形は `RecallQuery` 自体にこの欄を含められるので、
       * ここには無い。省略時 `"tenant"`。
       */
      activityCounting?: "tenant" | "subject" | undefined;
    };

/**
 * `{ seedMemoryId }` 形（ADR 0152）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。** 保守側（畳まない側）に倒してある。統合元は `superseded` へ動く（ADR 0089）ので、
 * 取り違えて畳んだときの damage は「畳まなかった」より大きい。`ConsolidateOptions.dryRun` で、呼び手は本番へ入れる前に何が畳まれるはずかを見られる。
 */
export const DEFAULT_CONSOLIDATE_MIN_AFFINITY = 0.8;

/** `runtime.consolidate` の任意オプション（ADR 0089）。 */
export interface ConsolidateOptions {
  /** 統合の対象（{@link ConsolidateTarget}）。 */
  target: ConsolidateTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、束ねられる対象だけを見て返す
   * （{@link ConsolidateSourceOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean | undefined;
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（統合元の `superseded`・統合先の `created` の両方）。省略時は積まない。
   * `meta.reason` は常に固定値 `'consolidated'` であり、この欄では上書きしない（`MarkContestedOptions.reason` と
   * 同じ形。`ForgetOptions.reason` とは違う）。
   */
  reason?: string | undefined;
  /**
   * 中断の合図（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。内部で呼ぶ `recall()`（`{ seedMemoryId }`/`{ query }` 形のとき）と、
   * LLM 呼び出し（`completeStructured`）の両方に効く。**既定の時間の上限にはならない**（省略すれば待ち続ける）。
   *
   * abort されると、`consolidate()` は `signal.reason`（無ければ `AbortError` 相当）で reject する。既存の `"llm_failed"` には倒さない
   * （中断と LLM の失敗を区別するため）。LLM 呼び出しは対象を1件も書く前に行うので、abort の時点では何も書かれていない。
   */
  signal?: AbortSignal | undefined;
}

/**
 * `runtime.consolidate` 全体の結末（ADR 0089）。「束ねるものが無かった」「そもそも見ていない」「LLM が落ちた」「下見だけ」を1つの `false` に潰さない（ADR 0008）。
 *
 * - `"consolidated"` — 統合先を1件作り、少なくとも1件を `superseded` へ動かした。
 * - `"nothing_to_consolidate"` — 対象を見た上で、束ねるものが無かった（{@link ConsolidateNothingReason}）。
 * - `"not_examined"` — 対象が空（`memoryIds: []`）、または `query` が0件。store の Memory を1件も見ていない。
 * - `"llm_failed"` / `"dry_run"` — LLM 呼び出しが失敗した（本文が空白だけの応答を含む） / 下見だけを行った。**どちらも1件も書いていない。**
 * - `"aborted_source_forgotten"` — LLM は呼んだ（`llmCalls: 1`）が、書き込み直前の見直しで eligible の1件以上が `forgotten`（`forget()` のみ・`purge()` 済みも含む）になっていたので、**何も書かずに打ち切った**
 *   （ADR 0375）。{@link ConsolidateSourceOutcome} の `"forgotten_before_write"` 参照。
 * - `"aborted_source_status_changed"` — 同じく書き込み直前（または書き込みのトランザクション内）の見直しで、eligible の1件以上が `superseded` になっていた（`reextract` などが LLM を待つ間に別の記憶で置き換えた）、
 *   または eligible の**すべて**が `active` でなくなっていた（同じ ids の `consolidate` が先に commit した、など）ので、**何も書かずに打ち切った**（ADR 0420）。{@link ConsolidateSourceOutcome} の
 *   `"status_changed_concurrently"` が動いていた要素を名指しする。1件でも `active` のまま残り、`superseded` になったものが無いなら、部分成功（`"consolidated"`、動いていた要素だけ `"status_changed_concurrently"`）。
 *   **破壊的変更として数える**（`docs/migration-v1.md` 項目42）。union に値を足す変更は破壊的変更と数えない（同文書の数え方の規律）。
 */
export type ConsolidateOutcome =
  | "consolidated"
  | "nothing_to_consolidate"
  | "not_examined"
  | "llm_failed"
  | "dry_run"
  | "aborted_source_forgotten"
  | "aborted_source_status_changed";

/**
 * `ConsolidateOutcome: "nothing_to_consolidate"` の理由（ADR 0089）。
 *
 * - `"no_eligible_sources"` — 渡された/引けた対象のうち、統合元にできるもの（`status: 'active'` で、いまの時点で有効期間の内側）が0件。
 * - `"single_eligible_source"` — 統合元にできるものが1件だけ。1件を1件に「統合」しない。
 */
export type ConsolidateNothingReason = "no_eligible_sources" | "single_eligible_source";

/**
 * `runtime.consolidate` が対象1件ごとに返す結末（ADR 0089）。`ForgetOutcome` / `ReextractSkip` の語彙にできるだけ揃え、新しい `kind` を作らない。
 *
 * - `"superseded"` — この呼び出しで実際に `superseded` へ動かした。
 * - `"not_found"` — その id の Memory がそもそも無い。
 * - `"status_not_active"` — `status !== 'active'`（`forgotten` はここで確実に弾かれる）。
 * - `"status_changed_concurrently"` — compare-and-swap が破れた（`reextract` の同名と同じ意味）。
 * - `"failed"` — 競合以外の例外で書き込みが失敗した。**この時点で処理を打ち切る**（下の `"not_attempted"`）。
 * - `"not_attempted"` — eligible だったが、`superseded` への書き込みを試みていない（状態を変えずにそのまま再送してよい）。次の場合に出る: それより前の要素が `"failed"` で打ち切った / eligible が1件だけ
 *   （`single_eligible_source`。重複して渡されていれば全部） / LLM 呼び出しが失敗した（`llm_failed`） / `outcome: 'aborted_source_forgotten'` で、この要素自身は forgotten ではなかった。
 * - `"eligible"` — `dryRun: true` のときだけ出る。実際に統合される側になったであろう対象。
 * - `"expired"` / `"not_yet_valid"` — `status === 'active'` だが、いま有効期間が切れている（`validUntil <= now`）/ まだ始まっていない（`validFrom > now`）。統合元にしない。値はその記憶の `validUntil`/`validFrom`。
 * - `"forgotten_before_write"` — LLM を待つ間に eligible の1件が `forget`（さらに `purge`）された。この呼び出し全体が `aborted_source_forgotten` で打ち切られる（統合先を一切作らない。ADR 0375）。
 *   `"status_not_active"` は LLM を呼ぶ**前**の初期分類、こちらは呼んだ**後**・書き込み直前の見直しで検出した分類で、同じ「forgotten」でも検出した時点が違うので別の kind にした。
 *
 * `"expired"`/`"not_yet_valid"` の判定は `status` の後に行い（`forgotten` で期限切れの記憶は `status_not_active`）、述語は `recall()` の期間のゲート（ADR 0164）と同じで、時刻は呼んだ時点の `clock.now()`。
 * 逆転した区間（`validFrom > validUntil`）は `"expired"`。対象の形によらず効き、`dryRun` でも同じ値で名指しし、`nothingReason` の数え方には入らない。統合先の有効期間は統合元の区間の積（{@link ConsolidateTarget}）。
 * 🔴 この union を網羅的に分岐する呼び出し側は、`"expired"`・`"not_yet_valid"`・`"forgotten_before_write"` を扱う必要がある（union に値を足す変更は破壊的変更と数えない。`docs/migration-v1.md`）。
 */
export type ConsolidateSourceOutcome =
  | { memoryId: MemoryId; kind: "superseded"; previousStatus: "active" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
  | { memoryId: MemoryId; kind: "expired"; validUntil: Date }
  | { memoryId: MemoryId; kind: "not_yet_valid"; validFrom: Date }
  | { memoryId: MemoryId; kind: "status_changed_concurrently"; observedStatus: MemoryStatus | null }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363）: drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、
       * `cause` の連鎖と SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" }
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "forgotten_before_write" };

/** `runtime.consolidate` の結果（ADR 0089）。`consolidatedCount` のような派生値を持たない（`ForgetResult` と同じ理由。`sources` を数えれば得られる）。 */
export interface ConsolidationResult {
  /** 統合がどう終わったか（{@link ConsolidateOutcome}）。 */
  outcome: ConsolidateOutcome;
  /**
   * {@link WriteAtomicity}。⛔ 省略可能にしない。
   * `outcome` が `"consolidated"` 以外（`dry_run`・`nothing_to_consolidate`・`not_examined`・`llm_failed`）のときは必ず `"not_attempted"`
   * （書き込みを1件も試みていないため）。
   */
  atomicity: WriteAtomicity;
  /** `outcome === "nothing_to_consolidate"` のときだけ非 `null`。それ以外は必ず `null`。 */
  nothingReason: ConsolidateNothingReason | null;
  /** 作られた統合先の id。`outcome !== "consolidated"` のときは必ず `null`。 */
  consolidatedMemoryId: MemoryId | null;
  /**
   * 対象1件ごとの結末。**入力と同じ順序・同じ長さ**（`{ memoryIds }` のとき）。
   * 対象そのものを見ていない（`outcome === "not_examined"`）場合は空配列。
   */
  sources: ConsolidateSourceOutcome[];
  /** LLM を実際に呼んだ回数。`dryRun`・`not_examined`・`nothing_to_consolidate` は必ず `0`。 */
  llmCalls: number;
  /** `outcome !== "llm_failed"` のときは必ず `null`（`ReextractResult.extractionFailure` と同じ規律）。 */
  llmFailure: ExtractionFailure | null;
}

/**
 * `runtime.reflect` の対象（`{ seedMemoryId }` は ADR 0154）。`consolidate` の {@link ConsolidateTarget} と**意図的に同じ形**で、`{ memoryIds }`（重複も入力順も保つ）・`{ query, maxCandidates }`・`{ seedMemoryId }` の
 * 解決も同じ（種の選定・種を先頭に含める・種が無い/forget・purge された記憶なら `recall()` を呼ばず対象は `[seedMemoryId]` のみ、`contested`/`superseded` の種は近傍を集める）。`target` を必須にしたのは、
 * 省略できると `reflect` 自身が対象を選ぶことになり、Background Cognition の実運用（docs/roadmap.md §1.3）の決定を先取りしてしまうため。
 *
 * ⚠ **`minAffinity` の既定値は `consolidate` と別の定数である**（{@link DEFAULT_REFLECT_MIN_AFFINITY}。`consolidate` は {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）。同じ道具に逆向きの帯を要求する:
 * `consolidate` は「同じ事実の言い換え」（近いほどよい）、`reflect` は「関連するが同じではない複数の事実」（近すぎると導けるものが無い）を欲しがる。`reflect()` は既存行の `status` を動かさない（ADR 0091）ので、
 * 取り違えたときの damage が小さく、保守側へ倒す理由も弱い。
 * ⛔ 上限（近すぎるものを除く帯）は無い。入れると `reflect` が「何が重複か」を判断することになり、それは `consolidate` の仕事である（責務の二重化）。代わりに「`consolidate` が先に走っていれば重複は既に畳まれている」
 * という前提に乗る。**この前提は負債である**（ADR 0154）。
 *
 * ⚠ **`maxCandidates` の値は検査しない**（`consolidate` と同じ。正の整数 `n` なら先頭 `n` 件、省略なら全件。それ以外は未定義で、`Array.prototype.slice` に渡る。頼らないこと）。
 *
 * - **`{ query }` は `retrievedVia` によらず全部採る。** 連想枠は既定 on（ADR 0337）なので、クエリに当たっていない「連想で返った」`active` な記憶も材料として適格になる（避けるなら `query.association: null`）。
 * - **`{ memoryIds }` は忘却の床を見ない。** `{ query }`・`{ seedMemoryId }` の近傍は `recall()` の忘却のゲートを通る。
 * - どの形でも、いま有効期間の外にある記憶は材料にしない（`basis` に `"expired"`/`"not_yet_valid"`）。内省の記憶も有効期間を持たない（ADR 0164）ので、期限切れの内容が期限の無い `active` として `recall()` に戻るのを避ける。
 *   `{ seedMemoryId }` の種と、`{ query }` に `includeOutsideValidity: true`・過去の `validAt` を渡して集めた記憶にも効く。
 */
export type ReflectTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number | undefined }
  | {
      seedMemoryId: MemoryId;
      maxCandidates?: number | undefined;
      minAffinity?: number | undefined;
      /**
       * `ConsolidateTarget`（`{ seedMemoryId }` 形）の同名の欄と同じ。種の digest で内部的に呼ぶ `recall()` へそのまま渡す。省略時 `"tenant"`
       * （[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。
       */
      activityCounting?: "tenant" | "subject" | undefined;
    };

/**
 * `{ seedMemoryId }` 形（ADR 0154）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。** 根拠は向きの議論だけで、数字の根拠ではない。`consolidate` の 0.8 より低くしてあるのは、
 * `reflect` が「近すぎない」複数の事実を欲しがるため（{@link ReflectTarget} の doc 参照）。
 */
export const DEFAULT_REFLECT_MIN_AFFINITY = 0.4;

/** `runtime.reflect` の任意オプション。 */
export interface ReflectOptions {
  /** 内省の対象（{@link ReflectTarget}）。 */
  target: ReflectTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、土台になりうる対象だけを見て返す
   * （{@link ReflectBasisOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean | undefined;
  /** `memory_events.actor`（`created` イベント）。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`created` イベント）。省略時は積まない。`meta.reason` は常に固定値
   * `'reflected'` であり、この欄では上書きしない（`ConsolidateOptions.reason` と同じ形）。
   */
  reason?: string | undefined;
  /**
   * 中断の合図（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。`ConsolidateOptions.signal` と同じ形で、
   * 内部で呼ぶ `recall()` と LLM 呼び出しの両方に効く。abort されると `reflect()` は reject し、既存の `"llm_failed"` には倒さない。
   */
  signal?: AbortSignal | undefined;
}

/**
 * `runtime.reflect` 全体の結末。`ConsolidateOutcome` と同じ「無い」の分類で、「一般化するものが無かった」「そもそも見ていない」「LLM が落ちた」「下見だけ」を1つの `false` に潰さない。
 *
 * - `"reflected"` — 新しい Memory を1件作った（`reflectedMemoryId` は非 `null`）。
 * - `"nothing_to_reflect"` — 土台を見た上で、作るものが無かった（{@link ReflectNothingReason}）。
 * - `"not_examined"` — 対象が空（`memoryIds: []`）、または `query` が0件。store の Memory を1件も見ていない。
 * - `"llm_failed"` / `"dry_run"` — LLM 呼び出しが失敗した（本文が空白だけの応答を含む） / 下見だけを行った。**どちらも1件も書いていない。**
 * - `"aborted_source_forgotten"` — LLM は呼んだ（`llmCalls: 1`）が、書き込み直前の見直しで eligible の1件以上が `forgotten`（`purge()` 済みも含む）になっていたので、**何も書かずに打ち切った**（ADR 0375）。
 * - `"aborted_source_status_changed"` — 同じく書き込み直前（または書き込みのトランザクション内）の見直しで eligible の1件以上が `superseded` になっていたので、**何も書かずに打ち切った**（ADR 0420）。
 *   **破壊的変更として数える**（`docs/migration-v1.md` 項目42）。union に値を足す変更は破壊的変更と数えない。
 */
export type ReflectOutcome =
  | "reflected"
  | "nothing_to_reflect"
  | "not_examined"
  | "llm_failed"
  | "dry_run"
  | "aborted_source_forgotten"
  | "aborted_source_status_changed";

/**
 * `ReflectOutcome: "nothing_to_reflect"` の理由。
 *
 * - `"no_eligible_basis"` — 渡された/引けた対象のうち、採れるもの（`status: 'active'` かつ `provenance.kind !== 'reflected'`）が0件。
 *   **LLM を呼んでいない**（`llmCalls: 0`）。
 * - `"llm_declined"` — LLM を呼び、モデルが「一般化するものは無い」と答えた（`outcome: 'nothing'`、`llmCalls: 1`）。**書き込みは0件。**
 */
export type ReflectNothingReason = "no_eligible_basis" | "llm_declined";

/**
 * `runtime.reflect` が対象1件ごとに返す結末。`ConsolidateSourceOutcome` と**意図的に違う語彙**を持つ: `reflect` は「足す」操作で既存の行の `status` を動かさないので、`"status_changed_concurrently"` / `"failed"` /
 * `"not_attempted"` は存在しない。
 *
 * - `"used"` — 実際に新しい Memory の `provenance.sources` に入った土台。
 * - `"not_found"` / `"status_not_active"` — その id の Memory が無い / `status !== 'active'`（`forgotten` はここで確実に弾かれる）。
 * - `"expired"` / `"not_yet_valid"` — `status === 'active'` だが、いま有効期間が切れている / まだ始まっていない。材料にしない。値はその記憶の `validUntil`/`validFrom`。
 * - `"basis_is_reflected"` — 有効期間の内側の `active` だが `provenance.kind === 'reflected'`。自己増幅（reflect の産物を土台にまた reflect すること）を形の側で止める。
 * - `"eligible"` — 土台として採れる状態だったが、結局使われなかった（`dryRun: true` の下見 / LLM 呼び出しの失敗 / LLM が「無い」と答えた / 他の eligible が `"forgotten_before_write"` になり呼び出し全体が打ち切られた、のいずれか）。
 * - `"forgotten_before_write"` — LLM を待つ間に eligible の1件が `forget`（さらに `purge`）された。この呼び出し全体が `aborted_source_forgotten` で打ち切られる（内省の Memory を作らない。ADR 0375）。
 *   `"status_not_active"` は LLM の**前**、こちらは**後**・書き込み直前の見直しで検出した分類（`ConsolidateSourceOutcome` と同じ区別）。
 * - `"status_changed_before_write"` — 書き込み直前（または書き込みのトランザクション内）の見直しで、すでに `superseded`（ADR 0420）・`contested`（ADR 0544）になっていた（`observedStatus` はそのとき見えた値）。
 *   この呼び出し全体が `aborted_source_status_changed` で打ち切られ、他の eligible は `"eligible"` のまま。
 *
 * `"expired"`/`"not_yet_valid"` の判定は `status` の後・`basis_is_reflected` の前で、述語は `consolidate()`・`recall()` と同じ `classifyValidity`（`./validity.js`、非公開）、時刻は呼んだ時点の `clock.now()`
 * （逆転した区間は `"expired"`）。対象の形によらず効き、`dryRun` でも同じ値で名指しし、`nothingReason` の数え方には入らない。内省の記憶の有効期間は null（材料の区間を引き継がない）。
 * 🔴 この union を網羅的に分岐する呼び出し側は、`"expired"`・`"not_yet_valid"`・`"forgotten_before_write"` を扱う必要がある（union に値を足す変更は破壊的変更と数えない。`docs/migration-v1.md`）。
 */
export type ReflectBasisOutcome =
  | { memoryId: MemoryId; kind: "used" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
  | { memoryId: MemoryId; kind: "expired"; validUntil: Date }
  | { memoryId: MemoryId; kind: "not_yet_valid"; validFrom: Date }
  | { memoryId: MemoryId; kind: "basis_is_reflected" }
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "forgotten_before_write" }
  | { memoryId: MemoryId; kind: "status_changed_before_write"; observedStatus: MemoryStatus };

/** `runtime.reflect` の結果。⛔ 派生値（`reflectedCount` 等）を持たない（`ConsolidationResult` と同じ理由。`basis` を数えれば得られる）。 */
export interface ReflectionResult {
  /** 内省がどう終わったか（{@link ReflectOutcome}）。 */
  outcome: ReflectOutcome;
  /** `outcome === "nothing_to_reflect"` のときだけ非 `null`。それ以外は必ず `null`。 */
  nothingReason: ReflectNothingReason | null;
  /** 作られた Memory の id。`outcome !== "reflected"` のときは必ず `null`。 */
  reflectedMemoryId: MemoryId | null;
  /**
   * 対象1件ごとの結末。**入力と同じ順序・同じ長さ**（`{ memoryIds }` のとき、重複も保つ）。
   * 対象そのものを見ていない（`outcome === "not_examined"`）場合は空配列。
   */
  basis: ReflectBasisOutcome[];
  /** LLM を実際に呼んだ回数。`dryRun`・`not_examined`・`no_eligible_basis` は必ず `0`。 */
  llmCalls: number;
  /** `outcome !== "llm_failed"` のときは必ず `null`（`ConsolidationResult.llmFailure` と同じ規律）。 */
  llmFailure: ExtractionFailure | null;
}

/** `Runtime.tick` の設定。 */
export interface TickOptions {
  /**
   * claim のリース長（ミリ秒）。`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）へそのまま渡す。**必須・既定値なし**: リース長は「ワーカーが止まったとみなすまでの時間」という運用方針で、`packages/core` が決めてよい値ではない。
   * `tick(ctx)` を引数無しで呼ぶことはできない。
   *
   * ⚠ **0 以下も受け付ける（`leaseMs` が有限の数でありさえすれば検査しない）。** 0 以下では、claim した行がその時点で既にリース切れとして扱われ、同時に走る別の `tick` が同じ行を claim して handler をもう一度走らせ、
   * 遅れて `complete`/`fail` した側は {@link TickResult.leaseConflicts} に載る。重複の防ぎは、正の `leaseMs` が処理時間より長いときにだけ効く。
   *
   * ⚠ **Runtime が入口で検査する**（ADR 0496）。claim する前に、`opts` が object でない（`tick(ctx)` で第2引数ごと省略した場合を含む）と `TypeError`、`opts.leaseMs` が有限の数でない
   * （省略・`undefined`・文字列・`NaN`・`±Infinity`）と `RangeError`（`Runtime.tick: opts.leaseMs must be a finite number` など。入力値は入れない）。store ごとに違う例外にはならず、ジョブは claim されない
   * （同じ時刻の次の `tick` で取れる）。0 以下の有限の値は断らない。例外の種類は `packages/postgres/src/__tests__/runtime-entry-exception-kinds.postgres.test.ts` が測っている。
   * ⚠ 巨大な `leaseMs` も、claim する前に `RangeError`（ADR 0514）。`now - leaseMs`（`now` は `RuntimeConfig.clock` の今）が `Date` の範囲を外れる（`1e20`・`-1e20`）か、Postgres の `timestamptz` の下限
   * （4714-11-24 BC、`-210866803200000` ms）より前になる（`3e14` など）と `Runtime.tick: opts.leaseMs is out of range (now - leaseMs must be a timestamp every store can hold)`。下限ちょうどは通る。
   *
   * ⚠ ジョブの処理がリースより長く掛かっても、その間に別の `tick` が同じジョブを取らなければ、完了は通り、`TickResult` には何も出ない（`attempts` が変わらないので `complete` の CAS が通り、`processed` に数えられ、
   * `leaseConflicts` は空）。別の `tick` が取った場合は、遅れた側が `leaseConflicts` に載る。リースを超えたこと自体を名乗る口は無い。
   *
   * ⚠ **リースはバッチの claim 時点から数える。後ろのジョブは、自分の番が来る前に切れうる。** `tick` は {@link TickOptions.limit}（既定 50）件を1回の `claimBatch` で一括して claim し（全件の `claimed_at` は同じ `now`）、
   * 1件ずつ順に処理するので、各ジョブのリースは**そのジョブの処理開始からではなく、バッチの claim 時点から**減っていく。前のジョブに時間が掛かると、後ろのジョブは自分の処理が始まる前に、あるいは始まって間もなく切れる。
   * 1件あたりの処理時間が `leaseMs` より短くても、`limit` 件の合計が `leaseMs` を超えれば起きる。切れたジョブは別の `tick` が再 claim できる。そのとき **provider 呼び出しと書き込み（`embed` なら埋め込みの呼び出しと `upsert`）は二重に走る**。
   * CAS（ADR 0142）が無害にするのは完了の記録だけで、遅れて `complete` した側は {@link TickResult.leaseConflicts} に載る。結果は壊れない（2件とも完了し、`attempts` が進む）が、二重の呼び出し分の費用は掛かる。
   * `embed` は上書きなので冪等、`extract` は再配達の確認（`OutboxStore` の doc）、`reflect` は再配達で2件になりうる（`Runtime.reflect` の doc）。避けるには、`leaseMs` を「`limit` 件を最後まで処理する時間」より長く取るか、
   * `limit` を小さくする。`tick` はジョブの所要時間を知らないのでこの関係を検査せず、各ジョブの前にリースを延ばす口も `OutboxStore` には無い。
   * `packages/core/src/__tests__/tick-batch-lease-expiry.test.ts` が、fake の store で A が2件を claim → 2件目の処理中に時計を進めて別の `tick` B が2件目を再 claim → A の `complete` は `leaseConflicts`、provider 呼び出しは3回、と測っている。
   *
   * ⚠ **二重に走った結末は種類で違う**（[ADR 0530](../../../docs/decisions/0530-batch-exceeds-lease-double-processing-per-kind.md)）。
   * `embed` は同じベクトルを上書きするだけで、記憶は壊れない。`extract` は、先に走った側がまだ書いていなければ事前の確認（ADR 0347）が効かず、同じ候補なら冪等の鍵で1件、
   * 違う候補なら両方が `active` で残る（遅れた側の LLM が落ちると全文のフォールバックの記憶も残る）。`reflect` は、材料の記憶を `superseded` にしないので、二重に走ると内省の記憶が2件できる。
   * `consolidate` は、書く前の読み直し（ADR 0420）で、先に統合された元の記憶が `superseded` になっているのを見て、何も書かずに打ち切る（LLM は二重に呼ぶ。統合先は1件のまま）。
   * どの種類でも、遅れた側の `complete`/`fail` は `leaseConflicts` に載り、行は先に完了した側のまま。
   */
  leaseMs: number;
  /**
   * 1回の `tick` で claim する上限。省略時の値は `@mnemora/core` の内部定数（`DEFAULT_TICK_LIMIT`）。`0` なら何も claim しない。
   * ⚠ 0 以上 2^63 未満の整数でなければ、claim する前に `RangeError`（`Runtime.tick: opts.limit must be an integer from 0 up to (not including) 2^63`。
   * 文字列・`null`・`NaN`・`±Infinity`・負数・小数を含む。`undefined` は省略と同じ。ADR 0514）。`0` は断らない。
   */
  limit?: number | undefined;
  /**
   * claim する job の種類。省略時は {@link TICK_SUPPORTED_JOB_KINDS}。
   *
   * - **その外の種類の行は、既定の `tick` では claim されず、終端にもならないまま残る**（ADR 0082「頼まれていない kind は claim すらしない」）。
   *   明示して渡したときだけ claim し、{@link TickResult.unsupported} として `fail` に落とす。
   * - 空配列は何も claim しない。
   * - ⚠ 文字列の配列でなければ、claim する前に `TypeError`（`Runtime.tick: opts.kinds must be an array of strings`。裸の文字列・`null`・object・文字列でない要素を含む。
   *   `undefined` は省略と同じ。ADR 0514）。
   * - claim の順は、種類に関わらず `available_at` の古い順である。種類ごとの枠の配分は無く、古い job が `limit` を埋めていれば、
   *   後から積まれた別の種類の job は次の `tick` に回る。
   */
  kinds?: OutboxJobKind[] | undefined;
  /**
   * claim した worker の名前（outbox の行の `claimed_by`）。省略すると `RuntimeConfig.defaultClaimedBy`、それも無ければ `"runtime.tick"`。
   * ⚠ 空文字は省略と同じにはならず、そのまま `OutboxStore.claimBatch` に渡る（`ClaimOutboxJobsOptions.claimedBy` の doc）。
   * ⚠ 文字列でなければ、claim する前に `TypeError`（`Runtime.tick: opts.claimedBy must be a string`。`null`・数・object。ADR 0514）。
   * NUL（U+0000）を含む文字列は `RangeError`（`Runtime.tick: opts.claimedBy must not contain NUL characters (U+0000)`。ADR 0493）。`undefined` は省略と同じ。
   */
  claimedBy?: string | undefined;
  /**
   * 中断の合図（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。**既定の時間の上限にはならない**
   * （省略すれば provider が返るまで待ち続ける）。
   *
   * `signal` を渡し、それが abort されると:
   * - claim 済みで処理中・未着手のジョブは、**`fail()` しない**。claim されたまま残り、リースが切れれば次の `tick` が取る。
   *   abort までに `complete()` まで記録できたジョブの完了は残る。
   * - `tick()` 自身は reject する（`signal.reason`。無ければ `AbortError` 相当）。`TickResult` はこの中断のために新しい欄を持たない。
   */
  signal?: AbortSignal | undefined;
}

/**
 * `tick` が claim したものの、**処理する分岐を持たなかった**ジョブ（ADR 0082）。{@link TickResult.unsupported} の要素型。
 * 件数の欄を持たない（配列そのものが件数を持つ。`ReextractSkip` / `StageSkippedOmission` に倣った形。ADR 0029）。
 */
export interface UnsupportedOutboxJob {
  /** `fail()` で終端に落とした outbox 行の id。どの行が焼かれたかを名指しできる。 */
  jobId: string;
  /** その行の `kind`。`TICK_SUPPORTED_JOB_KINDS` に無かったもの。 */
  kind: OutboxJobKind;
}

/**
 * 🔴 `tick` がジョブの結果を `complete`/`fail` で記録しようとした時点で、既にリースを失っていた（`OutboxLeaseConflictError`）ジョブ（ADR 0142）。
 * {@link TickResult.leaseConflicts} の要素型。
 *
 * **これは失敗ではない。** リース競合が起きるのは、別のワーカーが既に同じジョブを再 claim して（成功にせよ失敗にせよ）終端まで進めた場合だけである
 * （`claimBatch` の `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）が、終端化されていない行しか対象にしないため）。
 * **システムから見れば、そのジョブは（このワーカー以外の誰かによって）既に済んでいる。**
 */
export interface OutboxLeaseConflict {
  /** 競合した outbox 行の id。 */
  jobId: string;
  /** その行の `kind`。 */
  kind: OutboxJobKind;
  /**
   * このワーカーが記録しようとしていた結果。`"complete"` はジョブの処理自体には成功したが、記録しようとした時点でリースを失っていたこと、
   * `"fail"` は処理に失敗した（または `"complete"` の記録自体が競合以外の理由で失敗した）ため `fail()` で記録しようとしたが、
   * それもリース切れで記録できなかったことを示す。**いずれの場合も、この worker はジョブの最終的な結果に影響を与えていない**
   * （別のワーカーが既に書いた結果がそのまま残る）。
   */
  attemptedOutcome: "complete" | "fail";
}

/** `Runtime.tick` の結果。 */
export interface TickResult {
  /** この tick で処理に成功し、`complete()` まで記録できたジョブの本数（完了の記録がリースの競合で弾かれたものは数えない）。 */
  processed: number;
  /**
   * この tick で `outboxStore.fail()` を呼び、それが `OutboxLeaseConflictError` で弾かれなかった件数。
   *
   * ⚠ **「`fail()` を呼んで弾かれなかった」は「その行が終端 `failed` になった」と同じではない。** `outboxStore.complete()` がハンドラの成功を DB へ
   * コミットした**後**に `OutboxLeaseConflictError` 以外の例外（コミット後の接続断・タイムアウト等）を返すと、`tick()` はそれを「処理が失敗した」と
   * 区別できずに `fail()` を呼ぶ。`OutboxStore.complete`/`fail` の契約により、既に `completed_at` が付いた行に対する `fail()` は無言の no-op になる。
   * 行は `completed` のまま（`failed_at`/`last_error` は `NULL`）で変わらないが、`tick()` はそれでも `failed` を1増やす。この場合、行の実際の終端状態
   * （`completed`）と `failed` の集計は食い違う。`unsupported` にも `leaseConflicts` にも載らないため、`TickResult` からはどの1件がこのずれに当たるかを
   * 特定できない。`OutboxStore.complete`/`fail` はどちらも `Promise<void>` で、`OutboxStore` に id で1件を読み直す口も無いため、`tick()` 自身にこれを区別する手段は無い
   * （[ADR 0142](../../../docs/decisions/0142-outbox-complete-fail-compare-and-swap.md)）。
   */
  failed: number;
  /**
   * `failed` の**内訳**のうち、「処理を試みて失敗した」のではなく「`tick` がその kind を処理する分岐を持っていなかった」もの（ADR 0082）。
   *
   * 🔴 **この欄が在る理由は1つだけ**: これが無いと、「embed の provider が落ちて失敗した」と「`kinds: ['consolidate']` を渡したが `tick` は consolidate を
   * 処理できない」が、どちらも `failed: 1` という**同じ顔**になる（ADR 0029が `ReextractResult.skipped` で塞いだのと同じ、「無い」の種類を潰す欠落）。
   * **`unsupported` に入ったジョブは `failed` にも数える。** `unsupported` に入るジョブ（対応する handler が無い）は、`failed` の doc にある
   * 「`complete()` がコミット後に例外を返す」分岐を通らないため、そのずれの対象にはならない。
   *
   * ⚠ **ここに出たジョブは `fail()` で終端に落ちている**（Phase 1 に自動リトライは無い。ADR 0032）。claim したまま何もしないと、
   * 「claim され続けるがいつまでも進まない」という、呼び出し側から見えない停止になるため、黙って lease 切れを待つ形にはしない。
   *
   * 空配列が既定であり、`undefined` にはならない（「出なかった」と「見ていない」を同じ顔にしないため）。
   */
  unsupported: UnsupportedOutboxJob[];
  /**
   * 🔴 このジョブの結果を記録しようとした時点で、既にリースを失っていた（`OutboxLeaseConflictError`）ジョブ（ADR 0142）。
   * **`processed` にも `failed` にも数えない**（`unsupported` と同じ理由。ADR 0008）。良性の競合（正常な並行の結果）を、失敗という別の顔に変えない。
   *
   * `tick` はこの例外を検知すると、**そのジョブだけを飛ばして残りのジョブの処理を続ける**。1件の良性の競合で、同じ `tick` 呼び出し内の他のジョブまで
   * 処理が止まるのは、狭い事象を広い停止に変換する形である。
   *
   * 空配列が既定であり、`undefined` にはならない。
   */
  leaseConflicts: OutboxLeaseConflict[];
}

/**
 * {@link Runtime.sweepArchive} の返り値（ADR 0114）。
 *
 * `MemoryStore.archiveDecayed` は任意メソッドである。**store 側の `ArchiveDecayedResult`（`interfaces/memory-store.ts`）をそのまま返り値にしない**。
 * store 側の型には「口が無かった」を語る場所が無い。この違いを埋めるのが `supported` である。
 *
 * ⛔ **`supported` を省略可能にしない**（`WriteAtomicity`（ADR 0100）と同じ理由）。
 */
export interface SweepArchiveResult {
  /**
   * `MemoryStore.archiveDecayed` が実装されていたか。**`false` のとき `archived` は
   * 常に空配列・`reachedLimit` は常に `false`**——「対応していないので0件」であって
   * 「対応していて0件だった」ではない。呼び出し側はこの2つを取り違えないよう、
   * 必ず `supported` を先に見ること。
   */
  supported: boolean;
  /** 実際に archived にした Memory。`decay_floor_at` 昇順。`supported: false` なら常に空。 */
  archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }>;
  /** store 側の `ArchiveDecayedResult.reachedLimit` をそのまま運ぶ。`supported: false` なら常に `false`。 */
  reachedLimit: boolean;
}

/** `runtime.restoreArchived` の対象（ADR 0122）。`ForgetTarget` と**意図的に同じ形**。 */
export type RestoreArchivedTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.restoreArchived` の任意オプション（ADR 0122）。`ForgetOptions` と同じ形。 */
export interface RestoreArchivedOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string | undefined;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
}

/**
 * `runtime.restoreArchived` が対象1件ごとに返す結果（ADR 0122）。`ForgetOutcome` と**同じ6つの `kind`**（`forgotten`/`already_forgotten` の位置が `restored`/`status_not_archived` に入れ替わるだけ。ADR 0008）。
 *
 * - `"restored"`: `archived` から `active` へ動かし、`kind: 'restored'` を積んだ。`previousStatus` は常に `"archived"`。続けて `MemoryStore.reinforce` も呼ぶ（[ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）。
 *   **`reinforce` が失敗しても復帰は握り潰さず**、`kind` は `"restored"` のまま、失敗を `reinforceError` に運ぶ。
 * - `"status_not_archived"`: 対象は最初から（または同じ呼び出し内の先行する要素の処理によって）`archived` ではなかった。**書き込みは起きていない。** `status` に現在値。
 *   `ConsolidateSourceOutcome.status_not_active` と同じ命名規律で、「見たが前提の状態ではなかった」を表す。
 * - `"not_found"`: そのテナントにその id の Memory が無い。
 * - `"conflicted"`: compare-and-swap が破れた。**自動で再試行しない。** 再読した結果が `"active"`（別の呼び出しが先に同じ復帰を済ませていた）なら `"status_not_archived"` に含める
 *   （求めていた状態に既に居るのは対立ではない。`forget` の `already_forgotten` と同じ）。それ以外の状態に変わっていた場合だけ `"conflicted"` で `observedStatus` を運ぶ。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になったため、まだ見ていない。
 */
export type RestoreArchivedOutcome =
  | {
      memoryId: MemoryId;
      kind: "restored";
      previousStatus: "archived";
      /**
       * `status` の復帰に続けて試みた `reinforce` が失敗した場合だけ在る（ADR 0153）。省略時（`undefined`）は `reinforce` も成功したことを意味する
       * （`reinforce` は復帰が成功した全件に対して必ず試みる）。文字列は `"failed"` の `error` と同じ整形（ADR 0363）。
       */
      reinforceError?: string;
    }
  | { memoryId: MemoryId; kind: "status_not_archived"; status: Exclude<MemoryStatus, "archived"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363）: drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、
       * `cause` の連鎖と SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/** `runtime.restoreArchived` の結果（ADR 0122）。`restoredCount` のような派生値を持たない（`ForgetResult`/`ConsolidationResult` と同じ理由）。 */
export interface RestoreArchivedResult {
  /**
   * 入力（`RestoreArchivedTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: RestoreArchivedOutcome[];
}

/**
 * `runtime.restoreSuperseded` の対象（`docs/memory-model.md` §11 行15「`superseded → active`」を書き込む口）。
 *
 * 🔴 **粒度の既定は「群」であり、個別の Memory id を渡す形は無い。** `ForgetTarget`/`RestoreArchivedTarget` の `{ memoryId } | { memoryIds }` という二形は、
 * 意図的に採らない。`superseded` な Memory は `recall()` に出てこない（段1の候補生成が使う status ゲートは `['active','contested']` 固定。
 * `docs/recall.md` §2 段0「スコープの外延」）ので、呼び出し側は「戻したい Memory の id」を知る手段を持たない。
 * 手元にある唯一の取っ手は「置き換えた側（supersede した側）」の id である。
 *
 * 🔴 **`superseded_by_id` が作る群は「1回の操作」とちょうど一致するとは限らない**
 * （[ADR 0230](../../../docs/decisions/0230-restore-superseded-recovery-path.md)）。`resolveContested` の勝者は前から在る Memory であり、
 * `reextract` のアンカーも冪等な `ON CONFLICT` 経由で前から在る Memory に解決されることがある。どちらも「同じ id の下に別々の操作の敗者が積み上がる」余地を残す。
 * `consolidate` の統合先だけが常に新規作成である（構造的な保証。下記 `onlyMemoryIds` の doc 参照）。
 */
export type RestoreSupersededTarget = {
  /** 置き換えた側（supersede した側）の Memory の id。これを `supersededById` に持つ Memory の群を戻す。 */
  supersededById: MemoryId;
  /**
   * 群を「1回の操作」単位に絞る**任意の**フィルタ（[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）。指定すると、対象は `superseded_by_id = supersededById` の群のうち、
   * このリストに含まれる `memoryId` だけ（積集合）。**省略時は群全体。** 空配列は対象0件（`id = ANY('{}')` は常に偽）。
   *
   * 🔴 **どの id をまとめて渡すかは mnemora は判定しない**（機械は検出まで。[ADR 0223](../../../docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)）。呼び出し側は `opts.dryRun: true` で
   * `previewRestoreSupersededBy?` を呼び、`candidates[].supersededReason` から「どの `memoryId` が同じ操作に属するか」を決めてから渡す:
   * - `"consolidated"`: 同じ reason の候補は、1アンカーの下で高々1つの群（`consolidate` は統合先の `sourceObservationId` を常に `null` にするため、`createMemory` の冪等 `ON CONFLICT`
   *   〔`WHERE source_observation_id IS NOT NULL`〕の対象に入らず、統合先は必ず新規作成される）。同じ reason の候補全部をまとめて渡せば、1回の操作になる。
   * - `"contested_resolved"`: **1件 = 1回の操作**（`resolveContested` は1回につき敗者1件）。**1件ずつ**渡す。まとめると、同じ勝者が複数回勝った別々の操作を1回で混ぜて戻す。
   * - 🔴 `"reextract_superseded"` と `null`（由来不明）: **既存の情報だけでは操作単位に分割できないことがある。⛔ 割れるという顔をしない。** `reextract` のアンカーは位置で選ぶだけで、冪等な `ON CONFLICT` 経由で
   *   既存の Memory に解決されると、複数回の別々の `reextract` が同じアンカーを共有しうる。そのとき `meta.reason`/`sourceObservationId`/`extractorVersion` は一致しうるので区別できない（ADR 0230、ADR 0258）。
   *   まとめて渡すのは「確認できていないが、たまたま1回の操作かもしれない」という賭けである。
   *
   * {@link groupSupersededCandidatesByOperation} がこの判断を補助する任意の純関数（判定はしない・`"unknown"` を隠さない）。
   *
   * ⚠ 判断材料の `supersededReason` は、`MemoryStore.purgeExpiredEvents?`（[ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)）が保持期間で掃除した後は取れない。`previewRestoreSupersededBy?` は
   * `superseded` イベントの `meta` から読むが、`purgeExpiredEvents?` は `events_purged` 以外の行を全て対象にする。掃除後は `consolidated`/`contested_resolved` だった候補も `null` に劣化し、`"unknown"` グループに合流する。
   * **「最初から由来が無かった」候補と「掃除で消えた」候補は区別できず**、別々の操作の敗者が同じ `null` で1グループに誤って統合されうる（採らなかった案は ADR 0258）。
   */
  onlyMemoryIds?: MemoryId[] | undefined;
};

/** {@link groupSupersededCandidatesByOperation} が返す1グループ（ADR 0258）。 */
export type SupersededOperationGroup = {
  /** 群を作った `superseded` イベントの `meta.reason`（自由文をそのまま運ぶ。無ければ `null`）。 */
  supersededReason: string | null;
  /** この群に入る Memory の id。 */
  memoryIds: MemoryId[];
  /**
   * この `memoryIds` の区切りが、1回の操作と一致することをどこまで保証できるかを正直に示す。
   * ⛔ **`"unknown"` は「安全」の意味ではない**: 「同じ操作かもしれないし、別の操作かもしれない。mnemora はこれを区別する情報を持たない」という宣言である。
   *
   * - `"structural"`: `consolidate` が作る群。統合先は常に新規作成されるという構造的な保証により、同じ reason の候補は必ず1操作分である。
   * - `"per_item"`: `resolveContested` が作る群。1件が必ず1操作なので、`memoryIds` は常にちょうど1件になる。
   * - `"unknown"`: `reextract` が作る群、または `supersededReason` が取れなかった候補。既存の情報だけでは1回の操作と一致するかを判定できない（ADR 0230、ADR 0258）。
   */
  boundaryConfidence: "structural" | "per_item" | "unknown";
};

/**
 * `previewRestoreSupersededBy?` が返す候補を、推定される「1回の操作」単位へグルーピングする補助（ADR 0258）。
 *
 * 🔴 **これは検出だけである。書き込みには一切触れない**（機械は検出まで。ADR 0223）。
 * **どのグループを実際に `restoreSuperseded` の `onlyMemoryIds` へ渡すかは、呼び出し側が決める。**
 *
 * グルーピングの規則（詳細は `RestoreSupersededTarget.onlyMemoryIds` の doc）:
 * - `supersededReason === "consolidated"`: 同じ reason の候補をまとめて1グループにする。`boundaryConfidence: "structural"`。
 * - `supersededReason === "contested_resolved"`: 1件ずつ別グループにする（`memoryIds` は常に1件）。`boundaryConfidence: "per_item"`。
 * - それ以外（`"reextract_superseded"` を含む未知の reason、および `null`）: **同じ `supersededReason` の値ごとにまとめて返す。**
 *   ⛔ **1件ずつには分割しない。** 分割すると「1件ずつが別操作である」という*偽の構造*を呼び出し側に与える（「分からない」を「分かっている」に化けさせる）。
 *   `boundaryConfidence: "unknown"` を付けたうえで、まとめた配列をそのまま返す。
 *
 * 入力の順序は保持しない（`supersededReason` の初出順にグループを並べる）。空配列を渡すと空配列を返す。
 *
 * ⚠ この関数は渡された `supersededReason` をそのまま group key として使うだけで、`null` になった理由（最初から由来が記録されていなかったのか、
 * `MemoryStore.purgeExpiredEvents?`（ADR 0115）の保持期間の掃除で消えたのか）は問わない。掃除が走った後は、本来なら別々の
 * `"consolidated"`/`"contested_resolved"` だった候補も `null` に劣化してここへ渡され、同じ `"unknown"` グループへ合流しうる。
 * この場合の「分からない」は**掃除によって後天的に作られたもの**だが、判定材料が最初から無かった場合と地続きに扱われる。詳細は ADR 0258。
 */
export function groupSupersededCandidatesByOperation(
  candidates: ReadonlyArray<{ memoryId: MemoryId; supersededReason: string | null }>,
): SupersededOperationGroup[] {
  const groups: SupersededOperationGroup[] = [];
  const byReason = new Map<string | null, SupersededOperationGroup>();

  for (const candidate of candidates) {
    const { memoryId, supersededReason } = candidate;

    if (supersededReason === "contested_resolved") {
      groups.push({
        supersededReason,
        memoryIds: [memoryId],
        boundaryConfidence: "per_item",
      });
      continue;
    }

    const confidence: SupersededOperationGroup["boundaryConfidence"] =
      supersededReason === "consolidated" ? "structural" : "unknown";

    const existing = byReason.get(supersededReason);
    if (existing !== undefined) {
      existing.memoryIds.push(memoryId);
      continue;
    }
    const group: SupersededOperationGroup = {
      supersededReason,
      memoryIds: [memoryId],
      boundaryConfidence: confidence,
    };
    byReason.set(supersededReason, group);
    groups.push(group);
  }

  return groups;
}

/** `runtime.restoreSuperseded` の任意オプション。 */
export interface RestoreSupersededOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。
   *
   * ⚠ **省略時の規律が `RestoreArchivedOptions.reason`/`ForgetOptions.reason` とは違う。** あちらは省略すると `meta` に `reason` キー自体を持たせないが、
   * こちらは省略すると固定タグ `"unsuperseded"` が入る（`MemoryStore.restoreSupersededBy` の契約節、`meta` の doc 参照）。
   * この操作は群単位（複数の Memory にまたがる）で、`meta.supersededById`（外した相手の id）と組み合わせて監査ログから「どの群が、なぜ戻ったか」を引けるようにするには、
   * `reason` キー自体が常に存在するほうが検索・集計しやすい。
   */
  reason?: string | undefined;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * 🔴 **下見。** `true` のとき、一切の書き込み（`memories` の `UPDATE`・`memory_events` への `INSERT`・`reinforce`）を行わず、
   * 「実際に呼べば何が戻るか」だけを {@link RestoreSupersededOutcome} の `"would_restore"` として返す。省略時 `false`。
   * 選ぶ内容は `MemoryStore.previewRestoreSupersededBy?` が `restoreSupersededBy?` と同じ `WHERE` で選ぶ。前者が無い adapter では `supported: false`。
   */
  dryRun?: boolean | undefined;
}

/**
 * `runtime.restoreSuperseded` が対象1件ごとに返す結果。
 *
 * `RestoreArchivedOutcome` と違い、`"not_found"`/`"status_not_archived"`/`"conflicted"`/`"not_attempted"` を持たない。このメソッドは個別 id への
 * compare-and-swap ではなく、`MemoryStore.restoreSupersededBy` が1トランザクションで選んで戻した行の集合をそのまま返す。`status = 'superseded'` を条件に含めた
 * `WHERE` 句が選定そのものを兼ねるため、「対象ではあったが状態が違った」という分岐が発生しない（一致しない行は最初から選ばれていない）。
 *
 * - `"restored"`: `status` を `"superseded"` から `"active"` へ動かし、`superseded_by_id` を `null` にし、`memory_events` に `kind: "unsuperseded"` を1件積んだ。
 *   続けて試みた `MemoryStore.reinforce` が失敗した場合だけ `reinforceError` が入る（`RestoreArchivedOutcome.reinforceError` と同じ規律。
 *   status の復帰そのものは reinforce の成否と無関係に確定している）。`decayFloorAt` は、この呼び出しが最後に観測した値
 *   （reinforce が成功していればその結果、失敗していれば復帰直後の値）。
 * - `"would_restore"`: `opts.dryRun: true` のとき、`status = 'superseded'` かつ `superseded_by_id` が対象と一致する行について、実際に呼べば `"restored"` に
 *   なったはずであることを示す。**書き込みは一切起きていない**（`reinforce` も呼ばない）。`supersededReason` は `MemoryStore.previewRestoreSupersededBy?` の doc を参照。
 *   「なぜその群に入っているか」を運ぶが、`memory_events` に一致する行が無ければ `null`（**取れないことを `null` で正直に返す。取れるふりをしない**）。
 * - `"failed"`: 🔴 **現在の実装では到達しない防御的な分類**（`PurgeOutcome.conflicted` と同じ立場）。`restoreSupersededBy` の1トランザクションが成功したあと、
 *   個々の Memory について `Runtime` が行うのは `reinforce` の呼び出しだけで、その失敗は必ず `reinforceError` に運ぶ（`"failed"` には落ちない）。
 *   将来 store 側が行ごとの部分失敗を報告するようになったときのための予約であり、今日のコードパスからは一度も生成されない。
 */
export type RestoreSupersededOutcome =
  | {
      memoryId: MemoryId;
      kind: "restored";
      previousStatus: "superseded";
      decayFloorAt: Date;
      /** 失敗の説明。`"failed"` の `error` と同じ整形（ADR 0363）。 */
      reinforceError?: string;
    }
  | {
      memoryId: MemoryId;
      kind: "would_restore";
      previousStatus: "superseded";
      supersededReason: string | null;
    }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363）: drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、
       * `cause` の連鎖と SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    };

/** `runtime.restoreSuperseded` の結果。⛔ `restoredCount` のような派生値を持たない（`RestoreArchivedResult`/`ForgetResult` と同じ理由）。 */
export interface RestoreSupersededResult {
  /**
   * `opts.dryRun` の有無で、見ている口が違う。**`dryRun` 省略・`false`**: `MemoryStore.restoreSupersededBy?` が実装されていたか。
   * **`dryRun: true`**: `MemoryStore.previewRestoreSupersededBy?` が実装されていたか（2つの口は独立した任意メソッドで、片方だけを実装した adapter があり得る）。
   * どちらの場合も `false` のとき `outcomes` は常に空配列（`SweepArchiveResult.supported` と同じ規律。「対応していないので0件」であって
   * 「対応していて0件だった」ではない。呼び出し側はこの2つを取り違えないよう、必ず `supported` を先に見ること）。
   */
  supported: boolean;
  /**
   * 置き換えた側（新しいほう）の id（`target.supersededById` をそのまま運ぶ）。
   *
   * 🔴 **この操作は、この id が指す Memory に一切触れない**（消さない・`forget` しない・`status` を変えない）。呼び出し側がそれを見落とさないよう、返り値自身にも運ぶ。
   * `recall()` は戻した直後、古いほう（`outcomes` に載る Memory）も新しいほう（この `supersedingMemoryId`）も両方 `active` として返しうる。
   * 始末したいなら、呼び出し側が `forget(ctx, supersedingMemoryId)` を別途呼ぶ、あるいは `markContested` で対にすること。
   * この分岐をこのメソッドの `opts` には足さない（`Runtime.restoreSuperseded` の doc「やらないこと」参照）。
   */
  supersedingMemoryId: MemoryId;
  /**
   * `MemoryStore.restoreSupersededBy` が返した `restored` の順序をそのまま引き継ぐ（順序の契約は store 側に委ねる）。
   * `RestoreArchivedResult.outcomes` のような「入力と同じ順序」という契約は無い（入力が id の配列ではなく単一の群指定子であるため）。
   */
  outcomes: RestoreSupersededOutcome[];
}

/** `runtime.purge` の対象（ADR 0124）。`ForgetTarget`/`RestoreArchivedTarget` と意図的に同じ形。 */
export type PurgeTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.purge` の任意オプション（ADR 0124）。`ForgetOptions`/`RestoreArchivedOptions` と同じ形に `dryRun` を足す。 */
export interface PurgeOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string | undefined;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * 🔴 **下見。** `true` のとき、一切の書き込み（`content`/`digest`/`purgedAt` の更新、`memory_events` への追記、`VectorStore.deleteAcrossSpaces`）を行わず、
   * 「実行していたら何が起きたか」だけを {@link PurgeOutcome} の `"would_purge"`/`"already_purged"`/`"status_not_forgotten"`/`"not_found"` として返す。
   * **`already_purged` のときも `dryRun: true` では `VectorStore.deleteAcrossSpaces` を呼ばない**（ADR 0382）。`dryRun` は「何も書かない」ことが約束なので、
   * `already_purged` が既に書き込み0件を意味していても、ベストエフォートの副作用（embedding の削除）も止める。省略時 `false`。
   */
  dryRun?: boolean | undefined;
}

/**
 * `"purged"` / `"already_purged"` の後始末（`VectorStore.deleteAcrossSpaces`）が失敗したことの知らせ（ADR 0399）。
 *
 * **失敗したときだけ付く。成功したときはプロパティ自体が無い。** `kind` は変わらない（MemoryStore 側の書き込みは確定している）。
 * `error` は例外の整形（`"failed"` outcome の `error` と同じ。ADR 0363）。`status` は将来の値のための判別子。
 */
export type PurgeEmbeddingCleanup = { status: "failed"; error: string };

function embeddingCleanupFailed(error: unknown): PurgeEmbeddingCleanup {
  return { status: "failed", error: describeFailure(error) };
}

/**
 * `"already_purged"` の後始末（`MemoryStore.scrubPurged`。v1.1.0 より前に purge した行の `tags`・`attributes`・claim key・label の紐付けの掃除と、
 * `recalls.index_band` の目次帯に残った digest を伏せること。ADR 0437、ADR 0512）が失敗したことの知らせ。
 * {@link PurgeEmbeddingCleanup} と同じ形・同じ規律（失敗したときだけ付く。`kind` は変わらない）。
 */
export type PurgeResidueCleanup = { status: "failed"; error: string };

function residueCleanupFailed(error: unknown): PurgeResidueCleanup {
  return { status: "failed", error: describeFailure(error) };
}

/**
 * `runtime.purge` が対象1件ごとに返す結果（ADR 0124）。`ForgetOutcome`/`RestoreArchivedOutcome` と同じ「無い」の分類（ADR 0008）に、`purge` 固有の `"would_purge"`/`"already_purged"` を足す。
 *
 * - `"purged"`: `content`/`digest` をトゥームストーンで上書きし、`purgedAt` を設定し、`kind: 'purged'` を積んだ。`VectorStore.deleteAcrossSpaces` はベストエフォートで、失敗しても kind は変わらず、
 *   **失敗したときだけ** `embeddingCleanup`（{@link PurgeEmbeddingCleanup}。ADR 0399）が付く。`previousStatus` は常に `"forgotten"`。
 * - `"would_purge"`: `opts.dryRun: true` で、対象が `forgotten` かつ未 purge なので、`dryRun: false` なら `"purged"` になったはず。**書き込みは一切起きていない。**
 * - `"already_purged"`: 既に purge 済み（`purgedAt` が非 `null`）。**`MemoryStore` への書き込みは起きない**（下の `scrubPurged` を除く）。`dryRun` の有無に関わらず同じ kind。`dryRun` が `false` なら、
 *   `deleteAcrossSpaces`（ADR 0382。埋め込みモデルを移した後の再実行で旧 space の埋め込みを消す）と `MemoryStore.scrubPurged`（任意メソッド。v1.1.0 より前の `purge` が残した `tags`・`attributes`・claim key・label の紐付けと、
 *   `recalls.index_band` の目次帯の digest を伏せる。ADR 0437、ADR 0512）をベストエフォートで試み、失敗したときだけ `embeddingCleanup`/`residueCleanup` が付く。`dryRun: true` では呼ばない。
 * - `"status_not_forgotten"`: `status` が `"forgotten"` ではなかった（`purge` は `forgotten` からのみ遷移できる）。`status` に現在値。**書き込みは一切起きていない。**
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い。
 * - `"conflicted"`: compare-and-swap が破れ、1回だけ再読しても上の3分岐のどれにも分類できなかった。`forgotten` から抜け出す経路も `purge` 以外に `purgedAt` を書く経路も無いので、**現在の実装では到達しない防御的な分類**。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になった、または `MemoryStore.purgeMemory` が無い（`PurgeResult.supported: false`）ため、まだ見ていない。
 */
export type PurgeOutcome =
  | {
      memoryId: MemoryId;
      kind: "purged";
      previousStatus: "forgotten";
      embeddingCleanup?: PurgeEmbeddingCleanup;
    }
  | { memoryId: MemoryId; kind: "would_purge"; previousStatus: "forgotten" }
  | {
      memoryId: MemoryId;
      kind: "already_purged";
      embeddingCleanup?: PurgeEmbeddingCleanup;
      residueCleanup?: PurgeResidueCleanup;
    }
  | { memoryId: MemoryId; kind: "status_not_forgotten"; status: Exclude<MemoryStatus, "forgotten"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363）: drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、
       * `cause` の連鎖と SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/** `runtime.purge` の結果（ADR 0124）。⛔ `purgedCount` のような派生値を持たない（`ForgetResult`/`RestoreArchivedResult` と同じ理由）。 */
export interface PurgeResult {
  /**
   * `MemoryStore.purgeMemory` が実装されていたか。**`false` のとき `outcomes` は全要素が `"not_attempted"`**
   * （`opts.dryRun` の有無に関わらず。`SweepArchiveResult.supported`（ADR 0114）と同じ「無い」の扱い）。
   */
  supported: boolean;
  /**
   * 入力（`PurgeTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: PurgeOutcome[];
}

/**
 * `runtime.markContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性（ADR 0134）。
 * 新しい語彙を作らず、`ForgetOutcome`/`ConsolidateSourceOutcome` が使っている `"not_found"`/`"status_not_active"`/`"eligible"` に揃える。
 *
 * - `"eligible"` — `status === "active"`。書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_active"` — 存在はするが `status !== "active"`（既に `contested`・`superseded`・`archived`・`forgotten` のいずれか）。
 */
export type MarkContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> };

/**
 * `runtime.markContested` 全体の結末（ADR 0134）。「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を
 * 1つの `false`/例外に潰さない（ADR 0008）。
 *
 * - `"contested"` — 両側を `status: 'contested'` へ動かし、`contestedWithId` を相互に設定した。**部分成功は無い。**
 *   `supersedeWithNewMemories` の `conflicted`（対象ごとに独立で部分成功を許す設計）とは違い、対向ペアは本質的に結合しているため、全部成功するか全部失敗するかのどちらかである。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で {@link MemoryStatusConflictError} が投げられた（TOCTOU）。
 *   1回だけ再読した現在の `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.markContestedPair` が実装されていない（`MarkContestedResult.supported: false`）。
 *   フォールバック経路は無い（`archiveDecayed`/`purgeMemory` と同じ理由。`contestedWithId` を書ける経路はこの口以外に無い）。
 */
export type MarkContestedOutcome =
  | { kind: "contested"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [MarkContestedSideOutcome, MarkContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/** `runtime.markContested` の任意オプション（ADR 0134）。`ConsolidateOptions`/`ForgetOptions` と同じ形。 */
export interface MarkContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested'` であり、この欄では上書きしない。
   * `consolidate`/`reflect` の `opts.reason` → `meta.note` と同じ形）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string | undefined;
}

/** `runtime.markContested` の結果（ADR 0134）。 */
export interface MarkContestedResult {
  /** `MemoryStore.markContestedPair` が実装されていたか。**`false` のとき `outcome` は必ず `{ kind: "not_attempted" }`**（`PurgeResult.supported` と同じ「無い」の扱い）。 */
  supported: boolean;
  /** どう終わったか（{@link MarkContestedOutcome}）。 */
  outcome: MarkContestedOutcome;
}

/**
 * `runtime.resolveContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性（ADR 0150）。
 * `MarkContestedSideOutcome` が持つ `"not_found"`/`"eligible"` はそのまま使い、この操作固有に足すのは2つだけである。
 *
 * - `"eligible"` — `status === "contested"` かつ、相手の `contestedWithId` が互いを指している
 *   （`first.contestedWithId === second.id` かつ `second.contestedWithId === first.id`）。書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。`status` に現在値が入る。
 * - `"pair_broken"` — `status === "contested"` ではあるが、相互参照が成立していない（`contestedWithId` が相手を指していない、または `null`）。
 *   [ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md) が数え上げた「一対一が破れた状態」の読み取り側の反映であり、
 *   `markContestedPair`（ADR 0134）を経由する限り到達しないはずだが、`PurgeOutcome` の `"conflicted"` と同じ「防御的な分類」として残す。
 *   `contestedWithId` に観測した現在値（`null` を含む）が入る。
 */
export type ResolveContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_contested"; status: Exclude<MemoryStatus, "contested"> }
  | { memoryId: MemoryId; kind: "pair_broken"; contestedWithId: MemoryId | null };

/**
 * `runtime.resolveContested` に「どちらが正しいか」を渡すための判別可能 union（ADR 0150）。この型自身は何も判定せず、
 * 呼び出し側が既に下した決定を運ぶだけである。
 *
 * - `"supersede"` — `winnerId` 側が勝ち残る。勝った側は `status: "active"`、負けた側は `status: "superseded"` + `supersededById: <勝者>` になる。
 * - `"both_active"` — どちらも正しかった（対向ではなかったと分かった）。両側とも `status: "active"` に戻る。
 *   `docs/memory-model.md` §11 lifecycle 行7の「（負けた側は）」という括弧書きが、負けた側が存在しない決着を許している。
 */
export type ContestedResolution =
  { kind: "supersede"; winnerId: MemoryId } | { kind: "both_active" };

/**
 * `runtime.resolveContested` 全体の結末（ADR 0150）。`MarkContestedOutcome` と対称で、「対象が適格でなかった」「書き込み時点で競合した」
 * 「対応していない」を1つの `false`/例外に潰さない（ADR 0008）。
 *
 * - `"resolved"` — 両側を解決後の状態へ動かした。**部分成功は無い**（対向ペアは本質的に結合しているため。`MarkContestedOutcome` の `"contested"` と同じ）。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で {@link MemoryStatusConflictError} が投げられた（TOCTOU）。
 *   `markContested` と同じく**1回だけ**再読した現在の `status` を `conflicts` に積み、そこで打ち切る（上限の無い再試行ループにしない）。
 * - `"not_attempted"` — `MemoryStore.resolveContestedPair` が実装されていない（`ResolveContestedResult.supported: false`）。
 *   フォールバック経路は無い（`contestedWithId` を `null` へ戻せる口はこの口以外に無い。`resolveContestedPair` の interface JSDoc 参照）。
 */
export type ResolveContestedOutcome =
  | { kind: "resolved"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [ResolveContestedSideOutcome, ResolveContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/** `runtime.resolveContested` の任意オプション（ADR 0150）。`MarkContestedOptions` と同じ形。 */
export interface ResolveContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested_resolved'` であり、この欄では上書きしない。
   * `markContested`/`consolidate`/`reflect` の `opts.reason` → `meta.note` と同じ形）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string | undefined;
}

/** `runtime.resolveContested` の結果（ADR 0150）。 */
export interface ResolveContestedResult {
  /** `MemoryStore.resolveContestedPair` が実装されていたか。**`false` のとき `outcome` は必ず `{ kind: "not_attempted" }`**（`MarkContestedResult.supported` と同じ「無い」の扱い）。 */
  supported: boolean;
  /** どう終わったか（{@link ResolveContestedOutcome}）。 */
  outcome: ResolveContestedOutcome;
}

/**
 * `runtime.resolveOrphanedContested` が生存側1件を分類する適格性（ADR 0150）。
 * `ResolveContestedSideOutcome` と同じ「無いを分類して返す」流儀に倣うが、この口は対の**もう一方**を分類しない（対向はもう `contested` ではない前提の口だから）。
 *
 * - `"eligible"` — `status === "contested"` かつ `contestedWithId` が非 null で、その id の Memory が `"forgotten"` であるか、そもそも見つからない（purge 済み等）。
 * - `"not_found"` — そのテナントに `survivorId` の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。
 * - `"no_contested_with_id"` — `status === "contested"` だが `contestedWithId` が `null`（片側だけの `contested`）。**この口はそれを直さない**。対象外として ineligible で返す。
 * - `"opposite_not_orphaned"` — `contestedWithId` の指す Memory が見つかったが、`status` が `"forgotten"` ではない（`active`/`contested`/`superseded`/`archived` のいずれか）。
 *   まだ `resolveContestedPair` で正規に解決できる可能性がある対象を、この口が代わりに割り込んで処理しないためのガード。
 *   実装は `"forgotten"` かどうかだけを見るので、対向が `archived` のときもこの値になる（`oppositeStatus: "archived"`。`Runtime` の口には
 *   `contested` な記憶を `archived` にするものは無い（`sweepArchive` が掃くのは `active` だけ）が、`MemoryStore.updateStatus` を直接呼べば作れる）。
 */
export type ResolveOrphanedContestedEligibility =
  | { kind: "eligible"; contestedWithId: MemoryId }
  | { kind: "not_found" }
  | { kind: "status_not_contested"; status: Exclude<MemoryStatus, "contested"> }
  | { kind: "no_contested_with_id" }
  | { kind: "opposite_not_orphaned"; contestedWithId: MemoryId; oppositeStatus: MemoryStatus };

/**
 * `runtime.resolveOrphanedContested` 全体の結末（ADR 0150）。`ResolveContestedOutcome` と対称の語彙を使う。
 *
 * - `"resolved"` — 生存側を `status: "active"`・`contestedWithId: null` へ動かした。
 * - `"ineligible"` — 読んだ時点で `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では `"eligible"` だったが、書き込み時点で {@link MemoryStatusConflictError} が投げられた（TOCTOU）。
 *   `resolveContested` と同じく**1回だけ**再読して打ち切る（上限の無い再試行ループにしない）。
 * - `"not_attempted"` — `MemoryStore.resolveOrphanedContested` が実装されていない（`ResolveOrphanedContestedResult.supported: false`）。フォールバック経路は無い。
 */
export type ResolveOrphanedContestedOutcome =
  | { kind: "resolved"; memory: Memory }
  | { kind: "ineligible"; eligibility: ResolveOrphanedContestedEligibility }
  | { kind: "conflict"; observedStatus: MemoryStatus | null }
  | { kind: "not_attempted" };

/** `runtime.resolveOrphanedContested` の任意オプション（ADR 0150）。`ResolveContestedOptions` と同じ形。 */
export interface ResolveOrphanedContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値
   * `'contested_resolved'` であり、この欄では上書きしない）。省略時は `meta` に `note`
   * キー自体を持たせない。
   */
  reason?: string | undefined;
}

/** `runtime.resolveOrphanedContested` の結果（ADR 0150）。 */
export interface ResolveOrphanedContestedResult {
  /** `MemoryStore.resolveOrphanedContested` が実装されていたか。**`false` のとき `outcome` は必ず `{ kind: "not_attempted" }`。** */
  supported: boolean;
  /** どう終わったか（{@link ResolveOrphanedContestedOutcome}）。 */
  outcome: ResolveOrphanedContestedOutcome;
}

/**
 * `runtime.markContestedGroup` がメンバー1件を分類する適格性（ADR 0327、ADR 0378、ADR 0381）。`MarkContestedSideOutcome`（2者版）と同じ「無いを分類して返す」流儀だが、
 * `MemoryStore.markContestedGroup` の CAS が `active`/`contested`（穴A の相方吸収）/`contested`（既存群の合併吸収）の3通りを許すぶん、分類も3者版になる
 * （`MemoryStore.markContestedGroup` JSDoc の契約と1対1対応）。
 *
 * - `"eligible"` — 次のいずれか: (1) `status === 'active'`。(2) `status === 'contested'` かつ `contestedWithId` が渡された `members` の**他の**誰かの id と一致する（穴Aの吸収）。
 *   (3) `status === 'contested'` かつ `contestedWithId === null`（既存群の合併吸収。実際にその群と `members` がつながっているかは、`Runtime` 側で
 *   `detectClaimKeyContested`/呼び出し側が `RelationStore.listRelated` を使って確かめる前提であり、この分類自体は行レベルの形だけを見る）。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_conflict"` — 上の3通りのいずれにも当てはまらない（`contested` だが `contestedWithId` が `members` の外を指す、または `superseded`/`archived`/`forgotten`）。
 *   `status`・観測した `contestedWithId` を積む。
 */
export type MarkContestedGroupSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | {
      memoryId: MemoryId;
      kind: "status_conflict";
      status: MemoryStatus;
      contestedWithId: MemoryId | null;
    };

/**
 * `runtime.markContestedGroup` 全体の結末（ADR 0327、ADR 0378、ADR 0381）。`MarkContestedOutcome`（2者版）と対称の語彙で、
 * 「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を1つの `false`/例外に潰さない。
 *
 * - `"contested_group"` — 全メンバーを `status: 'contested'`・`contestedWithId: null` へ動かし、有効期間が重なる組に `memory_relations` を張った。**部分成功は無い。**
 * - `"ineligible"` — `getMany` で読んだ時点で、1件以上が `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では全員 `"eligible"` だったが、書き込み時点で {@link MemoryStatusConflictError} が投げられた（TOCTOU）。
 *   1回だけ再読した現在の `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.markContestedGroup` が実装されていない（`MarkContestedGroupResult.supported: false`）。フォールバック経路は無い。
 */
export type MarkContestedGroupOutcome =
  | { kind: "contested_group"; members: Memory[] }
  | { kind: "ineligible"; sides: MarkContestedGroupSideOutcome[] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/** `runtime.markContestedGroup` の任意オプション（ADR 0381）。`MarkContestedOptions`（2者版）と同じ形。 */
export interface MarkContestedGroupOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested'` であり、この欄では上書きしない。
   * `markContested` の `opts.reason` → `meta.note` と同じ形）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string | undefined;
}

/** `runtime.markContestedGroup` の結果（ADR 0381）。 */
export interface MarkContestedGroupResult {
  /** `MemoryStore.markContestedGroup` が実装されていたか。**`false` のとき `outcome` は必ず `{ kind: "not_attempted" }`。** */
  supported: boolean;
  /** どう終わったか（{@link MarkContestedGroupOutcome}）。 */
  outcome: MarkContestedGroupOutcome;
}

/**
 * `runtime.resolveContestedGroup` がメンバー1件を分類する適格性（ADR 0327、ADR 0378、ADR 0381）。`ResolveContestedSideOutcome`（2者版）と違い、
 * 群のメンバーは `contestedWithId` を持たない設計（`markContestedGroup` 契約）なので、`"pair_broken"` に相当する分類は無い。`status` だけを見る。
 *
 * - `"eligible"` — `status === "contested"`。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。
 */
export type ResolveContestedGroupSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | {
      memoryId: MemoryId;
      kind: "status_not_contested";
      status: Exclude<MemoryStatus, "contested">;
    };

/**
 * `runtime.resolveContestedGroup` 全体の結末（ADR 0381）。`ResolveContestedOutcome`（2者版）と対称の語彙。
 *
 * - `"resolved"` — 全メンバーを `resolution` に従って `active`/`superseded` へ動かし、このメンバー間の `memory_relations` を双方向とも削除した。
 * - `"ineligible"` — 読んだ時点で、1件以上が `"eligible"` でなかった。`members` が `memory_relations` でつながった「今も `contested` な」群の一部しか
 *   渡されていなかった場合も含む。この場合は、`sides` に含めきれない欠けたメンバーの id を `missingMembers` に積む（`sides` は渡された `members` だけを分類するため、
 *   渡されなかった欠けたメンバーは `sides` に現れない）。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では全員 `"eligible"` だったが、書き込み時点で {@link MemoryStatusConflictError} が投げられた（TOCTOU、または store 側の全体一致 CAS 違反）。
 *   1回だけ再読した現在の `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.resolveContestedGroup` が実装されていない。
 */
export type ResolveContestedGroupOutcome =
  | { kind: "resolved"; members: Memory[] }
  | {
      kind: "ineligible";
      sides: ResolveContestedGroupSideOutcome[];
      missingMembers: MemoryId[];
    }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.resolveContestedGroup` に「どちらが正しいか」を渡すための判別可能 union（ADR 0378、ADR 0381）。`ContestedResolution`（2者版）と完全に同じ形で、
 * 新しい決着の種類は増やさない。`"supersede"` の `winnerId` は `members` のうちのちょうど1件を指す。
 */
export type ContestedGroupResolution = ContestedResolution;

/** `runtime.resolveContestedGroup` の任意オプション（ADR 0381）。`ResolveContestedOptions`（2者版）と同じ形。 */
export interface ResolveContestedGroupOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor | undefined;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested_resolved'` であり、この欄では上書きしない）。
   * 省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string | undefined;
}

/** `runtime.resolveContestedGroup` の結果（ADR 0381）。 */
export interface ResolveContestedGroupResult {
  /** `MemoryStore.resolveContestedGroup` が実装されていたか。**`false` のとき `outcome` は必ず `{ kind: "not_attempted" }`。** */
  supported: boolean;
  /** どう終わったか（{@link ResolveContestedGroupOutcome}）。 */
  outcome: ResolveContestedGroupOutcome;
}

/**
 * `createRuntime()` が返す runtime。中核の5動詞（`observe`・`recall`・`reflect`・`consolidate`・`forget`）と、保守・是正・説明の口を持つ。
 * どのメソッドも第一引数に `ctx`（`tenantId` 必須）を取る。一覧と分類は README の「外から見える API」を見ること。
 */
export interface Runtime {
  /**
   * 層: 中核
   * Observation を記録し、`extract: 'sync'`（既定）ならその場で LLM 抽出して Memory を書く。
   *
   * 冪等キー（`externalId`）は、その Observation から生まれた Memory のその後を問わない。`forget()`・`purge()` した Memory の元と同じ `externalId` で呼び直しても、抽出はやり直さず
   * `{ memoryIds: [], extraction: 'skipped', extractionFailure: null }` を返す（`sync`/`deferred` とも）。やり直すと、`purge()` で消した内容が再送だけで蘇りうるため。
   * 再送の内訳（その Observation から作られた記憶の `status` と `purged`）は `ObserveResult.resend`（ADR 0639）で読む。
   *
   * 投げる例外:
   * - `input` が `ObserveInputSchema` に合わなければ `ZodError`（何も書く前）。`utterance.text`・`event.name`・`document.content` は、空文字に加えて `trim` で空になる値も断る（ADR 0502。U+200B は通る）。
   * - `extract: "deferred"` と、空でない `subjectCandidates` または `claimKey` の同時指定は、{@link SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX} /
   *   {@link CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX} で始まる `Error`（何も書く前）。
   * - LLM の呼び出しの失敗は投げず、全文フォールバックへ倒して `extractionFailure` に載せる（docs/memory-model.md §4）。
   * - store の例外はそのまま伝わる。ただし LLM の抽出結果に保存できない値が混じると、その候補だけを落として残りを書き、投げない
   *   （[ADR 0347](../../../docs/decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）。落とした候補は `created` イベントの `meta.droppedCandidates` に残り、戻り値には出ない。
   *   全件が落ちたら最初の例外を投げ、何も書かない（全文フォールバックの Memory も作られない）。NUL は `@mnemora/postgres` も testkit の fixture も拒む。孤立サロゲートを含む `text` などは、
   *   `@mnemora/postgres` では Observation を書く前に例外になり、testkit / core の Fake では通る（`MemoryStore.createObservation` の doc）。
   *
   * 第3引数 `opts?: AbortOptions`（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。`signal` は `sync` で LLM を呼ぶ間だけ効く。Observation と `extract` ジョブは LLM の前に書かれている。
   * abort されると、全文フォールバックへ倒さず（中断と LLM の失敗を同じ顔にしない）reject し（`signal.reason`。無ければ `AbortError` 相当）、Memory は書かれない。`extract` ジョブは `complete()` されず、
   * observe の claim（`claimed_by: "runtime.observe:sync"`。[ADR 0407](../../../docs/decisions/0407-sync-observe-extract-job-lease.md)）のまま残るので、`tick()` はリースが切れるまで拾わず、
   * 切れた後に取り直して処理する。その間の同じ `externalId` の再送は抽出をやり直さず、この呼び出しにだけ渡した `subjectCandidates`・`claimKey` は永続化されないので、後の `tick()` からの再抽出には届かない。
   * `deferred` と `memory_usage` は LLM を呼ばないので `signal` は効かない。
   */
  observe(ctx: Ctx, input: ObserveInput, opts?: AbortOptions): Promise<ObserveResult>;
  /**
   * 層: 保守操作
   * outbox に溜まったジョブを消化する（docs/architecture.md §3.3）。`extract: 'deferred'` かつ `InlineScheduler`（キュー無し）構成では、これを誰かが呼ばない限り抽出・埋め込みは永久に走らない。
   *
   * `opts.leaseMs` は必須（ADR 0032）で、`packages/core` は既定値を決めない。省略や `opts` が object でないときは、claim する前に `TypeError`・`RangeError` で断る（ADR 0496。{@link TickOptions.leaseMs}）。
   *
   * 🔴 **処理する kind は {@link TICK_SUPPORTED_JOB_KINDS} が唯一の出所。** それに無い kind を `opts.kinds` に明示すると、そのジョブは claim され、**終端で失敗し**（`fail()`。自動リトライは無い）、
   * {@link TickResult.unsupported} に名指しで出る（黙って lease 切れを待たない）。`OutboxJobKind` に名前が在ることと `tick` が処理することは別（その型の JSDoc も参照）。
   */
  tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
  /**
   * 層: 中核
   * docs/recall.md §2 の7段パイプライン（実装は `./recall-runtime.js` の `runRecall`）。
   *
   * 投げる例外:
   * - `query` が `RecallQuerySchema` に合わなければ `ZodError`（store を読む前・書く前）。
   * - `channels` に `"lexical"` が在るのに `RuntimeDeps.lexicalStore` が無ければ、`LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`（`recall.ts`）で始まる `Error`（ADR 0084）。
   * - `RuntimeDeps.outputValidation` が `"throw"` のときだけ、結果が検証に落ちると `RecallOutputValidationError`（ADR 0098。既定の `"report"` では投げない）。この検証は recall の記録（`recallId`）を書いた後に走る。
   * - store の例外はそのまま伝わる。`consolidate` / `reflect` の `{ query }` 形と `findCorrectionCandidates` は内部で `recall()` を呼ぶので、同じ例外が届く。
   *
   * 第3引数 `opts?: AbortOptions`（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。`signal` はクエリの埋め込みを待つ間だけ効く。abort されると reject し
   * （`signal.reason`。無ければ `AbortError` 相当）、`embedding_provider_unavailable` の omission には倒さない。段6（記録）は埋め込みより後にしか走らないため、abort の時点では recall の記録も `activity_seq` の前進も無い。
   */
  recall(ctx: Ctx, query: RecallQuery, opts?: AbortOptions): Promise<RecallResult>;
  /**
   * 層: 説明
   * `recall()` が返した `RecallId` から、その recall が何を・どの内訳で返したかを**後から**読み戻す（[ADR 0161](../../../docs/decisions/0161-runtime-get-recall.md)）。
   * 見つからない `recallId`、または別テナントの recall なら `null`（例外にしない）。引数と返り値は {@link RecallId} / {@link RecallRecord} をそのまま使う
   * （`MemoryStore.getRecall` への素通しで、同じ形の型を2つ置くと黙ってずれる）。
   *
   * 🔴 **`RecallRecord.returnedMemories` は `memoryId`/`score`/`retrievedVia`/`companionOf`/`associationOf` までしか運ばず、`digest` には届かない**
   * （`recall()` の `RecalledMemory` との非対称。`digest` は `MemoryStore.get()` で再現できるので `recalls` へ複製しなかった。ADR 0155）。`Runtime` には記憶を1件読む口が無いので、
   * `digest` まで要る採用側は `MemoryStore` を自前で保持する。
   */
  getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
  /**
   * 層: 未分類
   * 採用側が「これは訂正だ」と宣言したとき、既存の recall で相手の候補を探して返す（[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）。
   *
   * 🔴 **機械が相手を選んで `supersede` する形は採らない**（測定で、訂正してはいけない8ケース中6ケースで失効させてはいけない事実を1位に置き、閾値では分離できなかった）。**候補を返すところまで**で、
   * 確定と書き込みは採用側が `markContested`/`resolveContested`/`reextract` 等を明示的に呼ぶ。LLM は呼ばず、`recall(ctx, { text: input.text })` を1回だけ呼び（`text` 以外は `recall()` の既定）、
   * この口専用の閾値は置かない。`tick()`/`observe()` からは呼ばれない。
   * 記憶と監査ログへの確定の書き込みはしないが、中の `recall()` が recall の記録を1件書き、`decay_clock` が `'wall'` 以外のテナントでは `activity_seq` を1進める（ADR 0165）ので、
   * 活動時計のテナントでは探すたびに記憶が1回ぶん沈む。
   *
   * `CorrectionCandidate.recallRank` は `excludeMemoryIds` で除外した後に詰め直さず、`recall()` の並びでの1始まりの順位を運ぶ（自己除外で1位を落としても次は「2」）。
   * `outcome` に「探していない」は無く、「見つからなかった」は `no_candidates` と `omitted` で説明される（ADR 0008）。`limit` 件（既定 {@link DEFAULT_CORRECTION_CANDIDATE_LIMIT}）に切る。
   *
   * 投げる例外（`recall()` も書き込みも試みる前。ADR 0496）: `input.limit` が指定されていて整数でない・`1` 未満は `RangeError`。`input.text` が文字列でない、`input.excludeMemoryIds` が配列でない
   * （裸の文字列を含む）か文字列でない要素を含む場合は `TypeError`（呼び出し側の取り違えを黙って直さない）。`""` は `recall()` の検証で例外になる。
   *
   * 第3引数 `opts?: AbortOptions`（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）は内部の `recall()` へそのまま渡り、`recall()` と同じくクエリの埋め込みを待つ間だけ効く。
   */
  findCorrectionCandidates(
    ctx: Ctx,
    input: FindCorrectionCandidatesInput,
    opts?: AbortOptions,
  ): Promise<FindCorrectionCandidatesResult>;
  /**
   * 層: 保守操作
   * 失敗した抽出をやり直す（ADR 0028）。指定した Observation にもう一度 `extractCandidates` を走らせ、成功したら、同じ `(sourceObservationId, extractorVersion)` を持つ既存の `active` Memory のうち
   * 今回作られなかったもの（content_hash が今回の集合に無いもの）を `superseded` にする。置き換えた側は `active` な行（非 `active` の既存行にぶつかる候補は選ばない。ADR 0454）。
   * 安全弁3つ（LLM がまた失敗したら何もしない・候補0件なら何もしない・compare-and-swap で競合を検知する）は {@link ReextractResult} の doc。
   *
   * 投げる例外: 抽出をやり直せない対象には、LLM も書き込みも試みる前に `Error`。Observation が見つからないとき（別テナントの id・形式の合わない id を含む）と、
   * 使用報告の Observation（`kind: "usage"`。抽出器を通らない。docs/memory-model.md §6）を渡したとき。
   *
   * ⚠ **`extractorVersion` は runtime インスタンスが生成時に固定した値で、`reextract()` の引数ではない。** supersede の判定は「今回の runtime の `extractorVersion` に一致する既存 Memory」しか見ない。
   * ⟹ `extractorVersion` を上げた別の runtime インスタンスで同じ Observation を reextract しても、旧い版の `active` Memory は supersede されず、新旧2件が `active` のまま `recall()` に出続ける。
   * **旧い版を退役させるのは運用側の責務**（`forget`/`consolidate` 等を個別に呼ぶ。[ADR 0028](../../../docs/decisions/0028-reextract-superseded-cleanup.md)）。
   *
   * 新しい Memory に引き継がれるもの: 有効期間・`occurredAt` は Observation から（`observe()` と同じ）。**`claimKey` は常に null**（`reextract` に `claimKey` の口が無く、鍵は保存もされない。ADR 0320、ADR 0324）ので、
   * `claimKey` 付きで observe した Memory を置き換えると、鍵は `superseded` の旧い Memory にだけ残り、矛盾検出の対象から外れる。`subjectCandidates` の口も無く、省略された候補は Observation の `subjectId` へ落ちる。
   * 既定では LLM が返した `subjectId` は捨てられる（`RuntimeConfig.acceptLlmSubjectIdWithoutCandidates: true` のときだけ検査されずに通る。ADR 0635）。
   *
   * ⚠ **利用者の意思で退けた記憶を持つ Observation では、抽出をやり直さない。** やり直すと、LLM の言い方しだいで、退けた事実が印の無い新しい `active` として戻るため（`observe()` の再送と同じ規律。ADR 0124）。
   * - 退けた記憶に数えるもの（同じ Observation の記憶のうち、版を問わず1件でも在れば。[ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）: `forgotten`（purge を含む）、
   *   `contested`、訂正の解決で負けた `superseded`（最新の `superseded` イベントの `meta.reason` が `"contested_resolved"`）。数えないもの: 機構（`reextract`・`consolidate`）で置き換えた `superseded`、`archived`、
   *   理由を読めない `superseded`（イベントが無い・保持期間の掃除で消えた）。やり直せなくなるほうが利用者に見えにくい失敗になるため。運用側が旧い版の記憶を forget すると、その Observation のほかの事実も、
   *   以後 reextract では新しい版の記憶として作られなくなる。
   * - やり直さないときは LLM を呼ばず何も書かない: `extraction: "skipped"`・`atomicity: "not_attempted"`・`memoryIds: []`・`supersededMemoryIds: []`・`extractionFailure: null`、`skipped` には退けた記憶ごとに `status_not_active`。
   * - LLM を待つ間に退けられた場合も、何も書かずに同じ形で打ち切る（[ADR 0406](../../../docs/decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)、
   *   [ADR 0544](../../../docs/decisions/0544-llm-wait-state-change-contested-skips-three-paths.md)）。LLM が返った直後に、LLM の前に読んだ記憶を読み直して同じ判定を当てる（`archived`・機構で置き換えた
   *   `superseded` は止めない）。`abortIfForgotten` を実装する adapter（`@mnemora/postgres`）は、書き込みと同一トランザクションでも `forgotten` を見直す（{@link SourceMemoryForgottenError}）。
   *   例外は投げず、`ReextractResult` に `aborted_source_forgotten` に当たる欄は無い。LLM は呼んでいる。実装しない adapter（testkit の `InMemoryMemoryStore`・core の fake）では、読み直しと書き込みの間の窓が残る。
   *
   * ⚠ **`archived` の記憶を持つ Observation を reextract したときの帰結**（[ADR 0432](../../../docs/decisions/0432-recall-status-recheck-and-archive-docs.md)）。`archived` は「退けた記憶」に数えないので、抽出は走る。
   * 抽出結果が今の記憶と同じ内容なら何も起きない（`memoryIds` は既存の記憶を指し、`archived` のまま、`skipped` にその記憶の `status_not_active`（`status: "archived"`））。reextract は `archived` を戻さない
   * （戻すには `restoreArchived`）。内容が違えば、新しい版が `active` で作られ、古い `archived` は `archived` のまま残る（その古い版を `restoreArchived` で戻すと、新旧2件が `active` で並ぶ）。
   *
   * 第3引数 `opts?: AbortOptions`（[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。`signal` は抽出の LLM 呼び出しを待つ間だけ効く。abort されると reject し
   * （`signal.reason`。無ければ `AbortError` 相当）、`extraction: "llm_failed_whole_observation"` には倒さない。LLM 呼び出しは supersede 対象を読む・書くより前なので、abort の時点では何も書かれていない。
   */
  reextract(ctx: Ctx, observationId: ObservationId, opts?: AbortOptions): Promise<ReextractResult>;
  /**
   * 層: 保守操作
   * 索引に載っていない Memory を**もう一度索引へ載せに行く**（ADR 0079）。`recall` は `omitted` に `{ kind: 'not_indexed', reason }` を積んで名乗り、docs/recall.md §4 が `reason` ごとの次の一手を案内している。
   * 埋め込みの provider が落ちていた間に入った Memory は、provider が直っても自力では索引へ戻らない（`fail` は終端で、Phase 1 に自動リトライは無い。ADR 0032）。この口はその案内どおりに動くための操作である。
   *
   * **このメソッド自身は埋め込まない。** `MemoryStore.requeueEmbedJobs` で `embed` ジョブを積み直すだけで、埋め込むのは次の `tick()`。**呼んだだけでは索引は埋まらない。** `reextract`（抽出のやり直し）とは別の操作。
   * 引数と返り値は {@link RequeueEmbedJobsOptions} / {@link RequeueEmbedJobsResult} をそのまま使う（store の同名メソッドへ素通しで、同じ形の型を2つ置くと黙ってずれる）。
   *
   * ⚠ 埋め込みの入力上限を超えて `failed` になった Memory は、この口だけでは戻らない（次の `tick()` が同じ `memory.content` を送って同じ理由で `failed` に戻る）。
   * {@link RuntimeDeps.embeddingInput}（ADR 0336）を渡した runtime でこの口を呼び、続けて `tick(ctx, { kinds: ['embed'], leaseMs })` を呼ぶ。
   * ⚠ 埋め込み空間を切り替えた後の、古い空間で `ready` の記憶は積み直せない（`statuses` は `pending`/`failed`/`skipped` だけを受け付け、`embeddingStatus` は空間を区別しない。Phase 1 は空間の切り替えを支えない。`docs/memory-model.md` §10）。
   *
   * 投げる例外: `limit` は入口で検査する（ADR 0433）。省略したとき（JavaScript・`as` 経由）と、数なのに 0 以上の整数でないとき（負・小数・`NaN`・±`Infinity`）は、store を呼ぶ前に `RangeError`
   * （`Runtime.reembed: limit must be a non-negative integer`）。`0` は例外にならず、何も積み直さない。
   */
  reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
  /**
   * 層: 保守操作
   * `docs/memory-model.md` §11 行8「`decay_floor_at < now()` を検出する低頻度の掃引 → `status='archived'` + `archived` イベント」を実行する（[ADR 0114](../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md)）。
   * `MemoryStore.archiveDecayed`（任意メソッド）へ素通しし、引数の型 {@link ArchiveDecayedOptions} を store 側と共有する（`reembed` と同じ）。
   *
   * ⭐ **`opts.clock` を省略した場合に限り、この口が `tenant_settings.decay_clock` を読んで補う**（[ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。`'wall'`（既定）なら
   * `decayFloorAt <= now`、`'activity'`/`'either'` なら `nowSeq`（`tenant_activity.activity_seq`）も読んで store へ渡す。**`opts.clock` を明示したときはそちらが勝ち、`decay_clock` は読まない。**
   * `activity`/`either` を明示して `opts.nowSeq` を省くと、`tenant_activity` は1回読む。読まないのは `clock: wall` を明示したときと、`clock` と `nowSeq` の両方を明示したときだけ。
   *
   * store が実装していなければ `{ supported: false, archived: [], reachedLimit: false }`（黙って0件を返さず「対応していない」と名指しする。ADR 0082）。`reextract`/`consolidate` と違いフォールバックは無い
   * （`decay_floor_at` を読んで `archived` にする経路はこの口だけ）。🔴 **自動では一度も走らない**: `tick()`/`observe()` から呼ばれず、`opts.now`/`opts.limit` にも既定値を置かない（`reembed` と同じ）。
   */
  sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult>;
  /**
   * 層: 是正・取り消し
   * `archived` な Memory を、呼び出し側が**明示的に**取り戻す（[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md)）。`sweepArchive` の逆向き（`archived` → `active`）。結果の意味は {@link RestoreArchivedOutcome}。
   *
   * `MemoryStore` に新しい任意メソッドは足していない（必須の `updateStatusWithEvent` の compare-and-swap で足りる）ので、`supported: false` は無い。`target` は `MemoryId[]` に正規化して入力順に処理し、
   * 空配列は store に触れず `{ outcomes: [] }`。在るかどうかは `getMany` の答えに従い、id は小文字にそろえて突き合わせる（`@mnemora/postgres` では大文字の UUID も在る記憶になる。
   * 大文字小文字だけが違う id を同じ呼び出しに混ぜたときは渡された綴りどおり）。競合は**1回だけ**再読して返し、再試行しない。競合以外の例外は `failed` を積んで打ち切り、残りを `not_attempted` で返す
   * （再読・ループ前の読みの失敗を含む）。例外は外へ投げない。
   *
   * ⚠ **`decay_floor_at` を動かす**（[ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）。`recall()` は既定で忘却ゲートを持ち、`sweepArchive` が `archived` にした行は定義上その条件を満たす
   * （テナントの `decay_clock` に従う。[ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）ので、`status` を戻しただけでは既定では recall に二度と現れない。そこで、復帰に成功した対象へ続けて
   * `MemoryStore.reinforce` を呼び、復帰の瞬間から引き直す。`reinforce` が失敗しても復帰は握り潰さず、`restored` のまま `reinforceError` に運ぶ。
   *
   * ⚠ **`sweepArchive` と重なると、`restored` と返っても `status` が `archived` のままのことがある**（ADR 0432。この版では直していない）。復帰と `reinforce` は別々の書き込みで、その間は `decay_floor_at` が
   * まだ過去を指す。その窓に同じ Memory を対象にした `sweepArchive` が入ると再び `archived` にされ、あとで `reinforce` が成功しても `decay_floor_at` だけが延びて `status` は `archived` のまま残る
   * （outcome は `restored` のまま、`memory_events` は `archived → restored → archived`）。確かめるなら、復帰のあとに `get` で今の `status` を読む。
   *
   * イベントは `kind: "restored"`。`digestSnapshot` は現在の `digest` で、`content` は運ばない（`forget`/`reextract` と同じ。docs/memory-model.md §9）。`opts.reason` は `meta.reason` に入り、
   * 省略すると `meta` に `reason` キー自体を持たない。
   */
  restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult>;
  /**
   * 層: 是正・取り消し
   * `superseded` な Memory を、呼び出し側が**明示的に**取り戻す（`docs/memory-model.md` §11 行15。`restoreArchived` の `superseded` 版）。結果の意味は {@link RestoreSupersededOutcome}。
   *
   * 🔴 **粒度の既定は「群」。** `target: { supersededById }`（置き換えた側の id）を渡し、`superseded_by_id` が一致する `status = 'superseded'` の行すべてを戻す。個別の Memory id を渡す形は無い
   * （`superseded` は `recall()` に出ないので、戻したい id を知る手段が無く、手元の取っ手は「置き換えた側」だけ。{@link RestoreSupersededTarget}）。群は「1回の操作」とは限らない
   * （[ADR 0230](../../../docs/decisions/0230-restore-superseded-recovery-path.md)。バグではなく確定した契約）ので、呼び出し側は `opts.dryRun: true` で中身（`supersededReason` を含む）を確かめ、
   * 必要なら `target.onlyMemoryIds`（[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）で絞ってから呼ぶ。どの id をまとめて渡すかは mnemora は判定しない。
   *
   * 🔴 **`MemoryStore.restoreSupersededBy?`（新しい任意メソッド）が無い adapter は `{ supported: false, supersedingMemoryId, outcomes: [] }`。** `updateStatusWithEvent` に収まらないため
   * （個別 CAS ではなく群単位の範囲走査+一括更新で、`superseded_by_id` を `NULL` へ戻す経路が無い。{@link MemoryStore.restoreSupersededBy}）。フォールバックは無い（ADR 0082）。
   *
   * 🔴 **`opts.dryRun: true` は別の枝**: `MemoryStore.previewRestoreSupersededBy?`（独立した任意メソッド）だけを呼び、書き込みも `reinforce` も起きない（ADR 0237）。対象の選び方は `restoreSupersededBy?` と同じ `WHERE` で、
   * `would_restore` の `memoryId` 集合は直後の `restored` と一致するが、保証する仕組みは無い（間の書き込みでずれる）。`previewRestoreSupersededBy?` が無い adapter では `supported: false`
   * （`restoreSupersededBy?` があっても免除されない）。
   *
   * 対象が0件なら `{ supported: true, outcomes: [] }`。存在しない・形式不正な `supersededById` も例外にしない。戻した各対象に続けて `MemoryStore.reinforce` を呼び、失敗しても復帰は握り潰さず `reinforceError` に運ぶ
   * （理由は `restoreArchived` と同じ忘却ゲート。ADR 0153）。`superseded` な Memory の床は過去とは限らない（統合直後は先の未来を指しうる）が、ADR 0048（`reinforce` は起点を巻き戻さない）により
   * 無条件に呼んで安全なので、対象ごとに出し分けない。
   *
   * ⛔ **やらないこと**: 置き換えた側（`supersededById` が指す Memory）には一切触らない（消さない・`forget` しない・`status` を変えない）。統合先は supersede が誤りでも中身が正しいことがあり、黙って消すと作業を破壊する。
   * `forget` が在って呼び出し側が選べ、操作1つにイベント1つのほうが辿れ、どちらを残すか（統合先は `consolidated`（推論）、戻す側は `stated` のことが多い）を枠組みが決めないため。
   * ⟹ 戻した直後は古いほうも新しいほうも `active` で、`recall()` は両方を返しうる。始末したいなら呼び出し側が `forget(ctx, supersedingMemoryId)` か `markContested` を呼ぶ。この分岐は `opts` に足さない
   * （「戻す」と「置き換えた側をどうするか」の2つの意思決定を暗黙に束ねない）。置き換えた側が `forgotten` でも群は `active` に戻る（置き換えた側の状態は見ない）。
   */
  restoreSuperseded(
    ctx: Ctx,
    target: RestoreSupersededTarget,
    opts?: RestoreSupersededOptions,
  ): Promise<RestoreSupersededResult>;
  /**
   * 層: 中核
   * Memory を**論理的に**忘れさせる。結果の意味は {@link ForgetOutcome}。
   *
   * **行も `content` も消さない。** `status` を `'forgotten'` へ動かして `memory_events` に `kind: 'forgotten'` を積むだけで（`updateStatusWithEvent`。同一トランザクション）、物理削除は別操作の `purge()`
   * （ADR 0124。docs/memory-model.md「forget() と purge() を分ける」）。`digestSnapshot` には `digest` を入れ、`content` は運ばない（§9）。`forgotten` は `recall()` の status ゲート（`['active','contested']`）に
   * 含まれないので、以後 `recall()` に出ず、`omitted` に `{ kind: 'filtered', condition: 'forgotten' }` で計上される（ADR 0027）。
   *
   * **冪等**: 既に `forgotten` なら書き込まず `already_forgotten`。同じ id を同じ呼び出しに複数回渡しても `memory_events` は高々1件。`target` は `MemoryId[]` に正規化して入力順に処理し、
   * 空配列は store に触れず `{ outcomes: [] }`。在るかどうかは `getMany` の答えに従い、id は小文字にそろえて突き合わせる（`@mnemora/postgres` では大文字の UUID も在る記憶になる。
   * 大文字小文字だけが違う id を同じ呼び出しに混ぜたときは渡された綴りどおり）。観測した status を `expectedStatus` にした compare-and-swap で書き、競合は**1回だけ**再読して返す（再試行しない）。
   * 競合以外の例外（DB 接続断等。再読・ループ前の読みの失敗を含む）は、`failed` を積んでその場で打ち切り、残りを `not_attempted` として返す。例外は外へ投げない。
   */
  forget(ctx: Ctx, target: ForgetTarget, opts?: ForgetOptions): Promise<ForgetResult>;
  /**
   * 層: 是正・取り消し
   * `forgotten` な Memory を**物理削除**する（docs/roadmap.md §5.3、[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）。不可逆で、`content`/`digest` を固定のトゥームストーン文字列で上書きし、
   * `purgedAt` を設定する。**行そのものは消さない**（`memory_events` からの外部キー参照整合性のため）。結果の意味は {@link PurgeOutcome}。
   *
   * 🔴 **`forgotten` からのみ遷移できる**（`forget → purge` の二段階が、不可逆操作に対する最小の安全弁。`docs/memory-model.md` §11 行10）。それ以外の `status` は `status_not_forgotten` で書き込みなし。
   * 🔴 **`MemoryStore.purgeMemory`（任意メソッド）が無い adapter では何も実行できない**: `{ supported: false, outcomes: 全件 "not_attempted" }` を返し、フォールバックは無い。`dryRun` の有無でも同じ扱いにする
   * （下見だけ許す adapter を作ると、下見の約束と実際の振る舞いが食い違いうる）。
   *
   * 契約: `target` は正規化して入力順に処理し、空配列は store に触れず `{ supported, outcomes: [] }`。在るかどうかの突き合わせは `restoreArchived` と同じ。`purgedAt` が非 `null` なら `already_purged`
   * （`MemoryStore` への書き込み無し）。`opts.dryRun` が `false`（省略含む）なら、`already_purged` でも `VectorStore.deleteAcrossSpaces` をベストエフォートで試みる（ADR 0382。埋め込みモデルを移した後の再実行で
   * 旧 space の埋め込みを消す。`dryRun: true` では呼ばない）。`forgotten` かつ未 purge は、`dryRun` なら `would_purge`、そうでなければ `purgeMemory` で上書きして `purged` を返し、続けて
   * `deleteAcrossSpaces`（adapter が持つ**全 space**）をベストエフォートで試みる。その失敗は握り潰さず `embeddingCleanup` で知らせ、`purged` を `failed` に格下げしない（`MemoryStore` 側の書き込みは確定しており、
   * 「安全に再試行できる」という `failed`/`not_attempted` の意味を裏切るため）。競合（{@link MemoryPurgeConflictError}）は**1回だけ**再読して分類し（`dryRun` では到達しない）、再試行しない。
   * 競合以外の例外は `failed` を積んで打ち切り、残りを `not_attempted` で返す。例外は外へ投げない（再読・ループ前の読みの失敗を含む）。
   *
   * イベントの `kind` は `"purged"`。`digestSnapshot` は上書き**前**の digest で、`content` は運ばない。`opts.reason` は `meta.reason` に入り、省略すると `meta` に `reason` キー自体を持たない。
   * `tick()`/`observe()` からは呼ばれない（`TICK_SUPPORTED_JOB_KINDS` に `purge` 相当は無く、`observe()` の入力分岐にも混ぜていない）。`status` を動かさないので、purge された Memory は常に `forgotten` のままで、
   * 一度も「スコープ内」に入らず（`docs/recall.md` §2 段0・§5）、`ScopeAggregate` の群カウントに触れない（ADR 0124）。
   */
  purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult>;
  /**
   * 層: 是正・取り消し
   * 判定できない対向の2件を、両側 `status='contested'`・`contested_with_id` を相互に設定して書く**明示的操作**（`docs/memory-model.md` §11 行6、ADR 0134）。結果の意味は {@link MarkContestedOutcome}。
   *
   * **この操作は「矛盾しているか」を判定しない。** 呼び出し側が「この2件は対向する」と決めたことを、§5 の形（一対一・相互参照・mandatory companion retrieval が働く状態）で機械的に書くだけで、
   * 順序（新しい方を勝たせる）で判定せず、LLM も呼ばない。
   *
   * - `firstId === secondId` は `RangeError`（`Runtime.markContested: firstId and secondId must differ`。書き込みは試みない）。
   * - `MemoryStore.markContestedPair` が無ければ `{ supported: false, outcome: { kind: "not_attempted" } }`（フォールバックなし）。
   * - 両側を `getMany` で読み、どちらかが `eligible` でなければ書き込まず `ineligible`。在るかどうかの突き合わせは `restoreArchived` と同じで、同じ記憶を小文字と大文字で渡したときは渡された綴りどおりなので、
   *   store の id と綴りが違う側は `not_found` になる（位置によらない）。
   * - 競合（{@link MemoryStatusConflictError}。読んだ後に別の書き込みが入った）は**1回だけ**再読して `conflict` で返し、再試行しない。
   *
   * 両側に `kind: 'updated'`・`meta.reason: 'contested'`（操作の種類を表す固定タグ。`forget` 等の自由文とは別）を1件ずつ積む。`opts.reason` は `meta.note` に追加で入る。`meta.contestedWithId` には
   * store が返した相手の id（`@mnemora/postgres` では小文字）が入る。解決で `contested_with_id` はクリアされるので、監査ログに残さないと誰と対だったかを後から追えない。
   * `digestSnapshot` は現在の `digest` で、`content` は運ばない。`tick()`/`observe()` からは呼ばれない。
   */
  markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult>;
  /**
   * 層: 是正・取り消し
   * `contested` の2件を `active | superseded` へ解決する**明示的操作**（`docs/memory-model.md` §11 行7、ADR 0150。`markContested` の解決側）。結果の意味は {@link ResolveContestedOutcome}。
   *
   * **この操作も「どちらが正しいか」を判定しない。** 呼び出し側が下した決定（{@link ContestedResolution}）を機械的に書くだけで、`recordedAt`/`occurredAt` は参照せず（§5「順序では解かない」）、LLM も呼ばない。
   *
   * 投げる例外（書き込みの前）:
   * - `firstId === secondId` は `RangeError`。
   * - `resolution.kind` が `"supersede"`・`"both_active"` のどちらでもなければ `RangeError`（ADR 0496。`supersede` へ倒すと勝者の無いまま両側が `superseded` になるため）。
   * - `supersede` の `winnerId` が `firstId`/`secondId` のどちらでもなければ `RangeError`。片側と大文字小文字だけ違うときは store の `get` で同じ記憶かを確かめ、同じなら勝者として扱う
   *   （`@mnemora/postgres` の uuid。大文字小文字を区別する store では `RangeError`）。
   * - `MemoryStore.resolveContestedPair` が無ければ `{ supported: false, outcome: { kind: "not_attempted" } }`（フォールバックなし）。
   *
   * 両側を `getMany` で読み、適格性は「両側とも `status === 'contested'` かつ相互参照が成立している」（[ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md) の対不変条件を読む側からも守る）。
   * どちらかが `eligible` でなければ書き込まず `ineligible`。競合は `markContested` と同じく**1回だけ**再読して `conflict`。`both_active` は両側 `active`、`supersede` は勝者が `active`・
   * 敗者が `superseded` + `supersededById: <winnerId>`。
   *
   * 両側に `memory_events` を1件ずつ積む（勝者・`both_active` は `updated`、敗者は `superseded`）。`meta.reason` は固定値 `'contested_resolved'`、`meta.resolution` は `'supersede' | 'both_active'`。
   * `opts.reason` は `meta.note` に追加で入る。全イベントに `meta.contestedWithId` が入り、敗者の `superseded` は加えて `meta.supersededById`（値は同じ）を持つ。どちらも store が返した id（列の値と同じ形）で、
   * 渡された id ではない。`digestSnapshot` は現在の `digest` で、`content` は運ばない。`contested` から離れると、段1の status ゲートと段3の mandatory companion retrieval から外れ、
   * 敗者は以後 `recall` に単独でも同伴でも出ない。`tick()`/`observe()` からは呼ばれない。
   */
  resolveContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
    opts?: ResolveContestedOptions,
  ): Promise<ResolveContestedResult>;
  /**
   * 層: 是正・取り消し
   * 対の片側を `forget()` した後の、生存側1件の `contested` を解消する（[ADR 0150](../../../docs/decisions/0150-resolve-contested-explicit-operation.md)）。`resolveContested` の CAS
   * （両側とも `contested` かつ相互参照が成立）は、`forget` が `status` だけを `'forgotten'` にして `contestedWithId` に触れないため満たせず、生存側は `resolveContested` を呼んでも対向が `status_not_contested` で
   * `ineligible` になり、二度と解消できない。この口はそのための別の任意メソッドで、`resolveContested`/`MemoryStore.resolveContestedPair` の CAS には触れない。
   * 結果の意味は {@link ResolveOrphanedContestedOutcome}。
   *
   * **「どちらが正しいか」は判定しない。** 判定するのは「対向が `forgotten`（または purge 済みで見つからない）か」という機械的な事実だけで、`content` の正しさ・`recordedAt`/`occurredAt` には触れず、LLM も呼ばない。
   *
   * `MemoryStore.resolveOrphanedContested` が無ければ `{ supported: false, outcome: { kind: "not_attempted" } }`（フォールバックなし）。`survivorId` を読んで
   * {@link ResolveOrphanedContestedEligibility} に分類し、`eligible` でなければ書き込まず `ineligible`、`eligible` なら生存側を `status: "active"`・`contestedWithId: null` にして `resolved`。
   * 競合は**1回だけ**再読して `conflict`、再試行しない。生存側1件にだけ `kind: 'updated'` を積み（対向の行には触れない）、`meta.reason` は `resolveContested` と同じ `'contested_resolved'`、
   * **`meta.resolution: 'orphan_reclaimed'`**（`'supersede'`/`'both_active'` と区別できる値）、`meta.contestedWithId` は forget された（または見つからない）対向の id。`opts.reason` は `meta.note` に入る。
   * `tick()`/`observe()` からは呼ばれない。
   *
   * 🔴 **任意メソッド（`?`）。** `@mnemora/core` は v1.0.0 として公開済みで、`Runtime` interface を自前で実装している利用者にとって、後から必須メソッドが増えることは次のメジャー版を要求する破壊的変更になる
   * （`docs/migration-v1.md` §12/§14/§16）。`createRuntime` が返す `Runtime` には必ず実装されており、省略されるのは独自に `Runtime` を実装する場合の後方互換のためだけ。
   * 呼ぶ側は非 null アサーション（`runtime.resolveOrphanedContested!(...)`）でよい。
   */
  resolveOrphanedContested?(
    ctx: Ctx,
    survivorId: MemoryId,
    opts?: ResolveOrphanedContestedOptions,
  ): Promise<ResolveOrphanedContestedResult>;
  /**
   * 層: 是正・取り消し
   * **3件以上**（群）を `active → contested` へ書く**明示的操作**（ADR 0327、ADR 0378、ADR 0381。`markContested` の N者版）。結果の意味は {@link MarkContestedGroupOutcome}。
   *
   * **「矛盾しているか」は判定しない。** 呼び出し側（`detectClaimKeyContested` の `contested_group` 分岐、または人・上位のアプリケーション層）が `members` は対向すると決めたことを機械的に書く。
   * **穴Aの吸収（既存の2者間の対の相方を含める）・合併（複数の既存群を1つに束ねる）の判定は呼び出し側の責務**で、この口は渡された `members` を検査して書くだけ（`RelationStore` は読まない）。
   *
   * 投げる例外（書き込みの前）: `memberIds.length < 3`・id の重複は `RangeError`（`Runtime.markContestedGroup: memberIds must have at least 3 entries` / `must be unique`）。
   * `MemoryStore.markContestedGroup` が無ければ `{ supported: false, outcome: { kind: "not_attempted" } }`（フォールバックなし）。全員を `getMany` で読んで {@link MarkContestedGroupSideOutcome} に分類し、
   * 1件でも `eligible` でなければ書き込まず `ineligible`、全員 `eligible` なら書いて `contested_group`。競合は**1回だけ**再読して `conflict`、再試行しない。
   *
   * 全メンバーに `kind: 'updated'`・`meta.reason: 'contested'` を1件ずつ積み、`opts.reason` は `meta.note` に追加で入る。**`meta.contestedWithId` は積まない**（群のメンバーは `contestedWithId` を持たない設計。
   * ADR 0378。「誰と対だったか」は `memory_relations` の行（`RelationStore.listRelated`）から辿る）。`tick()`/`observe()` からは呼ばれない。
   *
   * 🔴 **任意メソッド（`?`）。** 理由は `resolveOrphanedContested?` と同じ（v1.0.0 公開後に必須メソッドを増やさない）。`createRuntime` が返す `Runtime` には必ず実装されている。
   */
  markContestedGroup?(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    opts?: MarkContestedGroupOptions,
  ): Promise<MarkContestedGroupResult>;
  /**
   * 層: 是正・取り消し
   * 群の `contested` を `active | superseded` へ解決する**明示的操作**（ADR 0327、ADR 0378、ADR 0381。`markContestedGroup` の解決側）。結果の意味は {@link ResolveContestedGroupOutcome}。
   * 呼び出し側が下した決定（{@link ContestedGroupResolution}）を機械的に書くだけで、「どちらが正しいか」は判定しない。
   *
   * 投げる例外（書き込みの前）:
   * - `memberIds.length < 3`・id の重複は `RangeError`。
   * - `resolution.kind` が `"supersede"`・`"both_active"` のどちらでもなければ `RangeError`（ADR 0496）。
   * - `supersede` の `winnerId` が `memberIds` のどれとも一致しなければ `RangeError`（`Runtime.resolveContestedGroup: resolution.winnerId must be one of memberIds`）。大文字小文字だけ違うときは、
   *   **一意に絞れたときだけ**救済する（群は候補を一意に絞れないことが多いため）: 小文字にそろえて memberIds から集めた候補がちょうど1件で、store の `get` が `winnerId` と候補に同じ id の記憶を返したときだけ、
   *   その memberId の綴りを勝者にする（敗者の `supersededById` は memberIds の綴りになる）。候補が2件以上・`get` が食い違う・どの member とも違う場合は `RangeError`（最後は store を読まない）。
   * `MemoryStore.resolveContestedGroup` が無ければ `{ supported: false, outcome: { kind: "not_attempted" } }`。
   *
   * 全員を `getMany` で読み {@link ResolveContestedGroupSideOutcome} に分類する。store 側の CAS が「`members` は `memory_relations` でつながった今も `contested` な群の全員と一致しなければならない」
   * ことを要求する（ADR 0381）ので、`deps.relationStore` が配線されていれば読み側でも `kind: 'contradicts'` を辿って確認し、群の一部しか渡されていなければ欠けた id を `missingMembers` に積んで
   * 書き込まず `ineligible`。配線されていなければ store 側の CAS だけに任せる（`ContestedGroupMembershipMismatchError` が来れば `ineligible`（`missingMembers` にエラーが名指しした1件）、
   * `MemoryStatusConflictError` なら `conflict`）。1件でも `eligible` でなければ書き込まず `ineligible`。全員 `eligible` なら、`both_active` は全員 `active`、`supersede` は勝者が `active`・他の全員が
   * `superseded` + `supersededById: <winnerId>` で `resolved`。競合は**1回だけ**再読して `conflict`。
   *
   * 全メンバーに `memory_events` を1件ずつ積む（`supersede` は勝者 `updated`・他は `superseded`、`both_active` は全員 `updated`）。`meta.reason` は `'contested_resolved'`、`meta.resolution` は
   * `'supersede' | 'both_active'`、`opts.reason` は `meta.note`。`meta.contestedWithId` は積まない（群のメンバーはその欄を持たない）。負けた側の `superseded` は `meta.supersededById` に勝者の id
   * （memberIds の綴りに寄せた `winnerId`）を持つ（2者版と同じ。ADR 0421）。`tick()`/`observe()` からは呼ばれない。
   *
   * 🔴 **任意メソッド（`?`）。** 理由は `markContestedGroup?` と同じ。
   */
  resolveContestedGroup?(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    resolution: ContestedGroupResolution,
    opts?: ResolveContestedGroupOptions,
  ): Promise<ResolveContestedGroupResult>;
  /**
   * 層: 是正・取り消し
   * `findCorrectionCandidates`（発見、ADR 0232）と `markContested`/`resolveContested`（書き込み、ADR 0134・ADR 0150）の間の「選択」の段を、出荷される面（`Runtime` の公開 interface）から駆動する
   * （[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）。`examples/chat/src/correction-demo.ts`（`private: true` で出荷されない）にだけあった3態の状態機械（選択待ち／候補外／解決）を、
   * `packages/core` の公開 API へ持ち上げたもの。
   *
   * ⛔ **この口も「相手を選ぶ」ことはしない。** {@link ApplyCorrectionInput.correctedId} は必ず呼び出し側が渡し、`discovery.candidates[0]` を自動で採る経路は無い
   * （[ADR 0134](../../../docs/decisions/0134-mark-contested-explicit-operation.md)・[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md) の「機械は選ばない」。
   * 閾値では分離できず、訂正してはいけない8件中、棄権率 0/8・深い誤爆 6/8だった）。
   *
   * - `input.correctedId` が `undefined` なら、何も呼ばず `{ kind: "awaiting_choice" }`。
   * - `discovery.candidates` に `memoryId === correctedId` が無ければ、何も呼ばず `{ kind: "not_a_candidate", correctedId }`。完全一致が無くても、大文字小文字を無視してちょうど1件の候補に一致し、
   *   store の `get` が両者を同じ記憶と言えば、その候補として扱う（ADR 0446。`resolveContested` の `winnerId` と同じ形）。
   * - `input.resolution` が `supersede` で `winnerId` が `correctedId`・`correctingId` のどちらでもなければ、**書き込む前に** `RangeError`（`resolveContested` と同じ型と文言。`markContested` は呼ばれず何も書かれない。ADR 0446）。
   * - 見つかれば `markContested(ctx, correctedId, correctingId, { actor, reason })` を呼ぶ。`resolution` が無ければここで止まり `{ kind: "contested", ..., markResult }`。あれば続けて `resolveContested` を呼び、
   *   `{ kind: "resolved", ..., markResult, resolveResult }` を返す。
   *
   * ⛔ **`markContested`/`resolveContested` の失敗（`ineligible`/`conflict`/`not_attempted`）を握り潰さず**、`markResult`/`resolveResult` としてそのまま運ぶ（例外・`boolean` に変換しない）。
   * `kind: "resolved"` は「`resolveContested` まで呼んだ」ことだけを意味するので、解決に成功したかは `resolveResult.outcome.kind` で見る。
   * ⛔ 監査理由は自動生成しない: `input.reason`（`buildCorrectionReason`〔`apply-correction.ts`。ADR 0238〕で組み立てた文字列か自由文）を両方へそのまま渡す。`meta.note` の `recallId` が `getRecall` への橋になる。
   * ⭐ `resolution` を渡さず呼んだ後、別の呼び出しで `resolution` を渡す2段の使い方ができる（状態を持たない。2回目も `markContested` は呼ばれるが、対象は既に `contested` なので書き込み無しで `ineligible` を返し、
   * 続く `resolveContested` は解決へ進む）。
   * ⚠ `correctedId === correctingId` を特別扱いしない: 照合を通ると、`markContested` が `RangeError` を投げ、捕まえない（呼び手のバグ）。`tick()`/`observe()` からは呼ばれない。
   */
  applyCorrection(ctx: Ctx, input: ApplyCorrectionInput): Promise<ApplyCorrectionResult>;
  /**
   * 層: 中核
   * 複数の Memory を1件に統合する（ADR 0089。docs/vision.md「5動詞」の1つ）。結果の意味は {@link ConsolidateOutcome}。
   *
   * 統合元は `status: 'superseded'` + `supersededById: <統合先>` へ動き、行も `content` も消えない。**`forgotten` は絶対に統合元にしない**（利用者が意図して忘れさせたものを、機構の都合で上書きしない）。
   *
   * ⚠ 以下の「書き込み無し」は Memory・`memory_events`・outbox のことである。`target` が `{ query }`・`{ seedMemoryId }` のときの `recall()` は、**どの枝で終わっても**（`dryRun`・eligible 0件/1件・LLM の失敗でも）
   * recall の記録を1件書き、`decay_clock` が `'wall'` 以外のテナントでは `activity_seq` を1進める（ADR 0165）ので、活動時計のテナントでは `dryRun` で確かめるだけでも記憶が1回ぶん沈む
   * （`tick()` の `consolidate` ジョブも同じ。`{ memoryIds }` は `recall()` を呼ばない）。
   *
   * 契約:
   * - 空配列・`query` が0件は `not_examined`（store に触れない）。対象の解決は {@link ConsolidateTarget}。`getMany` で読んで、無ければ `not_found`、`status !== 'active'` なら `status_not_active`、有効期間の外なら
   *   `expired`/`not_yet_valid`、それ以外が eligible（在るかどうかの突き合わせは `restoreArchived` と同じ）。
   * - eligible が0件なら `nothing_to_consolidate`/`no_eligible_sources`、1件だけなら `single_eligible_source`（どちらも LLM を呼ばず、書き込み無し）。**eligible は重複を除いて数える**ので、`{ memoryIds: [a, a] }` は
   *   `single_eligible_source` になり、同じ Memory を自分自身と統合しない（`sources` は入力と同じ長さのまま）。**これが冪等性の芯**で、同じ id 集合の2回目は LLM も呼ばず何も書かない（`{ seedMemoryId }` では保証されない。{@link ConsolidateTarget}）。
   * - `dryRun: true` は `dry_run`（eligible は `{ kind: 'eligible' }`、`llmCalls: 0`）。LLM を1回呼ぶ（`completeStructured`）。失敗したら `llm_failed`・書き込みゼロ（失敗を根拠に既存の記憶を置き換えない）。
   * - LLM が返った直後・統合先を作る前に eligible を読み直し（ADR 0375）、1件でも `forgotten`（`purge()` 済みも含む）なら**統合先を作らず** `aborted_source_forgotten`（forgotten だった要素は `"forgotten_before_write"`、他は `"not_attempted"`）。
   *   `superseded`・`contested`（ADR 0420・ADR 0544）が1件でも、または eligible の**すべて**が `active` でなくなっていた場合は `aborted_source_status_changed`。
   *   **読み直しと書き込みの間には小さな窓が残る。** `atomicity: 'store_supported'` の経路は、`supersedeWithNewMemories` に `abortIfForgotten`・`abortIfSuperseded`・`abortIfAllConflicted` を渡し、書き込みと同一トランザクションの
   *   `SELECT … FOR UPDATE` でもう一度見直す（`@mnemora/postgres`。{@link SourceMemoryForgottenError}。何もコミットされず、同じ outcome で返る。`contested` の見直しはまだ無い）。`store_unsupported` の経路は読み直しだけが保護で、
   *   `packages/testkit` の `InMemoryMemoryStore` と `packages/core` の `FakeMemoryStore` は `abortIf*` を実装しない。
   * - ⚠ **統合先は `embeddingStatus: 'pending'` で作られ、`tick()` が回るまで ANN の候補に入らない。** 統合元は同じ呼び出しで `superseded` へ動くため、**元はもう引けないが統合先もまだ引けない窓が開く**
   *   （塞いでいない。[ADR 0089](../../../docs/decisions/0089-runtime-consolidate-shape.md)）。
   * - 統合元の `superseded` 化: `store_supported`（`MemoryStore.supersedeWithNewMemories` が在る）は、作成と supersede を1トランザクションで撃ち、CAS の競合は戻り値の `conflicted`（`status_changed_concurrently`）として届く。
   *   **それ以外の予期しない例外は、この経路では投げる**（ADR 0089 の「打ち切って `not_attempted` で返す。投げない」を、この経路だけ覆す。1トランザクションでは部分的に起きたことが無く、「投げない」とした理由が満たされるため。ADR 0100）。
   *   `store_unsupported` は `updateStatusWithEvent` で1件ずつ CAS し、競合はその1件だけ `status_changed_concurrently` で飛ばして続行、それ以外の例外は `failed` を積んで打ち切り、残りを `not_attempted` で返す（投げない）。
   *   部分成功が残るのは、`superseded` 以外の理由（`archived` など）で一部だけが破れたとき。`store_unsupported` の2段の経路では、読み直しより後に全件が破れても打ち切れず、統合先は残る（ADR 0420）。
   *
   * `meta.reason` は `superseded` イベントに `'consolidated'`。`digestSnapshot` は積むが **`content` は積まない**。⭐ `tick()` は `'consolidate'` の outbox ジョブが在ればこれを駆動する（ADR 0157。`payload` は `{ memoryId }`、
   * それを `seedMemoryId` として呼ぶだけ）。ジョブが積まれるのは `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にしたときだけで、無効のままでも `consolidate()` を直接呼ぶ経路は変わらず動く。
   */
  consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult>;
  /**
   * 層: 中核
   * 複数の Memory から一般化・気づきを1件作る（ADR 0091。docs/vision.md「5動詞」の1つ）。結果の意味は {@link ReflectOutcome}。
   *
   * **`consolidate` の双子だが、意味論は正反対**: `consolidate` は N→1 の**置換**（統合元を `superseded` へ動かす）、`reflect` は**足すだけ**で既存の行の `status` を動かさない。書き込みは新しい Memory 1件と `created` イベントだけ。
   * `consolidate` と同じく、`{ query }`・`{ seedMemoryId }` の `recall()` は**どの枝で終わっても** recall の記録を書き、活動時計のテナントでは `activity_seq` を1進める（ADR 0165。`tick()` の `reflect` ジョブも同じ）。
   *
   * 契約（`consolidate` と同じ段取りで、書き込みの終盤だけ違う）:
   * - 対象の解決は {@link ReflectTarget}。`getMany` で読み、**この優先順で**分類する: 無ければ `not_found`、`status !== 'active'` なら `status_not_active`、有効期間の外なら `expired`/`not_yet_valid`（`consolidate`・`recall()` と同じ `classifyValidity`）、
   *   期間の内側で `provenance.kind === 'reflected'` なら `basis_is_reflected`（reflect の産物を土台にまた reflect する自己増幅を形の側で止める）、それ以外は eligible。
   * - eligible（重複除去）が0件なら `nothing_to_reflect`/`no_eligible_basis`（LLM を呼ばない）。`consolidate` と違い、1件だけでも打ち切らない（1件からの一般化も意味を持ちうる）。`dryRun: true` は `dry_run`。
   * - LLM を1回呼ぶ（`completeStructured`。スキーマは判別子 `outcome: 'reflected' | 'nothing'` の判別可能ユニオン。断れないスキーマを渡すと、モデルは毎回何かを捏造するため、「一般化するものは無い」と答えられる形にしてある）。
   *   失敗したら `llm_failed`（書き込みゼロ。失敗を根拠に新しい記憶を作らない）。`'nothing'` なら `nothing_to_reflect`/`llm_declined`。
   * - `'reflected'` が返った直後・組み立てる前に eligible を読み直し（ADR 0375）、1件でも `forgotten` なら**内省の Memory を作らず** `aborted_source_forgotten`（forgotten だった要素は `"forgotten_before_write"`、他は `"eligible"`）。
   *   `superseded`・`contested`（ADR 0420・ADR 0544）なら `aborted_source_status_changed`（`"status_changed_before_write"`）。読み直しと書き込みの間には小さな窓が残る。`createMemoryWithOutbox` に `abortIfForgotten`・`abortIfSuperseded` を渡し、
   *   `@mnemora/postgres` は INSERT と同一トランザクションの `SELECT … FOR UPDATE` で見直す（{@link SourceMemoryForgottenError}。何もコミットされず、同じ outcome で返る）。`packages/testkit` の `InMemoryMemoryStore` と
   *   `packages/core` の `FakeMemoryStore` は実装しないので、読み直しだけが保護。
   * - 新しい Memory の `provenance` は `{ kind: 'reflected', sources: <eligible の memoryId> }`。**`sources` は必ず埋める**（`ReflectedProvenance.sources` は型としては省略可のままだが、公開型の破壊的変更を避けるため型は変えない）。
   *   store が `createMemoriesWithOutboxAndEvents?` を持てば `created` も同じ1トランザクションで積む（ADR 0416）。持たなければ `createMemoryWithOutbox` + 別の `eventStore.append`（直さない負債）。`created` の `meta.reason` は `'reflected'`、
   *   `meta.sources` は store が返した行の id＝小文字の正規形（渡された綴りではない。ADR 0527）、`opts.reason` があれば `meta.note`。eligible は `'used'` で返る。
   *
   * ⚠ **冪等性は買っていない。** `sourceObservationId: null` なので `createMemoryWithOutbox` の部分一意索引は効かず、既存の行の `status` も動かさないので `consolidate` の「読んで status で弾く」も使えない。
   * ⟹ 同じ target で2回呼ぶと、内容が同じ `reflected` Memory が2件できる（塞ぐために `MemoryStore` へメソッドや索引は足さない）。**`tick()` の `'reflect'` ジョブも同じ**: outbox は at-least-once（ADR 0032）で、`reflect()` が書いた後・`complete` の前に
   * ワーカーが止まると、リース切れ後の `tick()` が再処理して内省の Memory が2件になる（`'embed'`・`'consolidate'` は再配達でも1回と同じ状態になる）。
   *
   * ⭐ `tick()` は `'reflect'` の outbox ジョブが在ればこれを駆動する（ADR 0157。`consolidate` と対称）。`reflect()` の*実運用*（Background Cognition・Scheduler による自動起動）は Phase 1 の範囲外（docs/roadmap.md §1.3）で、
   * ジョブを**自動で積む**のは `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にしたときだけ。無効のままでも `reflect()` を直接呼ぶ経路は変わらず動く。
   */
  reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult>;
}

/** `observations.payload`（`kind = 'usage'`）の形。公開 API 表面（ADR 0178）を増やさないよう export しない。`externalId` は Observation 行の列そのものなので、ここには含めない。 */
const UsageObservationPayloadSchema = z.object({
  recallId: z.string().min(1),
  usedMemoryIds: z.array(z.string().min(1)),
});

function extractObservationPayload(
  input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
): unknown {
  const context =
    input.extractionContext === undefined ? {} : { extractionContext: input.extractionContext };
  switch (input.kind) {
    case "utterance":
      return { text: input.text, speaker: input.speaker, ...context };
    case "event":
      // `extractData: true` のときだけ印を足す。`false`・省略では `extractData` キー自体を足さない（`payload` を変えないため）。
      return {
        name: input.name,
        data: input.data ?? {},
        ...(input.extractData === true ? { extractData: true } : {}),
        ...context,
      };
    case "document":
      // `extractData` と同じく、`true` のときだけ印を足す。
      return {
        title: input.title,
        content: input.content,
        ...(input.extractTitle === true ? { extractTitle: true } : {}),
        ...context,
      };
    default: {
      const exhaustive: never = input;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}

/**
/**
 * 抽出で保存できずに落とした候補1件の記録（ADR 0347）。残った候補の `created` イベントの `meta.droppedCandidates` に入る（公開の型ではない）。
 *
 * 🔴 **候補の本文は写さない。** 落ちた理由がまさに本文（NUL・1MB 超）であることが多く、写すと `created` の追記まで同じ理由で落ちる。候補は `index`（LLM が返した順の 0 起点）と `contentHash` で指す。
 */
interface DroppedCandidate {
  index: number;
  contentHash: string;
  /** 最も内側の原因が名乗った文字列の `code`（pg なら SQLSTATE）。無ければ `null`。 */
  code: string | null;
  /** 最も内側の原因の `message`。NUL と孤立サロゲートは目に見える形に置き換え、500 文字で切る。 */
  message: string;
}

const DROPPED_CANDIDATE_MESSAGE_MAX_CHARS = 500;

/** 候補それぞれの補助の欄（`digest`・`tags`）から、保存できない値だけを落とす（ADR 0443）。候補は捨てない。落とした欄の記録は、`created` イベントの `meta.droppedFields` に入る。 */
function sanitizeCandidatesAuxFields(
  candidates: ExtractedMemoryCandidate[],
  hashContent: (content: string) => string,
): { candidates: ExtractedMemoryCandidate[]; droppedFields: DroppedAuxField[] } {
  const droppedFields: DroppedAuxField[] = [];
  const sanitized = candidates.map((candidate, index) => {
    const result = sanitizeCandidateAuxFields(candidate);
    if (result.dropped.length > 0) {
      const contentHash = hashContent(candidate.content);
      for (const entry of result.dropped) {
        droppedFields.push({ index, contentHash, ...entry });
      }
    }
    return result.candidate;
  });
  return { candidates: droppedFields.length === 0 ? candidates : sanitized, droppedFields };
}

/**
 * `createMemoryWithOutbox` が投げた例外から {@link DroppedCandidate} を作る。外側の `message` は使わない。
 * drizzle の `Failed query: <SQL> params: …` は params（候補の本文）を含むので、本文を写さない規律が破れる。`cause` の連鎖の最も内側（pg のエラー文・fixture の文言）を使う。
 */
function describeDroppedCandidate(
  index: number,
  contentHash: string,
  error: unknown,
): DroppedCandidate {
  let innermost: unknown = error;
  const seen = new Set<unknown>([error]);
  while (
    innermost instanceof Error &&
    innermost.cause !== undefined &&
    !seen.has(innermost.cause)
  ) {
    seen.add(innermost.cause);
    innermost = innermost.cause;
  }
  const rawCode = (innermost as { code?: unknown } | null | undefined)?.code;
  const rawMessage = innermost instanceof Error ? innermost.message : String(innermost);
  const message = Array.from(
    rawMessage
      .split("\u0000")
      .join("\\u0000")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"),
  )
    .slice(0, DROPPED_CANDIDATE_MESSAGE_MAX_CHARS)
    .join("");
  return {
    index,
    contentHash,
    code: typeof rawCode === "string" && rawCode.length > 0 ? rawCode : null,
    message,
  };
}

/**
 * `getMany` が返した記憶を、渡された id で引き当てるときの鍵を作る関数を返す。`ids` はその呼び出しに渡された id の全部。
 *
 * store が返す `Memory.id` は、渡した id と文字列として一致するとは限らない。`@mnemora/postgres` は uuid を大文字小文字を区別せずに比べ、小文字で返す
 * （`get("…ABC…")` が `id: "…abc…"` の記憶を返す）。渡された id のまま引くと、store が「在る」と言う記憶を `not_found` にしてしまう。
 * ⟹ 両側を小文字にして突き合わせる。**store へ渡す id は変えない。** 在るかどうかは store の `get`/`getMany` が決め、Runtime はそれに従うだけである
 * （大文字小文字を区別する store では、大文字の id は `not_found`）。
 *
 * ⚠ **大文字小文字だけが違う id を同じ呼び出しに混ぜたときは、その id どうしは渡された文字列どおりに突き合わせる。** `getMany` の戻りだけでは、
 * 「store がどちらも在ると言った」と「片方だけ在ると言った」を区別できないため。⟹ store が返す id と同じ綴りで渡した id だけが在る記憶になり、ほかの綴りは `not_found` のまま残る。
 * **並びの位置によらない**（`@mnemora/postgres` の `forget({ memoryIds: [小文字, 大文字] })` でも `[大文字, 小文字]` でも、`not_found` になるのは大文字の側である）。
 * どの綴りも store の id と違えば（`[先頭だけ大文字, 大文字]` など）、全部が `not_found` になる。
 */
function memoryLookupKeyFor(ids: readonly MemoryId[]): (id: MemoryId) => string {
  const spellingsByLower = new Map<string, Set<MemoryId>>();
  for (const id of ids) {
    const lower = id.toLowerCase();
    const spellings = spellingsByLower.get(lower) ?? new Set<MemoryId>();
    spellings.add(id);
    spellingsByLower.set(lower, spellings);
  }
  return (id) => {
    const lower = id.toLowerCase();
    return (spellingsByLower.get(lower)?.size ?? 0) > 1 ? id : lower;
  };
}

/**
 * {@link Runtime} を組み立てる。
 *
 * ⚠ **組み立ての時点では、`deps` も `deps.config` も検査しない**（1つだけ例外がある: `config.extractorVersion` が空文字・空白だけ（`trim()` が空）なら、`createRuntime` が素の `Error`
 * （`createRuntime: config.extractorVersion must not be empty or whitespace-only`）を投げる。`undefined`・`null` は既定に倒す）。省略した欄は各欄の doc にある既定値に倒れ、
 * 足りない依存や型の外の値は、組み立てでは落ちずに最初の呼び出しで現れる:
 * - 必須の store・`hashContent` が無い: それを使う最初の呼び出しが `TypeError` を投げる（メッセージは欠けた依存の名前ではなく、呼ぼうとしたメソッドの名前を言う）。
 * - `llmProvider` が無い: 例外にならない。`observe()` の抽出は LLM の失敗と同じ扱いになり、`extraction: "llm_failed_whole_observation"` で観測の全文を1件の Memory として残す
 *   （`extractionFailure.message` に `Cannot read properties of undefined` が出る）。
 * - `embeddingProvider` が無い: `recall()` は `stage_skipped`（`embedding_provider_unavailable`）を名乗って ANN を飛ばし、`tick()` の `embed` ジョブは `failed` になる。
 * - `clock.now()` が Invalid Date を返す: 最初の書き込み・`recall()`・`tick()` が例外を投げる（Postgres は DB の例外、testkit の fixture は `RangeError` などで、文言は揃っていない）。
 * - `outputValidation` が `"off"`/`"report"`/`"throw"` のどれでもない: `"report"` と同じに振る舞う。
 * - `config.autoQueueConsolidateReflectOnExtract` が真偽値でない: 真偽として評価される（例: 文字列 `"no"` は真として扱われ、consolidate / reflect の job を積む）。
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const clock = deps.clock ?? systemClock;
  const extractorVersion = deps.config?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
  if (typeof extractorVersion === "string" && extractorVersion.trim() === "") {
    throw new Error("createRuntime: config.extractorVersion must not be empty or whitespace-only");
  }
  // 空文字は省略と同じに扱う（`RuntimeConfig.llmModelId`・`promptVersion` の TSDoc）。空文字のまま書くと、
  // inferred の provenance が `ProvenanceSchema`（`model`・`promptVersion` は `min(1)`）を通らなくなる。
  const llmModelId = deps.config?.llmModelId || DEFAULT_LLM_MODEL_ID;
  const promptVersion = deps.config?.promptVersion || DEFAULT_PROMPT_VERSION;
  const digestFallbackLength = deps.config?.digestFallbackLength ?? DEFAULT_DIGEST_FALLBACK_LENGTH;
  const defaultClaimedBy = deps.config?.defaultClaimedBy ?? DEFAULT_CLAIMED_BY;
  const autoQueueConsolidateReflectOnExtract =
    deps.config?.autoQueueConsolidateReflectOnExtract ?? false;
  const acceptLlmSubjectIdWithoutCandidates =
    deps.config?.acceptLlmSubjectIdWithoutCandidates ?? false;

  /** キーごと消す。`buildNewMemoryFromCandidate` は `subjectId` キーの有無で observation の `subjectId` へ落とす。 */
  function dropLlmSubjectIdsWithoutCandidates(
    candidates: ExtractedMemoryCandidate[],
    subjectCandidates: readonly string[] | undefined,
  ): ExtractedMemoryCandidate[] {
    if (
      acceptLlmSubjectIdWithoutCandidates ||
      (subjectCandidates !== undefined && subjectCandidates.length > 0)
    ) {
      return candidates;
    }
    return candidates.map((candidate) => {
      if (!("subjectId" in candidate)) {
        return candidate;
      }
      const { subjectId: _dropped, ...rest } = candidate;
      return rest;
    });
  }

  /**
   * Memory 書き込み側（抽出・consolidate・reflect）が共通して要る、活動時計の入力のうち **subject に依らない部分**（`T` と `halfLifeRecalls`。[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)）。
   * `decay_clock === 'wall'` のテナントでは `tenant_activity` を一度も読まず `undefined` を返す。「いま」の `S_x` はここでは足さない（[ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)）。
   * `x` はこれから作る Memory 自身の `subjectId` であって `ctx.subjectId` ではなく（`tick` の ctx には通常 `subjectId` が無く、抽出は候補ごとに `subjectId` が違いうる）、各 Memory の `subjectId` が決まった後で
   * `readActivitySeqForSubjects` がまとめて引く。
   *
   * 活動時計を進めるのは `runRecall`（`decayClock` が `"wall"` のテナントでは進めない）を通る呼び出しすべてで、`runtime.ts` の中で `recall()`/`runRecall()` を呼ぶ入口は次のとおり。
   * 行頭の印 `ADVANCER:` の行が機械で読める正本で、`activity-clock-advancers-doc.test.ts` が「`recall(`/`runRecall(` の呼び出しを囲む関数の集合」と一致することを縛る:
   *
   * - ADVANCER: recall — 公開の `recall()` 自身（`runRecall` を呼ぶ）。
   * - ADVANCER: findCorrectionCandidates — 内部で `recall()` を1回呼ぶ。
   * - ADVANCER: consolidate — `{ seedMemoryId }` 形と `{ query }` 形のどちらも内部で `recall()` を呼ぶ。
   * - ADVANCER: reflect — 同じく `{ seedMemoryId }` 形と `{ query }` 形のどちらも `recall()` を呼ぶ。
   *
   * `consolidate`/`reflect` は `dryRun` でも進む（打ち切りは `recall()` の後ろにあるため）。`sweepArchive` は `archiveDecayed` を呼ぶだけで、活動時計を**読む**だけで進めない。
   */
  async function resolveActivityClockBase(
    ctx: Ctx,
  ): Promise<{ tenantSeq: number; halfLifeRecalls: number } | undefined> {
    const decayClock = await readDecayClock(deps.tenantSettingsStore, ctx);
    if (decayClock === "wall") {
      return undefined;
    }
    const [tenantSeq, halfLifeRecalls] = await Promise.all([
      readActivitySeq(deps.tenantSettingsStore, ctx),
      readDefaultHalfLifeRecalls(deps.tenantSettingsStore, ctx),
    ]);
    return { tenantSeq, halfLifeRecalls };
  }

  /**
   * 渡した subject（`null`/`undefined` は主題なし。読まない）のうち distinct なものの `S_x`（`tenant_subject_activity.activity_seq`）を、まとめて1回で引く（ADR 0394）。
   * `hasSubjectActivityCounters` が `false`（`tenant_subject_activity` に行が1本も無い、または未実装）のテナントでは何も引かない。`S_x` はどの subject でも `0` で、`T` のみと同じ値になるため。
   */
  async function readActivitySeqForSubjects(
    ctx: Ctx,
    subjectIds: Iterable<string | null | undefined>,
  ): Promise<ReadonlyMap<string, number>> {
    const distinct = [...new Set([...subjectIds].filter((id): id is string => id != null))];
    if (distinct.length === 0) {
      return new Map();
    }
    if (!(await readHasSubjectActivityCounters(deps.tenantSettingsStore, ctx))) {
      return new Map();
    }
    const seqs = await readSubjectActivitySeqs(deps.tenantSettingsStore, ctx, distinct);
    return new Map(distinct.map((id) => [id, seqs[id] ?? 0]));
  }

  /**
   * 1つの Memory（`subjectId` が決まったもの）の活動時計の入力。`activitySeq` は `T + S_x`（`x` = その Memory 自身の `subjectId`。主題なし・`subjectSeqs` に無い subject は `T` のみ）。
   * `base` が `undefined`（`'wall'` のテナント）なら `{}`。
   */
  function activityClockInputsFor(
    base: { tenantSeq: number; halfLifeRecalls: number } | undefined,
    subjectSeqs: ReadonlyMap<string, number>,
    subjectId: string | null | undefined,
  ): { activitySeq?: number; halfLifeRecalls?: number } {
    if (base === undefined) {
      return {};
    }
    const subjectSeq = subjectId == null ? 0 : (subjectSeqs.get(subjectId) ?? 0);
    return { activitySeq: base.tenantSeq + subjectSeq, halfLifeRecalls: base.halfLifeRecalls };
  }

  /**
   * `reinforce` の呼び出し側（使用報告・`restoreArchived`・`restoreSuperseded`）が共通して要る活動時計の「いま」を、`ReinforceOptions` として返す（[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)）。
   * `decay_clock === 'wall'` のテナントでは `tenant_activity` を読まない。`nowSeq` には **`T` だけ**を入れ、`S_x` は足さない（[ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)）。
   * `reinforceMany` は同じ `opts` を全件に適用し、使用報告は subject の違う Memory を1回で強化しうるので、「Memory 自身の `S_x` を足す」ことを `addOwnSubjectSeq: true` で store に頼む
   * （`tenant_subject_activity` に行が無いテナントでは `S_x` は常に `0` なので付けない）。
   * ⭐ `addOwnSubjectSeq` を渡すのは、store が `MemoryStore.supportsAddOwnSubjectSeq?()` で `true` を宣言しているときだけ（第三者 adapter の挙動を悪くしないため）。宣言の無い store には `T + S_ctx` を `nowSeq` として渡す。
   * 🔴 **引き受けた負債**: 宣言の無い store では、強化される Memory の subject が `ctx.subjectId` とずれる呼び出しで、起点が `ctx` の subject の `S_x` で書かれる取り違えが残る。
   */
  async function resolveReinforceOptions(ctx: Ctx): Promise<ReinforceOptions | undefined> {
    const decayClock = await readDecayClock(deps.tenantSettingsStore, ctx);
    if (decayClock === "wall") {
      return undefined;
    }
    const nowSeq = await readActivitySeq(deps.tenantSettingsStore, ctx);
    if (!(await readHasSubjectActivityCounters(deps.tenantSettingsStore, ctx))) {
      return { nowSeq };
    }
    if (deps.memoryStore.supportsAddOwnSubjectSeq?.() === true) {
      return { nowSeq, addOwnSubjectSeq: true };
    }
    const ctxSubjectSeq =
      ctx.subjectId === undefined
        ? 0
        : await readSubjectActivitySeq(deps.tenantSettingsStore, ctx, ctx.subjectId);
    return { nowSeq: nowSeq + ctxSubjectSeq };
  }

  async function buildNewMemoriesForCandidates(
    ctx: Ctx,
    observation: Observation,
    candidates: ExtractedMemoryCandidate[],
    claimKeys?: readonly (ClaimKey | null)[],
  ): Promise<NewMemory[]> {
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    const activityClockBase = await resolveActivityClockBase(ctx);
    const subjectSeqs =
      activityClockBase === undefined
        ? new Map<string, number>()
        : await readActivitySeqForSubjects(
            ctx,
            candidates.map((candidate) => resolveCandidateSubjectId(candidate, observation)),
          );
    return candidates.map((candidate, index) =>
      buildNewMemoryFromCandidate({
        ctx,
        observation,
        candidate,
        hashContent: deps.hashContent,
        extractorVersion,
        llmModelId,
        promptVersion,
        halfLifeHours,
        now,
        digestFallbackLength,
        claimKey: claimKeys?.[index] ?? null,
        ...activityClockInputsFor(
          activityClockBase,
          subjectSeqs,
          resolveCandidateSubjectId(candidate, observation),
        ),
      }),
    );
  }

  interface CreatedEventReextractOpts {
    readonly at?: Date;
    readonly reextracted?: boolean;
  }

  /** 言語の事後検査の観測側の数え（長さに比例する）を、観測ごとに1回へ畳む（ADR 0507）。同じ抽出の候補は同じ Observation のオブジェクトを渡すので、それを弱参照の鍵にする。 */
  const observationLanguageProfiles = new WeakMap<Observation, ObservationLanguageProfile>();
  function observationLanguageProfileOf(observation: Observation): ObservationLanguageProfile {
    let profile = observationLanguageProfiles.get(observation);
    if (profile === undefined) {
      profile = profileObservationLanguage(observationPayloadText(observation));
      observationLanguageProfiles.set(observation, profile);
    }
    return profile;
  }

  /**
   * 新しく作られた Memory の `created` イベントを組み立てる（**書かない**）。`appendCreatedEvent` と、`createMemoriesFromCandidates` が `createMemoriesWithOutboxAndEvents?` へ渡す `buildCreatedEvent` が共有し、
   * `meta` の中身が2つの経路でずれないよう組み立てを1箇所に置く（ADR 0410）。`reextractOpts`（ADR 0422）は `reextract` だけが渡し、`at` と `reextracted: true` の印を足す。
   * ⚠ 同じ `at` を持つ `created` と `superseded`（`consolidate`・`reextract`）の**並びは約束しない**（`EventStore.list` は `at` の昇順だけ）。順が要るなら `kind` と meta の `supersededById` で読む。
   */
  function buildCreatedEventFor(
    ctx: Ctx,
    memory: Memory,
    observation: Observation,
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
    droppedCandidates: readonly DroppedCandidate[] = [],
    reextractOpts?: CreatedEventReextractOpts,
    droppedFields: readonly DroppedAuxField[] = [],
  ): NewMemoryEvent {
    const languageMismatch =
      outcome === "llm_failed_whole_observation"
        ? null
        : detectLanguageMismatchFromProfile(
            observationLanguageProfileOf(observation),
            memory.content,
          );
    return {
      tenantId: ctx.tenantId,
      memoryId: memory.id,
      kind: "created",
      // `reextract` は入口の `now` を渡す（同じ操作の `superseded` と揃える。ADR 0422）。
      at: reextractOpts?.at ?? clock.now(),
      actor: { type: "system" },
      digestSnapshot: memory.digest,
      sizeBeforeBytes: null,
      meta: {
        reason:
          outcome === "llm_failed_whole_observation"
            ? "extraction_failed_whole_observation_fallback"
            : "extracted",
        sourceObservationId: observation.id,
        extractorVersion,
        // 失敗経路のときだけ足す（成功経路の meta の形は変えない）。
        ...(outcome === "llm_failed_whole_observation"
          ? { failureKind: failure?.kind ?? null }
          : {}),
        // 落とした候補があったときだけ足す（ADR 0347）。
        ...(droppedCandidates.length > 0 ? { droppedCandidates: [...droppedCandidates] } : {}),
        // 保存できない補助の欄（digest・tags）だけを落として候補を残したときに足す（ADR 0443）。
        ...(droppedFields.length > 0 ? { droppedFields: [...droppedFields] } : {}),
        // 言語の事後検査（ADR 0391）: 日本語の観測からラテン文字だけの本文が出たときだけ足す。印を付けるだけで、再試行も書き換えもしない。
        ...(languageMismatch !== null ? { languageMismatch } : {}),
        // `reextract` の `created` にだけ足す印（ADR 0422）。
        ...(reextractOpts?.reextracted === true ? { reextracted: true } : {}),
      },
    };
  }

  /**
   * 新しく作られた Memory の `created` イベントを積む。⚠ **`memories` への INSERT と同一トランザクションではない**（`EventStore.append` は別コミット）。通るのは次の経路だけ（ADR 0410・ADR 0416）:
   * 抽出のうち `MemoryStore.createMemoriesWithOutboxAndEvents?` を**持たない** adapter（持てば `createMemoriesFromCandidates` がその口で同一トランザクションに積む）、`reextract` の口あり経路で store が
   * `createdEventsWritten: true` を名乗らなかったとき、`reextract` の口なし経路（直さない負債）。`consolidate`・`reflect` は `eventStore.append` を直に呼ぶが、同じ形の別コミットである。
   */
  async function appendCreatedEvent(
    ctx: Ctx,
    memory: Memory,
    observation: Observation,
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
    droppedCandidates: readonly DroppedCandidate[] = [],
    reextractOpts?: CreatedEventReextractOpts,
    droppedFields: readonly DroppedAuxField[] = [],
  ): Promise<void> {
    await deps.eventStore.append(
      ctx,
      buildCreatedEventFor(
        ctx,
        memory,
        observation,
        outcome,
        failure,
        droppedCandidates,
        reextractOpts,
        droppedFields,
      ),
    );
  }

  /**
   * 新しく `active` になった Memory 1件について、同じ鍵の衝突を**列と索引だけで**（LLM を呼ばずに）見つける（分岐は {@link ContestedDetectionOutcome}。ADR 0185、ADR 0320、ADR 0324、ADR 0378）。
   * 一致から、検出中の memory と同じ `sourceObservationId` を持つものを、件数を数える前に除く（ADR 0377）: 同じ発話から抽出された兄弟候補どうしが、互いの検出時点で既に `active` になっているため。
   * `null` 同士は「同じ観測」と見なさない。この除外は core 側だけで行い、`findActiveByClaimKey?`/`findContestedByClaimKey?` の interface・Postgres 実装・testkit は変えない。
   * ⛔ `superseded` へは進めず `contested` までで止める（`claimKey` は LLM が作る鍵＝推論で、推論から導いた「矛盾」でユーザーが言った事実を消してはならない。ADR 0185）。
   */
  async function detectClaimKeyContested(
    ctx: Ctx,
    memory: Memory,
  ): Promise<ContestedDetectionOutcome | null> {
    const claimKey = memory.claimKey ?? null;
    if (claimKey === null) {
      return null;
    }
    const findActiveByClaimKey = deps.memoryStore.findActiveByClaimKey;
    if (findActiveByClaimKey === undefined) {
      return null;
    }
    const query = {
      subjectId: memory.subjectId ?? null,
      claimKey,
      excludeMemoryId: memory.id,
      contentHash: memory.contentHash,
      validFrom: memory.validFrom ?? null,
      validUntil: memory.validUntil ?? null,
    };
    const rawActiveMatches = await findActiveByClaimKey.call(deps.memoryStore, ctx, query);
    const findContestedByClaimKey = deps.memoryStore.findContestedByClaimKey;
    const rawContestedMatches =
      findContestedByClaimKey === undefined
        ? []
        : await findContestedByClaimKey.call(deps.memoryStore, ctx, query);
    const rawMatches = [...rawActiveMatches, ...rawContestedMatches];
    const memorySourceObservationId = memory.sourceObservationId ?? null;
    const notSiblings =
      memorySourceObservationId === null
        ? rawMatches
        : rawMatches.filter((m) => (m.sourceObservationId ?? null) !== memorySourceObservationId);
    // store は生の `content_hash` だけで「同じ内容」を除くので、NFC と NFD の違いや末尾の空白1つだけで別の行として返ってくる。
    // `content` を NFC + trim で比べて、検出中の memory と等しい行も、件数を数える前に除く（保存値・`content_hash` は変えない。ADR 0424）。
    const memoryComparableContent = normalizeContentForComparison(memory.content);
    const matches = notSiblings.filter(
      (m) => normalizeContentForComparison(m.content) !== memoryComparableContent,
    );

    if (matches.length === 0) {
      return { memoryId: memory.id, claimKey, matchCount: 0, result: { kind: "no_conflict" } };
    }

    const describeSide = (m: Memory) => ({
      id: m.id,
      status: m.status,
      contentHash: m.contentHash,
      validFrom: m.validFrom ?? null,
      validUntil: m.validUntil ?? null,
    });

    // `markContested` へ進めるのは、一致がちょうど1件で、かつその1件がまだ `active` のときだけ。既に `contested` なら `ineligible` になり、検出中の Memory が `active` のまま痕跡も残らない（ADR 0378）。
    if (matches.length === 1 && matches[0]!.status === "active") {
      const other = matches[0]!;
      // 根拠を構造として `meta.note`（`MarkContestedOptions.reason`）へ載せる。
      const note = JSON.stringify({
        kind: "claim_key_conflict",
        claimKey,
        subjectId: memory.subjectId ?? null,
        first: describeSide(memory),
        second: describeSide(other),
      });
      const markResult = await markContested(ctx, memory.id, other.id, { reason: note });
      return {
        memoryId: memory.id,
        claimKey,
        matchCount: 1,
        result: { kind: "contested", withMemoryId: other.id, markContested: markResult },
      };
    }

    // それ以外（matches.length >= 2、または1件だがその1件が既に `contested`）は、1対1の `contestedWithId` では表せない（ADR 0185）。`deps.relationStore` と `deps.memoryStore.markContestedGroup` の両方が
    // 配線されていれば群として書き込みを試みる（ADR 0327、ADR 0381）。`relationStore` が無いと穴A吸収・合併の判定に使う `listRelated` が呼べないので、`markContestedGroup` だけでは群を作らない。
    // 群のメンバーは、(1) 検出中の `memory` と `matches` の全員、(2) 穴A: `matches` のうち `contested` で `contestedWithId` を持つものの相手（相方は有効期間の重なり等を満たさず `matches` に現れないことがある）、
    // (3) 合併: ここまでの `contested` な id から `kind: 'contradicts'` を辿って到達できる id を `getMany` で読み直した、**`status === 'contested'` のものだけ**（BFS。forget 等で群を離れたメンバーの関係の行は残るので、
    // そのまま加えると `markContestedGroup` の CAS 全体が `status_conflict` で落ちる。行の有無ではなく status で今の群を判定する）。広げた結果が3件未満なら呼ばない。呼んで `contested_group` にならなかった場合も含め、
    // evidence-only の `memory_events` 追記 + `unresolved_conflict` へフォールバックする（状態が動かなかった呼び出しでも根拠は残す。ADR 0378）。
    let groupOutcome: {
      memberIds: MemoryId[];
      markContestedGroup: MarkContestedGroupResult;
    } | null = null;
    if (deps.relationStore !== undefined && deps.memoryStore.markContestedGroup !== undefined) {
      const relationStore = deps.relationStore;
      const memberIdSet = new Set<MemoryId>([memory.id, ...matches.map((m) => m.id)]);
      for (const m of matches) {
        if (m.status === "contested" && (m.contestedWithId ?? null) !== null) {
          memberIdSet.add(m.contestedWithId!);
        }
      }
      {
        const seedIds = matches
          .filter((m) => m.status === "contested" && (m.contestedWithId ?? null) === null)
          .map((m) => m.id);
        const visited = new Set(seedIds);
        // 幅優先を1段ずつ進める。1段ぶんは `listRelatedMany?` があれば1往復で引く（ADR 0402）。
        let level = [...seedIds];
        const discovered = new Set<MemoryId>();
        while (level.length > 0) {
          const relatedByOrigin = await listRelatedLevel(relationStore, ctx, level, "contradicts");
          const nextLevel: MemoryId[] = [];
          for (const related of relatedByOrigin) {
            for (const r of related) {
              if (!memberIdSet.has(r.memoryId)) {
                discovered.add(r.memoryId);
              }
              if (!visited.has(r.memoryId)) {
                visited.add(r.memoryId);
                nextLevel.push(r.memoryId);
              }
            }
          }
          level = nextLevel;
        }
        if (discovered.size > 0) {
          const discoveredMemories = await deps.memoryStore.getMany(ctx, [...discovered]);
          for (const m of discoveredMemories) {
            if (m.status === "contested") {
              memberIdSet.add(m.id);
            }
          }
        }
      }
      if (memberIdSet.size >= 3) {
        const memberIds = [...memberIdSet];
        // 監査イベントの `note` には件数と id 昇順の先頭 K 件だけを入れる（全員を入れると、群の全メンバーのイベントに N 件ぶん入り N³ バイトになる。ADR 0431）。
        const sortedMemberIds = [...memberIds].sort(compareCodeUnits);
        const sortedMatches = [...matches].sort((a, b) => compareCodeUnits(a.id, b.id));
        const note = JSON.stringify({
          kind: "claim_key_conflict_group",
          claimKey,
          subjectId: memory.subjectId ?? null,
          triggering: describeSide(memory),
          matches: sortedMatches.slice(0, CONTESTED_GROUP_NOTE_SAMPLE_LIMIT).map(describeSide),
          matchCount: matches.length,
          matchesTruncated: matches.length > CONTESTED_GROUP_NOTE_SAMPLE_LIMIT,
          memberIds: sortedMemberIds.slice(0, CONTESTED_GROUP_NOTE_SAMPLE_LIMIT),
          memberCount: memberIds.length,
          memberIdsTruncated: memberIds.length > CONTESTED_GROUP_NOTE_SAMPLE_LIMIT,
        });
        const markResult = await markContestedGroup(ctx, memberIds, { reason: note });
        if (markResult.outcome.kind === "contested_group") {
          groupOutcome = { memberIds, markContestedGroup: markResult };
        }
      }
    }
    if (groupOutcome !== null) {
      return {
        memoryId: memory.id,
        claimKey,
        matchCount: matches.length,
        result: {
          kind: "contested_group",
          memberIds: groupOutcome.memberIds,
          markContestedGroup: groupOutcome.markContestedGroup,
        },
      };
    }

    const sortedUnresolvedMatches = [...matches].sort((a, b) => compareCodeUnits(a.id, b.id));
    await deps.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: memory.id,
      kind: "updated",
      at: clock.now(),
      actor: { type: "system" },
      digestSnapshot: memory.digest,
      meta: {
        reason: "claim_key_conflict_unresolved",
        note: JSON.stringify({
          kind: "claim_key_conflict_unresolved",
          claimKey,
          subjectId: memory.subjectId ?? null,
          triggering: describeSide(memory),
          matches: sortedUnresolvedMatches
            .slice(0, CONTESTED_GROUP_NOTE_SAMPLE_LIMIT)
            .map(describeSide),
          matchCount: matches.length,
          matchesTruncated: matches.length > CONTESTED_GROUP_NOTE_SAMPLE_LIMIT,
        }),
      },
    });
    return {
      memoryId: memory.id,
      claimKey,
      matchCount: matches.length,
      result: { kind: "unresolved_conflict", matchMemoryIds: matches.map((m) => m.id) },
    };
  }

  async function createMemoriesFromCandidates(
    ctx: Ctx,
    observation: Observation,
    candidates: ExtractedMemoryCandidate[],
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
    claimKeys?: readonly (ClaimKey | null)[],
    detectContested?: boolean,
    droppedFields: readonly DroppedAuxField[] = [],
  ): Promise<{
    memoryIds: MemoryId[];
    contentHashes: Set<string>;
    contestedDetection: ContestedDetectionOutcome[];
  }> {
    const newMemories = await buildNewMemoriesForCandidates(
      ctx,
      observation,
      candidates,
      claimKeys,
    );
    const memoryIds: MemoryId[] = [];
    const contentHashes = new Set<string>();
    const contestedDetection: ContestedDetectionOutcome[] = [];
    const jobKinds: OutboxJobKind[] = autoQueueConsolidateReflectOnExtract
      ? ["embed", "consolidate", "reflect"]
      : ["embed"];
    // 保存できない候補（本文の NUL など）は、その候補だけを落として残りを書く（ADR 0347）。core は「保存できない値」と一時的な障害を見分けられず、上限も adapter の都合なので事前には検査できない。
    // `createMemoryWithOutbox` が投げたことだけを根拠にする（書けた後の `created` の追記・衝突の検出の失敗は投げる）。全件が落ちたら最初の例外をそのまま投げ、落とした候補は残った候補の `created` の
    // `meta.droppedCandidates` に残す（そのため候補を全件書いてから `created` を積む）。store が `createMemoriesWithOutboxAndEvents?` を持つなら、書き込みと `created` を1トランザクションに任せる（ADR 0410）。
    // **口が在るかどうかだけで選ぶ。** 撃って投げられたときに旧経路で撃ち直さない（二重に書きうる。ADR 0100）。`now` はこの呼び出し全体で1回だけ読む（同じ observation から作る候補すべてに同じ outbox の `now`）。
    const outboxNow = clock.now();
    const createBatch = deps.memoryStore.createMemoriesWithOutboxAndEvents;
    if (createBatch !== undefined) {
      for (const newMemory of newMemories) {
        contentHashes.add(newMemory.contentHash);
      }
      const batch = await createBatch.call(
        deps.memoryStore,
        ctx,
        newMemories.map((input) => ({ input, jobKinds })),
        (memory, droppedByStore) =>
          buildCreatedEventFor(
            ctx,
            memory,
            observation,
            outcome,
            failure,
            droppedByStore.map(({ index, error }) =>
              describeDroppedCandidate(index, newMemories[index]!.contentHash, error),
            ),
            undefined,
            droppedFields,
          ),
        { now: outboxNow },
      );
      for (const { memory, created } of batch.written) {
        memoryIds.push(memory.id);
        // 冪等な再送（`created === false`）では走らせない（下の旧経路と同じ）。
        if (created && detectContested === true) {
          const outcomeForMemory = await detectClaimKeyContested(ctx, memory);
          if (outcomeForMemory !== null) {
            contestedDetection.push(outcomeForMemory);
          }
        }
      }
      return { memoryIds, contentHashes, contestedDetection };
    }
    const written: Array<{ memory: Memory; created: boolean }> = [];
    const dropped: DroppedCandidate[] = [];
    let firstError: { error: unknown } | null = null;
    for (const [index, newMemory] of newMemories.entries()) {
      contentHashes.add(newMemory.contentHash);
      try {
        written.push(
          await deps.memoryStore.createMemoryWithOutbox(ctx, newMemory, jobKinds, {
            now: outboxNow,
          }),
        );
      } catch (error) {
        firstError ??= { error };
        dropped.push(describeDroppedCandidate(index, newMemory.contentHash, error));
      }
    }
    if (written.length === 0 && firstError !== null) {
      throw firstError.error;
    }
    for (const { memory, created } of written) {
      memoryIds.push(memory.id);
      if (created) {
        await appendCreatedEvent(
          ctx,
          memory,
          observation,
          outcome,
          failure,
          dropped,
          undefined,
          droppedFields,
        );
        // 冪等な再送（`created === false`）では検出を走らせない（新しく `active` になったわけではないため）。
        if (detectContested === true) {
          const outcomeForMemory = await detectClaimKeyContested(ctx, memory);
          if (outcomeForMemory !== null) {
            contestedDetection.push(outcomeForMemory);
          }
        }
      }
    }
    return { memoryIds, contentHashes, contestedDetection };
  }

  /**
   * `ClaimKeyOptions.knownPredicates`（呼び出し側の語彙）と `knownPredicatesFromStore`（store から集める語彙）を合成する（ADR 0329）。後者が偽、または `listActiveClaimPredicates` が無い adapter では、
   * `knownPredicates` をそのまま返し、**store を読まない**（opt-in していない呼び出しで挙動を変えないため）。そうでなければ `listActiveClaimPredicates` を1回呼び、利用者の語彙を先に、集めた一覧を後ろに重複を除いて連結する。
   * `subjectId` は `observation.subjectId ?? null`（候補ごとの `subjectId` 上書きは `deriveClaimKeys` より後に確定するため、観測全体の既定値を使う。ADR 0271）。一覧が空なら `undefined`（「空配列＝渡していない」規約）。
   */
  async function resolveKnownPredicates(
    ctx: Ctx,
    observation: Observation,
    claimKeyOptions: ClaimKeyOptions,
  ): Promise<string[] | undefined> {
    const callerKnown = claimKeyOptions.knownPredicates ?? [];
    const fromStoreOption = claimKeyOptions.knownPredicatesFromStore;
    const listActiveClaimPredicates = deps.memoryStore.listActiveClaimPredicates;
    if (!fromStoreOption || listActiveClaimPredicates === undefined) {
      return callerKnown.length > 0 ? callerKnown : undefined;
    }
    const limit =
      typeof fromStoreOption === "object" && fromStoreOption.limit !== undefined
        ? fromStoreOption.limit
        : DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT;
    const fromStore = await listActiveClaimPredicates.call(deps.memoryStore, ctx, {
      subjectId: observation.subjectId ?? null,
      limit,
    });
    const merged = [...callerKnown];
    for (const predicate of fromStore) {
      if (!merged.includes(predicate)) {
        merged.push(predicate);
      }
    }
    return merged.length > 0 ? merged : undefined;
  }

  /**
   * `deriveClaimKeys` へ渡す `knownSubjects` を決める（ADR 0334）。**`ClaimKeyOptions.knownSubjects` だけを見る。** `subjectCandidates` への暗黙の転用はしない: `claimKey.enabled: true` と `subjectCandidates` を併用する
   * 呼び出し側が、この opt-in を選んでいないのに claim key プロンプトが動いてしまい、「off のときのプロンプトは1バイトも変えない」に反する。転用したいなら同じ配列を `knownSubjects` へ明示的に渡す。
   * store から動的に集める版（`knownPredicatesFromStore` の対）は実装しない: store が自己蓄積した `claim_key_subject`（LLM が自由記述で作った曖昧な値になりがち）を横流しすると、無関係な話題の主張にその値が使い回される汚染を実測した（`claim-key.ts`）。
   */
  function resolveKnownSubjects(claimKeyOptions: ClaimKeyOptions): string[] | undefined {
    if (claimKeyOptions.knownSubjects !== undefined && claimKeyOptions.knownSubjects.length > 0) {
      return claimKeyOptions.knownSubjects;
    }
    return undefined;
  }

  /**
   * 1件の Observation に対して抽出を実行し、作られた（または冪等に既存の）Memory の id を返す。`subjectCandidates`・`claimKeyOptions` は `handleExtractableObservation` の sync 経路からだけ渡り、
   * `processExtractJob`（deferred 側）は渡さない（保存していないから。`reextract` も同じ）。`claimKeyOptions` は既定で無効（`{ enabled: false }` なら `deriveClaimKeys` は呼ばれない。ADR 0315）。
   * `signal`（ADR 0359）は `extractCandidates`・`deriveClaimKeys` の両方へ渡る。どちらも `createMemoriesFromCandidates`（書き込み）より前に投げるので、呼び出し側は何も書いていない状態で例外を受け取る。
   */
  async function runExtraction(
    ctx: Ctx,
    observation: Observation,
    subjectCandidates?: readonly string[],
    claimKeyOptions?: ClaimKeyOptions,
    signal?: AbortSignal,
  ): Promise<{
    memoryIds: MemoryId[];
    outcome: ExtractionOutcome;
    failure: ExtractionFailure | null;
    rejectedSubjectIds: string[];
    claimKeyFailure: ExtractionFailure | null;
    contestedDetection: ContestedDetectionOutcome[];
  }> {
    const {
      candidates: extractedCandidates,
      usedWholeObservationFallback,
      failure,
      rejectedSubjectIds: rawRejectedSubjectIds,
    } = await extractCandidates(deps.llmProvider, ctx, observation, subjectCandidates, signal);
    // ADR 0443: 保存できない補助の欄（digest・tags）だけを落とし、候補は残す。
    const { candidates, droppedFields } = sanitizeCandidatesAuxFields(
      dropLlmSubjectIdsWithoutCandidates(extractedCandidates, subjectCandidates),
      deps.hashContent,
    );
    // 型としては optional だが、`extractCandidates` の両経路が必ず値を埋める。ここの `?? []` は型を合わせるためだけ。
    const rejectedSubjectIds = rawRejectedSubjectIds ?? [];
    const outcome: ExtractionOutcome = usedWholeObservationFallback
      ? "llm_failed_whole_observation"
      : "ok";
    if (candidates.length === 0) {
      // 候補が0件なら早期 return する。`deriveClaimKeys` にも検出にも到達しない（ADR 0315）。
      return {
        memoryIds: [],
        outcome,
        failure,
        rejectedSubjectIds,
        claimKeyFailure: null,
        contestedDetection: [],
      };
    }
    let claimKeys: (ClaimKey | null)[] | undefined;
    let claimKeyFailure: ExtractionFailure | null = null;
    if (claimKeyOptions?.enabled === true) {
      const knownPredicates = await resolveKnownPredicates(ctx, observation, claimKeyOptions);
      const knownSubjects = resolveKnownSubjects(claimKeyOptions);
      const derived = await deriveClaimKeys(
        deps.llmProvider,
        ctx,
        candidates.map((candidate) => candidate.content),
        knownPredicates,
        knownSubjects,
        signal,
      );
      claimKeys = derived.claimKeys;
      claimKeyFailure = derived.failure;
    }
    const { memoryIds, contestedDetection } = await createMemoriesFromCandidates(
      ctx,
      observation,
      candidates,
      outcome,
      failure,
      claimKeys,
      claimKeyOptions?.detectContested === true,
      droppedFields,
    );
    return { memoryIds, outcome, failure, rejectedSubjectIds, claimKeyFailure, contestedDetection };
  }

  /**
   * その Observation から作られた記憶のうち、利用者の意思で退けたものを返す。**`extractorVersion` を問わない**（[ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）。
   * 数える/数えないものは `Runtime.reextract` の doc。版を跨いでも1件でも退けたものがあれば、その Observation の抽出全体を打ち切る（同じ版のときと同じ規律）。
   */
  async function listWithdrawnAmong(ctx: Ctx, existing: readonly Memory[]): Promise<Memory[]> {
    const withdrawn: Memory[] = [];
    for (const memory of existing) {
      if (memory.status === "forgotten" || memory.status === "contested") {
        withdrawn.push(memory);
        continue;
      }
      if (memory.status !== "superseded") continue;
      const events = await deps.eventStore.list(ctx, { memoryId: memory.id, kind: "superseded" });
      // `list` は `at` の昇順（`EventStore.list` の doc）。最後の1件が今の superseded の理由である。
      if (events.at(-1)?.meta.reason === "contested_resolved") withdrawn.push(memory);
    }
    return withdrawn;
  }

  /**
   * `observe()` が LLM 障害で全文フォールバックへ倒れた（または古い抽出器版で作られた）Observation の抽出をやり直す（ADR 0028。契約は `Runtime.reextract`）。`contested` は supersede 対象にしない:
   * 対向 Memory との対で意味を持つ契約（mandatory companion retrieval）があり、機構都合の reextract が対の片方だけを動かすと契約を壊しかねない。
   */
  async function reextract(
    ctx: Ctx,
    observationId: ObservationId,
    opts?: AbortOptions,
  ): Promise<ReextractResult> {
    const now = clock.now();
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.reextract: observation not found: ${observationId}`);
    }
    if (observation.kind === observeInputKindToObservationKind("memory_usage")) {
      throw new Error(
        `runtime.reextract: observation ${observationId} is a usage report (kind: "usage") and is never extracted`,
      );
    }

    const existingAllVersions = await deps.memoryStore.listBySourceObservationAllVersions(
      ctx,
      observationId,
    );
    const withdrawn = await listWithdrawnAmong(ctx, existingAllVersions);
    if (withdrawn.length > 0) {
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: withdrawn.map((memory) => ({
          kind: "status_not_active" as const,
          memoryId: memory.id,
          status: memory.status as Exclude<MemoryStatus, "active">,
        })),
        atomicity: "not_attempted",
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    const {
      candidates: extractedCandidates,
      usedWholeObservationFallback,
      failure,
    } = await extractCandidates(deps.llmProvider, ctx, observation, undefined, opts?.signal);
    // ADR 0443: observe と同じ。保存できない補助の欄（digest・tags）だけを落とし、候補は残す。
    const { candidates, droppedFields } = sanitizeCandidatesAuxFields(
      dropLlmSubjectIdsWithoutCandidates(extractedCandidates, undefined),
      deps.hashContent,
    );

    if (usedWholeObservationFallback) {
      // この早期 return は既存 Memory を「見ていない」。`skipped: []` にすると「何も飛ばさなかった」と嘘をつくので、`not_examined` を明示する（ADR 0029）。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "llm_failed_whole_observation" }],
        atomicity: "not_attempted",
        extraction: "llm_failed_whole_observation",
        extractionFailure: failure,
      };
    }
    if (candidates.length === 0) {
      // ここも既存を見ていない（上と同じ。ADR 0029）。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "no_candidates" }],
        atomicity: "not_attempted",
        extraction: "ok",
        extractionFailure: null,
      };
    }

    // LLM を待つ間に退けられた記憶があっても、上の確認（LLM の前）は古いままなので、LLM が返った直後・書く前に読み直し、1件でも退けられていたら何も書かずに打ち切る（ADR 0406）。
    // `abortIfForgotten` を実装する adapter（`@mnemora/postgres`）は、下の書き込み自身が同一トランザクションの `SELECT … FOR UPDATE` で、読み直しと書き込みの間の窓も閉じる。
    const knownMemoryIds = existingAllVersions.map((memory) => memory.id);
    const abortedSourceForgotten = (
      stopped: ReadonlyArray<{ id: MemoryId; status: Exclude<MemoryStatus, "active"> }>,
    ): ReextractResult => ({
      observationId,
      memoryIds: [],
      supersededMemoryIds: [],
      skipped: stopped.map(({ id, status }) => ({
        kind: "status_not_active" as const,
        memoryId: id,
        status,
      })),
      atomicity: "not_attempted",
      extraction: "skipped",
      extractionFailure: null,
    });
    const forgottenStopped = (ids: readonly MemoryId[]) =>
      ids.map((id) => ({ id, status: "forgotten" as const }));
    if (knownMemoryIds.length > 0) {
      const rechecked = await deps.memoryStore.getMany(ctx, knownMemoryIds);
      const withdrawnNow = await listWithdrawnAmong(ctx, rechecked);
      if (withdrawnNow.length > 0) {
        return abortedSourceForgotten(
          withdrawnNow.map((memory) => ({
            id: memory.id,
            status: memory.status as Exclude<MemoryStatus, "active">,
          })),
        );
      }
    }

    // supersede 判定は「今回作る前」の既存 Memory を基準にする——これから作る Memory 自身が
    // 混ざって「今回作ったものを今回 supersede する」という自己矛盾を起こさないため。
    const existingBefore = await deps.memoryStore.listBySourceObservation(
      ctx,
      observationId,
      extractorVersion,
    );

    const newMemories = await buildNewMemoriesForCandidates(ctx, observation, candidates);
    const contentHashes = new Set(newMemories.map((m) => m.contentHash));

    const { toSupersede: classifiedToSupersede, skipped } = classifyReextractTargets(
      existingBefore,
      contentHashes,
    );

    // 置き換えた側（アンカー）は、今回の抽出で **`active` になる行**でなければならない（ADR 0454）。冪等キー `(sourceObservationId, extractorVersion, contentHash)` は status を問わないので、
    // 候補が同じ版の `superseded`／`archived` な既存行にぶつかると、store はその行を `created: false` で返す。候補列の先頭を位置で選ぶと、その行が置き換えた側になり、
    // X → Y → X と出力が往復したとき、Y は X に置き換えられ X は Y に置き換えられたままで active が0件になる。ぶつかる行は `existingBefore`（LLM の後に読んだ、この版の全 status の行）に居る。
    // ぶつからない先頭の候補をアンカーにし、無ければ（候補が全部、非 active の既存行にぶつかる）何も supersede しない。ぶつかった行は、上の分類が `status_not_active` として `skipped` に載せている。
    const nonActiveHashes = new Set(
      existingBefore.filter((m) => m.status !== "active").map((m) => m.contentHash),
    );
    const anchorIndex = newMemories.findIndex((m) => !nonActiveHashes.has(m.contentHash));
    const toSupersede = anchorIndex === -1 ? [] : classifiedToSupersede;

    // `supersededById` を省略すると `meta` からその欄を落とす（口を使う経路ではアンカーの id が呼び出し前に無く、store が埋める）。監査ログの中身は、口が在る adapter と無い adapter で同一にする。
    const buildSupersedeEventFor = (existing: Memory, supersededById?: MemoryId) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: existing.id,
        kind: "superseded",
        at: now,
        actor: { type: "system" },
        digestSnapshot: existing.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "reextract_superseded",
          ...(supersededById === undefined ? {} : { supersededById }),
          sourceObservationId: observationId,
          extractorVersion,
        },
      }) satisfies NewMemoryEvent;

    const reextractCreated: CreatedEventReextractOpts = { at: now, reextracted: true };

    // 口が在れば、作成と supersede を1トランザクションで撃つ（ADR 0100）。フォールバックは**口の不在に対してだけ**。
    // ⛔ 撃って投げられたときに旧経路で撃ち直さない（「張れなかった」と「張ったが失敗した」が呼び手から区別できなくなる）。
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      let result: Awaited<ReturnType<typeof supersedeWithNewMemories>>;
      try {
        result = await supersedeWithNewMemories.call(
          deps.memoryStore,
          ctx,
          newMemories.map((input) => ({ input, jobKinds: ["embed"] as OutboxJobKind[] })),
          toSupersede.map((existing) => ({
            id: existing.id,
            supersededByIndex: anchorIndex,
            expectedStatus: "active" as MemoryStatus,
            // `meta.supersededById` は store が解決した id で埋める。
            event: buildSupersedeEventFor(existing),
          })),
          {
            now,
            abortIfForgotten: knownMemoryIds,
            buildCreatedEvent: (memory) =>
              buildCreatedEventFor(
                ctx,
                memory,
                observation,
                "ok",
                null,
                [],
                reextractCreated,
                droppedFields,
              ),
          },
        );
      } catch (error) {
        if (isSourceMemoryForgottenError(error)) {
          // 作成も supersede も rollback された。書き込みを試みていないのと区別が付かない。
          return abortedSourceForgotten(forgottenStopped(error.forgottenIds));
        }
        throw error;
      }

      const memoryIds = result.created.map((c) => c.memory.id);
      // store が `createdEventsWritten: true` と**名乗ったときだけ**別の append を省く（ADR 0416）。引数を渡しただけで「積まれた」と決めると、`opts.buildCreatedEvent` を黙って無視する第三者の adapter で `created` がまるごと消える。
      if (result.createdEventsWritten !== true) {
        for (const { memory, created } of result.created) {
          if (created) {
            await appendCreatedEvent(
              ctx,
              memory,
              observation,
              "ok",
              null,
              [],
              reextractCreated,
              droppedFields,
            );
          }
        }
      }

      // CAS に弾かれた対象は**既存の語彙**へ写す。⛔ `ReextractSkip` に新しい kind を足さない（exhaustive switch を持つ第三者を壊しうる）。
      const conflictedIds = new Set(result.conflicted.map((c) => c.id));
      for (const conflict of result.conflicted) {
        skipped.push({
          kind: "status_changed_concurrently",
          memoryId: conflict.id,
          observedStatus: conflict.observedStatus,
        });
      }

      return {
        observationId,
        memoryIds,
        supersededMemoryIds: toSupersede
          .map((existing) => existing.id)
          .filter((id) => !conflictedIds.has(id)),
        skipped,
        extraction: "ok",
        extractionFailure: null,
        atomicity: "store_supported",
      };
    }

    const memoryIds: MemoryId[] = [];
    for (const newMemory of newMemories) {
      let written: Awaited<ReturnType<MemoryStore["createMemoryWithOutbox"]>>;
      try {
        // ADR 0406: `abortIfForgotten` を渡す（実装しない adapter では無視され、上の読み直しだけが保護）。
        written = await deps.memoryStore.createMemoryWithOutbox(ctx, newMemory, ["embed"], {
          now,
          abortIfForgotten: knownMemoryIds,
        });
      } catch (error) {
        if (isSourceMemoryForgottenError(error)) {
          if (memoryIds.length === 0)
            return abortedSourceForgotten(forgottenStopped(error.forgottenIds));
          // 2件目以降で打ち切られた（この経路は1件ずつ書くため、1件目は既にコミット済み）。
          // 書いた分は隠さず返し、既存の supersede には進まない。
          return {
            ...abortedSourceForgotten(forgottenStopped(error.forgottenIds)),
            memoryIds,
            atomicity: "store_unsupported",
            extraction: "ok",
          };
        }
        throw error;
      }
      const { memory, created } = written;
      memoryIds.push(memory.id);
      if (created) {
        await appendCreatedEvent(
          ctx,
          memory,
          observation,
          "ok",
          null,
          [],
          reextractCreated,
          droppedFields,
        );
      }
    }
    const supersededById = memoryIds[Math.max(anchorIndex, 0)]!;

    const supersededMemoryIds: MemoryId[] = [];
    for (const existing of toSupersede) {
      try {
        await deps.memoryStore.updateStatusWithEvent(
          ctx,
          existing.id,
          "superseded",
          { supersededById, expectedStatus: "active" },
          buildSupersedeEventFor(existing, supersededById),
        );
      } catch (error) {
        const skip = classifySupersedeFailure(existing.id, error);
        if (skip === null) {
          // 競合以外の例外は飲み込まずそのまま投げる（`classifySupersedeFailure` の doc 参照）。
          throw error;
        }
        // CAS に弾かれた対象は `supersededMemoryIds` に入れず、`superseded` イベントも積まない（積むと「置き換えた」という監査ログが嘘になる）。
        skipped.push(skip);
        continue;
      }
      supersededMemoryIds.push(existing.id);
    }

    return {
      observationId,
      memoryIds,
      supersededMemoryIds,
      skipped,
      extraction: "ok",
      extractionFailure: null,
      atomicity: "store_unsupported",
    };
  }

  /**
   * `externalId` を渡した場合、`createObservation` の冪等性が `observations` 行にもそのまま効く。(1) `recordUsage`/`reinforce` は、**返ってきた（保存済みの）Observation の payload** で呼ぶ（`input` の値ではない）。
   * 再送では、最初の呼び出しが `createObservation` の後・`recordUsage` の前で落ちていても、保存済みの payload で完了させられる。同じ `externalId` で違う payload が来ても後着は無視する（他 kind の冪等な再送と同じ規約）。
   * (2) 返ってきた Observation の `kind` が `usage` 以外（別 kind と `externalId` が衝突した）なら、payload の形の保証が無いので `recordUsage`/`reinforce` を呼ばず、他 kind の再送と同じ形（`memoryIds: []`、`extraction: 'skipped'`）で返す。
   */
  async function handleMemoryUsage(
    ctx: Ctx,
    input: Extract<ObserveInput, { kind: "memory_usage" }>,
  ): Promise<ObserveResult> {
    const usageObservationKind = observeInputKindToObservationKind(
      "memory_usage" satisfies ObserveInputKind,
    );
    const observation = await deps.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind: usageObservationKind,
      payload: { recallId: input.recallId, usedMemoryIds: input.usedMemoryIds },
      occurredAt: null,
      recordedAt: clock.now(),
    });

    if (observation.kind !== usageObservationKind) {
      // 上の doc コメント2: externalId が別 kind の Observation と衝突した。
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    const storedPayload = UsageObservationPayloadSchema.parse(observation.payload);
    const reinforcedAt = clock.now();
    // 'wall' 以外のテナントでは活動時計の「いま」も一緒に渡し、decayBaseSeq/decayFloorSeq を同じ強化イベントとして進める（ADR 0165）。
    const reinforceOpts = await resolveReinforceOptions(ctx);
    // 使用の記録と強化を別々にコミットすると、その間で落ちたとき記録だけが残り、同じ `externalId` の再送では `recordUsage` が `insertedMemoryIds: []` を返すため強化が二度と呼ばれない。
    // `recordUsageAndReinforce`（任意メソッド）が在れば両方を1トランザクションで撃つ。無い adapter では下の2段のまま（その窓は残る。ADR 0009）。`insertedMemoryIds` の status は確かめない（`MemoryStore.reinforce` の doc）。
    const recordUsageAndReinforce = deps.memoryStore.recordUsageAndReinforce;
    if (recordUsageAndReinforce !== undefined) {
      const { insertedMemoryIds } = await recordUsageAndReinforce.call(
        deps.memoryStore,
        ctx,
        storedPayload.recallId,
        storedPayload.usedMemoryIds,
        reinforcedAt,
        reinforceOpts,
      );
      return {
        observationId: observation.id,
        memoryIds: insertedMemoryIds,
        extraction: "skipped",
        extractionFailure: null,
      };
    }
    const { insertedMemoryIds } = await deps.memoryStore.recordUsage(
      ctx,
      storedPayload.recallId,
      storedPayload.usedMemoryIds,
    );
    // `reinforce` を件数だけ直列に呼ぶと往復が線形に増える（N+1）ので、`reinforceMany`（任意メソッド）が在れば1回に束ねる。
    if (insertedMemoryIds.length > 0) {
      const reinforceMany = deps.memoryStore.reinforceMany;
      if (reinforceMany !== undefined) {
        await reinforceMany.call(
          deps.memoryStore,
          ctx,
          insertedMemoryIds,
          reinforcedAt,
          reinforceOpts,
        );
      } else {
        for (const memoryId of insertedMemoryIds) {
          await deps.memoryStore.reinforce(ctx, memoryId, reinforcedAt, reinforceOpts);
        }
      }
    }

    return {
      observationId: observation.id,
      memoryIds: insertedMemoryIds,
      extraction: "skipped",
      extractionFailure: null,
    };
  }

  /** sync の observe が積んだ extract ジョブを持つ間の `claimedBy`（ADR 0407）。 */
  const SYNC_OBSERVE_CLAIMED_BY = "runtime.observe:sync";

  async function handleExtractableObservation(
    ctx: Ctx,
    input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
    signal?: AbortSignal,
  ): Promise<ObserveResult> {
    const kind = observeInputKindToObservationKind(input.kind);
    const payload = extractObservationPayload(input);
    const extractMode = input.extract ?? "sync";
    // `recordedAt` と outbox 行の `now` に同じ値を使う。
    const now = clock.now();

    const newObservation: NewObservation = {
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? ctx.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind,
      payload,
      occurredAt: input.occurredAt ?? null,
      recordedAt: now,
      // `occurredAt` と同じ経路。deferred 抽出でも値が残るよう Observation に持たせる。
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      // 同じ経路。runtime は常に `{}` 以上の値を書く（ADR 0312）。
      attributes: input.attributes ?? {},
    };

    const { observation, created, jobs } = await deps.memoryStore.createObservationWithOutbox(
      ctx,
      newObservation,
      ["extract"],
      // sync のときだけ、observe が LLM を待つあいだ tick に取られないよう「observe が claim 済み」で積む（ADR 0407）。
      extractMode === "sync" ? { now, claimedBy: SYNC_OBSERVE_CLAIMED_BY } : { now },
    );

    if (!created) {
      // 冪等な再送。渡した欄は再送でも付ける（ADR 0454）。値は「再送は抽出も検出も走らせなかった」から決まる自然な値（弾いた候補なし []・鍵の導出の失敗なし null・検出の対象なし []）。再送の内訳は ADR 0639。
      const existing = await deps.memoryStore.listBySourceObservationAllVersions(
        ctx,
        observation.id,
      );
      const resendMemories: ObserveResendMemory[] = existing
        .map((memory) => ({
          memoryId: memory.id,
          status: memory.status,
          purged: memory.purgedAt != null,
        }))
        .sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
        ...(input.subjectCandidates !== undefined && input.subjectCandidates.length > 0
          ? { rejectedSubjectIds: [] }
          : {}),
        ...(input.claimKey?.enabled === true ? { claimKeyFailure: null } : {}),
        ...(input.claimKey?.detectContested === true ? { contestedDetection: [] } : {}),
        resend: { memories: resendMemories },
      };
    }

    if (extractMode === "deferred") {
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    const { memoryIds, outcome, failure, rejectedSubjectIds, claimKeyFailure, contestedDetection } =
      await runExtraction(ctx, observation, input.subjectCandidates, input.claimKey, signal);
    const extractJob = jobs.find((job) => job.kind === "extract");
    if (extractJob) {
      try {
        await deps.outboxStore.complete(ctx, extractJob.id, extractJob.attempts, {
          at: clock.now(),
        });
      } catch (err) {
        // LLM がリースより長くかかり、tick に取り直されていた（ADR 0407）。observe の書き込み（Observation と抽出した Memory）は既に済んでおり、ジョブの終端は取り直した側が持つ。
        // ここで投げると「書き込み済みなのに失敗」になり `memoryIds` が失われる。良性なので握る（tick 側の `leaseConflicts` と同じ扱い）。それ以外の例外は投げる。
        if (!isOutboxLeaseConflictError(err)) {
          throw err;
        }
      }
    }
    return {
      observationId: observation.id,
      memoryIds,
      extraction: outcome,
      extractionFailure: failure,
      // `subjectCandidates` を渡した呼び出しだけ、この欄を持たせる（空配列＝渡していないと同じ規約）。
      ...(input.subjectCandidates !== undefined && input.subjectCandidates.length > 0
        ? { rejectedSubjectIds }
        : {}),
      // `claimKey.enabled` を渡した呼び出しだけこの欄を持たせる（同じ「渡していない」規約）。
      ...(input.claimKey?.enabled === true ? { claimKeyFailure } : {}),
      // `claimKey.detectContested: true` を渡した呼び出しだけこの欄を持たせる（同じ規約）。
      ...(input.claimKey?.detectContested === true ? { contestedDetection } : {}),
    };
  }

  async function observe(
    ctx: Ctx,
    input: ObserveInput,
    opts?: AbortOptions,
  ): Promise<ObserveResult> {
    // ADR 0496: `attributes` のキー `__proto__` は zod が黙って落とす（属性が消える）ので、parse の前に断る。
    assertNoProtoAttributesKey((input as { attributes?: unknown } | null | undefined)?.attributes);
    const parsed = ObserveInputSchema.parse(input);
    if (parsed.kind === "memory_usage") {
      return handleMemoryUsage(ctx, parsed);
    }
    // `extract: 'deferred'` と `subjectCandidates` の組み合わせは、検証の段（DB へ何も書く前）で明示的に落とす。`subjectCandidates` はどこにも永続化されないため、
    // deferred 側の実行時（`processExtractJob`）は一覧を構造的に見られず、「渡されたのに黙って落とす」と、呼び出し側は候補一覧が効いたと思い込む。
    const extractMode = parsed.extract ?? "sync";
    if (
      extractMode === "deferred" &&
      parsed.subjectCandidates !== undefined &&
      parsed.subjectCandidates.length > 0
    ) {
      throw new Error(
        SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX +
          "pass extract: 'sync' (or omit extract), or drop subjectCandidates",
      );
    }
    // `claimKey` と `extract: 'deferred'` の組み合わせも同じ理由で落とす。
    if (extractMode === "deferred" && parsed.claimKey !== undefined) {
      throw new Error(
        CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX +
          "pass extract: 'sync' (or omit extract), or drop claimKey",
      );
    }
    return handleExtractableObservation(ctx, parsed, opts?.signal);
  }

  async function processExtractJob(
    ctx: Ctx,
    job: OutboxJobRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const observationId = job.payload.observationId;
    if (typeof observationId !== "string") {
      throw new Error("runtime.tick: extract job payload missing observationId");
    }
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.tick: extract job references missing observation: ${observationId}`);
    }
    // 再配達（1回目が書いた後・`complete` の前に止まり、リースが切れた後の2回目）で違う LLM の出力を足さない（ADR 0347）。その Observation から今の抽出器の版で作られた Memory が1件でも在れば、
    // 抽出は済んでいるものとして LLM を呼ばずに返す（`tick` が `complete` する）。
    // - status では絞らない: 全文フォールバック・forget / purge した Memory も「在る」に数える（再配達で、忘れさせた内容を蘇らせない）。
    // - 版で絞る: 旧い版の Memory しか無ければ、新しい版で抽出する。
    // - ここ（extract ジョブの handler）にだけ置く。sync の observe は Observation を作った直後であり、`reextract` は既存が在ってもやり直すのが目的なので、どちらもこの判定を通らない。
    // ⚠ 塞げないもの: 並行の2本（どちらも書く前にこの読みを通る）。1回目が候補の一部だけを書いて止まった場合の残り（作られない。`reextract` で回復する）。
    const existing = await deps.memoryStore.listBySourceObservation(
      ctx,
      observation.id,
      extractorVersion,
    );
    if (existing.length > 0) {
      return;
    }
    await runExtraction(ctx, observation, undefined, undefined, signal);
  }

  function resolveEmbeddingInput(memory: Memory): string {
    return deps.embeddingInput ? deps.embeddingInput(memory) : memory.content;
  }

  async function processEmbedJob(
    ctx: Ctx,
    job: OutboxJobRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error("runtime.tick: embed job payload missing memoryId");
    }
    const memory = await deps.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`runtime.tick: embed job references missing memory: ${memoryId}`);
    }
    // forget した記憶・purge 済みの記憶は、本文（purge 後は墓標）を外部の embedding provider に送らない（ADR 0541）。forget の前に積まれた埋め込みジョブが後から走っても、provider を呼ばず、ベクトルも書かず、
    // `embeddingStatus` も触らずに返す（`failed` にしないので再試行で回り続けない）。判定は上の `get` で読んだ状態による。読んでから provider を呼ぶまでの間に forget されると本文は送られる（塞げない窓）。
    if (isWithdrawnSeed(memory)) {
      return;
    }
    try {
      const [vector] = await runAbortable(signal, (raced) =>
        deps.embeddingProvider.embed(ctx, [resolveEmbeddingInput(memory)], { signal: raced }),
      );
      if (!vector) {
        throw new Error("runtime.tick: embedding provider returned no vector");
      }
      // provider が宣言した `space.dimensions` と違う長さのベクトルは upsert に渡さない（ADR 0393）。Postgres では pgvector の `expected N dimensions` で落ちて原因が SQL の失敗に見え、InMemory / Fake は黙って 'ready' にするため。
      if (vector.length !== deps.embeddingProvider.space.dimensions) {
        throw new Error(
          `runtime.tick: embedding provider returned a vector of the wrong dimension: expected ${deps.embeddingProvider.space.dimensions} dimensions, got ${vector.length}`,
        );
      }
      // 有限性も同じ形で確かめる（ADR 0393）。`NaN`/`Infinity` を upsert に渡さない。
      const badIndex = vector.findIndex((x) => !Number.isFinite(x));
      if (badIndex !== -1) {
        throw new Error(
          `runtime.tick: embedding provider returned a vector containing a non-finite value at index ${badIndex} (${String(vector[badIndex])})`,
        );
      }
      await deps.vectorStore.upsert(ctx, deps.embeddingProvider.space, memory.id, vector);
      // ⚠ `upsert` に成功したあとのこの `ready` の書き込みが一時的に失敗しても、下の `catch` は「埋め込みの失敗」と区別しない——`failed` を書いて投げ直す。
      // 結果: ベクトルは書けているのに記憶は `failed`（`recall` は `not_indexed{ reason: "failed" }` と名乗る）、ジョブは `fail()` で終端になる（Phase 1 に自動リトライは無い）ので、次の `tick` では回復しない。
      // 戻すには `reembed({ statuses: ["failed"], … })` で積み直して `tick` する（`failed → ready` は許される）。
      // 直さない理由: この `catch` の中の `failed` は「ここまでの store 呼び出しのどれかが落ちた」を等しく扱う唯一の口で、`ready` だけ分けても、ジョブが終端になる点（＝リトライが無い点）は変わらず、
      // 一時的な失敗が1件の記憶を `reembed` が要る状態にする、という同じ形が `memoryStore.get` などにもある。
      // 測っているのは `packages/core/src/__tests__/embed-job-ready-write-fails.test.ts`。
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    } catch (err) {
      if (isAbort(signal)) {
        throw err;
      }
      let markFailure: { error: unknown } | null = null;
      try {
        await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
      } catch (markErr) {
        markFailure = { error: markErr };
      }
      if (markFailure !== null) {
        const markErr = markFailure.error;
        throw new Error(
          `runtime.tick: embed job failed (${describeFailure(err)}), and marking ` +
            `embeddingStatus "failed" also failed: ${describeFailure(markErr)}`,
          { cause: err },
        );
      }
      throw err;
    }

    // Issue #1035 / ADR 0124 決定5: 上で読んでから upsert するまでの間に `purge()` が
    // 完了していると、purge の埋め込み削除より後に、purge 前の内容から作ったベクトルを
    // 書いてしまう。書いた後に読み直し、purge 済みなら書いた埋め込みを消す。
    // purge は「内容の上書きをコミット → 埋め込みを消す」の順なので、この読み直しが
    // 上書きより前なら purge 側の削除が upsert より後に来て、後なら、ここで消す。
    // `embeddingStatus` は `purge()` と同じく触らない（purge は `ready` の記憶を
    // `ready` のまま残す）。ここでの失敗は try の外で投げ、`failed` は書かない
    // ——埋め込み自体は成功しているため。`tick()` がジョブの失敗として記録する。
    const afterWrite = await deps.memoryStore.get(ctx, memory.id);
    if ((afterWrite?.purgedAt ?? null) !== null) {
      await deps.vectorStore.delete(ctx, deps.embeddingProvider.space, memory.id);
    }
  }

  /**
   * `job.payload` から `memoryId` を取り出す（ADR 0157）。壊れていたら投げる: 黙って何もしない・空処理として `complete()` しない（ADR 0082）。呼び出し元の `tick()` が catch して `fail()` で終端に落とす。
   */
  function readSeedMemoryIdFromPayload(job: OutboxJobRecord): MemoryId {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error(`runtime.tick: ${job.kind} job payload missing memoryId`);
    }
    return memoryId;
  }

  /**
   * `consolidate()`/`reflect()` は ADR 0089 の公開の約束により、LLM 呼び出しが失敗しても例外を投げず `outcome: "llm_failed"`（`llmFailure` 付き）を正常な戻り値として返す。
   * `processConsolidateJob`/`processReflectJob` が戻り値を捨てると、`tick()` は LLM が落ちても `complete()` して `processed` に数えてしまう。
   * そこで、この2つのハンドラだけがここで結果を見て `llm_failed` を例外に変え、`tick()` の既存の catch → `outboxStore.fail()` 経路
   * （`OutboxStore` 契約の「Phase 1 では失敗したジョブの自動リトライを行わない」どおり、終端に落ちるだけ）に乗せる（ADR 0157）。
   * `consolidate()`/`reflect()` を直接呼ぶ同期 API の契約（LLM 失敗は例外にしない）は変えない。変えるのは `tick()` 経由の自動ジョブの扱いだけである。
   */
  function throwIfLlmFailed(
    kind: "consolidate" | "reflect",
    result: { outcome: string; llmFailure: ExtractionFailure | null },
  ): void {
    if (result.outcome !== "llm_failed") {
      return;
    }
    const detail = result.llmFailure?.message ?? "unknown error";
    throw new Error(`runtime.tick: ${kind} job failed because the llm call failed: ${detail}`);
  }

  /**
   * `tick` の `consolidate` ジョブハンドラ（ADR 0157）。種が見つからなくても投げない（`consolidate()` 自身が `not_found` → `nothing_to_consolidate` の正規の結末として扱う。`processEmbedJob` が投げるのは、embed には「対象が無かった」を表す結末が無いから）。
   * LLM 失敗は `throwIfLlmFailed` が例外に変える。**種の `subjectId` を `ctx.subjectId` に置いてから呼ぶ**（[ADR 0317](../../../docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)）: `tick()` はジョブを subject で絞って
   * claim できないので、食い違うと近傍探索が別の subject から候補を拾い、統合後の `Memory.subjectId` が `null` に畳まれた。種が無い、または種の `subjectId` が `null` のときは渡された `ctx` のまま呼ぶ。
   * `get()` がここと `consolidate()` で2回になるのは、わざと避けていない（主キーの索引読みで安価、opt-in の内側だけ、同じジョブの他の代償に比べて小さい。「既に読んだ種」を渡す形は `consolidate()` 本体を分岐ごとに割る変更になるため採らない）。
   */
  async function processConsolidateJob(
    ctx: Ctx,
    job: OutboxJobRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    const seed = await deps.memoryStore.get(ctx, seedMemoryId);
    const scopedCtx: Ctx =
      seed !== null && typeof seed.subjectId === "string"
        ? { ...ctx, subjectId: seed.subjectId }
        : ctx;
    const result = await consolidate(scopedCtx, { target: { seedMemoryId }, signal });
    throwIfLlmFailed("consolidate", result);
  }

  /** `tick` の `reflect` ジョブハンドラ（ADR 0157）。`processConsolidateJob` と対称で、種の `subjectId` を `ctx.subjectId` に置く（ADR 0317）。LLM 失敗は `throwIfLlmFailed` が例外に変える。 */
  async function processReflectJob(
    ctx: Ctx,
    job: OutboxJobRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    const seed = await deps.memoryStore.get(ctx, seedMemoryId);
    const scopedCtx: Ctx =
      seed !== null && typeof seed.subjectId === "string"
        ? { ...ctx, subjectId: seed.subjectId }
        : ctx;
    // `processConsolidateJob` と同じ理由（ADR 0359）: abort されたら `reflect()` 自体が reject する。
    const result = await reflect(scopedCtx, { target: { seedMemoryId }, signal });
    throwIfLlmFailed("reflect", result);
  }

  /**
   * `tick` がジョブを配る先。**キーの集合は {@link TICK_SUPPORTED_JOB_KINDS} と型で結ばれている**: `Record<TickSupportedJobKind, JobHandler>` なので、片方だけ足す/消すと型検査が落ちる。
   * 型に kind が在るのに分岐が無い、というずれをコンパイル時に止める結び目である。
   */
  const jobHandlers: Record<TickSupportedJobKind, JobHandler> = {
    extract: processExtractJob,
    embed: processEmbedJob,
    consolidate: processConsolidateJob,
    reflect: processReflectJob,
  };
  /**
   * `job.kind`（開いたユニオン＝任意の文字列）で引くための索引。🔴 **プレーンなオブジェクトにしない**: `job.kind` が `"constructor"` / `"toString"` のとき `Object.prototype` 側の関数が返り、
   * 「対応している」と誤判定して呼んでしまう（`kind` は DB の `text` 列から来て、この2語を弾く仕組みは無い）。`Map` は prototype を持たない。
   */
  const jobHandlerLookup = new Map<string, JobHandler>(Object.entries(jobHandlers));

  async function tick(ctx: Ctx, opts: TickOptions): Promise<TickResult> {
    // ADR 0496: `leaseMs` は claim する前に、名指しの例外で断る。0 以下は通す（`TickOptions.leaseMs` の doc）。
    if (typeof opts !== "object" || opts === null) {
      throw new TypeError("Runtime.tick: opts must be an object");
    }
    if (typeof opts.leaseMs !== "number" || !Number.isFinite(opts.leaseMs)) {
      throw new RangeError("Runtime.tick: opts.leaseMs must be a finite number");
    }
    // ADR 0514: `kinds`・`limit`・`claimedBy`・巨大な `leaseMs` も、claim する前に名指しの例外で断る（`undefined` は省略と同じ）。
    if (
      opts.kinds !== undefined &&
      (!Array.isArray(opts.kinds) || opts.kinds.some((k: unknown) => typeof k !== "string"))
    ) {
      throw new TypeError("Runtime.tick: opts.kinds must be an array of strings");
    }
    if (
      opts.limit !== undefined &&
      // `Number.isInteger` は、数でない値・`NaN`・`±Infinity`・小数をまとめて落とす。
      (!Number.isInteger(opts.limit) || opts.limit < 0 || opts.limit >= 2 ** 63)
    ) {
      throw new RangeError(
        "Runtime.tick: opts.limit must be an integer from 0 up to (not including) 2^63",
      );
    }
    if (opts.claimedBy !== undefined) {
      if (typeof opts.claimedBy !== "string") {
        throw new TypeError("Runtime.tick: opts.claimedBy must be a string");
      }
      if (opts.claimedBy.includes("\u0000")) {
        throw new RangeError(
          "Runtime.tick: opts.claimedBy must not contain NUL characters (U+0000)",
        );
      }
    }
    const now = clock.now();
    // `now` 自体が壊れた Date のときは、ここでは見ない（今までどおり store が断る）。
    if (!Number.isNaN(now.getTime())) {
      const leaseExpiresBeforeMs = now.getTime() - opts.leaseMs;
      if (
        Number.isNaN(new Date(leaseExpiresBeforeMs).getTime()) ||
        leaseExpiresBeforeMs < MIN_STORABLE_TIMESTAMP_MS
      ) {
        throw new RangeError(
          "Runtime.tick: opts.leaseMs is out of range (now - leaseMs must be a timestamp every store can hold)",
        );
      }
    }
    const signal = opts.signal;
    const claimOpts: ClaimOutboxJobsOptions = {
      // 既定は「tick が処理できる kind だけ」——ここを広げると、処理できない kind を
      // 呼び出し側が頼んでもいないのに claim して終端で焼くことになる（ADR 0082）。
      kinds: opts.kinds ?? [...TICK_SUPPORTED_JOB_KINDS],
      limit: opts.limit ?? DEFAULT_TICK_LIMIT,
      now,
      claimedBy: opts.claimedBy ?? defaultClaimedBy,
      leaseMs: opts.leaseMs,
    };
    const jobs = await deps.outboxStore.claimBatch(ctx, claimOpts);

    let processed = 0;
    let failed = 0;
    const unsupported: UnsupportedOutboxJob[] = [];
    const leaseConflicts: OutboxLeaseConflict[] = [];
    for (const job of jobs) {
      if (signal?.aborted) {
        break;
      }
      const handler = jobHandlerLookup.get(job.kind);
      if (handler === undefined) {
        // 🔴 処理する分岐が無い kind（ADR 0082）。2つのことを同時にやる。
        // 1. `fail()` で**終端に落とす**。claim したまま何もしないと lease が切れて再び claim され、「claim され続けるがいつまでも進まない」になる。
        // 2. `unsupported` に**名指しで積む**。`failed` に数えるだけだと、「試して失敗した」と同じ顔になって呼び出し側から区別が付かない。
        // CAS（ADR 0142）: `job.attempts` は「自分の claim」を指すフェンシングトークンである。`fail()` 自体がリース競合（`OutboxLeaseConflictError`）で弾かれることもある
        // （別のワーカーが先にこのジョブを再 claim して終端まで進めていた場合）。良性の競合なので `leaseConflicts` に記録し、`unsupported`/`failed` には数えず次のジョブへ進む。
        //
        // この分岐は provider を呼ばないので、`signal` を渡す先も待つ相手も無い。abort を無視するわけではない: abort 済みなら、ループ頭の確認（上）ですでに抜けていて、
        // この分岐へは入らない（どのジョブも `fail()` しない。ADR 0359）。入ったあとの `fail()` は中断しない。
        try {
          await deps.outboxStore.fail(
            ctx,
            job.id,
            `${UNSUPPORTED_KIND_ERROR_PREFIX}${job.kind}`,
            job.attempts,
            { at: clock.now() },
          );
        } catch (err) {
          if (isOutboxLeaseConflictError(err)) {
            leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "fail" });
            continue;
          }
          throw err;
        }
        unsupported.push({ jobId: job.id, kind: job.kind });
        failed += 1;
        continue;
      }
      try {
        await handler(ctx, job, signal);
        // `complete` がリース競合で弾かれることがある（ADR 0142）。処理には成功したが、記録しようとした時点で別のワーカーが再 claim して終端まで進めていた場合。良性なので `leaseConflicts` に記録するだけで、`fail()` は呼ばない。
        await deps.outboxStore.complete(ctx, job.id, job.attempts, { at: clock.now() });
        processed += 1;
      } catch (err) {
        // `handler` の中で abort された例外は、処理を試みて失敗したのではなく待つのをやめただけなので、`fail()` しない・`failed` にも数えない。claim されたまま残り、リースが切れれば次の `tick` が取る（ADR 0359）。
        if (signal?.aborted) {
          break;
        }
        if (isOutboxLeaseConflictError(err)) {
          leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "complete" });
          continue;
        }
        // ここに来る `err` は「`complete()` が `OutboxLeaseConflictError` 以外の例外を返した」ことしか意味しない。`handler` は成功しており、`complete()` が DB 上ではコミット済みなのに
        // （コミット後の接続断・タイムアウト等で）例外だけが返ったケースと区別できない。その場合、下の `fail()` は `completed_at` が付いた行に対する無言の no-op だが、`failed` は1増える（`TickResult.failed` の doc）。
        try {
          await deps.outboxStore.fail(ctx, job.id, describeFailure(err), job.attempts, {
            at: clock.now(),
          });
        } catch (failErr) {
          if (isOutboxLeaseConflictError(failErr)) {
            leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "fail" });
            continue;
          }
          throw failErr;
        }
        failed += 1;
      }
    }
    // abort されていたら `tick()` 自体を reject する。abort までに `complete()` まで記録できたジョブの完了は既に store へ書かれており、reject しても覆らない（ADR 0359）。
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    return { processed, failed, unsupported, leaseConflicts };
  }

  const tokenCounter = deps.tokenCounter ?? heuristicTokenCounter;

  async function recall(ctx: Ctx, query: RecallQuery, opts?: AbortOptions): Promise<RecallResult> {
    return runRecall(
      ctx,
      query,
      {
        memoryStore: deps.memoryStore,
        vectorStore: deps.vectorStore,
        lexicalStore: deps.lexicalStore,
        embeddingProvider: deps.embeddingProvider,
        tenantSettingsStore: deps.tenantSettingsStore,
        relationStore: deps.relationStore,
        clock,
        tokenCounter,
        outputValidation: deps.outputValidation,
      },
      opts?.signal,
    );
  }

  async function getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null> {
    return deps.memoryStore.getRecall(ctx, recallId);
  }

  async function findCorrectionCandidates(
    ctx: Ctx,
    input: FindCorrectionCandidatesInput,
    opts?: AbortOptions,
  ): Promise<FindCorrectionCandidatesResult> {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new RangeError("Runtime.findCorrectionCandidates: limit must be a positive integer");
    }
    const limit = input.limit ?? DEFAULT_CORRECTION_CANDIDATE_LIMIT;
    // `text` は文字列でなければ、`recall()` を呼ぶ前に断る（ADR 0496）。空文字は `recall()` の検証が断る。
    if (typeof input.text !== "string") {
      throw new TypeError("Runtime.findCorrectionCandidates: text must be a string");
    }
    if (input.excludeMemoryIds !== undefined) {
      if (!Array.isArray(input.excludeMemoryIds)) {
        throw new TypeError("Runtime.findCorrectionCandidates: excludeMemoryIds must be an array");
      }
      for (const id of input.excludeMemoryIds as unknown[]) {
        if (typeof id !== "string") {
          throw new TypeError(
            "Runtime.findCorrectionCandidates: excludeMemoryIds must contain only strings",
          );
        }
      }
    }
    // 除外の集合は `recall()` を呼ぶ前に作る（後ろだと、反復できない値で `new Set` が投げたとき recall の記録を書いた後に落ちる）。大文字小文字は無視して突き合わせる（`@mnemora/postgres` は UUID を小文字で返す）。
    const excludeSet = new Set<unknown>();
    for (const id of new Set(input.excludeMemoryIds ?? [])) {
      excludeSet.add(typeof id === "string" ? id.toLowerCase() : id);
    }

    const recallResult = await recall(
      ctx,
      {
        text: input.text,
        activityCounting: input.activityCounting,
      },
      opts,
    );

    // recallRank は「recall() が返した並びでの、1始まりの順位」——除外の前に固定する。
    const ranked = recallResult.memories.map((memory, index) => ({
      memory,
      recallRank: index + 1,
    }));
    const remaining = ranked.filter(({ memory }) => !excludeSet.has(memory.memoryId.toLowerCase()));
    const excludedCount = ranked.length - remaining.length;

    const candidates: CorrectionCandidate[] = remaining
      .slice(0, limit)
      .map(({ memory, recallRank }) => ({
        memoryId: memory.memoryId,
        digest: memory.digest,
        recallRank,
        score: memory.score,
        retrievedVia: memory.retrievedVia,
      }));

    return {
      recallId: recallResult.recallId,
      candidates,
      omitted: recallResult.omitted,
      explain: recallResult.explain,
      outcome: candidates.length > 0 ? "candidates" : "no_candidates",
      recalledCount: recallResult.memories.length,
      excludedCount,
    };
  }

  async function reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    // `limit` の検査（ADR 0433）。省略と、数なのに 0 以上の整数でないもの（負・小数・`NaN`・±`Infinity`）は、store が SQL の `LIMIT` に渡して分かりにくい例外になるので、store を呼ぶ前に `RangeError` にする。
    // ⚠ 断るのは「例外になる値」だけ。`0` と 2^63 未満の正の整数は通す。数以外の型（`null`・数字の文字列・`bigint`）は Postgres が受け付けて成功することがあるので触れない。2^63 以上の数も store の検査に任せる。
    const limit = (opts as { limit?: unknown } | null | undefined)?.limit;
    if (
      limit === undefined ||
      (typeof limit === "number" && (!Number.isInteger(limit) || limit < 0))
    ) {
      throw new RangeError(
        `Runtime.reembed: limit must be a non-negative integer (got ${String(limit)})`,
      );
    }
    return deps.memoryStore.requeueEmbedJobs(ctx, opts, { now: clock.now() });
  }

  /**
   * `archiveDecayed` を一度ローカル変数へ受けてから `undefined` を判定し、`.call(deps.memoryStore, ...)` で `this` を束ね直す（分割代入したメソッドは `this` を失う。ADR 0100 と同じ作法）。
   * `opts.clock` を省略したら `tenant_settings.decay_clock` に従い（ADR 0186）、明示した呼び出し元の挙動は変えない（`??`）。解決した `clock` が `'wall'` のときは `tenant_activity` を読まない。
   */
  async function sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult> {
    const archiveDecayed = deps.memoryStore.archiveDecayed;
    if (archiveDecayed === undefined) {
      return { supported: false, archived: [], reachedLimit: false };
    }
    const clock = opts.clock ?? (await readDecayClock(deps.tenantSettingsStore, ctx));
    const nowSeq =
      opts.nowSeq ??
      (clock === "wall" ? undefined : await readActivitySeq(deps.tenantSettingsStore, ctx));
    const usesSubjectActivityCounters =
      opts.usesSubjectActivityCounters ??
      (await readHasSubjectActivityCounters(deps.tenantSettingsStore, ctx));
    const result = await archiveDecayed.call(deps.memoryStore, ctx, {
      ...opts,
      clock,
      nowSeq,
      usesSubjectActivityCounters,
    });
    return { supported: true, archived: result.archived, reachedLimit: result.reachedLimit };
  }

  async function restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    const lookupKey = memoryLookupKeyFor(ids);
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const outcomes: RestoreArchivedOutcome[] = [];
    const abortAt = (i: number, failure: unknown) => {
      outcomes.push({
        memoryId: ids[i]!,
        kind: "failed",
        error: describeFailure(failure),
      });
      for (let j = i + 1; j < ids.length; j += 1) {
        outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
      }
      return { outcomes };
    };

    // ループ前の読みの失敗も「競合以外の例外」である。まだ1件も書いていないので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    let reinforceOpts: ReinforceOptions | undefined;
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
      reinforceOpts = await resolveReinforceOptions(ctx);
    } catch (error) {
      return abortAt(0, error);
    }
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const actor = opts?.actor ?? { type: "system" };

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(lookupKey(id));
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status !== "archived") {
        outcomes.push({
          memoryId: id,
          kind: "status_not_archived",
          status: current.status as Exclude<MemoryStatus, "archived">,
        });
        continue;
      }

      try {
        const { memory } = await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "active",
          { expectedStatus: "archived" },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "restored",
            at: clock.now(),
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(lookupKey(id), memory);

        // 復帰そのものが「いま必要だ」という明示の信号なので、reinforce して decay_floor_at を復帰の瞬間から引き直す（ADR 0153）。これをしないと、status は active に戻ったのに
        // decayFloorAt が過去を指したままなので、recall() の既定の忘却ゲート（`RecallQuery.includeFullyDecayed` の既定 false）に阻まれて recall に二度と現れない。
        //
        // ⚠ status の復帰は既にここで成功している。reinforce が失敗しても、既に成功した復帰を握り潰さない。outcome は "restored" のままにし（`kind` を "failed" に落とさない）、
        // reinforce の失敗は追加欄 `reinforceError` で運ぶ。下の catch 節の「競合以外の例外は打ち切って残りを not_attempted にする」とは別の規律で、あちらは「書き込みそのものが
        // 起きなかった」場合の安全弁、こちらは「主たる書き込み（status の復帰）は成功したあとの、副次的な強化の失敗」であり、呼び出し側にとっての意味が違う
        // （前者は「何も変わっていない」、後者は「復帰はしたが、忘却ゲートに再び阻まれるかもしれない」）。だから reinforce 専用の内側の try/catch で切り離し、外側の catch に触れさせない。
        const reinforcedAt = clock.now();
        let reinforceError: string | undefined;
        try {
          const reinforced = await deps.memoryStore.reinforce(ctx, id, reinforcedAt, reinforceOpts);
          byId.set(lookupKey(id), reinforced);
        } catch (err) {
          reinforceError = describeFailure(err);
        }

        if (reinforceError === undefined) {
          outcomes.push({ memoryId: id, kind: "restored", previousStatus: "archived" });
        } else {
          outcomes.push({
            memoryId: id,
            kind: "restored",
            previousStatus: "archived",
            reinforceError,
          });
        }
      } catch (error) {
        if (isMemoryStatusConflictError(error)) {
          // 安全弁（`forget` と同じ形）。1回だけ再読して打ち切る。上限の無い再試行ループを作らない。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」なので、下と同じく打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から見えなくなる。
            return abortAt(i, refetchError);
          }
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if (refetched.status === "active") {
            byId.set(lookupKey(id), refetched);
            outcomes.push({ memoryId: id, kind: "status_not_archived", status: "active" });
          } else {
            // active 以外の別の状態に変わっていた（または archived のまま、という二重の競合）。求めていない状態への変化なので conflicted として扱う。
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外は打ち切って、残りは「見ていない」として返す。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { outcomes };
  }

  async function restoreSuperseded(
    ctx: Ctx,
    target: RestoreSupersededTarget,
    opts?: RestoreSupersededOptions,
  ): Promise<RestoreSupersededResult> {
    const supersedingMemoryId = target.supersededById;

    // `opts.dryRun` は別のメソッド（`previewRestoreSupersededBy?`）へ分岐するだけで、下の「実際に戻す」経路には一切触れない（ADR 0237）。
    if (opts?.dryRun === true) {
      const previewRestoreSupersededBy = deps.memoryStore.previewRestoreSupersededBy;
      if (previewRestoreSupersededBy === undefined) {
        return { supported: false, supersedingMemoryId, outcomes: [] };
      }
      const { candidates } = await previewRestoreSupersededBy.call(
        deps.memoryStore,
        ctx,
        supersedingMemoryId,
        { onlyMemoryIds: target.onlyMemoryIds },
      );
      return {
        supported: true,
        supersedingMemoryId,
        outcomes: candidates.map((c): RestoreSupersededOutcome => ({
          memoryId: c.memoryId,
          kind: "would_restore",
          previousStatus: "superseded",
          supersededReason: c.supersededReason,
        })),
      };
    }

    const restoreSupersededBy = deps.memoryStore.restoreSupersededBy;
    if (restoreSupersededBy === undefined) {
      return { supported: false, supersedingMemoryId, outcomes: [] };
    }

    const actor = opts?.actor ?? { type: "system" };
    const { restored } = await restoreSupersededBy.call(
      deps.memoryStore,
      ctx,
      supersedingMemoryId,
      {
        reason: opts?.reason,
        actor,
        at: clock.now(),
      },
      { onlyMemoryIds: target.onlyMemoryIds },
    );

    if (restored.length === 0) {
      return { supported: true, supersedingMemoryId, outcomes: [] };
    }

    // ADR 0165 と同じ理由（`restoreArchived` と同じ）: この呼び出し全体で1回だけ読む。
    const reinforceOpts = await resolveReinforceOptions(ctx);

    // 群の強化を1回に束ねる（`MemoryStore.reinforceMany?` が在るとき）。1件ずつ呼ぶと、群が1件増えるごとに往復が増える。
    // ⚠ **束ねた強化が失敗したら、下の1件ずつの強化へ戻る。** 「強化の失敗は、その要素の `reinforceError` に入り、outcome は restored のまま」という1件ごとの約束を崩さないため。強化は起点を巻き戻さない（ADR 0048）ので、やり直して害は無い。
    const reinforcedById = new Map<MemoryId, Memory>();
    const reinforceMany = deps.memoryStore.reinforceMany;
    if (reinforceMany !== undefined) {
      try {
        const reinforced = await reinforceMany.call(
          deps.memoryStore,
          ctx,
          restored.map((memory) => memory.id),
          clock.now(),
          reinforceOpts,
        );
        for (const memory of reinforced) {
          reinforcedById.set(memory.id, memory);
        }
      } catch {
        reinforcedById.clear();
      }
    }

    const outcomes: RestoreSupersededOutcome[] = [];
    for (const memory of restored) {
      const batched = reinforcedById.get(memory.id);
      if (batched !== undefined) {
        outcomes.push({
          memoryId: memory.id,
          kind: "restored",
          previousStatus: "superseded",
          decayFloorAt: batched.decayFloorAt,
        });
        continue;
      }
      let decayFloorAt = memory.decayFloorAt;
      let reinforceError: string | undefined;
      try {
        const reinforced = await deps.memoryStore.reinforce(
          ctx,
          memory.id,
          clock.now(),
          reinforceOpts,
        );
        decayFloorAt = reinforced.decayFloorAt;
      } catch (err) {
        reinforceError = describeFailure(err);
      }

      outcomes.push(
        reinforceError === undefined
          ? { memoryId: memory.id, kind: "restored", previousStatus: "superseded", decayFloorAt }
          : {
              memoryId: memory.id,
              kind: "restored",
              previousStatus: "superseded",
              decayFloorAt,
              reinforceError,
            },
      );
    }

    return { supported: true, supersedingMemoryId, outcomes };
  }

  async function forget(
    ctx: Ctx,
    target: ForgetTarget,
    opts?: ForgetOptions,
  ): Promise<ForgetResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    const lookupKey = memoryLookupKeyFor(ids);
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const outcomes: ForgetOutcome[] = [];
    const abortAt = (i: number, failure: unknown) => {
      outcomes.push({
        memoryId: ids[i]!,
        kind: "failed",
        error: describeFailure(failure),
      });
      for (let j = i + 1; j < ids.length; j += 1) {
        outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
      }
      return { outcomes };
    };

    // ループ前の一括読みの失敗も「競合以外の例外」である。まだ1件も書いていないので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
    } catch (error) {
      return abortAt(0, error);
    }
    // 同じ id が複数回現れたとき、1回目の書き込み結果を2回目が見るためのローカルの写し。**正しさのためではなく往復のため**: 消しても `outcomes` は変わらない（2回目は書き込み前の status で CAS を撃ち、弾かれ、
    // 読み直して `already_forgotten` に落ち着く。ADR 0087）が、写しが無いと、重複した id 1つにつき「必ず失敗する UPDATE」と「読み直しの SELECT」が余分に飛ぶ。
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const actor = opts?.actor ?? { type: "system" };

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(lookupKey(id));
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status === "forgotten") {
        outcomes.push({ memoryId: id, kind: "already_forgotten" });
        continue;
      }

      const observedStatus = current.status;
      try {
        const { memory } = await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "forgotten",
          { expectedStatus: observedStatus },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "forgotten",
            at: clock.now(),
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(lookupKey(id), memory);
        outcomes.push({ memoryId: id, kind: "forgotten", previousStatus: observedStatus });
      } catch (error) {
        if (isMemoryStatusConflictError(error)) {
          // 安全弁（ADR 0030 と同じ形。ただし `reextract` と違い、1回だけ再読して打ち切る。上限の無い再試行ループを作らない）。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」なので、下と同じく打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から見えなくなる。
            return abortAt(i, refetchError);
          }
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if (refetched.status === "forgotten") {
            byId.set(lookupKey(id), refetched);
            outcomes.push({ memoryId: id, kind: "already_forgotten" });
          } else {
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外は打ち切って、残りは「見ていない」として返す。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { outcomes };
  }

  async function purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    const lookupKey = memoryLookupKeyFor(ids);

    const purgeMemory = deps.memoryStore.purgeMemory;
    const supported = purgeMemory !== undefined;

    if (ids.length === 0) {
      return { supported, outcomes: [] };
    }
    if (!supported) {
      return {
        supported: false,
        outcomes: ids.map((id) => ({ memoryId: id, kind: "not_attempted" }) as const),
      };
    }

    const outcomes: PurgeOutcome[] = [];
    const abortAt = (i: number, failure: unknown) => {
      outcomes.push({
        memoryId: ids[i]!,
        kind: "failed",
        error: describeFailure(failure),
      });
      for (let j = i + 1; j < ids.length; j += 1) {
        outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
      }
      return { supported: true, outcomes };
    };

    // ループ前の一括読みの失敗も「競合以外の例外」である。まだ1件も書いていないので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
    } catch (error) {
      return abortAt(0, error);
    }
    // `forget` と同じ理由（往復の節約。ADR 0087）。正しさのためではない。
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const actor = opts?.actor ?? { type: "system" };
    const dryRun = opts?.dryRun ?? false;

    const cleanupAlreadyPurged = async (
      cleanupCtx: Ctx,
      id: MemoryId,
      outcome: Extract<PurgeOutcome, { kind: "already_purged" }>,
    ): Promise<void> => {
      try {
        await deps.vectorStore.deleteAcrossSpaces(cleanupCtx, [id]);
      } catch (cleanupError) {
        outcome.embeddingCleanup = embeddingCleanupFailed(cleanupError);
      }
      const scrubPurged = deps.memoryStore.scrubPurged;
      if (scrubPurged !== undefined) {
        try {
          await scrubPurged.call(deps.memoryStore, cleanupCtx, [id]);
        } catch (cleanupError) {
          outcome.residueCleanup = residueCleanupFailed(cleanupError);
        }
      }
    };

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(lookupKey(id));
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status !== "forgotten") {
        outcomes.push({
          memoryId: id,
          kind: "status_not_forgotten",
          status: current.status as Exclude<MemoryStatus, "forgotten">,
        });
        continue;
      }
      if ((current.purgedAt ?? null) !== null) {
        const alreadyPurged: Extract<PurgeOutcome, { kind: "already_purged" }> = {
          memoryId: id,
          kind: "already_purged",
        };
        outcomes.push(alreadyPurged);
        if (!dryRun) {
          await cleanupAlreadyPurged(ctx, id, alreadyPurged);
        }
        continue;
      }

      if (dryRun) {
        outcomes.push({ memoryId: id, kind: "would_purge", previousStatus: "forgotten" });
        continue;
      }

      try {
        const { memory } = await purgeMemory.call(
          deps.memoryStore,
          ctx,
          id,
          { content: PURGE_TOMBSTONE_CONTENT, digest: PURGE_TOMBSTONE_DIGEST },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "purged",
            at: clock.now(),
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(lookupKey(id), memory);
        const purgedOutcome: Extract<PurgeOutcome, { kind: "purged" }> = {
          memoryId: id,
          kind: "purged",
          previousStatus: "forgotten",
        };
        outcomes.push(purgedOutcome);

        // ベストエフォート。失敗しても "purged" を "failed" に格下げしない（ADR 0124・ADR 0382。`MemoryStore` 側の書き込みは確定していて、「安全に再試行できる」という failed/not_attempted の意味を裏切るため）。adapter が持つ全 space から消す。
        try {
          await deps.vectorStore.deleteAcrossSpaces(ctx, [id]);
        } catch (cleanupError) {
          // "purged" のまま、失敗だけを任意の欄で知らせる（ADR 0399。成功時は欄を出さない）。
          purgedOutcome.embeddingCleanup = embeddingCleanupFailed(cleanupError);
        }
      } catch (error) {
        if (isMemoryPurgeConflictError(error)) {
          // 安全弁（`forget`/`restoreArchived` と同じ形）。1回だけ再読して打ち切る。上限の無い再試行ループを作らない。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」なので、下と同じく打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から見えなくなる。
            return abortAt(i, refetchError);
          }
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if ((refetched.purgedAt ?? null) !== null) {
            byId.set(lookupKey(id), refetched);
            const racedAlreadyPurged: Extract<PurgeOutcome, { kind: "already_purged" }> = {
              memoryId: id,
              kind: "already_purged",
            };
            outcomes.push(racedAlreadyPurged);
            await cleanupAlreadyPurged(ctx, id, racedAlreadyPurged);
          } else if (refetched.status !== "forgotten") {
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "status_not_forgotten",
              status: refetched.status as Exclude<MemoryStatus, "forgotten">,
            });
          } else {
            // status === "forgotten" かつ purgedAt === null のまま。到達しないはずの防御的な分岐（ADR 0124）。
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外は打ち切って、残りは「見ていない」として返す。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { supported: true, outcomes };
  }

  async function markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult> {
    if (firstId === secondId) {
      throw new RangeError("Runtime.markContested: firstId and secondId must differ");
    }

    const markContestedPair = deps.memoryStore.markContestedPair;
    if (markContestedPair === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const classify = (id: MemoryId, memory: Memory | undefined): MarkContestedSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status !== "active") {
        return { memoryId: id, kind: "status_not_active", status: memory.status };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const found = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
    const lookupKey = memoryLookupKeyFor([firstId, secondId]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const firstSide = classify(firstId, byId.get(lookupKey(firstId)));
    const secondSide = classify(secondId, byId.get(lookupKey(secondId)));
    if (firstSide.kind !== "eligible" || secondSide.kind !== "eligible") {
      return { supported: true, outcome: { kind: "ineligible", sides: [firstSide, secondSide] } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const firstMemory = byId.get(lookupKey(firstId))!;
    const secondMemory = byId.get(lookupKey(secondId))!;
    const buildMeta = (contestedWithId: MemoryId): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested", contestedWithId }
        : { reason: "contested", note: opts.reason, contestedWithId };

    try {
      // 両側の `updated` イベントに同じ `at` を使う。
      const now = clock.now();
      const { first, second } = await markContestedPair.call(
        deps.memoryStore,
        ctx,
        {
          id: firstId,
          event: {
            tenantId: ctx.tenantId,
            memoryId: firstId,
            kind: "updated",
            at: now,
            actor,
            digestSnapshot: firstMemory.digest,
            meta: buildMeta(secondMemory.id),
          },
        },
        {
          id: secondId,
          event: {
            tenantId: ctx.tenantId,
            memoryId: secondId,
            kind: "updated",
            at: now,
            actor,
            digestSnapshot: secondMemory.digest,
            meta: buildMeta(firstMemory.id),
          },
        },
      );
      return { supported: true, outcome: { kind: "contested", first, second } };
    } catch (error) {
      if (isMemoryStatusConflictError(error)) {
        // 安全弁（`forget`/`restoreArchived`/`purge` と同じ形）。1回だけ再読して打ち切る。上限の無い再試行ループを作らない。
        const refetched = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
        const refetchedById = new Map(refetched.map((m) => [lookupKey(m.id), m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: [
              {
                id: firstId,
                observedStatus: refetchedById.get(lookupKey(firstId))?.status ?? null,
              },
              {
                id: secondId,
                observedStatus: refetchedById.get(lookupKey(secondId))?.status ?? null,
              },
            ],
          },
        };
      }
      throw error;
    }
  }

  function assertKnownResolutionKind(caller: string, resolution: ContestedResolution): void {
    const kind = (resolution as { kind?: unknown } | null | undefined)?.kind;
    if (kind !== "supersede" && kind !== "both_active") {
      throw new RangeError(`${caller}: resolution.kind must be "supersede" or "both_active"`);
    }
  }

  async function resolveWinnerSideId(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
  ): Promise<MemoryId | undefined> {
    assertKnownResolutionKind("Runtime.resolveContested", resolution);
    let winnerSideId: MemoryId | undefined;
    if (resolution.kind === "supersede") {
      if (resolution.winnerId === firstId || resolution.winnerId === secondId) {
        winnerSideId = resolution.winnerId;
      } else {
        const lower = resolution.winnerId.toLowerCase();
        const candidates = [firstId, secondId].filter((id) => id.toLowerCase() === lower);
        const candidate = candidates.length === 1 ? candidates[0]! : undefined;
        if (candidate !== undefined) {
          const [winner, side] = await Promise.all([
            deps.memoryStore.get(ctx, resolution.winnerId),
            deps.memoryStore.get(ctx, candidate),
          ]);
          if (winner !== null && side !== null && winner.id === side.id) {
            winnerSideId = candidate;
          }
        }
        if (winnerSideId === undefined) {
          throw new RangeError(
            "Runtime.resolveContested: resolution.winnerId must be firstId or secondId",
          );
        }
      }
    }

    return winnerSideId;
  }

  async function resolveContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
    opts?: ResolveContestedOptions,
  ): Promise<ResolveContestedResult> {
    if (firstId === secondId) {
      throw new RangeError("Runtime.resolveContested: firstId and secondId must differ");
    }
    // 勝者がどちらの側か（渡された `firstId`/`secondId` のどちらか）。`both_active` では使わない。
    const winnerSideId = await resolveWinnerSideId(ctx, firstId, secondId, resolution);

    const resolveContestedPair = deps.memoryStore.resolveContestedPair;
    if (resolveContestedPair === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const classify = (
      id: MemoryId,
      memory: Memory | undefined,
      otherId: MemoryId,
      otherMemory: Memory | undefined,
    ): ResolveContestedSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status !== "contested") {
        return { memoryId: id, kind: "status_not_contested", status: memory.status };
      }
      // 相互参照は、store が返した相手の id と比べる（`contestedWithId` も store の値である）。相手が見つからないときは、渡された id と比べる。
      if (memory.contestedWithId !== (otherMemory?.id ?? otherId)) {
        // ADR 0046 の「一対一が破れた状態」。`markContestedPair` 経由でしか `contestedWithId` は書かれないので到達しないはずだが、防御的に分類する。
        return {
          memoryId: id,
          kind: "pair_broken",
          contestedWithId: memory.contestedWithId ?? null,
        };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const found = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
    const lookupKey = memoryLookupKeyFor([firstId, secondId]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const firstMemory = byId.get(lookupKey(firstId));
    const secondMemory = byId.get(lookupKey(secondId));
    const firstSide = classify(firstId, firstMemory, secondId, secondMemory);
    const secondSide = classify(secondId, secondMemory, firstId, firstMemory);
    if (firstSide.kind !== "eligible" || secondSide.kind !== "eligible") {
      return { supported: true, outcome: { kind: "ineligible", sides: [firstSide, secondSide] } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const resolutionKind = resolution.kind;
    const buildMeta = (contestedWithId: MemoryId): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested_resolved", resolution: resolutionKind, contestedWithId }
        : {
            reason: "contested_resolved",
            resolution: resolutionKind,
            note: opts.reason,
            contestedWithId,
          };

    const buildSide = (
      id: MemoryId,
      memory: Memory,
      contestedWithId: MemoryId,
    ): {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    } => {
      const buildEvent = (
        kind: "updated" | "superseded",
        supersededById?: MemoryId,
      ): NewMemoryEvent => ({
        tenantId: ctx.tenantId,
        memoryId: id,
        kind,
        at: clock.now(),
        actor,
        digestSnapshot: memory.digest,
        meta:
          supersededById === undefined
            ? buildMeta(contestedWithId)
            : { ...buildMeta(contestedWithId), supersededById },
      });
      if (resolution.kind === "both_active") {
        return { id, status: "active", event: buildEvent("updated") };
      }
      if (id === winnerSideId) {
        return { id, status: "active", event: buildEvent("updated") };
      }
      // store へ渡す `supersededById` は渡された `winnerId` のまま。meta には勝者の store の id を載せる。
      return {
        id,
        status: "superseded",
        supersededById: resolution.winnerId,
        event: buildEvent("superseded", contestedWithId),
      };
    };

    try {
      const { first, second } = await resolveContestedPair.call(
        deps.memoryStore,
        ctx,
        buildSide(firstId, firstMemory!, secondMemory!.id),
        buildSide(secondId, secondMemory!, firstMemory!.id),
      );
      return { supported: true, outcome: { kind: "resolved", first, second } };
    } catch (error) {
      if (isMemoryStatusConflictError(error)) {
        // 安全弁（`markContested` と同じ形）。1回だけ再読して打ち切る。上限の無い再試行ループを作らない。
        const refetched = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
        const refetchedById = new Map(refetched.map((m) => [lookupKey(m.id), m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: [
              {
                id: firstId,
                observedStatus: refetchedById.get(lookupKey(firstId))?.status ?? null,
              },
              {
                id: secondId,
                observedStatus: refetchedById.get(lookupKey(secondId))?.status ?? null,
              },
            ],
          },
        };
      }
      throw error;
    }
  }

  async function resolveOrphanedContested(
    ctx: Ctx,
    survivorId: MemoryId,
    opts?: ResolveOrphanedContestedOptions,
  ): Promise<ResolveOrphanedContestedResult> {
    const resolveOrphanedContestedPair = deps.memoryStore.resolveOrphanedContested;
    if (resolveOrphanedContestedPair === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const survivor = await deps.memoryStore.get(ctx, survivorId);
    if (survivor === null) {
      return {
        supported: true,
        outcome: { kind: "ineligible", eligibility: { kind: "not_found" } },
      };
    }
    if (survivor.status !== "contested") {
      return {
        supported: true,
        outcome: {
          kind: "ineligible",
          eligibility: { kind: "status_not_contested", status: survivor.status },
        },
      };
    }
    const contestedWithId = survivor.contestedWithId ?? null;
    if (contestedWithId === null) {
      return {
        supported: true,
        outcome: { kind: "ineligible", eligibility: { kind: "no_contested_with_id" } },
      };
    }
    const opposite = await deps.memoryStore.get(ctx, contestedWithId);
    if (opposite !== null && opposite.status !== "forgotten") {
      return {
        supported: true,
        outcome: {
          kind: "ineligible",
          eligibility: {
            kind: "opposite_not_orphaned",
            contestedWithId,
            oppositeStatus: opposite.status,
          },
        },
      };
    }

    const actor = opts?.actor ?? { type: "system" };
    const meta: Record<string, unknown> =
      opts?.reason === undefined
        ? { reason: "contested_resolved", resolution: "orphan_reclaimed", contestedWithId }
        : {
            reason: "contested_resolved",
            resolution: "orphan_reclaimed",
            note: opts.reason,
            contestedWithId,
          };
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: survivorId,
      kind: "updated",
      at: clock.now(),
      actor,
      digestSnapshot: survivor.digest,
      meta,
    };

    try {
      const { memory } = await resolveOrphanedContestedPair.call(deps.memoryStore, ctx, {
        id: survivorId,
        contestedWithId,
        event,
      });
      return { supported: true, outcome: { kind: "resolved", memory } };
    } catch (error) {
      if (isMemoryStatusConflictError(error)) {
        // 安全弁（`resolveContested` と同じ形）。1回だけ再読して打ち切る。上限の無い再試行ループを作らない。
        const refetched = await deps.memoryStore.get(ctx, survivorId);
        return {
          supported: true,
          outcome: { kind: "conflict", observedStatus: refetched?.status ?? null },
        };
      }
      throw error;
    }
  }

  async function markContestedGroup(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    opts?: MarkContestedGroupOptions,
  ): Promise<MarkContestedGroupResult> {
    if (memberIds.length < 3) {
      throw new RangeError("Runtime.markContestedGroup: memberIds must have at least 3 entries");
    }
    const idSet = new Set<MemoryId>();
    for (const id of memberIds) {
      if (idSet.has(id)) {
        throw new RangeError("Runtime.markContestedGroup: memberIds must be unique");
      }
      idSet.add(id);
    }

    const markContestedGroupPort = deps.memoryStore.markContestedGroup;
    if (markContestedGroupPort === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const lookupKey = memoryLookupKeyFor(memberIds);
    const found = await deps.memoryStore.getMany(ctx, [...memberIds]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }
    const memberKeySet = new Set(memberIds.map((id) => lookupKey(id)));

    const classify = (id: MemoryId, memory: Memory | undefined): MarkContestedGroupSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status === "active") {
        return { memoryId: id, kind: "eligible" };
      }
      if (memory.status === "contested") {
        const contestedWithId = memory.contestedWithId ?? null;
        if (contestedWithId === null || memberKeySet.has(lookupKey(contestedWithId))) {
          return { memoryId: id, kind: "eligible" };
        }
      }
      return {
        memoryId: id,
        kind: "status_conflict",
        status: memory.status,
        contestedWithId: memory.contestedWithId ?? null,
      };
    };

    const sides = memberIds.map((id) => classify(id, byId.get(lookupKey(id))));
    if (sides.some((s) => s.kind !== "eligible")) {
      return { supported: true, outcome: { kind: "ineligible", sides } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const meta: Record<string, unknown> =
      opts?.reason === undefined
        ? { reason: "contested" }
        : { reason: "contested", note: opts.reason };

    try {
      // markContested（2者版）と同じく、群全員の `updated` イベントに同じ `at` を使う。
      const now = clock.now();
      const { members: writtenMembers } = await markContestedGroupPort.call(
        deps.memoryStore,
        ctx,
        memberIds.map((id) => {
          const memory = byId.get(lookupKey(id))!;
          const event: NewMemoryEvent = {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "updated",
            at: now,
            actor,
            digestSnapshot: memory.digest,
            meta,
          };
          return { id, event };
        }),
      );
      return { supported: true, outcome: { kind: "contested_group", members: writtenMembers } };
    } catch (error) {
      if (isMemoryStatusConflictError(error)) {
        const refetched = await deps.memoryStore.getMany(ctx, [...memberIds]);
        const refetchedById = new Map(refetched.map((m) => [lookupKey(m.id), m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: memberIds.map((id) => ({
              id,
              observedStatus: refetchedById.get(lookupKey(id))?.status ?? null,
            })),
          },
        };
      }
      throw error;
    }
  }

  async function resolveContestedGroup(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    resolution: ContestedGroupResolution,
    opts?: ResolveContestedGroupOptions,
  ): Promise<ResolveContestedGroupResult> {
    if (memberIds.length < 3) {
      throw new RangeError("Runtime.resolveContestedGroup: memberIds must have at least 3 entries");
    }
    const idSet = new Set<MemoryId>();
    for (const id of memberIds) {
      if (idSet.has(id)) {
        throw new RangeError("Runtime.resolveContestedGroup: memberIds must be unique");
      }
      idSet.add(id);
    }
    assertKnownResolutionKind("Runtime.resolveContestedGroup", resolution);
    let winnerId: MemoryId | undefined;
    if (resolution.kind === "supersede") {
      if (memberIds.includes(resolution.winnerId)) {
        winnerId = resolution.winnerId;
      } else {
        const lower = resolution.winnerId.toLowerCase();
        const candidates = memberIds.filter((id) => id.toLowerCase() === lower);
        const candidate = candidates.length === 1 ? candidates[0]! : undefined;
        if (candidate !== undefined) {
          const [winner, side] = await Promise.all([
            deps.memoryStore.get(ctx, resolution.winnerId),
            deps.memoryStore.get(ctx, candidate),
          ]);
          if (winner !== null && side !== null && winner.id === side.id) {
            winnerId = candidate;
          }
        }
        if (winnerId === undefined) {
          throw new RangeError(
            "Runtime.resolveContestedGroup: resolution.winnerId must be one of memberIds",
          );
        }
      }
    }

    const resolveContestedGroupPort = deps.memoryStore.resolveContestedGroup;
    if (resolveContestedGroupPort === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const lookupKey = memoryLookupKeyFor(memberIds);
    const found = await deps.memoryStore.getMany(ctx, [...memberIds]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const classify = (
      id: MemoryId,
      memory: Memory | undefined,
    ): ResolveContestedGroupSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status !== "contested") {
        return { memoryId: id, kind: "status_not_contested", status: memory.status };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const sides = memberIds.map((id) => classify(id, byId.get(lookupKey(id))));

    const memberKeySet = new Set(memberIds.map((id) => lookupKey(id)));
    let missingMembers: MemoryId[] = [];
    if (deps.relationStore !== undefined) {
      const visitedKeys = new Set(memberKeySet);
      const visitedIds: MemoryId[] = [...memberIds];
      // 幅優先を1段ずつ進める（1段ぶんは `listRelatedMany?` があれば1往復。ADR 0402）。
      let level: MemoryId[] = [...memberIds];
      while (level.length > 0) {
        const relatedByOrigin = await listRelatedLevel(
          deps.relationStore,
          ctx,
          level,
          "contradicts",
        );
        const nextLevel: MemoryId[] = [];
        for (const related of relatedByOrigin) {
          for (const r of related) {
            const key = lookupKey(r.memoryId);
            if (!visitedKeys.has(key)) {
              visitedKeys.add(key);
              visitedIds.push(r.memoryId);
              nextLevel.push(r.memoryId);
            }
          }
        }
        level = nextLevel;
      }
      const extraIds = visitedIds.filter((id) => !memberKeySet.has(lookupKey(id)));
      if (extraIds.length > 0) {
        const extraMemories = await deps.memoryStore.getMany(ctx, extraIds);
        missingMembers = extraMemories.filter((m) => m.status === "contested").map((m) => m.id);
      }
    }

    if (sides.some((s) => s.kind !== "eligible") || missingMembers.length > 0) {
      return { supported: true, outcome: { kind: "ineligible", sides, missingMembers } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const resolutionKind = resolution.kind;
    const buildMeta = (): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested_resolved", resolution: resolutionKind }
        : { reason: "contested_resolved", resolution: resolutionKind, note: opts.reason };

    try {
      const now = clock.now();
      const membersInput = memberIds.map((id) => {
        const memory = byId.get(lookupKey(id))!;
        const isWinner = resolutionKind === "supersede" && id === winnerId;
        const status: "active" | "superseded" =
          resolutionKind === "both_active" || isWinner ? "active" : "superseded";
        const event: NewMemoryEvent = {
          tenantId: ctx.tenantId,
          memoryId: id,
          kind: status === "active" ? "updated" : "superseded",
          at: now,
          actor,
          digestSnapshot: memory.digest,
          meta:
            status === "superseded" ? { ...buildMeta(), supersededById: winnerId! } : buildMeta(),
        };
        return status === "superseded"
          ? { id, status, supersededById: winnerId!, event }
          : { id, status, event };
      });
      const { members: writtenMembers } = await resolveContestedGroupPort.call(
        deps.memoryStore,
        ctx,
        membersInput,
      );
      return { supported: true, outcome: { kind: "resolved", members: writtenMembers } };
    } catch (error) {
      // 部分解消（ContestedGroupMembershipMismatchError）は、`relationStore` の配線によらず ineligible に写す（ADR 0381）。TOCTOU の競合（下の MemoryStatusConflictError）とは意味が違う（最初から適格でない集合を渡していた）。
      if (isContestedGroupMembershipMismatchError(error)) {
        return {
          supported: true,
          outcome: { kind: "ineligible", sides, missingMembers: [error.missingMemberId] },
        };
      }
      if (isMemoryStatusConflictError(error)) {
        // 安全弁（`resolveContested` と同じ形。1回だけ再読して打ち切る）。
        const refetched = await deps.memoryStore.getMany(ctx, [...memberIds]);
        const refetchedById = new Map(refetched.map((m) => [lookupKey(m.id), m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: memberIds.map((id) => ({
              id,
              observedStatus: refetchedById.get(lookupKey(id))?.status ?? null,
            })),
          },
        };
      }
      throw error;
    }
  }

  async function applyCorrection(
    ctx: Ctx,
    input: ApplyCorrectionInput,
  ): Promise<ApplyCorrectionResult> {
    if (input.correctedId === undefined) {
      return { kind: "awaiting_choice" };
    }
    const correctedId = input.correctedId;

    let candidate = input.discovery.candidates.find((c) => c.memoryId === correctedId);
    if (candidate === undefined) {
      const lower = correctedId.toLowerCase();
      const sameSpelling = input.discovery.candidates.filter(
        (c) => c.memoryId.toLowerCase() === lower,
      );
      if (sameSpelling.length === 1) {
        const [given, listed] = await Promise.all([
          deps.memoryStore.get(ctx, correctedId),
          deps.memoryStore.get(ctx, sameSpelling[0]!.memoryId),
        ]);
        if (given !== null && listed !== null && given.id === listed.id) {
          candidate = sameSpelling[0];
        }
      }
    }
    if (candidate === undefined) {
      return { kind: "not_a_candidate", correctedId };
    }

    if (input.resolution !== undefined) {
      await resolveWinnerSideId(ctx, correctedId, input.correctingId, input.resolution);
    }

    const markResult = await markContested(ctx, correctedId, input.correctingId, {
      actor: input.actor,
      reason: input.reason,
    });

    if (input.resolution === undefined) {
      return {
        kind: "contested",
        correctedId,
        correctingId: input.correctingId,
        chosenRecallRank: candidate.recallRank,
        markResult,
      };
    }

    const resolveResult = await resolveContested(
      ctx,
      correctedId,
      input.correctingId,
      input.resolution,
      { actor: input.actor, reason: input.reason },
    );

    return {
      kind: "resolved",
      correctedId,
      correctingId: input.correctingId,
      chosenRecallRank: candidate.recallRank,
      markResult,
      resolveResult,
    };
  }

  async function consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult> {
    const target = opts.target;

    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null || isWithdrawnSeed(seed)) {
        ids = [target.seedMemoryId];
      } else {
        const recallResult = await recall(
          ctx,
          {
            text: seed.digest,
            activityCounting: target.activityCounting,
            // この recall は `memories` しか読まない（`totalInScope`・目次帯・`filtered*` は読まない）ので、件数の集計（`aggregateScope` の `GROUP BY subject_id`）を発行しない（ADR 0415）。
            scopeAggregate: "skip",
          },
          { signal: opts.signal },
        );
        const minAffinity = target.minAffinity ?? DEFAULT_CONSOLIDATE_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          // 種を除く比較は store が返した種の id（`seed.id`）で行う（大文字の UUID を渡しても、種が近傍に重複しない）。
          .filter((m) => m.memoryId !== seed.id)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと recall() の結果に現れないため）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      const recallResult = await recall(
        ctx,
        { ...target.query, scopeAggregate: target.query.scopeAggregate ?? "skip" },
        { signal: opts.signal },
      );
      const recalledIds = recallResult.memories.map((m) => m.memoryId);
      ids =
        target.maxCandidates === undefined
          ? recalledIds
          : recalledIds.slice(0, target.maxCandidates);
    }
    if (ids.length === 0) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "not_examined",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "expired"; validUntil: Date }
      | { kind: "not_yet_valid"; validFrom: Date }
      | { kind: "active" };

    const validAt = clock.now();

    const uniqueIds = Array.from(new Set(ids));
    const lookupKey = memoryLookupKeyFor(uniqueIds);
    const found = await deps.memoryStore.getMany(ctx, uniqueIds);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }
    const initialById = new Map<MemoryId, InitialClassification>();
    for (const id of uniqueIds) {
      const memory = byId.get(lookupKey(id));
      if (memory === undefined) {
        initialById.set(id, { kind: "not_found" });
      } else if (memory.status !== "active") {
        initialById.set(id, {
          kind: "status_not_active",
          status: memory.status as Exclude<MemoryStatus, "active">,
        });
      } else {
        const validity = classifyValidity(memory, validAt);
        initialById.set(id, validity === null ? { kind: "active" } : validity);
      }
    }

    function mapSources(
      activeOutcome: (id: MemoryId) => ConsolidateSourceOutcome,
    ): ConsolidateSourceOutcome[] {
      return ids.map((id) => {
        const cls = initialById.get(id)!;
        if (cls.kind === "not_found") {
          return { memoryId: id, kind: "not_found" };
        }
        if (cls.kind === "status_not_active") {
          return { memoryId: id, kind: "status_not_active", status: cls.status };
        }
        if (cls.kind === "expired") {
          return { memoryId: id, kind: "expired", validUntil: cls.validUntil };
        }
        if (cls.kind === "not_yet_valid") {
          return { memoryId: id, kind: "not_yet_valid", validFrom: cls.validFrom };
        }
        return activeOutcome(id);
      });
    }

    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "active" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    if (eligibleIds.length === 0) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "nothing_to_consolidate",
        nothingReason: "no_eligible_sources",
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }
    if (eligibleIds.length === 1) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "nothing_to_consolidate",
        nothingReason: "single_eligible_source",
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    if (opts.dryRun === true) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "dry_run",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    const eligibleMemories = eligibleIds.map((id) => byId.get(lookupKey(id))!);

    let llmResult: ConsolidationLLMResult;
    // ADR 0456: LLM が返した補助の欄（digest・tags）のうち保存できない値（NUL）を落とした記録。
    let consolidateDroppedFields: DroppedAuxField[] = [];
    try {
      llmResult = await runAbortable(opts.signal, (raced) =>
        deps.llmProvider.completeStructured(
          ctx,
          {
            prompt: buildConsolidationPrompt(eligibleMemories),
            schema: ConsolidationLLMResultSchema,
          },
          { signal: raced },
        ),
      );
      assertLLMContentNotBlank(llmResult.content, "consolidate");
      const aux = sanitizeCandidateAuxFields(llmResult);
      if (aux.dropped.length > 0) {
        llmResult = aux.candidate;
        const contentHash = deps.hashContent(llmResult.content);
        consolidateDroppedFields = aux.dropped.map((entry) => ({
          index: 0,
          contentHash,
          ...entry,
        }));
      }
    } catch (error) {
      // abort による reject は `"llm_failed"` に丸めずそのまま投げ直す（ADR 0359）。この時点ではまだ何も書いていない。
      if (isAbort(opts.signal)) {
        throw error;
      }
      return {
        atomicity: "not_attempted" as const,
        outcome: "llm_failed",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 1,
        llmFailure: describeExtractionFailure(error),
      };
    }

    const recheckedBeforeConsolidateWrite = await deps.memoryStore.getMany(ctx, eligibleIds);
    const recheckedByIdBeforeConsolidateWrite = new Map<MemoryId, Memory>();
    for (const memory of recheckedBeforeConsolidateWrite) {
      recheckedByIdBeforeConsolidateWrite.set(lookupKey(memory.id), memory);
    }
    const forgottenBeforeConsolidateWrite = new Set(
      eligibleIds.filter(
        (id) => recheckedByIdBeforeConsolidateWrite.get(lookupKey(id))?.status === "forgotten",
      ),
    );
    if (forgottenBeforeConsolidateWrite.size > 0) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "aborted_source_forgotten",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) =>
          forgottenBeforeConsolidateWrite.has(id)
            ? { memoryId: id, kind: "forgotten_before_write" }
            : { memoryId: id, kind: "not_attempted" },
        ),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    const changedBeforeConsolidateWrite = new Map<MemoryId, MemoryStatus>();
    for (const id of eligibleIds) {
      const status = recheckedByIdBeforeConsolidateWrite.get(lookupKey(id))?.status;
      // ADR 0544: contested も superseded と同じに見る（待つ間に訂正の対に入った本文から統合先を作らない）。
      if (status === "superseded" || status === "contested") {
        changedBeforeConsolidateWrite.set(id, status);
      }
    }
    if (
      eligibleIds.every((id) => {
        const status = recheckedByIdBeforeConsolidateWrite.get(lookupKey(id))?.status;
        return status !== undefined && status !== "active";
      })
    ) {
      for (const id of eligibleIds) {
        changedBeforeConsolidateWrite.set(
          id,
          recheckedByIdBeforeConsolidateWrite.get(lookupKey(id))!.status,
        );
      }
    }
    if (changedBeforeConsolidateWrite.size > 0) {
      return {
        atomicity: "not_attempted" as const,
        outcome: "aborted_source_status_changed",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => {
          const observed = changedBeforeConsolidateWrite.get(id);
          return observed !== undefined
            ? { memoryId: id, kind: "status_changed_concurrently", observedStatus: observed }
            : { memoryId: id, kind: "not_attempted" };
        }),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // 統合先の subject（eligible 全件が一致すればその値、割れれば null）の `T + S_x`（ADR 0165・ADR 0394）。
    const activityClockBase = await resolveActivityClockBase(ctx);
    const consolidatedSubjectId = resolveCommonSubjectId(eligibleMemories);
    const activityClockInputs = activityClockInputsFor(
      activityClockBase,
      activityClockBase === undefined
        ? new Map()
        : await readActivitySeqForSubjects(ctx, [consolidatedSubjectId]),
      consolidatedSubjectId,
    );
    const newMemory = buildConsolidatedMemory({
      ctx,
      eligible: eligibleMemories,
      llmResult,
      hashContent: deps.hashContent,
      digestFallbackLength,
      halfLifeHours,
      now,
      ...activityClockInputs,
    });
    const actor = opts.actor ?? { type: "system" };
    const buildCreatedEvent = (memory: Memory) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "created",
        at: now,
        actor,
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "consolidated",
          sources: eligibleMemories.map((m) => m.id),
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
          ...(consolidateDroppedFields.length > 0
            ? { droppedFields: consolidateDroppedFields }
            : {}),
        },
      }) satisfies NewMemoryEvent;
    const buildConsolidateSupersedeEvent = (source: Memory, supersededById?: MemoryId) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: source.id,
        kind: "superseded",
        at: now,
        actor,
        digestSnapshot: source.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "consolidated",
          // 口を使う経路では store が解決した id で埋める（ADR 0100）。監査ログの中身は、口が在る adapter と無い adapter で同一になる。
          ...(supersededById === undefined ? {} : { supersededById }),
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
        },
      }) satisfies NewMemoryEvent;

    const finalOutcomeById = new Map<MemoryId, ConsolidateSourceOutcome>();

    // 口が在れば、作成と supersede を1トランザクションで撃つ（ADR 0100）。⛔ 撃って投げられたときに旧経路で撃ち直さない。
    // 🔴 ADR 0089 の「予期しない例外は打ち切って `not_attempted` で返す（投げない）」を**この経路だけ**覆し、**投げる**。ADR 0089 が「投げない」とした理由（部分的に起きたことを呼び出し側から見えなくしないため）は、
    // 1トランザクションでは部分的に起きたこと自体が無い（全部巻き戻る）ので満たされたままである。⚠ 型は変わらないため、例外を受け止めていない呼び手はコンパイルでは気づけない（ADR 0100）。
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      let result: Awaited<ReturnType<typeof supersedeWithNewMemories>>;
      try {
        result = await supersedeWithNewMemories.call(
          deps.memoryStore,
          ctx,
          [{ input: newMemory, jobKinds: ["embed"] as OutboxJobKind[] }],
          eligibleIds.map((id) => ({
            id,
            supersededByIndex: 0,
            expectedStatus: "active" as MemoryStatus,
            event: buildConsolidateSupersedeEvent(byId.get(lookupKey(id))!),
          })),
          {
            now,
            abortIfForgotten: eligibleIds,
            // ADR 0420: superseded・全件 CAS 弾かれは統合先を commit せず打ち切る（tx ごと巻き戻る）。
            abortIfSuperseded: eligibleIds,
            abortIfAllConflicted: true,
            buildCreatedEvent,
          },
        );
      } catch (error) {
        if (isSourceMemoryForgottenError(error)) {
          const forgottenLate = new Set(error.forgottenIds);
          return {
            // `news`/`supersede` どちらも rollback された。書き込みを試みていないのと呼び出し側からは区別が付かない。
            atomicity: "not_attempted" as const,
            outcome: "aborted_source_forgotten",
            nothingReason: null,
            consolidatedMemoryId: null,
            sources: mapSources((id) =>
              forgottenLate.has(id)
                ? { memoryId: id, kind: "forgotten_before_write" }
                : { memoryId: id, kind: "not_attempted" },
            ),
            llmCalls: 1,
            llmFailure: null,
          };
        }
        if (isSourceMemoryStatusChangedError(error)) {
          const changedLate = new Map(error.changed.map((c) => [c.id, c.observedStatus]));
          return {
            // 全部巻き戻った——書き込みを試みていないのと呼び出し側からは区別が付かない。
            atomicity: "not_attempted" as const,
            outcome: "aborted_source_status_changed",
            nothingReason: null,
            consolidatedMemoryId: null,
            sources: mapSources((id) => {
              const observed = changedLate.get(id);
              return observed !== undefined
                ? { memoryId: id, kind: "status_changed_concurrently", observedStatus: observed }
                : { memoryId: id, kind: "not_attempted" };
            }),
            llmCalls: 1,
            llmFailure: null,
          };
        }
        throw error;
      }

      const consolidated = result.created[0]!;
      // 名乗られたときだけ別の append を省く（reextract と同じ。ADR 0416）。⛔ 投げられたときに撃ち直さない。
      if (consolidated.created && result.createdEventsWritten !== true) {
        await deps.eventStore.append(ctx, buildCreatedEvent(consolidated.memory));
      }

      const conflictedById = new Map(result.conflicted.map((c) => [c.id, c.observedStatus]));
      for (const id of eligibleIds) {
        const observed = conflictedById.get(id);
        finalOutcomeById.set(
          id,
          observed === undefined
            ? { memoryId: id, kind: "superseded", previousStatus: "active" }
            : { memoryId: id, kind: "status_changed_concurrently", observedStatus: observed },
        );
      }

      return {
        outcome: "consolidated",
        nothingReason: null,
        consolidatedMemoryId: consolidated.memory.id,
        sources: mapSources((id) => finalOutcomeById.get(id)!),
        llmCalls: 1,
        llmFailure: null,
        atomicity: "store_supported",
      };
    }

    let consolidatedMemory: Memory;
    let created: boolean;
    try {
      const createResult = await deps.memoryStore.createMemoryWithOutbox(
        ctx,
        newMemory,
        ["embed"],
        { now, abortIfForgotten: eligibleIds, abortIfSuperseded: eligibleIds },
      );
      consolidatedMemory = createResult.memory;
      created = createResult.created;
    } catch (error) {
      if (isSourceMemoryForgottenError(error)) {
        const forgottenLate = new Set(error.forgottenIds);
        return {
          atomicity: "not_attempted" as const,
          outcome: "aborted_source_forgotten",
          nothingReason: null,
          consolidatedMemoryId: null,
          sources: mapSources((id) =>
            forgottenLate.has(id)
              ? { memoryId: id, kind: "forgotten_before_write" }
              : { memoryId: id, kind: "not_attempted" },
          ),
          llmCalls: 1,
          llmFailure: null,
        };
      }
      if (isSourceMemoryStatusChangedError(error)) {
        const changedLate = new Map(error.changed.map((c) => [c.id, c.observedStatus]));
        return {
          atomicity: "not_attempted" as const,
          outcome: "aborted_source_status_changed",
          nothingReason: null,
          consolidatedMemoryId: null,
          sources: mapSources((id) => {
            const observed = changedLate.get(id);
            return observed !== undefined
              ? { memoryId: id, kind: "status_changed_concurrently", observedStatus: observed }
              : { memoryId: id, kind: "not_attempted" };
          }),
          llmCalls: 1,
          llmFailure: null,
        };
      }
      throw error;
    }
    // ADR 0416: この口なしの経路の `created` は別コミットのまま（直さない負債）。
    if (created) {
      await deps.eventStore.append(ctx, buildCreatedEvent(consolidatedMemory));
    }

    for (let i = 0; i < eligibleIds.length; i += 1) {
      const id = eligibleIds[i]!;
      const source = byId.get(lookupKey(id))!;
      try {
        await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "superseded",
          { supersededById: consolidatedMemory.id, expectedStatus: "active" },
          buildConsolidateSupersedeEvent(source, consolidatedMemory.id),
        );
        finalOutcomeById.set(id, { memoryId: id, kind: "superseded", previousStatus: "active" });
      } catch (error) {
        if (isMemoryStatusConflictError(error)) {
          // CAS が破れた——この1件だけ飛ばして続行する（`reextract` と同じ）。
          finalOutcomeById.set(id, {
            memoryId: id,
            kind: "status_changed_concurrently",
            observedStatus: error.observedStatus,
          });
          continue;
        }
        finalOutcomeById.set(id, {
          memoryId: id,
          kind: "failed",
          error: describeFailure(error),
        });
        for (let j = i + 1; j < eligibleIds.length; j += 1) {
          finalOutcomeById.set(eligibleIds[j]!, {
            memoryId: eligibleIds[j]!,
            kind: "not_attempted",
          });
        }
        break;
      }
    }

    // 統合先は既に作られている。途中で supersede が打ち切られても outcome は変わらない（ADR 0089）。
    return {
      outcome: "consolidated",
      nothingReason: null,
      consolidatedMemoryId: consolidatedMemory.id,
      sources: mapSources((id) => finalOutcomeById.get(id)!),
      llmCalls: 1,
      llmFailure: null,
      atomicity: "store_unsupported",
    };
  }

  async function reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult> {
    const target = opts.target;

    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null || isWithdrawnSeed(seed)) {
        ids = [target.seedMemoryId];
      } else {
        const recallResult = await recall(
          ctx,
          {
            text: seed.digest,
            activityCounting: target.activityCounting,
            // この recall は `memories` しか読まない（`totalInScope`・目次帯・`filtered*` は読まない）ので、件数の集計（`aggregateScope` の `GROUP BY subject_id`）を発行しない（ADR 0415）。
            scopeAggregate: "skip",
          },
          { signal: opts.signal },
        );
        const minAffinity = target.minAffinity ?? DEFAULT_REFLECT_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          // 種を除く比較は store が返した種の id（`seed.id`）で行う（大文字の UUID を渡しても、種が近傍に重複しない）。
          .filter((m) => m.memoryId !== seed.id)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと recall() の結果に現れないため）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      const recallResult = await recall(
        ctx,
        { ...target.query, scopeAggregate: target.query.scopeAggregate ?? "skip" },
        { signal: opts.signal },
      );
      const recalledIds = recallResult.memories.map((m) => m.memoryId);
      ids =
        target.maxCandidates === undefined
          ? recalledIds
          : recalledIds.slice(0, target.maxCandidates);
    }
    if (ids.length === 0) {
      return {
        outcome: "not_examined",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "expired"; validUntil: Date }
      | { kind: "not_yet_valid"; validFrom: Date }
      | { kind: "basis_is_reflected" }
      | { kind: "eligible" };

    const validAt = clock.now();

    const uniqueIds = Array.from(new Set(ids));
    const lookupKey = memoryLookupKeyFor(uniqueIds);
    const found = await deps.memoryStore.getMany(ctx, uniqueIds);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }
    const initialById = new Map<MemoryId, InitialClassification>();
    for (const id of uniqueIds) {
      const memory = byId.get(lookupKey(id));
      if (memory === undefined) {
        initialById.set(id, { kind: "not_found" });
      } else if (memory.status !== "active") {
        initialById.set(id, {
          kind: "status_not_active",
          status: memory.status as Exclude<MemoryStatus, "active">,
        });
      } else {
        const validity = classifyValidity(memory, validAt);
        if (validity !== null) {
          initialById.set(id, validity);
        } else if (memory.provenance.kind === "reflected") {
          initialById.set(id, { kind: "basis_is_reflected" });
        } else {
          initialById.set(id, { kind: "eligible" });
        }
      }
    }

    function mapBasis(
      eligibleOutcome: (id: MemoryId) => ReflectBasisOutcome,
    ): ReflectBasisOutcome[] {
      return ids.map((id) => {
        const cls = initialById.get(id)!;
        if (cls.kind === "not_found") {
          return { memoryId: id, kind: "not_found" };
        }
        if (cls.kind === "status_not_active") {
          return { memoryId: id, kind: "status_not_active", status: cls.status };
        }
        if (cls.kind === "expired") {
          return { memoryId: id, kind: "expired", validUntil: cls.validUntil };
        }
        if (cls.kind === "not_yet_valid") {
          return { memoryId: id, kind: "not_yet_valid", validFrom: cls.validFrom };
        }
        if (cls.kind === "basis_is_reflected") {
          return { memoryId: id, kind: "basis_is_reflected" };
        }
        return eligibleOutcome(id);
      });
    }

    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "eligible" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    if (eligibleIds.length === 0) {
      return {
        outcome: "nothing_to_reflect",
        nothingReason: "no_eligible_basis",
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    if (opts.dryRun === true) {
      return {
        outcome: "dry_run",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    const eligibleMemories = eligibleIds.map((id) => byId.get(lookupKey(id))!);

    let llmResult: ReflectionLLMResult;
    // ADR 0456: consolidate と同じ。落とした補助の欄の記録。
    let reflectDroppedFields: DroppedAuxField[] = [];
    try {
      llmResult = await runAbortable(opts.signal, (raced) =>
        deps.llmProvider.completeStructured(
          ctx,
          {
            prompt: buildReflectionPrompt(eligibleMemories),
            schema: ReflectionLLMResultSchema,
          },
          { signal: raced },
        ),
      );
      if (llmResult.outcome === "reflected") {
        assertLLMContentNotBlank(llmResult.content, "reflect");
        const aux = sanitizeCandidateAuxFields(llmResult);
        if (aux.dropped.length > 0) {
          llmResult = aux.candidate;
          const contentHash = deps.hashContent(llmResult.content);
          reflectDroppedFields = aux.dropped.map((entry) => ({ index: 0, contentHash, ...entry }));
        }
      }
    } catch (error) {
      // abort による reject は `"llm_failed"` に丸めずそのまま投げ直す（ADR 0359）。この時点ではまだ何も書いていない。
      if (isAbort(opts.signal)) {
        throw error;
      }
      return {
        outcome: "llm_failed",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 1,
        llmFailure: describeExtractionFailure(error),
      };
    }

    if (llmResult.outcome === "nothing") {
      return {
        outcome: "nothing_to_reflect",
        nothingReason: "llm_declined",
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    const recheckedBeforeReflectWrite = await deps.memoryStore.getMany(ctx, eligibleIds);
    const recheckedByIdBeforeReflectWrite = new Map<MemoryId, Memory>();
    for (const memory of recheckedBeforeReflectWrite) {
      recheckedByIdBeforeReflectWrite.set(lookupKey(memory.id), memory);
    }
    const forgottenBeforeReflectWrite = new Set(
      eligibleIds.filter(
        (id) => recheckedByIdBeforeReflectWrite.get(lookupKey(id))?.status === "forgotten",
      ),
    );
    if (forgottenBeforeReflectWrite.size > 0) {
      return {
        outcome: "aborted_source_forgotten",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) =>
          forgottenBeforeReflectWrite.has(id)
            ? { memoryId: id, kind: "forgotten_before_write" }
            : { memoryId: id, kind: "eligible" },
        ),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    const supersededBeforeReflectWrite = new Map<MemoryId, MemoryStatus>();
    for (const id of eligibleIds) {
      const status = recheckedByIdBeforeReflectWrite.get(lookupKey(id))?.status;
      // ADR 0544: contested も superseded と同じに見る。
      if (status === "superseded" || status === "contested") {
        supersededBeforeReflectWrite.set(id, status);
      }
    }
    if (supersededBeforeReflectWrite.size > 0) {
      return {
        outcome: "aborted_source_status_changed",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) => {
          const observed = supersededBeforeReflectWrite.get(id);
          return observed !== undefined
            ? { memoryId: id, kind: "status_changed_before_write", observedStatus: observed }
            : { memoryId: id, kind: "eligible" };
        }),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // 反映先の subject（eligible 全件が一致すればその値、割れれば null）の `T + S_x`（ADR 0165・ADR 0394）。
    const activityClockBase = await resolveActivityClockBase(ctx);
    const reflectedSubjectId = resolveCommonSubjectId(eligibleMemories);
    const activityClockInputs = activityClockInputsFor(
      activityClockBase,
      activityClockBase === undefined
        ? new Map()
        : await readActivitySeqForSubjects(ctx, [reflectedSubjectId]),
      reflectedSubjectId,
    );
    const newMemory = buildReflectedMemory({
      ctx,
      eligible: eligibleMemories,
      llmResult,
      hashContent: deps.hashContent,
      digestFallbackLength,
      halfLifeHours,
      now,
      ...activityClockInputs,
    });
    const buildReflectedCreatedEvent = (memory: Memory) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "created",
        at: now,
        actor: opts.actor ?? { type: "system" },
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "reflected",
          sources: eligibleMemories.map((m) => m.id),
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
          ...(reflectDroppedFields.length > 0 ? { droppedFields: reflectDroppedFields } : {}),
        },
      }) satisfies NewMemoryEvent;
    const createBatch = deps.memoryStore.createMemoriesWithOutboxAndEvents;
    let reflectedMemory: Memory;
    let created: boolean;
    let createdEventWritten = false;
    try {
      if (createBatch !== undefined) {
        const batch = await createBatch.call(
          deps.memoryStore,
          ctx,
          [{ input: newMemory, jobKinds: ["embed"] as OutboxJobKind[] }],
          (memory) => buildReflectedCreatedEvent(memory),
          { now, abortIfForgotten: eligibleIds, abortIfSuperseded: eligibleIds },
        );
        // 候補は1件なので、全件が落ちたなら store は最初の例外を投げている（`dropped` は空のはず）。
        // 契約に反して `written` が空で返ったときは、落とした例外があればそれを、無ければ契約違反として投げる。
        const only = batch.written[0];
        if (only === undefined) {
          throw (
            batch.dropped[0]?.error ??
            new Error(
              "MemoryStore.createMemoriesWithOutboxAndEvents returned no written entry for a single candidate",
            )
          );
        }
        reflectedMemory = only.memory;
        created = only.created;
        createdEventWritten = true;
      } else {
        const createResult = await deps.memoryStore.createMemoryWithOutbox(
          ctx,
          newMemory,
          ["embed"],
          { now, abortIfForgotten: eligibleIds, abortIfSuperseded: eligibleIds },
        );
        reflectedMemory = createResult.memory;
        created = createResult.created;
      }
    } catch (error) {
      if (isSourceMemoryForgottenError(error)) {
        const forgottenLate = new Set(error.forgottenIds);
        return {
          outcome: "aborted_source_forgotten",
          nothingReason: null,
          reflectedMemoryId: null,
          basis: mapBasis((id) =>
            forgottenLate.has(id)
              ? { memoryId: id, kind: "forgotten_before_write" }
              : { memoryId: id, kind: "eligible" },
          ),
          llmCalls: 1,
          llmFailure: null,
        };
      }
      if (isSourceMemoryStatusChangedError(error)) {
        const changedLate = new Map(error.changed.map((c) => [c.id, c.observedStatus]));
        return {
          outcome: "aborted_source_status_changed",
          nothingReason: null,
          reflectedMemoryId: null,
          basis: mapBasis((id) => {
            const observed = changedLate.get(id);
            return observed !== undefined
              ? { memoryId: id, kind: "status_changed_before_write", observedStatus: observed }
              : { memoryId: id, kind: "eligible" };
          }),
          llmCalls: 1,
          llmFailure: null,
        };
      }
      throw error;
    }
    if (created && !createdEventWritten) {
      await deps.eventStore.append(ctx, buildReflectedCreatedEvent(reflectedMemory));
    }

    return {
      outcome: "reflected",
      nothingReason: null,
      reflectedMemoryId: reflectedMemory.id,
      basis: mapBasis((id) => ({ memoryId: id, kind: "used" })),
      llmCalls: 1,
      llmFailure: null,
    };
  }

  return guardRuntimeEntry({
    observe,
    tick,
    recall,
    getRecall,
    findCorrectionCandidates,
    reextract,
    reembed,
    sweepArchive,
    restoreArchived,
    restoreSuperseded,
    forget,
    purge,
    markContested,
    resolveContested,
    resolveOrphanedContested,
    markContestedGroup,
    resolveContestedGroup,
    applyCorrection,
    consolidate,
    reflect,
  });
}

/**
 * `Runtime` の各メソッドの入口と出口に掛ける関門（[ADR 0423](../../../docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)）。
 *
 * - **入口**: 第1引数の {@link Ctx}（`tenantId`・`subjectId`）と、`observe` の入力の `subjectId`・`externalId` が
 *   孤立サロゲートか NUL を含めば、何も書かずに {@link MalformedIdentifierError} で拒む（正規化はしない）。
 *   本文（`text` など）は検査しない。`Runtime` のメソッドを新しく足したときは、ここを通る（全メソッドに掛かる）。
 * - **出口**: store などが投げた例外の `message` から、SQL に付けた値（params）を落とす
 *   （{@link omitParamsFromError}）。例外そのもの（`kind`・`cause`）は変えない。
 */
function guardRuntimeEntry(runtime: Runtime): Runtime {
  const guarded: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(runtime) as Array<
    [string, (...args: unknown[]) => Promise<unknown>]
  >) {
    guarded[name] = (...args: unknown[]): Promise<unknown> => {
      try {
        assertWellFormedCtx(args[0] as Ctx);
        if (name === "observe") {
          const input = args[1] as { subjectId?: unknown; externalId?: unknown } | null | undefined;
          assertWellFormedIdentifier(input?.subjectId, "input.subjectId");
          assertWellFormedIdentifier(input?.externalId, "input.externalId");
        }
        return method(...args).catch((error: unknown) => {
          throw omitParamsFromError(error);
        });
      } catch (error) {
        return Promise.reject(error);
      }
    };
  }
  return guarded as unknown as Runtime;
}
