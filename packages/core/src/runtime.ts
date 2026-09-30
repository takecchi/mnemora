import { z } from "zod";
import { abortReason, isAbort, runAbortable } from "./abort.js";
import type { AbortOptions } from "./abort.js";
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
import { describeFailure } from "./failure-description.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { EventStore } from "./interfaces/event-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import {
  isContestedGroupMembershipMismatchError,
  isMemoryPurgeConflictError,
  isMemoryStatusConflictError,
  isSourceMemoryForgottenError,
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
import { detectLanguageMismatch } from "./language-mismatch.js";
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

/**
 * `runtime.observe` / `runtime.tick` の実装（roadmap.md 段階3、docs/architecture.md §3.2・§3.3）。
 *
 * **runtime は `packages/core` に置く**（docs/architecture.md §4）。ただし core は zod 以外の
 * 実行時依存を持てない（§3.6）ため、DB・LLM・埋め込み・時刻・ハッシュ計算はすべて
 * `createRuntime(deps)` の呼び出し側が注入する。core 自身はこれらの実体を import しない。
 *
 * D16 の反映: `contentHash`（SHA-256 hex）の実装は core に置かない。`deps.hashContent` として
 * 注入される関数（`node:crypto` を使う実装は adapter 側、例えば `packages/postgres` の
 * `sha256Hex`）に委ねる。runtime はこの関数を「呼ぶ」だけで、計算そのものは行わない。
 */

export interface RuntimeConfig {
  /**
   * 抽出器のバージョン。冪等キー `(observationId, extractorVersion)` の一部になる。
   * 省略時（`undefined`・`null`）は `"v1"`。空文字は既定に倒れず、空文字のまま書かれる。
   */
  extractorVersion?: string;
  /**
   * `provenance.inferred.model` に書き込むモデル識別子。呼び出し側の LLMProvider の実体に合わせる。
   * 省略時（`undefined`・空文字）は `"unknown"`。空白だけの値はそのまま書く。
   */
  llmModelId?: string;
  /**
   * `provenance.inferred.promptVersion`。抽出プロンプトを変えたら上げる。省略時（`undefined`・空文字）は `"v1"`。
   * 空白だけの値はそのまま書く。
   */
  promptVersion?: string;
  /**
   * digest フォールバック（機械的な先頭文字列切り出し）の最大文字数。既定 200。
   * ⚠ 値は検査しない（今の振る舞い）。0・負の数・`NaN` を渡すと、本文が収まらない限り
   * digest は `"…"` だけになる（本文は `content` にそのまま残る）。
   */
  digestFallbackLength?: number;
  /**
   * `tick` の既定 claimedBy 値。複数ワーカーを区別したい場合に指定する。省略時は `"runtime.tick"`。
   * ⚠ 空文字は既定に倒れず、そのまま `OutboxStore.claimBatch` に渡る（`ClaimOutboxJobsOptions.claimedBy` の doc）。
   */
  defaultClaimedBy?: string;
  /**
   * [Issue #204](https://github.com/takecchi/mnemora/issues/204) /
   * [ADR 0157](../../../docs/decisions/0157-tick-drives-consolidate-and-reflect.md):
   * `extract`（`observe()` の sync 経路・`tick()` の `extract` ジョブ経路の両方）が新しい
   * Memory を1件作るたびに、その `memoryId` を種にした `consolidate` / `reflect` の
   * outbox ジョブも追加で積むかどうか。
   *
   * 🔴 **既定は `false`（積まない）。** 北極星の問い2（「これを無効にしたとき、
   * Memory Framework として成立するか」）を満たすための opt-in——この設定を有効に
   * しなくても `observe()`/`recall()`/`tick()` は完全に成立し、`tick()` は
   * `embed` ジョブだけを処理し続ける。`consolidate()`/`reflect()` 自体は
   * この設定と無関係に、呼び出し側が明示的に呼べば常に動く（ADR 0089/0091）。
   *
   * `true` にすると、積む job kinds が `["embed"]` から `["embed", "consolidate", "reflect"]`
   * に変わる。ジョブの `payload` は既存の `embed` ジョブと同じ `{ memoryId }`
   * （`MemoryStore.createMemoryWithOutbox` が `jobKinds` の各要素に同じ payload を使う。
   * 新しい payload 形は発明していない）。`tick()` はその2種を
   * `consolidate(ctx, { target: { seedMemoryId: memoryId } })` /
   * `reflect(ctx, { target: { seedMemoryId: memoryId } })` として処理する。
   *
   * 🔴 **`consolidate`・`reflect` のどちらも、渡された `ctx` そのままではない**
   * （`consolidate` は [Issue #579](https://github.com/takecchi/mnemora/issues/579) /
   * [ADR 0317](../../../docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)
   * 決定1、`reflect` は [Issue #820](https://github.com/takecchi/mnemora/issues/820) /
   * ADR 0317 決定3「確かめていないこと」を埋めた変更）。`processConsolidateJob` /
   * `processReflectJob` はどちらも種の Memory を読み、その `subjectId` が `null` でなければ
   * `ctx.subjectId` をそれで置き換えてから `consolidate()` / `reflect()` を呼ぶ——`tick()`
   * はジョブを subject で絞って claim できないため、`tick()` に渡した `ctx.subjectId` と
   * 種の `subjectId` が食い違うと、近傍探索（`recall()`）が種と別の subject から候補を
   * 集めてしまい、統合後・反映後の `Memory.subjectId` が `null` に畳まれる（`consolidate`
   * は ADR 0310 実測、`reflect` は Issue #820 実測）。種の `subjectId` が `null`、または
   * 種そのものが見つからない場合は、今日どおり `tick()` に渡された `ctx` のまま呼ぶ——
   * どちらも新しい判定は発明していない。**明示的に
   * `runtime.consolidate(ctx, { target: { seedMemoryId } })` /
   * `runtime.reflect(ctx, { target: { seedMemoryId } })` を呼ぶ側の挙動はこの設定と
   * 無関係に変わらない**——呼び手は自分の `ctx.subjectId` で完全に制御できる
   * （ADR 0310 決定2）。
   */
  autoQueueConsolidateReflectOnExtract?: boolean;
}

const DEFAULT_EXTRACTOR_VERSION = "v1";
const DEFAULT_LLM_MODEL_ID = "unknown";
const DEFAULT_PROMPT_VERSION = "v1";
const DEFAULT_DIGEST_FALLBACK_LENGTH = 200;
const DEFAULT_CLAIMED_BY = "runtime.tick";
const DEFAULT_TICK_LIMIT = 50;

/**
 * Issue #1136: `consolidate` / `reflect` の `{ seedMemoryId }` 形で、種の `digest` を検索語にして
 * 近傍を集めてよいか。forget と purge は、利用者が「使わないでほしい」と言った記憶である——その
 * `digest` で近傍を束ねると、消した情報が別の形で効き続ける（#897 / ADR 0124 が observe の再送で
 * 「消した情報が蘇るので抽出をやり直さない」と決めたのと同じ線。クローン miku の判断）。
 * `contested` / `superseded` の種は利用者が消したものではないので、今どおり近傍を集める。
 */
function isWithdrawnSeed(seed: Memory): boolean {
  return seed.status === "forgotten" || (seed.purgedAt ?? null) !== null;
}

/**
 * `tick` が**実際に処理する分岐を持つ** outbox job kind（ADR 0082）。
 *
 * ⚠ **ここに「いまは extract と embed だけ」と書かない。**この配列そのものが答えであり、
 * 散文で数え直した瞬間に、次に kind が増えたとき（`consolidate` / `reflect` の本体、
 * 利用者が足す第5・第6の kind）に黙って嘘になる。**コメントは検査されない。**
 *
 * 🔴 **これが「tick が何を処理するか」の唯一の出所である。**`claimBatch` の `kinds` の
 * 既定値も、ジョブを配る先（`jobHandlers`）も、`OutboxJobKind` の JSDoc も、ここを指す。
 * issue #105 の根は、この一覧が3か所（`OutboxJobKind` の名指しの列挙・`tick` の claim
 * 既定値・`if (job.kind === ...)` の分岐）に別々に写されていて、独立にずれたことだった。
 * `jobHandlers` は `Record<TickSupportedJobKind, JobHandler>` として書いてあるので、
 * **この配列に kind を足してハンドラを足し忘れると型検査が落ちる**（逆も落ちる）。
 *
 * ⚠ `OutboxJobKind` は `(string & {})` を含む開いたユニオンであり、ここに無い kind を
 * 積むこと自体は正しい使い方である（利用者が独自の種別を足して別経路で処理する）。
 * ここに無い kind を **`tick` に渡した**ときの倒れ方は {@link TickResult.unsupported} を見ること。
 */
export const TICK_SUPPORTED_JOB_KINDS = ["extract", "embed", "consolidate", "reflect"] as const;

/** {@link TICK_SUPPORTED_JOB_KINDS} の要素型。 */
export type TickSupportedJobKind = (typeof TICK_SUPPORTED_JOB_KINDS)[number];

/**
 * `tick` が `fail()` へ書き込む `last_error` の接頭辞。
 * 「対応していない kind だった」ことは {@link TickResult.unsupported} が第一の伝達路であり、
 * こちらは**後から outbox 行だけを見た人**（運用者・DB を覗いた人）が同じ結論に届くための
 * 二の路である。定数にしてあるのは、歯がこの文字列を名指しで測るため。
 */
export const UNSUPPORTED_KIND_ERROR_PREFIX = "runtime.tick: unsupported outbox job kind: ";

/**
 * `tick` が1件の outbox ジョブを処理する関数の形。
 *
 * `signal`（Issue #1200、ADR 0359）は `tick(ctx, opts)` の `opts.signal` をそのまま渡す。
 * provider を呼ぶハンドラ（`processExtractJob`・`processEmbedJob`・`processConsolidateJob`・
 * `processReflectJob`）だけがこれを使う——`tick` 側の分岐（unsupported kind の `fail()`）は
 * provider を呼ばないため、そもそも受け取らない。
 */
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
   * 語彙候補生成チャンネル（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
   *
   * **省略可能である。**省略しても mnemora は成立する（北極星の問い2）——
   * `recall()` の既定は ANN 1本のままで、何も変わらない。
   *
   * **🔴 省略したまま `RecallQuery.channels` に `"lexical"` を渡すと `recall()` は投げる**
   * （`recall.ts` の `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`）。**黙って0件を返さない**——
   * 理由は `RecallQuery.channels` の doc に書いてある。
   */
  lexicalStore?: LexicalStore;
  /**
   * `memory_relations` を読む store（Issue #207/#933 PR2、ADR 0292 決定1、ADR 0327、
   * ADR 0381）。
   *
   * **省略可能である。**省略しても mnemora は成立する（北極星の問い2）——省略時は
   * `detectClaimKeyContested` の `contested_group` 分岐が組み立てる `members` は常に
   * 「新しく重なった相手」だけになり、既存の穴A（2者間の対）の相方吸収・既存群の合併は
   * 行われない（`markContestedGroup`/`resolveContestedGroup` 自体は呼べるが、
   * 呼び出し側がこの store 無しに安全に集合を広げる手段が無いため）。`resolveContestedGroup`
   * の「渡された `members` が群の全員と一致するか」という読み側の事前確認
   * （`Runtime.resolveContestedGroup` の doc コメント手順6）も、この欄が無ければ行わず
   * store 側の CAS だけに任せる。
   */
  relationStore?: RelationStore;
  /** 監査ログ（`memory_events`）を読み書きする store。 */
  eventStore: EventStore;
  /** テナントの設定（既定の半減期・減衰の時計・保持期間など）を読む store。 */
  tenantSettingsStore: TenantSettingsStore;
  /** 抽出・統合・内省・claim key に使う LLM。 */
  llmProvider: LLMProvider;
  /** 記憶とクエリの埋め込みに使う provider。ベクトルはこの `space` の空間として `vectorStore` に書かれる（`@mnemora/postgres` では、先に `registerEmbeddingSpace` で登録しておく）。 */
  embeddingProvider: EmbeddingProvider;
  /**
   * 省略時は `systemClock`。
   * ⚠ 注入した時計は、store が埋める時刻（監査ログの `at`・outbox の `availableAt` など）には届かず、
   * 壁時計より過去の時計では `tick` がジョブを取らない。reinforce は注入した時計に従うが、監査ログの `at` は
   * `restoreSuperseded` の `unsuperseded` だけが注入した時計で、`restoreArchived` の `restored`・`sweepArchive` の
   * `archived` は壁時計——{@link Clock} の doc 参照（Issue #1237）。
   */
  clock?: Clock;
  /** D16: SHA-256 hex 等、content からハッシュを計算する関数（core は計算しない）。 */
  hashContent: (content: string) => string;
  /** runtime の設定（{@link RuntimeConfig}）。省略すると既定値で動く。 */
  config?: RuntimeConfig;
  /**
   * roadmap.md 段階4: `usage`（docs/recall.md §6）の計測に使う。省略時は
   * `heuristicTokenCounter`（文字数ベースの推定、`counter: 'heuristic'`）。
   */
  tokenCounter?: TokenCounter;
  /**
   * `recall()` の戻り値を zod で検証するときの倒れ方（Issue #131、ADR 0098）。
   * 省略時は `"report"`（`DEFAULT_RECALL_OUTPUT_VALIDATION`（`recall-output-validation.ts`））——既定では投げない。
   * `recall-runtime.js` の `RecallRuntimeDeps.outputValidation` へそのまま渡る。
   */
  outputValidation?: RecallOutputValidationMode;
  /**
   * `processEmbedJob` が `embed(ctx, [...])` へ送る文字列を、`Memory` から差し替える
   * **任意**のフック（Issue #753、#449 の残り。ADR 0305 は「上限超過は例外」を契約に
   * 明記したが、失敗した Memory を回復する口までは開けなかった——`reembed()`
   * （ADR 0079）は failed を pending に戻して embed ジョブを積み直すだけで、次の
   * `processEmbedJob` はまた同じ `memory.content` を送って同じ理由でまた failed に
   * 戻る。このフックがその回復の口である）。
   *
   * **省略時は `memory.content` をそのまま `embed()` へ送る**——この欄の有無は
   * 既定の挙動を1ビットも変えない（北極星の問い2、`docs/north-star.md`）。
   * 指定すると `processEmbedJob` は `embed(ctx, [embeddingInput(memory)])` を呼ぶ。
   * **`Memory.content` 自体はどちらの場合も変えない**——DB に書き戻る content は
   * 常に元のままで、このフックは送る文字列だけを差し替える。
   *
   * 使い方の例: 上限超過で `embeddingStatus: 'failed'` になった Memory を、先頭を
   * 切って短くする関数を渡し、`runtime.reembed(ctx, { statuses: ['failed'], limit })` →
   * `runtime.tick(ctx, { kinds: ['embed'], leaseMs })` の順に呼ぶと、対象は `'ready'` に戻る
   * （`Memory.content` は全文のまま）。
   *
   * 🔴 **core はモデルごとの入力上限・トークン数を持たない**（ADR 0305 決定6 /
   * ADR 0090 決定「3.6」と同じ理由——層が違う。core が特定モデルの数字を知ってはならない）。
   * このフックが「何を・どれだけ切ったか」の印も core は残さない——残すには
   * `Memory` に列を足す必要があり、それは migration を要する変更であって、この
   * フック（純粋な関数の注入）の範囲を超える。印が要る呼び出し側は、自前の仕組み
   * （別テーブル・ログ等）で残すこと。
   *
   * フックが例外を投げた場合、`processEmbedJob` は今までどおり
   * `embeddingStatus` を `'failed'` にしてから再送出する——このフックのために
   * 新しい throw の経路を既定側へ作らない。
   */
  embeddingInput?: (memory: Memory) => string;
}

/** `Runtime.observe` の戻り値。 */
export interface ObserveResult {
  /** 記録した Observation の id（`externalId` で冪等に再送したときは既存の Observation の id）。 */
  observationId: ObservationId;
  /**
   * sync 抽出で実際に作られた（または既存の冪等な行として返された）Memory の id。
   * `deferred` の場合、または冪等な再送（`created: false`）の場合は空配列——
   * **この場合に「以前作られた Memory の id」を遡って探すことはしない**（本 PR の決定。
   * PR 本文参照）。
   *
   * 要素は抽出の候補ごとに1つ、候補の順に並ぶ。**同じ本文（`content`）の候補が複数あると、
   * 同じ id が候補の数だけ入る**——Memory の冪等キーは
   * `(tenant_id, source_observation_id, extractor_version, content_hash)` で
   * （`MemoryStore.createMemory`）、`content_hash` は本文だけから作るため、2件目以降の候補は
   * 1件目が作った行に当たる。そのとき2件目以降の候補の `provenanceKind`・`confidence`・
   * `subjectId`・`tags` は書かれない（Memory・`created` イベント・`embed` ジョブは1件目の
   * 分の1つずつだけ）。重複を除いた集合が要るときは、呼び手が `new Set(memoryIds)` にする。
   * 【実測 2026-09-27】`@mnemora/postgres` と testkit の InMemory で同じ結果になる
   * （歯は `packages/postgres/src/__tests__/observe-duplicate-candidates.postgres.test.ts`）。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1234](https://github.com/takecchi/mnemora/issues/1234)）:
   * 候補は「書く → `created` イベントを積む」の順で、1つのトランザクションではない（2026-09-28 から、候補を全件
   * 書いてから `created` を積む。Issue #1063、ADR 0347）。**書いた直後、
   * `created` を積む前にその1件が `forget` → `purge` されると、この配列にも purge した id が入り、その Memory の
   * 監査ログには `forgotten`・`purged` の**後に** `created` が積まれる（`at` もその順になる。`created` の
   * `digestSnapshot` は purge 前の digest）。`at` の順に読むと「消した後に作られた」と読めるが、実際は作られてから
   * 消され、作成の記録だけが遅れて積まれたものである。【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture
   * で同じ（`observe-created-event-after-purge.postgres.test.ts`）。
   *
   * ⚠ **2026-09-30 追記（[ADR 0410](../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)）: 上の段落は、
   * `MemoryStore.createMemoriesWithOutboxAndEvents?` を持たない adapter の経路の話である。**持つ store
   * （`@mnemora/postgres`・testkit の fixture）では、全候補の記憶と `created` を1つのトランザクションで書くので、
   * 書いた記憶は `created` と一緒にコミットされるまで `forget`・`purge` の対象にならない——この窓は無い
   * （上の歯は、口を外した store で今の経路を縛り続けている）。
   */
  memoryIds: MemoryId[];
  /**
   * この呼び出しの中で抽出がどうなったか。
   *
   * **`boolean` にしない。**「抽出した / していない」の2値に潰すと、
   * **LLM 呼び出しが失敗して全文フォールバックへ倒れた**という第三の状態が
   * 「抽出した」と同じ顔になる。ADR 0008 の判定基準——その区別があると
   * 呼び出し側の次の一手が変わるか——に照らすと、これは潰してはいけない区別である
   * （`llm_failed_whole_observation` なら、provider の復旧後に抽出をやり直す、
   * という一手がある。`ok` にはその一手が無い）。
   */
  extraction: ExtractionOutcome;
  /**
   * `extraction === "llm_failed_whole_observation"` のときに LLM 呼び出しが失敗した理由。
   * **それ以外（`"ok"` / `"skipped"`）は必ず `null`。**
   *
   * `ExtractionOutcome` 自体は3値のまま変えない（値を足すと `extraction` を分岐する
   * 網羅性チェックの無い箇所——本ファイルの三項演算子と
   * `examples/chat/src/retrieval-quality.ts` の switch——が黙って既定側へ落ちるため）。
   * その代わり、失敗の中身（provider が名乗った `kind` と人が読むメッセージ）はこの欄で運ぶ。
   *
   * **省略可能にしない。** 必須にすることで、`ObserveResult` を組み立てる全経路を
   * TypeScript に列挙させ、「埋め忘れた経路が黙って `undefined`（＝間違った *有る*）になる」
   * ことを防ぐ。
   */
  extractionFailure: ExtractionFailure | null;
  /**
   * Issue #608 項目②(b): この呼び出しで `subjectCandidates` を渡したとき、LLM が返した
   * `subjectId` のうち**一覧に無かった**ため弾いた値（弾いた順、`ExtractCandidatesResult.
   * rejectedSubjectIds` の写し）。弾かれた候補自体は observation の `subjectId` へ
   * フォールバックして作られており（`sanitizeCandidateSubjectId`、extraction.ts）、
   * **この欄が無くても Memory は正しく作られる**——ここは「黙って戻さない」ための
   * 監査用の記録に過ぎない。
   *
   * ⛔ **省略可能にする（既存の `ObserveResult` の他の欄と違う規律）。** 理由は逆——
   * 他の欄と同じく必須にすると、この PR より前に `ObserveResult` を自前で組み立てている
   * 呼び出し側（本 repo の外を含む）のリテラルがコンパイルを通らなくなる。**新しい任意
   * プロパティの追加**（`docs/decisions/0178-public-api-surface-gate.md` が semver 的に
   * 安全と定める形）に留めるため、あえて必須にしない。
   *
   * - **`subjectCandidates` を渡さなかった（省略・空配列）呼び出しでは、この欄は無い**
   *   （`undefined`）——「候補一覧を渡していないので判定していない」ことと「渡したが
   *   0件だった」ことを、キーの有無で区別する。
   * - **渡した場合は常に配列**（弾いた候補が無ければ `[]`）。
   */
  rejectedSubjectIds?: string[];
  /**
   * Issue #371: この呼び出しで `claimKey: { enabled: true }` を渡したとき、
   * `deriveClaimKeys`（claim-key.ts）の呼び出しが失敗した理由。**失敗しても
   * Memory の作成自体は止まらない**——各候補の `claimKey` が `null` のまま作られる
   * （`rejectedSubjectIds` と同じ「黙って戻さない」ための監査用の記録）。
   *
   * ⛔ **省略可能にする**（`rejectedSubjectIds` と同じ理由・同じ規約）。
   * - **`claimKey.enabled` を渡さなかった（省略、または `enabled: false`）呼び出しでは、
   *   この欄は無い**（`undefined`）。
   * - **`claimKey.enabled: true` を渡した場合は常に値を持つ**（成功なら `null`）。
   */
  claimKeyFailure?: ExtractionFailure | null;
  /**
   * Issue #372（(B) 第2段）: この呼び出しで `claimKey: { enabled: true,
   * detectContested: true }` を渡したとき、鍵が付いた Memory ごとの検出結果
   * （`detectClaimKeyContested` 参照）。**LLM を一度も呼ばない**——列と索引だけで
   * 判定する（`docs/decisions/`「主張キーの衝突検出」ADR、北極星 問い5）。
   *
   * ⛔ **省略可能にする**（`rejectedSubjectIds`/`claimKeyFailure` と同じ理由・同じ規約）。
   * - **`claimKey.detectContested` を渡さなかった（省略、または `false`）呼び出しでは、
   *   この欄は無い**（`undefined`）——「検出していない」ことと「検出したが対象の候補が
   *   無かった」ことを、キーの有無で区別する。
   * - **`detectContested: true` を渡した場合は常に配列**（`claimKey` が付かなかった
   *   候補——鍵の導出自体が失敗した／実行しなかった——は含まれない。付いた鍵の数だけ
   *   要素がある。0件なら `[]`）。
   */
  contestedDetection?: ContestedDetectionOutcome[];
}

/**
 * Issue #372（(B) 第2段）: `detectClaimKeyContested` が Memory 1件について返す結果。
 * `matchCount` は「同じ tenant・同じ subjectId・同じ claim key・有効期間が重なる・
 * `contentHash` が違う」他の Memory の件数（この Memory 自身を除く）——
 * `MemoryStore.findActiveByClaimKey?`（`status = 'active'`）の一致と、
 * `MemoryStore.findContestedByClaimKey?`（`status = 'contested'`。任意メソッド、
 * Issue #933・ADR 0378）の一致を合わせたもの。`findContestedByClaimKey?` を実装していない
 * adapter では、今まで通り `findActiveByClaimKey?` の一致（`active` のみ）だけになる。
 *
 * - `matchCount === 0` ⟹ `result.kind === "no_conflict"`。
 * - `matchCount === 1` **かつその1件が `active`** ⟹ `result.kind === "contested"`。
 *   `Runtime.markContested` を実際に呼んだ結果を `markContested` に運ぶ
 *   （`ineligible`/`conflict` になることもある——TOCTOU で相手の status が読んだ後に
 *   変わった場合等。この関数はその結果をそのまま運ぶだけで、再試行はしない）。
 * - `matchCount >= 2`、**または `matchCount === 1` だがその1件が既に `contested`**
 *   ⟹ `result.kind === "unresolved_conflict"`。**`markContested` を呼ばない**——
 *   [#207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`、多対多）
 *   が無いと、1対1の `contestedWithId` では3件以上を表現できない（ADR 0185 決定5）。
 *   代わりに `memory_events` へ根拠を構造として残すだけに留める（`detectClaimKeyContested`
 *   の実装コメント参照）。**`superseded` へは一切進めない。**⚠ **状態遷移そのものを
 *   動かさない**——`findContestedByClaimKey?` の一致で既に `contested` な相手が
 *   含まれていても、この関数はその相手の `status`/`contestedWithId` に一切触れない
 *   （ADR 0378 決定2、PR1 の範囲）。⚠ **2026-09-30 の直し（ADR 0378 追記）**:
 *   `matchCount === 1` でもこの分岐に入りうる（一致がちょうど1件で、その1件が既に
 *   `contested` だった場合）——直す前は `markContested` へ進んで `ineligible` になり、
 *   検出中の Memory は `active` のまま痕跡も残らなかった（例: 3件目の有効期間が、既に
 *   対になった1件目・2件目のうち片方とだけ重なる場合）。
 *
 * ⚠ **2026-09-30 の直し（Issue #207/#933 PR2、ADR 0381、段階B。2026-09-30 のさらなる
 * 直しで `deps.relationStore` の配線を条件にした）**: `matchCount >= 2`、または
 * `matchCount === 1` だがその1件が既に `contested` の場合、`deps.relationStore` と
 * `deps.memoryStore.markContestedGroup` の両方が配線されていて、かつ「群のメンバー」の
 * 組み立て（下の `detectClaimKeyContested` 実装コメント参照。穴Aの吸収・既存群の合併を
 * 含む）の結果が**3件以上**になれば、`result.kind === "contested_group"` になる——
 * `Runtime.markContestedGroup` を実際に呼んだ結果を運ぶ。それ以外（`relationStore`/
 * `markContestedGroup` のどちらかが配線されていない、または組み立てた群が2件以下にしか
 * ならない場合）は、今まで通り `result.kind === "unresolved_conflict"`（evidence だけ）
 * になる。
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
 * `runtime.reextract` の結果（ADR 0028、ADR 0029）。
 *
 * `observe()` の `ExtractionOutcome` が持つ `'skipped'`（`ObserveResult.extraction`。
 * `memory_usage` 入力用の値）と、この型が持つ `ReextractResult.skipped` フィールドは
 * **別の語彙**である——前者は「この呼び出しで抽出そのものを行ったか」、後者は
 * 「既存 Memory を supersede しなかった理由」。名前が似ているだけで無関係。
 * `reextract` の `extraction` は `'ok'` か `'llm_failed_whole_observation'` のどちらかが基本である
 * （deferred も冪等な再送もここには来ない）。
 * ⚠ **2026-09-28 変更（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・
 * [Issue #1149](https://github.com/takecchi/mnemora/issues/1149)）: 利用者の意思で退けた記憶を持つ Observation では、
 * `extraction: 'skipped'`（observe の再送が抽出をやり直さないときと同じ意味）を返す。**以前は「`'skipped'` は取らない」
 * と約束していた。型は変わらない（`'skipped'` は元から `ExtractionOutcome` に在る）が、「`'skipped'` は来ない」と
 * 仮定したコードは見直しが要る。条件は `Runtime.reextract` の doc を参照。
 */
/**
 * この呼び出しで「正典が要求する1トランザクション」が使えたかどうか（Issue #134 /
 * [ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md)）。
 *
 * - `'store_supported'` — `MemoryStore.supersedeWithNewMemories`（任意メソッド）が在り、
 *   新 Memory の作成と旧行の supersede をその口へ渡した。
 * - `'store_unsupported'` — 口が無い adapter だったので、今日どおり作成と supersede を
 *   別々の書き込みとして行った（docs/memory-model.md §11 行5 は**満たされていない**）。
 * - `'not_attempted'` — **書き込みを1件も試みていない。**`reextract` の安全弁（LLM が
 *   また失敗した／候補が0件）で早期 return した場合と、利用者の意思で退けた記憶を持つ Observation で
 *   抽出をやり直さなかった場合（2026-09-28 から。Issue #1079・#1149）。⛔ この状態を上の2つのどちらかに
 *   寄せない——「口が無かった」と「そもそも書いていない」は別のことであり、潰すと
 *   呼び手は「§11 行5 が破れた」と「破れる機会が無かった」を区別できなくなる。
 *   名前は `ConsolidationResult` の `not_attempted`（ADR 0087 決定5）に揃えた。
 *
 * 🔴 **この値は原子性の証拠ではない。口の有無の写しである。** adapter が口を実装したと
 * 宣言したことしか意味しない——実装していても実際にはトランザクションを張っていない
 * adapter（`packages/testkit` の `InMemoryMemoryStore` は「トランザクションは一切模して
 * いない」と自分で書いている）を、この値は見抜けない。原子性を実際に測るのは適合テストと
 * `packages/postgres` の並行の歯であって、この値ではない。
 *
 * ⛔ **省略可能（`?`）にしない。**`undefined` が「口が無かった」と「この欄より前の版の
 * 戻り値」の両方を意味してしまい、「無い」の種類を潰すことになる。
 */
export type WriteAtomicity = "store_supported" | "store_unsupported" | "not_attempted";

/**
 * ⚠ **2026-09-26 追記（[Issue #856](https://github.com/takecchi/mnemora/issues/856)）:
 * この型は「observationId が存在しない（または他テナントの id だった）」場合を
 * 表す値を持たない。** `Runtime.reextract(ctx, observationId)` は
 * `deps.memoryStore.getObservation(ctx, observationId)` が `null` を返すと、
 * `ReextractResult` を一切構築せずに素の `Error`
 * （`runtime.reextract: observation not found: <id>`。型付き例外ではない、
 * `RangeError` でもない）で reject する——書き込みは一切行わない。
 *
 * `Runtime` の他の書き込み系メソッド（`forget`/`purge`/`restoreArchived`/
 * `restoreSuperseded`/`markContested`/`resolveContested`）は、対象 id が存在しない
 * 場合を構造化された outcome（`kind: "not_found"` 等）として返し、例外にしない、
 * という規律をそれぞれの doc コメントで明示している。`reextract` は単一の id を
 * 直接受け取る口という点で `getRecall(ctx, recallId)`（存在しない id には例外では
 * なく `null` を返す）とも似た形をしているが、`getRecall` とは逆に、存在しない id
 * では例外を投げる——この型・このメソッドは、その不揃いを解消していない。
 * 呼び出し側は `try`/`catch`（または Promise の `.catch`）でこれを扱うことになる。
 *
 * 2026-09-26、クローン miku がこの振る舞いを現状の契約として記録すると決めた
 * （[Issue #856](https://github.com/takecchi/mnemora/issues/856)）。採らなかった案は、
 * `ReextractResult` に `not_found` 相当の outcome を足す案（公開の型の変更になる）と、
 * 型付き例外に変える案（投げる例外の種類が変わる）である。
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
   * - LLM がまた失敗した場合（`outcome: 'llm_failed_whole_observation'`）は必ず空配列
   *   ——失敗を根拠に既存の記憶を置き換えない。
   * - 候補が0件だった場合も必ず空配列——そもそも `supersededById` の指す先が無い。
   * - 対象は同じ `(sourceObservationId, extractorVersion)` を持つ **`status: 'active'`** の
   *   Memory のうち、今回作られた content_hash の集合に含まれないものだけ
   *   （`forgotten` は絶対に含めない。`contested` も対象外——理由は ADR 0028 参照）。
   * - 🔴 安全弁3（ADR 0030）: `updateStatus` を `expectedStatus: "active"` の
   *   compare-and-swap で呼ぶ。読み（`listBySourceObservation`）と書き（`updateStatus`）の
   *   間に他の書き込みで status が変わっていた Memory は、ここには**入らない**
   *   （`skipped` に `status_changed_concurrently` として出る）。
   */
  supersededMemoryIds: MemoryId[];
  /**
   * ADR 0029: 既存 Memory を supersede しなかった理由。ADR 0028 が「引き受ける負債」に
   * 記録した欠落——`contested` で飛ばした・`forgotten` で飛ばした・そもそも置き換える
   * ものが無かった、の3つが `supersededMemoryIds: []` という同じ顔になっていた——を埋める。
   * ADR 0030（安全弁3）で `status_changed_concurrently`（TOCTOU で弾かれた）を追加した。
   *
   * **件数は持たない**（`ReextractSkip` 自体に `count`/`countKind` が無い。`recall.ts` の
   * `StageSkippedOmission` に倣った形。理由は ADR 0029 参照）。
   *
   * 利用者の意思で退けた記憶を持つ Observation の早期 return、`usedWholeObservationFallback` の
   * 早期 return、`candidates.length === 0` の早期 return、本経路（`classifyReextractTargets` +
   * `classifySupersedeFailure`）の4つの書き込み経路がある——後ろ2つの早期 return は
   * **`listBySourceObservation` を呼ぶ前に return する**ため、`skipped` には
   * `{ kind: 'not_examined', ... }` が入る（「何も飛ばさなかった」ではなく「既存を見ていない」）。
   *
   * ⚠ 2026-09-28 追記（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・
   * [Issue #1149](https://github.com/takecchi/mnemora/issues/1149)。今の振る舞いを書くだけ）: 1つ目の
   * 早期 return（退けた記憶が1件でも在ると抽出をやり直さない。条件は `Runtime.reextract` の doc を参照）は、
   * 既存を見た上で LLM を呼ぶ前に return する。**`skipped` には退けた記憶ごとに `status_not_active`
   * （`status` はその記憶の今の status）が1件ずつ入り、`not_examined` は入らない。**同じ Observation の
   * 他の `active` な記憶はここに載らない。このとき `extraction: "skipped"`・`atomicity: "not_attempted"`・
   * `memoryIds: []`・`supersededMemoryIds: []`・`extractionFailure: null`。【実測 2026-09-28】Postgres と testkit の
   * fixture で同じ（`status_not_active` が入ることの歯は `reextract-withdrawn-memories.postgres.test.ts`）。
   *
   * ⚠ **2026-09-30 変更（[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、
   * [ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）:
   * 上の「退けた記憶」の判定は `extractorVersion` を問わなくなった。** `extractorVersion` を
   * 上げた runtime インスタンスで reextract しても、前の版の `forgotten`/`contested`/
   * 訂正の解決で負けた `superseded` があれば同じく `skipped` に `status_not_active` が入り、
   * 抽出をやり直さない。**`skipped` に版の欄は足していない**（`memoryId` から
   * `MemoryStore.get` で版をたどれるため）。詳細は `Runtime.reextract` の doc の
   * 2026-09-30 変更を参照。
   *
   * ⚠ **2026-09-30 追記（[ADR 0406](../../../docs/decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)）:
   * LLM を待つ間に元の記憶が `forget` されたときも、この早期 return と同じ形で返る**（`status_not_active`、
   * `status: "forgotten"`）。LLM を呼んだ**後**に打ち切った点だけが違うが、戻り値からは区別できない
   * （どちらも「何も書かれていない」）。
   */
  skipped: ReextractSkip[];
  /** 抽出がどう終わったか（{@link ExtractionOutcome}）。 */
  extraction: ExtractionOutcome;
  /**
   * `ObserveResult.extractionFailure` と同じ意味の欄（ADR 0076）。
   * `reextract` も `extractCandidates` を呼び、`llm_failed_whole_observation` を返す
   * 早期 return を持つ——`ObserveResult` にだけ運んで `ReextractResult` に運ばないと、
   * 「片方は種類が分かるのにもう片方は分からない」という非対称ができるため、対称に足す。
   * `extraction !== "llm_failed_whole_observation"` のときは必ず `null`。
   */
  extractionFailure: ExtractionFailure | null;
}

/**
 * `runtime.forget` の対象（Issue #102）。
 *
 * `{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論——
 * `forget` 自身は内部でこれを `MemoryId[]` に正規化してから処理する
 * （`{ memoryId }` は1要素の配列と同じ扱い）。単数形をわざわざ用意するのは、
 * 呼び出し側の大多数が1件だけを忘れさせたい場合に `{ memoryIds: [id] }` と
 * 書かせないため。
 */
export type ForgetTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/**
 * `runtime.forget` が対象1件ごとに返す結果（Issue #102）。
 *
 * **6つの `kind` はそれぞれ呼び出し側の次の一手が違う**——`ReextractSkip` や
 * `UnsupportedOutboxJob` と同じ「無いの分類」（ADR 0008）の適用:
 *
 * - `"forgotten"`: 今回の呼び出しで実際に `status` を `forgotten` へ動かし、
 *   `memory_events` にも `kind: 'forgotten'` を積んだ。`previousStatus` は
 *   動かす直前に観測した status。
 * - `"already_forgotten"`: 対象は最初から（または同じ呼び出し内の先行する
 *   要素の処理によって）`forgotten` だった。**書き込みは一切起きていない**
 *   ——`status` を「動かして `forgotten` になった」のではなく「既に
 *   `forgotten` だった」の区別を、呼び出し側が監査ログの読み方を誤らないよう
 *   に残す（同じ Memory を2回 forget しても `memory_events` は1件のまま、
 *   という冪等性がこの kind の存在理由そのもの）。
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い（一度も
 *   存在しなかった、または他テナントの id）。`"already_forgotten"` と混同しない
 *   ——「もう忘れている」と「そもそも知らない」は呼び出し側にとって別の状況
 *   （前者は監査ログを遡れる、後者は遡れるものが無い）。
 * - `"conflicted"`: compare-and-swap が破れた——`getMany` で読んだ時点の
 *   status と、実際に書きに行った時点の status が一致しなかった（並行して
 *   別の書き込みが割り込んだ）。**このメソッドは自動で再試行しない**
 *   （上限の無い再試行ループを作らない）。呼び出し側は `observedStatus` を見て
 *   必要なら自分でもう一度 `forget` を呼び直す。
 * - `"failed"`: 競合以外の例外（DB 接続断等）で書き込みそのものが失敗した。
 *   `error` に例外のメッセージを運ぶ。**この時点で処理を打ち切る**
 *   （下の `"not_attempted"` 参照）。
 * - `"not_attempted"`: 同じ呼び出しの中で、**それより前の要素が `"failed"`
 *   になったため、この要素はまだ見ていない。** `"not_found"` や
 *   `"already_forgotten"` に潰さない——それらは「見た上でそう判定した」だが
 *   こちらは「見ていない」であり、意味が違う（`ReextractSkip` の
 *   `not_examined` と同じ区別）。呼び出し側は `"failed"` の原因を解消してから
 *   `"not_attempted"` になった id だけを含めて `forget` を呼び直せる。
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
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363、2026-09-30 追記）:
       * drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、`cause` の連鎖と
       * SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/** `runtime.forget` の任意オプション（Issue #102）。 */
export interface ForgetOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。「ユーザーの訂正で
   * 落ちた」と「運用の都合で落とした」を後から区別するためにある。省略時、
   * `meta` に `reason` キー自体を持たせない（`""` と「省略」を区別する）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
}

/**
 * `runtime.forget` の結果（Issue #102）。
 *
 * **`forgottenCount` のような派生値を持たない。**`outcomes` を数えれば得られる
 * 値を欄として複製すると、「同じことを言う道が2つ在り、どちらか一方だけ直して
 * ずれる」というこのリポジトリが繰り返し踏んできた欠陥（`TICK_SUPPORTED_JOB_KINDS`・
 * `MAX_STRENGTH` の JSDoc 参照）を新しく作ることになる。
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
 * `runtime.consolidate` の対象（Issue #103、ADR 0089。`{ seedMemoryId }` は
 * Issue #135、ADR 0152）。
 *
 * `{ memoryIds }` は `forget` の `ForgetTarget` と同じ規律——正規化せず、**重複も入力順も
 * そのまま保つ**。`{ query, maxCandidates }` は `recall(ctx, query)` を1回呼んで得られた
 * `memories` の id を順に採る（`maxCandidates` があれば先頭からその件数で切る）。
 *
 * ⚠ 2026-09-27 追記（今の振る舞いを書くだけ。Postgres と testkit で実測）:
 * - **`{ query }` は、`recall()` の `memories` を `retrievedVia` によらず全部採る。**連想枠は既定 on
 *   （ADR 0337）なので、`query.association` を省略すると、クエリには当たっていない「連想で返った」
 *   `active` な記憶（`retrievedVia: 'association'`）も統合元として適格になる。クエリに当たったものだけを
 *   畳みたいなら `query.association: null` を渡すこと。contested の同伴（`mandatory_companion`）は
 *   `status_not_active` で弾かれる。`{ seedMemoryId }` は `computeAffinity` の閾値で絞るので、
 *   連想や同伴で返った記憶（`similarity` も `lexicalMatch` も持たない）は入らない。
 * - **`{ memoryIds }` は、忘却の床（`decayFloorAt`）を見ない。**（忘却の床はコードを読んで確かめた
 *   だけで、実測はしていない）。`{ query }`・`{ seedMemoryId }` の近傍は `recall()` の忘却のゲートを通る。
 * - ⚠ **2026-09-29 変更（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)）: どの形でも、いまの
 *   時点で有効期間（`validFrom`/`validUntil`）の外にある記憶は統合元にしない**（`sources` に `"expired"`/
 *   `"not_yet_valid"`。{@link ConsolidateSourceOutcome} 参照）。それまでは `{ memoryIds }` が有効期間を見ず、
 *   統合先は有効期間を持たない（ADR 0164「射程外にしたもの」1）ので、期限切れの記憶の内容が期限の無い
 *   `active` な記憶として `recall()` に戻っていた。`{ seedMemoryId }` の種（`recall()` を通らずに候補に入る）と、
 *   `{ query }` に `includeOutsideValidity: true`・過去の `validAt` を渡して集めた記憶も、同じく統合されていた
 *   （2026-09-29 に Postgres と testkit の fixture で実測）。
 * - ⚠ **2026-09-29 追記2（Issue #1188 残り、[ADR 0368](../../../docs/decisions/0368-consolidate-reflect-validity-intersection.md)）:
 *   統合先は eligible の有効期間の**積**を引き継ぐ（`intersectValidity`、`validity.ts`）
 *   ——今までは常に `validFrom`/`validUntil` とも `null` だった。**代償**: 期限の無い記憶 F と、
 *   将来の期限を持つ記憶 E を一緒に統合すると、統合先は E の期限を持ち、F は他の統合元と同じく
 *   `superseded` になる——期限後は F 由来の内容も `recall()` に出なくなる（F 自身の行は
 *   superseded として残り、消えはしない）。ADR 0368「代償」を見ること。
 *
 * `{ seedMemoryId }` は「この記憶に似ているものを mnemora 自身が集めて、1つに畳め」という
 * 意味である（ADR 0152）。`{ query, maxCandidates }` と違い、**「似ている」の判定
 * そのものを呼び手ではなく mnemora 側が行う**。ただし ADR 0089 却下案7・
 * `docs/roadmap.md` §5.7 が拒んだ「対象を自分で*列挙して*選ぶ」（active な記憶を走査して
 * どれから畳むかを決める）ことはしない——**起点（`seedMemoryId`）は必ず呼び手が渡す。**
 * mnemora が自分で決めるのは「起点に似ているものをどう集めるか」だけである。
 *
 * - 実装（`consolidate()` 内）: `seedMemoryId` の Memory を `get` し、その `digest` を
 *   `RecallQuery.text` にして `recall(ctx, { text })` を1回呼ぶ——`{ query }` 形と
 *   まったく同じ経路（同じ `recall()`）を通す。**新しい「似ている」の判定を作らない。**
 * - 「似ている」は `recall()` が既に使っている `affinity`
 *   （`strategies/scoring.ts`: `affinity = max(similarity, lexicalMatch)`）をそのまま使う
 *   （{@link computeAffinity}）。`minAffinity` 未満の候補は落とす。**既定は
 *   {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}。**
 * - **種（`seedMemoryId` そのもの）は `minAffinity` の判定を受けず、必ず候補に含める。**
 *   種の embedding がまだ無ければ ANN 段に載らず `recall()` の結果に現れないため
 *   （`embeddingStatus: 'pending'`。`consolidate` 自身が作る統合先の産物と同じ窓、
 *   ADR 0089「引き受けた負債」4）、`recall()` の結果に種が見つからなければ先頭に足す。
 *   見つかった場合も、`minAffinity` で弾かれないよう先頭に固定する（`affinity` の判定対象は
 *   種以外の候補だけ）。
 * - `maxCandidates` は「1回の統合に入れる上限」——`{ query }` 形と同じ意味。
 *   `[seedMemoryId, ...minAffinity を満たした近傍]` の順に並べたあと、先頭から切る
 *   （種は常に先頭にいるため、`maxCandidates >= 1` である限り必ず残る）。
 * - `seedMemoryId` が指す Memory が無い場合、`recall()` は呼ばない——
 *   対象は `[seedMemoryId]` の1件のみとなり、後続の `getMany` が `not_found` に分類する
 *   （新しい `nothingReason` を発明しない。下記 {@link ConsolidateNothingReason} 参照）。
 * - **種が forget・purge された記憶なら、`recall()` は呼ばない**（Issue #1136）——対象は
 *   `[seedMemoryId]` の1件のみとなり、後続の `getMany` が `status_not_active`（`forgotten`）に
 *   分類する（結果は `nothing_to_consolidate`/`no_eligible_sources`、`llmCalls: 0`）。利用者が
 *   「使わないでほしい」と言った記憶の `digest` で近傍を束ねると、消した情報が別の形で効き続ける
 *   ためである（#897 / ADR 0124 の observe の再送と同じ線）。自動 job（ADR 0157）も同じ経路を通る。
 *   ⚠ **種が `contested` / `superseded` なら、今どおり種の `digest` で近傍を集める**
 *   （種そのものは `status_not_active` で弾かれ、近傍が2件以上あれば近傍どうしが統合される）。
 *   利用者が消した記憶ではないので、集めることを止めていない。
 * - **近傍は `ctx` の scope で集める。**`ctx.subjectId` を付けなければテナント全体から集まる。
 *   近傍が別の subject にまたがると、統合後の `subjectId` は `null` に畳まれる。
 *   **帰属を保ちたいなら、`ctx.subjectId` に種の `subjectId` を渡すこと**——混在は構造的に
 *   起きなくなる（Issue #579、ADR 0310 の実測。付けなかった場合の混在率は、使い方しだいで
 *   0〜100%）。
 *
 * ⚠ **2026-09-26 追記（Issue #869）: 「同じ対象で2回呼んだら2回目は書き込みゼロ」
 * （ADR 0089 決定3）は `{ memoryIds }` の経路でしか成り立たない。** `{ seedMemoryId }` は
 * 近傍（`neighborIds`）を呼ぶたびに `recall()` で**現在の** active な記憶集合から拾い直す
 * ——1回目で `recall()` の窓（既定 `limit`/`maxCandidates`）から溢れて `active` のまま
 * 残った近傍は、同じ `seedMemoryId` で2回目を呼ぶと eligible として拾われ、LLM が再度
 * 呼ばれて新しい統合先ができる（Fake・Postgres の両方で実測）。1回目の統合先自身が
 * 2回目の統合に巻き込まれて `superseded` になるケースもありうる（Fake で実測）。
 * `{ query, maxCandidates }` も `recall()` を呼び直す点は同じ形を共有するが、この追記では
 * 実測していない。2026-09-26 にクローン miku（オーナーではない）が、挙動を変えずに
 * 既知の負債として記録すると判断した。詳細は
 * [ADR 0152](../../../docs/decisions/0152-consolidate-seed-neighborhood.md) 負債5・
 * [ADR 0089](../../../docs/decisions/0089-runtime-consolidate-shape.md) の2026-09-26 追記。
 *
 * ⚠ **`maxCandidates` の値は検査しない**（[Issue #1067](https://github.com/takecchi/mnemora/issues/1067)）。
 * **保証するのは、正の整数 `n` を渡したとき「`recall()` が返した順（`{ seedMemoryId }` では種が先頭）の
 * 先頭 `n` 件」と、省略したとき「その全件（`recall()` の `limit` と、`{ seedMemoryId }` では `minAffinity` で絞ったあと）」だけである。**それ以外（`0`・負の数・整数でない数・`NaN`）を
 * 渡したときの対象は未定義である——例外は投げず、今の実装はそのまま `Array.prototype.slice` に
 * 渡すので、`-1` は「末尾の1件を除く全部」、`1.5` は1件、`0` と `NaN` は0件になる。`dryRun` でなければ、
 * そうして選ばれた対象に統合（統合元は `superseded` になる）を実際に書く。この解釈は将来変わりうるので、頼らないこと。
 * `Runtime.findCorrectionCandidates` の `limit`（正の整数以外を `RangeError` で拒む）とは揃えていない。
 */
export type ConsolidateTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number }
  | {
      seedMemoryId: MemoryId;
      maxCandidates?: number;
      minAffinity?: number;
      /**
       * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
       * （Issue #338）: 種の digest で内部的に呼ぶ `recall()` へそのまま渡す
       * `RecallQuery.activityCounting`。**`{ query }` 形は `RecallQuery` 自体に
       * この欄を含められるので、ここには無い**——`{ seedMemoryId }` 形だけ、
       * `recall()` に直接触れられないためにこの欄を用意する。省略時 `"tenant"`
       * （本 ADR 以前と1バイトも変わらない挙動）。
       */
      activityCounting?: "tenant" | "subject";
    };

/**
 * `{ seedMemoryId }` 形（Issue #135、ADR 0152）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。**保守側（畳まない側）に倒した理由——統合元は
 * `superseded` へ動く（ADR 0089 決定1）ため、**取り違えて畳んだときの damage は
 * 「畳まなかった」より大きい。**緩めるのは `examples/chat` の `consolidation-cost`
 * （Issue #136、着地済み）で実際に測ってから判断する。`ConsolidateOptions.dryRun` が
 * あるので、呼び手は本番へ入れる前に何が畳まれるはずかを見られる。
 */
export const DEFAULT_CONSOLIDATE_MIN_AFFINITY = 0.8;

/**
 * `runtime.consolidate` の任意オプション（Issue #103、ADR 0089）。
 */
export interface ConsolidateOptions {
  /** 統合の対象（{@link ConsolidateTarget}）。 */
  target: ConsolidateTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、束ねられる対象だけを見て返す
   * （{@link ConsolidateSourceOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean;
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（統合元の `superseded`・統合先の `created` の両方）。省略時は積まない。
   * `meta.reason` は常に固定値 `'consolidated'` であり、この欄では上書きしない（`MarkContestedOptions.reason` と
   * 同じ形。`ForgetOptions.reason` とは違う）。
   */
  reason?: string;
  /**
   * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)（クローン miku の判断）:
   * 中断の合図。内部で呼ぶ `recall()`（`{ seedMemoryId }`/`{ query }` 形のとき）と、
   * LLM 呼び出し（`completeStructured`）の両方に効く。**既定の時間の上限にはならない**
   * ——省略すれば今までどおり待ち続ける。
   *
   * abort されると、`consolidate()` は reject する（`signal.reason`。無ければ `AbortError`
   * 相当）。**既存の `"llm_failed"` には倒さない**——中断と LLM の失敗を区別するため。
   * LLM 呼び出しは、束ねる対象を1件も書く前に行う（上の手順5）ので、abort の時点では
   * 何も書かれていない。
   */
  signal?: AbortSignal;
}

/**
 * `runtime.consolidate` 全体の結末（Issue #103、ADR 0089）。ADR 0008 の「無い」の分類の適用——
 * 「束ねるものが無かった」「そもそも見ていない」「LLM が落ちた」「下見だけ」を1つの `false` に
 * 潰さない。
 *
 * - `"consolidated"` — 統合先を1件作り、少なくとも1件を `superseded` へ動かした。
 * - `"nothing_to_consolidate"` — 対象を見た上で、束ねるものが無かった
 *   （{@link ConsolidateNothingReason} で細分）。
 * - `"not_examined"` — 対象そのものが空（`memoryIds: []`）、または `query` が0件だった
 *   ——store の Memory を1件も見ていない。
 * - `"llm_failed"` — LLM 呼び出しが失敗した（本文が空白だけの応答を含む。Issue #1065）。
 *   **1件も書いていない。**
 * - `"dry_run"` — 下見だけを行った。**1件も書いていない。**
 * - `"aborted_source_forgotten"` — LLM は呼んだ（`llmCalls: 1`）が、書き込みの直前に
 *   見直したら eligible の1件以上が `forgotten`（`forget()` のみ・`purge()` 済みのどちらも
 *   含む）になっていたので、**何も書かずに打ち切った**（統合先は作らない。eligible の
 *   どれ1つも `superseded` へ動かさない）。2026-09-30 追記（Issue #1226、ADR 0375 決定7、
 *   クローン miku の判断）。{@link ConsolidateSourceOutcome} の `"forgotten_before_write"`
 *   参照。破壊的変更とは数えない（union に値を足す変更は数えない。同日付の
 *   「数え方の規律への追記（2026-09-28）」、`"expired"`/`"not_yet_valid"` の追加と同じ扱い）。
 */
export type ConsolidateOutcome =
  | "consolidated"
  | "nothing_to_consolidate"
  | "not_examined"
  | "llm_failed"
  | "dry_run"
  | "aborted_source_forgotten";

/**
 * `ConsolidateOutcome: "nothing_to_consolidate"` の理由（Issue #103、ADR 0089）。
 *
 * - `"no_eligible_sources"` — 渡された/引けた対象のうち、統合元にできるもの（`status: 'active'`
 *   で、いまの時点で有効期間の内側）が0件。
 * - `"single_eligible_source"` — 統合元にできるものが1件だけ。1件を1件に「統合」しない。
 *
 * ⚠ 2026-09-29 変更（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)）: 「統合元にできる」に
 * 有効期間の条件が加わった（{@link ConsolidateSourceOutcome} の `"expired"`/`"not_yet_valid"`）。それまでは
 * `status: 'active'` だけで数えていた。
 */
export type ConsolidateNothingReason = "no_eligible_sources" | "single_eligible_source";

/**
 * `runtime.consolidate` が対象1件ごとに返す結末（Issue #103、ADR 0089）。
 * `ForgetOutcome` / `ReextractSkip` の語彙にできるだけ揃える——新しい `kind` を作らない。
 *
 * - `"superseded"` — この呼び出しで実際に `status` を `superseded` へ動かした。
 * - `"not_found"` — その id の Memory がそもそも無い（`ForgetOutcome` と同じ意味）。
 * - `"status_not_active"` — `status !== 'active'`（`forgotten` はここで確実に弾かれる。
 *   ADR 0089 §1）。
 * - `"status_changed_concurrently"` — compare-and-swap が破れた（TOCTOU。`reextract` の
 *   `status_changed_concurrently` と同じ意味）。
 * - `"failed"` — 競合以外の例外で書き込みが失敗した。**この時点で処理を打ち切る**
 *   （下の `"not_attempted"` 参照）。
 * - `"not_attempted"` — `status === 'active'`（eligible）だったが、この呼び出しでは
 *   `superseded` への書き込みを試みていない。**次の4つの場合に出る**（どれも書き込みを
 *   試みていないので、状態を変えずにそのまま再送してよい）:
 *   - それより前の要素が `"failed"` になり、そこで打ち切った（まだ見ていない）。
 *   - eligible が1件だけだった（`nothing_to_consolidate`/`single_eligible_source`）。その1件
 *     （重複して渡されていれば、その全部）がこの値になる。
 *   - LLM 呼び出しが失敗した（`llm_failed`）。eligible だった要素がすべてこの値になる。
 *   - `outcome: 'aborted_source_forgotten'`（下）で、**この要素自身は forgotten ではなかった**
 *     （他の eligible が forgotten だったために書き込みごと打ち切られた）。2026-09-30 追記
 *     （Issue #1226）。
 *   ⚠ 2026-09-27 に、実装（`consolidate.test.ts` が固定している振る舞い）に合わせて書き直した。
 *   それまでの doc は1つ目の場合だけを書いていた（ADR 0089 の同日付の追記）。
 * - `"eligible"` — `dryRun: true` のときだけ出る。`status === 'active'` で、実際に統合される
 *   側になったであろう対象。
 * - `"expired"` — `status === 'active'` だが、いまの時点で有効期間が切れている
 *   （`validUntil <= now`）。統合元にしない。`validUntil` はその記憶の値。
 * - `"not_yet_valid"` — `status === 'active'` だが、いまの時点でまだ有効期間が始まっていない
 *   （`validFrom > now`）。統合元にしない。`validFrom` はその記憶の値。
 *
 * ⚠ **2026-09-29 変更（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)）:
 * `"expired"`/`"not_yet_valid"` を足した。**それまでは、有効期間の外にある `active` な記憶も統合元にして
 * `superseded` へ動かしていた。統合先は有効期間を持たない（`validFrom`/`validUntil` とも null。
 * [ADR 0164](../../../docs/decisions/0164-valid-from-until-recall.md)「射程外にしたもの」1）ので、期限切れ・
 * 未到来の事実が、期限の無い `active` な記憶として `recall()` に戻っていた。
 * - **判定は `status` の後**に行う（`forgotten` で期限切れの記憶は、今どおり `status_not_active`）。
 *   述語は `recall()` の期間のゲート（ADR 0164 決定1）と同じで、時刻は `consolidate` を呼んだ時点の
 *   `clock.now()`。逆転した区間（`validFrom > validUntil`。Issue #1042）は `"expired"` になる。
 * - **対象の形によらない。**`{ memoryIds }` だけでなく、`{ seedMemoryId }` の種（`recall()` を通らずに
 *   必ず候補に入る）と、`{ query }` に `includeOutsideValidity: true` や過去の `validAt` を渡して集めた
 *   記憶にも効く——`query` の期間の指定は「何を集めるか」を決めるだけで、統合元にできるかは変えない。
 * - 統合先の有効期間は今までどおり null（統合元の区間を引き継がない）。いまの時点で有効な統合元が、
 *   将来の `validUntil` を持っていても、統合先はその期限を持たない（引き継ぎ方は ADR 0164 が別の判断として
 *   残したまま）。
 * - `dryRun` でも同じ値で名指しする。この値の要素は `nothingReason` の数え方にも入らない。
 * - 🔴 **`ConsolidateSourceOutcome` を網羅的に分岐している呼び出し側は、この2値を扱う必要がある。**
 * - 破壊的変更とは数えない（union に値を足す変更は数えない。オーナーの回答、`docs/migration-v1.md` の数え方の規律）。
 *   同じ入力でも結果が変わる（統合されずに `nothing_to_consolidate` で返ることもある）。2026-09-29 にクローン miku
 *   （オーナーではない）が決めた（ADR 0089 の同日付の追記）。
 *
 * ⚠ **2026-09-30 追記（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
 * ADR 0375 決定7、クローン miku の判断）: `"forgotten_before_write"` を足した。**LLM を待つ間に
 * eligible の1件が `forget`（さらに `purge`）されると、**この要素の分類が `"status_not_active"`
 * ではなく `"forgotten_before_write"` になり、この呼び出し全体が `outcome: 'aborted_source_forgotten'`
 * で打ち切られる**（統合先を一切作らない）。`"status_not_active"` は手順2（LLM を呼ぶ**前**）の
 * 初期分類、`"forgotten_before_write"` は手順7（LLM を呼んだ**後**、書き込みの直前）の見直しで
 * 検出した分類——**同じ「forgotten」でも検出した時点が違うので、別の kind にした**（`ForgetOutcome`
 * の語彙を再利用しなかった理由）。それ以前は、この競合が起きても `"status_changed_concurrently"`
 * に分類され、統合先はその本文を入れた LLM の出力から作られ `active` で書かれていた（今の
 * `packages/postgres/src/__tests__/consolidate-reflect-forget-race.postgres.test.ts` が固定する）。
 * 破壊的変更とは数えない（union に値を足す変更、上と同じ扱い）。
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
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363、2026-09-30 追記）:
       * drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、`cause` の連鎖と
       * SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" }
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "forgotten_before_write" };

/**
 * `runtime.consolidate` の結果（Issue #103、ADR 0089）。
 *
 * ⛔ `consolidatedCount` のような派生値を持たない——`ForgetResult` と同じ理由
 * （`sources` を数えれば得られる）。
 */
export interface ConsolidationResult {
  /** 統合がどう終わったか（{@link ConsolidateOutcome}）。 */
  outcome: ConsolidateOutcome;
  /**
   * {@link WriteAtomicity}。⛔ 省略可能にしない。
   *
   * `outcome` が `"consolidated"` 以外（`dry_run`・`nothing_to_consolidate`・
   * `not_examined`・`llm_failed`）のときは必ず `"not_attempted"`——書き込みを1件も
   * 試みていないからである。
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
 * `runtime.reflect` の対象（Issue #104。`{ seedMemoryId }` は Issue #204、ADR 0154）。
 * `consolidate` の {@link ConsolidateTarget} と**意図的に同じ形**——`reflect` に「何を見るか」を
 * 決めさせない。`target` を必須にしたのは、これを省略できると `reflect` 自身が対象を選ぶことに
 * なり、それは Background Cognition の*実運用*（Phase 1 の範囲外、docs/roadmap.md §1.3）の決定を
 * 先取りしてしまうためである。
 *
 * `{ memoryIds }` は正規化せず、**重複も入力順もそのまま保つ**。`{ query, maxCandidates }` は
 * `recall(ctx, query)` を1回呼んで得られた `memories` の id を順に採る（`maxCandidates` が
 * あれば先頭からその件数で切る）。
 *
 * `{ seedMemoryId }` は `ConsolidateTarget` の `{ seedMemoryId }`（ADR 0152）と**同じ土台選定**
 * を使う——種の `digest` を `RecallQuery.text` にして `recall()` を1回呼び、`computeAffinity`
 * （`strategies/consolidate.ts`、`max(similarity, lexicalMatch)`）が `minAffinity` 未満の
 * 候補を落とす。**新しい「似ている」は発明しない。**種そのものは判定を受けず、必ず先頭に
 * 含める（種の embedding がまだ `pending` で `recall()` に現れない窓があるため、
 * `ConsolidateTarget` の doc コメントと同じ理由）。
 *
 * ⚠ **`minAffinity` の既定値は `consolidate` と別の定数である**
 * （{@link DEFAULT_REFLECT_MIN_AFFINITY}、`consolidate` は {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）。
 * `consolidate` と `reflect` は同じ道具に**逆向きの帯**を要求する——`consolidate` が欲しいのは
 * 「同じ事実の言い換え」（近いほどよい）、`reflect` が欲しいのは「関連するが同じではない
 * 複数の事実」（近すぎると導けるものが無い。同じ事実の写しを5枚並べて内省させても、
 * 新しい知識は出てこない）。低い閾値でよいもう1つの根拠: `reflect()` は既存行の `status` を
 * 1つも動かさない（ADR 0091 決定4）⟹ 取り違えたときの damage が `consolidate`（統合元が
 * `superseded` へ動く）より小さい⟹ 保守側へ倒す理由が `consolidate` ほど強くない。
 *
 * ⛔ **上限（近すぎるものを除く帯）は無い。**上限を入れると `reflect` が「何が重複か」を
 * 判断することになり、それは `consolidate` の仕事である（責務の二重化、Issue #103 が
 * 訴えたのと同じ形）。代わりに「`consolidate` が先に走っていれば重複は既に畳まれている」
 * という前提に乗る——**この前提は負債である**（ADR 0154「引き受けた負債」）。
 *
 * `seedMemoryId` が指す Memory が無い場合、`recall()` は呼ばない——対象は `[seedMemoryId]` の
 * 1件のみとなり、後続の `getMany` が既存の分類（`not_found`）にそのまま落とす（新しい
 * `nothingReason`/`ReflectBasisOutcome` は発明しない）。
 *
 * **種が forget・purge された記憶なら、`recall()` は呼ばない**（Issue #1136、
 * {@link ConsolidateTarget} と同じ規則）——対象は `[seedMemoryId]` の1件のみとなり、
 * `status_not_active`（`forgotten`）→ `nothing_to_reflect`/`no_eligible_basis`（`llmCalls: 0`）に
 * 落ちる。種が `contested` / `superseded` なら、今どおり近傍を集める。
 *
 * この形も `target` を呼び手が必須で渡す点は変わらない——`reflect` 自身が「何を見るか」を
 * 決めているわけではなく、ADR 0091 決定3（`target` 必須）に反しない（ADR 0154）。
 *
 * ⚠ **`maxCandidates` の値は検査しない**（[Issue #1067](https://github.com/takecchi/mnemora/issues/1067)）。
 * **保証するのは、正の整数 `n` を渡したとき「`recall()` が返した順（`{ seedMemoryId }` では種が先頭）の
 * 先頭 `n` 件」と、省略したとき「その全件（`recall()` の `limit` と、`{ seedMemoryId }` では `minAffinity` で絞ったあと）」だけである。**それ以外（`0`・負の数・整数でない数・`NaN`）を
 * 渡したときの対象は未定義である——例外は投げず、今の実装はそのまま `Array.prototype.slice` に
 * 渡すので、`-1` は「末尾の1件を除く全部」、`1.5` は1件、`0` と `NaN` は0件になる。`dryRun` でなければ、
 * そうして選ばれた対象に内省の結果（新しい `reflected` の Memory）を実際に書く。この解釈は将来変わりうるので、頼らないこと。
 * `Runtime.findCorrectionCandidates` の `limit`（正の整数以外を `RangeError` で拒む）とは揃えていない。
 *
 * ⚠ 2026-09-27 追記（今の振る舞いを書くだけ。Postgres と testkit で実測）——{@link ConsolidateTarget} の
 * 同日付の追記と同じ形である:
 * - **`{ query }` は、`recall()` の `memories` を `retrievedVia` によらず全部採る。**連想枠は既定 on
 *   （ADR 0337）なので、クエリには当たっていない「連想で返った」`active` な記憶も材料として適格になる。
 *   クエリに当たったものだけを材料にしたいなら `query.association: null` を渡すこと。
 * - **`{ memoryIds }` は、忘却の床（`decayFloorAt`）を見ない。**（忘却の床はコードを読んで確かめた
 *   だけで、実測はしていない）。`{ query }`・`{ seedMemoryId }` の近傍は `recall()` の忘却のゲートを通る。
 * - ⚠ **2026-09-29 変更（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)）: どの形でも、いまの
 *   時点で有効期間（`validFrom`/`validUntil`）の外にある記憶は材料にしない**（`basis` に `"expired"`/
 *   `"not_yet_valid"`。{@link ReflectBasisOutcome} 参照）。それまでは `{ memoryIds }` が有効期間を見ず、
 *   統合先と同じく内省の記憶も有効期間を持たない（ADR 0164「射程外にしたもの」1）ので、期限切れの記憶の
 *   内容が期限の無い `active` な記憶として `recall()` に戻っていた。**この2026-09-27 追記自身に誤りがあった**
 *   ——旧文は「`{ query }`・`{ seedMemoryId }` は `recall()` の期間のゲートを通るので、期限切れの記憶は材料に
 *   入らない」と書いていたが、`{ seedMemoryId }` の種（`recall()` を通らずに候補に入る）と、`{ query }` に
 *   `includeOutsideValidity: true`・過去の `validAt` を渡して集めた記憶は、実際には材料に入っていた
 *   （2026-09-29 に testkit の fixture で実測。`consolidate` の同日付の追記と同じ穴）。
 */
export type ReflectTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number }
  | {
      seedMemoryId: MemoryId;
      maxCandidates?: number;
      minAffinity?: number;
      /**
       * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
       * （Issue #338）: `ConsolidateTarget`（`{ seedMemoryId }` 形）の同名の欄と
       * 同じ——種の digest で内部的に呼ぶ `recall()` へそのまま渡す。省略時 `"tenant"`。
       */
      activityCounting?: "tenant" | "subject";
    };

/**
 * `{ seedMemoryId }` 形（Issue #204、ADR 0154）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。**根拠は向きの議論だけであり、数字の根拠ではない
 * （`DEFAULT_CONSOLIDATE_MIN_AFFINITY` の JSDoc と同じ書き方）。`consolidate` の 0.8 より
 * 低くしてあるのは、`reflect` が「近すぎない」複数の事実を欲しがるためである
 * （{@link ReflectTarget} の doc コメント参照）。緩める/締めるのは、`reflect` 側の実測
 * （`consolidation-cost` に相当する reflect 側の計測）が入ってから判断する。
 */
export const DEFAULT_REFLECT_MIN_AFFINITY = 0.4;

/**
 * `runtime.reflect` の任意オプション（Issue #104）。
 */
export interface ReflectOptions {
  /** 内省の対象（{@link ReflectTarget}）。 */
  target: ReflectTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、土台になりうる対象だけを見て返す
   * （{@link ReflectBasisOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean;
  /** `memory_events.actor`（`created` イベント）。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`created` イベント）。省略時は積まない。`meta.reason` は常に固定値
   * `'reflected'` であり、この欄では上書きしない（`ConsolidateOptions.reason` と同じ形）。
   */
  reason?: string;
  /**
   * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)（クローン miku の判断）:
   * 中断の合図。`ConsolidateOptions.signal` と同じ形——内部で呼ぶ `recall()` と LLM 呼び出しの
   * 両方に効く。abort されると `reflect()` は reject し、既存の `"llm_failed"` には倒さない。
   */
  signal?: AbortSignal;
}

/**
 * `runtime.reflect` 全体の結末（Issue #104）。`ConsolidateOutcome` と同じ2階層の
 * 「無い」の分類の適用——「一般化するものが無かった」「そもそも見ていない」「LLM が落ちた」
 * 「下見だけ」を1つの `false` に潰さない。
 *
 * - `"reflected"` — 新しい Memory を1件作った。`reflectedMemoryId` は非 `null`。
 * - `"nothing_to_reflect"` — 土台を見た上で、作るものが無かった
 *   （{@link ReflectNothingReason} で細分）。
 * - `"not_examined"` — 対象そのものが空（`memoryIds: []`）、または `query` が0件だった
 *   ——store の Memory を1件も見ていない。
 * - `"llm_failed"` — LLM 呼び出しが失敗した（本文が空白だけの応答を含む。Issue #1065）。
 *   **1件も書いていない。**
 * - `"dry_run"` — 下見だけを行った。**1件も書いていない。**
 * - `"aborted_source_forgotten"` — LLM は呼んだ（`llmCalls: 1`）が、書き込みの直前に
 *   見直したら eligible の1件以上が `forgotten`（`forget()` のみ・`purge()` 済みのどちらも
 *   含む）になっていたので、**何も書かずに打ち切った**（内省の Memory を作らない）。
 *   2026-09-30 追記（Issue #1226、ADR 0375 決定7、クローン miku の判断）。
 *   {@link ReflectBasisOutcome} の `"forgotten_before_write"` 参照。破壊的変更とは数えない
 *   （union に値を足す変更は数えない。`ConsolidateOutcome` の同日付の追記と同じ扱い）。
 */
export type ReflectOutcome =
  | "reflected"
  | "nothing_to_reflect"
  | "not_examined"
  | "llm_failed"
  | "dry_run"
  | "aborted_source_forgotten";

/**
 * `ReflectOutcome: "nothing_to_reflect"` の理由（Issue #104）。
 *
 * - `"no_eligible_basis"` — 渡された/引けた対象のうち、採れるもの
 *   （`status: 'active'` かつ `provenance.kind !== 'reflected'`）が0件。**LLM を呼んでいない**
 *   （`llmCalls: 0`）。
 * - `"llm_declined"` — LLM を呼び、モデルが「一般化するものは無い」と答えた
 *   （`outcome: 'nothing'`、`llmCalls: 1`）。**書き込みは0件。**
 */
export type ReflectNothingReason = "no_eligible_basis" | "llm_declined";

/**
 * `runtime.reflect` が対象1件ごとに返す結末（Issue #104）。`ConsolidateSourceOutcome` と
 * **意図的に違う語彙を持つ**——`reflect` は N→1 の置換ではなく「足す」操作であり
 * （既存の行の `status` を1つも動かさない）、書き込みの途中で対象1件だけが失敗しうる
 * `"status_changed_concurrently"` / `"failed"` / `"not_attempted"` は存在しない
 * （そもそも対象へ書き込みに行かないので、その種類の失敗が起きようがない）。
 *
 * - `"used"` — 実際に新しい Memory の `provenance.sources` に入った土台。
 * - `"not_found"` — その id の Memory がそもそも無い（`ConsolidateSourceOutcome` と同じ意味）。
 * - `"status_not_active"` — `status !== 'active'`（`forgotten` はここで確実に弾かれる）。
 * - `"expired"` — `status === 'active'` だが、いまの時点で有効期間が切れている
 *   （`validUntil <= now`）。材料にしない。`validUntil` はその記憶の値。
 * - `"not_yet_valid"` — `status === 'active'` だが、いまの時点でまだ有効期間が始まっていない
 *   （`validFrom > now`）。材料にしない。`validFrom` はその記憶の値。
 * - `"basis_is_reflected"` — `status: 'active'` で、いまの時点で有効期間の内側だが
 *   `provenance.kind === 'reflected'`。自己増幅（reflect の産物を土台にまた reflect すること）を
 *   形の側で止める。
 * - `"eligible"` — 土台として採れる状態だったが、この呼び出しでは結局使われなかった
 *   （`dryRun: true` で下見しただけ／LLM 呼び出しが失敗した／LLM が「無い」と答えた／
 *   他の eligible が `"forgotten_before_write"` になり呼び出し全体が打ち切られた（この
 *   要素自身は forgotten ではなかった。2026-09-30 追記、Issue #1226）、のいずれか）。
 *
 * ⚠ **2026-09-29 変更（[Issue #1188](https://github.com/takecchi/mnemora/issues/1188)）:
 * `"expired"`/`"not_yet_valid"` を足した。**それまでは、有効期間の外にある `active` な記憶も材料にして
 * `used`/`eligible` にしていた。内省の記憶は有効期間を持たない（統合先と同じく ADR 0164
 * 「射程外にしたもの」1）ので、期限切れ・未到来の事実が、期限の無い `active` な記憶として `recall()` に
 * 戻っていた。
 * - **判定は `status` の後・`basis_is_reflected` の前**に行う（`forgotten` で期限切れの記憶は、今どおり
 *   `status_not_active`）。述語は `consolidate()` および `recall()` の期間のゲート
 *   （`recall-runtime.ts` の `survivesValidityGate`、ADR 0164 決定1）と同じ `classifyValidity` を呼ぶ
 *   （`./validity.js`、非公開）。時刻は `reflect` を呼んだ時点の `clock.now()`。逆転した区間
 *   （`validFrom > validUntil`。Issue #1042）は `"expired"` になる。
 * - **対象の形によらない。**`{ memoryIds }` だけでなく、`{ seedMemoryId }` の種（`recall()` を通らずに
 *   必ず候補に入る）と、`{ query }` に `includeOutsideValidity: true` や過去の `validAt` を渡して集めた
 *   記憶にも効く。
 * - 内省の記憶の有効期間は今までどおり null（材料の区間を引き継がない）。
 * - `dryRun` でも同じ値で名指しする。この値の要素は `nothingReason` の数え方にも入らない
 *   （`no_eligible_basis` は今までどおり「eligible が0件」で判定する）。
 * - 🔴 **`ReflectBasisOutcome` を網羅的に分岐している呼び出し側は、この2値を扱う必要がある。**
 * - 破壊的変更とは数えない（union に値を足す変更は数えない。オーナーの回答、`docs/migration-v1.md` の
 *   数え方の規律、`consolidate` の同日付の変更と同じ扱い）。同じ入力でも結果が変わる（材料にならず
 *   `nothing_to_reflect` で返ることもある）。
 *
 * ⚠ **2026-09-30 追記（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
 * ADR 0375 決定7、クローン miku の判断）: `"forgotten_before_write"` を足した。**LLM を待つ間に
 * eligible の1件が `forget`（さらに `purge`）されると、**この要素の分類が `"used"` ではなく
 * `"forgotten_before_write"` になり、この呼び出し全体が `outcome: 'aborted_source_forgotten'`
 * で打ち切られる**（内省の Memory を一切作らない）。`"status_not_active"` は手順2（LLM を呼ぶ
 * **前**）の初期分類、`"forgotten_before_write"` は手順7（LLM を呼んだ**後**、書き込みの直前）
 * の見直しで検出した分類——`ConsolidateSourceOutcome` の同日付の追記と同じ区別。それ以前は、
 * この競合が起きても内省の Memory はその本文を入れた LLM の出力から作られ `active` で
 * 書かれ、`"used"` に分類されていた（今の
 * `packages/postgres/src/__tests__/consolidate-reflect-forget-race.postgres.test.ts` が固定する）。
 * 破壊的変更とは数えない（union に値を足す変更、上と同じ扱い）。
 */
export type ReflectBasisOutcome =
  | { memoryId: MemoryId; kind: "used" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
  | { memoryId: MemoryId; kind: "expired"; validUntil: Date }
  | { memoryId: MemoryId; kind: "not_yet_valid"; validFrom: Date }
  | { memoryId: MemoryId; kind: "basis_is_reflected" }
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "forgotten_before_write" };

/**
 * `runtime.reflect` の結果（Issue #104）。
 *
 * ⛔ 派生値（`reflectedCount` 等）を持たない——`ConsolidationResult` と同じ理由
 * （`basis` を数えれば得られる）。
 */
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
   * claim のリース長（ミリ秒）。`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）へそのまま渡す。
   * **必須・既定値なし**——リース長は「ワーカーが止まったとみなすまでの時間」という
   * 運用方針であり、`packages/core` が決めてよい値ではなく呼び出し側が決める。
   * これにより `tick(ctx)` を引数無しで呼ぶことはできない（意図した破壊的変更、ADR 0032）。
   *
   * ⚠ **0 以下も受け付ける（検査しない）。今の振る舞い:** 0 以下では、claim した行が
   * その時点で既にリース切れとして扱われる。同時に走る別の `tick` が同じ行を claim して
   * handler をもう一度走らせ、遅れて `complete`/`fail` した側は {@link TickResult.leaseConflicts}
   * に載る（Postgres と testkit の fixture の両方で実測）。重複の防ぎは、正の `leaseMs` が
   * 処理時間より長いときにだけ効く。
   * `now - leaseMs` が `Date` の範囲を外れる値（`NaN` を含む）は、どちらの実装でも例外になる。
   *
   * ⚠ **2026-09-28 追記（今の振る舞いを書いたもの、Issue #1184）: `leaseMs` を省略して呼ぶと**（JavaScript からの
   * 呼び出し・`as` を経由した呼び出し）、Runtime は検査せず、`undefined` のまま `OutboxStore.claimBatch` へ渡す。
   * 例外は store の側で起きるので、**例外の顔は store で違う**（どちらも `RangeError`・`TypeError` ではない）:
   * - `@mnemora/postgres`: DB が拒んだ例外（drizzle が包んだ `Error`。SQLSTATE は `err.cause.code` の `22007`）。
   * - testkit の fixture: 名前の無い `Error`（文面は `claimBatch: now - leaseMs must be a valid Date` で始まる。
   *   `cause.code` は持たない）。
   * どちらも claim する前に落ちるので、ジョブは claim されない（同じ時刻の次の `tick` で取れる）。
   * `leaseMs` に `NaN` を渡したときも同じ顔になる。第2引数ごと省略した `tick(ctx)` は、どちらの実装でも
   * `opts` を読むところで `TypeError` になる。種類を揃えるかは #1184 で決めていない。
   * 【実測 2026-09-28】`packages/postgres/src/__tests__/runtime-entry-exception-kinds.postgres.test.ts`。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、Issue #1200）: ジョブの処理がリースより長く掛かっても、
   * その間に別の `tick` が同じジョブを取らなければ、完了は通り、`TickResult` には何も出ない**
   * （`attempts` が変わらないので `complete` の CAS が通る。`processed` に数えられ、`leaseConflicts` は空）。
   * 別の `tick` が取った場合は、遅れた側が `leaseConflicts` に載る（#1092 の形）。リースを超えたこと自体を
   * 名乗る口は無い。【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ。
   *
   * ⚠ **2026-09-30 追記（今の振る舞いを書いたもの）: リースはバッチの claim 時点から数える。後ろのジョブは、自分の番が来る前に切れうる。**
   * `tick` は {@link TickOptions.limit}（既定 50）件を1回の `claimBatch` で一括して claim する（全件の `claimed_at` は同じ `now`）。
   * そのあと1件ずつ順に処理するので、各ジョブのリースは**そのジョブの処理開始からではなく、バッチの claim 時点から**減っていく。
   * 前のジョブに時間が掛かると、後ろのジョブは自分の処理が始まる前に、あるいは始まって間もなく切れる。1件あたりの処理時間が
   * `leaseMs` より短くても、`limit` 件の合計が `leaseMs` を超えれば起きる。切れたジョブは別の `tick` が再 claim できる。
   * そのとき **provider 呼び出しと書き込み（`embed` なら埋め込みの呼び出しと `upsert`）は二重に走る**——CAS（ADR 0142）が
   * 無害にするのは完了の記録だけで、遅れて `complete` した側は {@link TickResult.leaseConflicts} に載る。
   * 結果は壊れない（2件とも完了し、`attempts` が進む）が、二重の呼び出し分の費用は掛かる。`embed` は上書きなので冪等、
   * `extract` は再配達の確認（`OutboxStore` の doc）、`reflect` は再配達で2件になりうる（`Runtime.reflect` の doc）。
   * 避けるには、`leaseMs` を「`limit` 件を最後まで処理する時間」より長く取るか、`limit` を小さくする。
   * `tick` はジョブの所要時間を知らないので、この関係を検査しない。各ジョブの前にリースを延ばす口も `OutboxStore` には無い。
   * 【実測 2026-09-30】`packages/core/src/__tests__/tick-batch-lease-expiry.test.ts`（fake の store で、A が2件を claim →
   * 2件目の処理中に時計を進めて別の `tick` B が2件目を再 claim → A の `complete` は `leaseConflicts`、provider 呼び出しは3回）。
   */
  leaseMs: number;
  /**
   * 1回の `tick` で claim する上限。省略時の値は `@mnemora/core` の内部定数（`packages/core/src/runtime.ts` の `DEFAULT_TICK_LIMIT`）。
   * `0` なら何も claim しない。0 以上の整数を渡す前提であり、負数・非整数は例外になる
   * （`OutboxStore.claimBatch` がそのまま受け取る。Postgres は DB の例外、testkit の fixture は
   * 専用のメッセージ）。
   */
  limit?: number;
  /**
   * claim する job の種類。省略時は {@link TICK_SUPPORTED_JOB_KINDS}。
   *
   * - **その外の種類の行は、既定の `tick` では claim されず、終端にもならないまま残る**
   *   （ADR 0082「頼まれていない kind は claim すらしない」）。明示して渡したときだけ claim し、
   *   {@link TickResult.unsupported} として `fail` に落とす。
   * - 空配列は何も claim しない。
   * - claim の順は、種類に関わらず `available_at` の古い順である。種類ごとの枠の配分は無い
   *   ——古い job が `limit` を埋めていれば、後から積まれた別の種類の job は次の `tick` に回る。
   */
  kinds?: OutboxJobKind[];
  /**
   * claim した worker の名前（outbox の行の `claimed_by`）。省略すると `RuntimeConfig.defaultClaimedBy`、それも無ければ `"runtime.tick"`。
   * ⚠ 空文字は省略と同じにはならず、そのまま `OutboxStore.claimBatch` に渡る（`ClaimOutboxJobsOptions.claimedBy` の doc）。
   */
  claimedBy?: string;
  /**
   * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)（クローン miku の判断）:
   * 中断の合図。**既定の時間の上限にはならない**——省略すれば今までどおり provider が
   * 返るまで待ち続ける。
   *
   * `signal` を渡し、それが abort されると:
   * - claim 済みで処理中・未着手のジョブは、**`fail()` しない**——claim されたまま残り、
   *   リースが切れれば次の `tick` が取る。abort までに `complete()` まで記録できたジョブの
   *   完了は残る。
   * - `tick()` 自身は reject する（`signal.reason`。無ければ `AbortError` 相当）。
   *   `TickResult` はこの中断のために新しい欄を持たない——`tick()` が reject した時点で
   *   戻り値は無い。
   * - `tick` がリースを超えたこと自体を名乗る口は、今回も追加していない
   *   （上の「今の振る舞い」の追記のとおり）。
   */
  signal?: AbortSignal;
}

/**
 * `tick` が claim したものの、**処理する分岐を持たなかった**ジョブ（ADR 0082）。
 * {@link TickResult.unsupported} の要素型。
 *
 * **件数の欄を持たない**（`ReextractSkip` / `StageSkippedOmission` に倣った形。ADR 0029）
 * ——ここは配列そのものが件数を持っている。
 */
export interface UnsupportedOutboxJob {
  /** `fail()` で終端に落とした outbox 行の id。どの行が焼かれたかを名指しできる。 */
  jobId: string;
  /** その行の `kind`。`TICK_SUPPORTED_JOB_KINDS` に無かったもの。 */
  kind: OutboxJobKind;
}

/**
 * 🔴 ADR 0142 / Issue #233: `tick` がジョブの結果を `complete`/`fail` で記録しようと
 * した時点で、既にリースを失っていた（`OutboxLeaseConflictError`）ジョブ。
 * {@link TickResult.leaseConflicts} の要素型。
 *
 * **これは失敗ではない。** リース競合が起きるのは、別のワーカーが既に同じジョブを
 * 再 claim して（成功にせよ失敗にせよ）終端まで進めた場合だけである——
 * `claimBatch` の `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）が、
 * 終端化されていない行しか対象にしないため。**システムから見れば、そのジョブは
 * （このワーカー以外の誰かによって）既に済んでいる。**
 */
export interface OutboxLeaseConflict {
  /** 競合した outbox 行の id。 */
  jobId: string;
  /** その行の `kind`。 */
  kind: OutboxJobKind;
  /**
   * このワーカーが記録しようとしていた結果。`"complete"` はジョブの処理自体には
   * 成功したが、その結果を記録しようとした時点でリースを失っていたことを示す。
   * `"fail"` は、処理に失敗した（または `"complete"` の記録自体が競合以外の理由で
   * 失敗した）ため `fail()` で記録しようとしたが、それもリース切れで記録できな
   * かったことを示す。**いずれの場合も、この worker はジョブの最終的な結果に
   * 影響を与えていない**——別のワーカーが既に書いた結果がそのまま残る。
   */
  attemptedOutcome: "complete" | "fail";
}

/** `Runtime.tick` の結果。 */
export interface TickResult {
  /** この tick で処理に成功し、`complete()` まで記録できたジョブの本数（完了の記録がリースの競合で弾かれたものは数えない）。 */
  processed: number;
  /**
   * この tick で `outboxStore.fail()` を呼び、それが `OutboxLeaseConflictError` で
   * 弾かれなかった件数。
   *
   * ⚠ **2026-09-26 追記（[Issue #836](https://github.com/takecchi/mnemora/issues/836)）:
   * 「`fail()` を呼んで弾かれなかった」は「その行が終端 `failed` になった」と同じでは
   * ない。** `outboxStore.complete()` がハンドラの成功を DB へコミットした**後**に
   * `OutboxLeaseConflictError` 以外の例外（コミット後の接続断・タイムアウト等）を
   * 返すと、`tick()` はそれを「処理が失敗した」と区別できずに `fail()` を呼ぶ。
   * `OutboxStore.complete`/`fail` の契約（Issue #826）により、既に `completed_at` が
   * 付いた行に対する `fail()` は無言の no-op になる——行は `completed` のまま
   * （`failed_at`/`last_error` は `NULL`）で変わらないが、`tick()` はそれでも
   * `failed` を1増やす。この場合、行の実際の終端状態（`completed`）と `failed`
   * の集計は食い違う。`unsupported` にも `leaseConflicts` にも載らないため、
   * `TickResult` からはどの1件がこのずれに当たるかを特定できない。
   * `OutboxStore.complete`/`fail` はどちらも `Promise<void>` で、`OutboxStore` に
   * id で1件を読み直す口も無いため、`tick()` 自身にこれを区別する手段は無い
   * （[ADR 0142](../../../docs/decisions/0142-outbox-complete-fail-compare-and-swap.md)
   * の同日付追記を参照）。
   */
  failed: number;
  /**
   * `failed` の**内訳**のうち、「処理を試みて失敗した」のではなく
   * 「`tick` がその kind を処理する分岐を持っていなかった」もの（ADR 0082、issue #105）。
   *
   * 🔴 **この欄が在る理由は1つだけ**——これが無いと、
   * 「embed の provider が落ちて失敗した」と「`kinds: ['consolidate']` を渡したが
   * `tick` は consolidate を処理できない」が、どちらも `failed: 1` という**同じ顔**になる。
   * それは ADR 0029 が `ReextractResult.skipped` で塞いだのと同じ族の欠落
   * （「無い」の種類を潰す）である。**`unsupported` に入ったジョブは `failed` にも数える**
   * ——`failed` の意味（`fail()` を呼んで弾かれなかった件数）は変えていない。⚠ **この
   * 「`fail()` を呼んで弾かれなかった件数」という意味そのものが、「終端が `failed` に
   * なった件数」と常に一致するとは限らない**（`failed` フィールド自身の doc コメント、
   * [Issue #836](https://github.com/takecchi/mnemora/issues/836) 参照）——ただし
   * `unsupported` に入るジョブ（対応する handler が無い）はこの分岐（`complete()` が
   * コミット後に例外を返す）を通らないため、このずれの対象にはならない。
   *
   * ⚠ **ここに出たジョブは `fail()` で終端に落ちている**（Phase 1 に自動リトライは無い。
   * ADR 0032）。黙って lease 切れを待つ形にはしない——claim したまま何もしないと、
   * 「claim され続けるがいつまでも進まない」という、まさに呼び出し側から見えない停止になる。
   *
   * 空配列が既定であり、`undefined` にはならない（「出なかった」と「見ていない」を
   * 同じ顔にしないため）。
   */
  unsupported: UnsupportedOutboxJob[];
  /**
   * 🔴 ADR 0142 / Issue #233: このジョブの結果を記録しようとした時点で、既にリースを
   * 失っていた（`OutboxLeaseConflictError`）ジョブ。**`processed` にも `failed` にも
   * 数えない**——「無い」の種類を潰さない、`unsupported` と同じ理由（ADR 0008 の族）。
   * 良性の競合（正常な並行の結果）を、失敗という別の顔に変えない。
   *
   * `tick` はこの例外を検知すると、**そのジョブだけを飛ばして残りのジョブの処理を
   * 続ける**——1件の良性の競合で、同じ `tick` 呼び出し内の他のジョブまで処理が
   * 止まるのは、狭い事象を広い停止に変換する形であり、避ける。
   *
   * 空配列が既定であり、`undefined` にはならない。
   */
  leaseConflicts: OutboxLeaseConflict[];
}

/**
 * {@link Runtime.sweepArchive} の返り値（ADR 0114）。
 *
 * `MemoryStore.archiveDecayed` は任意メソッドである。**store 側の
 * `ArchiveDecayedResult`（`interfaces/memory-store.ts`） をそのまま返り値にしない**——store 側の型には
 * 「口が無かった」を語る場所が無い（口が無ければそもそも呼べないので、store が
 * 自分について「対応していない」と言う機会が無い）。この違いを埋めるのが `supported`
 * である。
 *
 * ⛔ **`supported` を省略可能にしない**（`WriteAtomicity`（ADR 0100）と同じ理由——
 * `undefined` は「口が無かった」と「この欄が増える前の版の戻り値」の両方を意味して
 * しまい、「無い」の種類を潰す）。
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

/**
 * `runtime.restoreArchived` の対象（Issue #195、ADR 0122）。`ForgetTarget` と**意図的に
 * 同じ形**——`{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論であり、
 * 内部で `MemoryId[]` に正規化してから処理する。
 */
export type RestoreArchivedTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.restoreArchived` の任意オプション（Issue #195、ADR 0122）。`ForgetOptions` と同じ形。 */
export interface RestoreArchivedOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
}

/**
 * `runtime.restoreArchived` が対象1件ごとに返す結果（Issue #195、ADR 0122）。
 * `ForgetOutcome` と**同じ6つの `kind`**（`forgotten`/`already_forgotten` の位置が
 * `restored`/`status_not_archived` に入れ替わるだけ）——呼び出し側の次の一手が違う
 * 状況を1つの `boolean` に潰さない、という同じ「無い」の分類（ADR 0008）を適用する。
 *
 * - `"restored"`: 今回の呼び出しで実際に `status` を `archived` から `active` へ動かし、
 *   `memory_events` に `kind: 'restored'` を積んだ。`previousStatus` は常に `"archived"`
 *   （このメソッドが動かす遷移はこの1本だけであり、他の値を取らない）。
 *   **⚠ 2026-09 追記（マネージャー決定、Issue #196 / [ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）:
 *   `status` の復帰に続けて `MemoryStore.reinforce` も呼ぶ**（`decay_floor_at` を
 *   復帰の瞬間から引き直す。理由は `restoreArchived` の JSDoc・ADR 0153 を参照）。
 *   **`reinforce` が失敗しても、既に成功した `status` の復帰は握り潰さない**
 *   ——`kind` は `"restored"` のままで、失敗は `reinforceError` に運ぶ
 *   （additive。省略時は成功、または対象が無かった旧来の形と区別が付かないという
 *   ことはない——`reinforce` は必ず `status` の復帰の直後に試みるので、この欄が
 *   無ければ「試みて成功した」ことを意味する）。
 * - `"status_not_archived"`: 対象は最初から（または同じ呼び出し内の先行する要素の
 *   処理によって）`archived` ではなかった。**書き込みは一切起きていない。**
 *   `status` に現在値（`active`/`superseded`/`contested`/`forgotten` のいずれか）が入る。
 *   `ConsolidateSourceOutcome.status_not_active` と同じ命名規律——「対象は見た。
 *   だが前提の状態ではなかった」を1つの語で表す。
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い。
 * - `"conflicted"`: compare-and-swap が破れた——`getMany` で読んだ時点は `archived` だったが、
 *   実際に書きに行った時点では別の書き込みが割り込んでいた。**このメソッドは自動で
 *   再試行しない。**再読した結果が `"active"`（＝別の呼び出しがちょうど同じ復帰を
 *   先に済ませていた）だった場合は `"status_not_archived"` に含める——「求めていた状態に
 *   既に居る」ことは対立ではない（`forget` の `already_forgotten` と同じ扱い）。
 *   それ以外の状態に変わっていた場合だけ `"conflicted"` として `observedStatus` を運ぶ。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になったため、まだ見ていない。
 */
export type RestoreArchivedOutcome =
  | {
      memoryId: MemoryId;
      kind: "restored";
      previousStatus: "archived";
      /**
       * `status` の復帰に続けて試みた `reinforce` が失敗した場合だけ在る
       * （マネージャー決定、Issue #196 / ADR 0153）。省略時（`undefined`）は
       * `reinforce` も成功したことを意味する——「試みていない」という第3の状態は
       * 無い（`reinforce` は復帰が成功した全件に対して必ず試みる）。
       * 文字列は `"failed"` の `error` と同じ整形（params を落とし、cause と SQLSTATE を足し、4096字で切る。ADR 0363）。
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
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363、2026-09-30 追記）:
       * drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、`cause` の連鎖と
       * SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/**
 * `runtime.restoreArchived` の結果（Issue #195、ADR 0122）。
 *
 * ⛔ `restoredCount` のような派生値を持たない（`ForgetResult`/`ConsolidationResult` と
 * 同じ理由——`outcomes` を数えれば得られる値を欄として複製すると、片方だけ直して
 * ずれるという、このリポジトリが繰り返し踏んできた欠陥を新しく作ることになる）。
 */
export interface RestoreArchivedResult {
  /**
   * 入力（`RestoreArchivedTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: RestoreArchivedOutcome[];
}

/**
 * `runtime.restoreSuperseded` の対象（`docs/memory-model.md` §11 行15
 * 「`superseded → active`」を書き込む口）。
 *
 * 🔴 **粒度の既定は「群」であり、個別の Memory id を渡す形は無い。**`ForgetTarget`/
 * `RestoreArchivedTarget` の `{ memoryId } | { memoryIds }` という二形は、ここでは
 * 意図的に採らない。
 *
 * **理由**: `superseded` な Memory は `recall()` に出てこない——段1の候補生成が使う
 * status ゲートは `['active','contested']` 固定である（`recall-runtime.ts` の該当箇所。
 * `docs/recall.md` §2 段0「スコープの外延」）。⟹ **呼び出し側は「戻したい Memory の id」を
 * そもそも知る手段を持たない**——`restoreArchived` の呼び出し側が辿れる「recall で
 * 見つからないものを id で名指しする」という経路が、ここには無い。手元にある唯一の
 * 取っ手は「置き換えた側（supersede した側）」の id である。
 *
 * 🔴 **⚠ `superseded_by_id` が作る群は「1回の操作」とちょうど一致するとは限らない**
 * （[ADR 0230](../../../docs/decisions/0230-restore-superseded-recovery-path.md) 冒頭の
 * 訂正1・訂正4）。`resolveContested` の勝者は前から在る Memory であり、`reextract` の
 * アンカーも冪等な `ON CONFLICT` 経由で前から在る Memory に解決されることがある——
 * どちらも「同じ id の下に別々の操作の敗者が積み上がる」余地を残す。`consolidate` の
 * 統合先だけが常に新規作成である（構造的な保証。下記 `onlyMemoryIds` の doc コメント
 * 参照）。
 */
export type RestoreSupersededTarget = {
  /** 置き換えた側（supersede した側）の Memory の id。これを `supersededById` に持つ Memory の群を戻す。 */
  supersededById: MemoryId;
  /**
   * [Issue #515](https://github.com/takecchi/mnemora/issues/515) 方向①
   * （[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）:
   * 群を「1回の操作」単位に絞るための**任意の**フィルタ。指定すると、対象は
   * `superseded_by_id = supersededById` の群のうち、このリストに含まれる
   * `memoryId` だけへ絞られる（積集合）。**省略時は従来どおり群全体が対象**
   * ——既定は1バイトも変えない。空配列を渡すと対象0件になる（`id = ANY('{}')`
   * は常に偽であるため、特別扱いのコードは無い）。
   *
   * 🔴 **どの id をまとめて渡すかは、mnemora 自身は判定しない**
   * （[ADR 0223](../../../docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
   * 決定2「機械は検出まで」）。呼び出し側の責務:
   *
   * `opts.dryRun: true` で `previewRestoreSupersededBy?` を呼び、返る
   * `candidates[].supersededReason` を見て「どの `memoryId` が同じ操作に
   * 属するか」を自分で決めてから、ここへ渡す。ADR 0258 が実測した非対称:
   *
   * - `supersededReason === "consolidated"`: 同じ reason の候補は、1アンカーの
   *   下で高々1つの群にしかならない（`consolidate` は統合先の
   *   `sourceObservationId` を常に `null` にするため、`createMemory` の冪等
   *   `ON CONFLICT`〔`WHERE source_observation_id IS NOT NULL`〕の対象に
   *   一度も入らず、統合先は必ず新規作成される——構造的な保証）。
   *   ⟹ 同じ reason の候補全部をまとめて渡せば、それが1回の操作である。
   * - `supersededReason === "contested_resolved"`: **1件 = 1回の操作**
   *   （`resolveContested` は呼び出し1回につきちょうど1件の敗者しか作らない
   *   ——`packages/core/src/__tests__/resolve-contested-loser-invariant.test.ts`
   *   の歯が固定する）。⟹ **1件ずつ**渡すこと。まとめて渡すと、同じ勝者が
   *   複数回勝った別々の操作を、1回の呼び出しで混ぜて戻すことになる。
   * - 🔴 `supersededReason === "reextract_superseded"` と `null`
   *   （由来不明）: **既存の情報だけでは操作単位に分割できないことがある。
   *   ⛔ 割れるという顔をしない。**`reextract` のアンカーは候補列の先頭
   *   （`memoryIds[0]`）を位置で選ぶだけであり、その候補が冪等な
   *   `ON CONFLICT` 経由で既存の Memory に解決されると、複数回の別々の
   *   `reextract` 呼び出しが同じアンカーを共有しうる——このとき
   *   `meta.reason`/`sourceObservationId`/`extractorVersion` は複数回の
   *   呼び出しの間で完全に一致しうるため区別できない（ADR 0230 訂正4、
   *   ADR 0258）。まとめて渡すことは「同じ操作だと確認した」ではなく
   *   「確認できていないが、たまたま1回の操作かもしれない」という賭けである。
   *
   * {@link groupSupersededCandidatesByOperation} が、この判断を機械的に
   * 補助する任意の純関数として在る——ただし判定はしない・"unknown" を
   * 隠さない（同関数の doc コメント参照）。
   *
   * ⚠ **2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:
   * 上の判断材料（`supersededReason`）は、`MemoryStore.purgeExpiredEvents?`
   * （[ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)）が保持期間で
   * 掃除した後は取れなくなる。** `previewRestoreSupersededBy?` は `kind: 'superseded'`
   * の `memory_events` 行から `supersededReason` を読むが、`purgeExpiredEvents?` は
   * `kind = 'events_purged'` 以外の行をすべて対象にする——`superseded` 行も除外しない。
   * ⟹ 保持期間を過ぎた後は、`consolidated`/`contested_resolved` のように本来は
   * `"structural"`/`"per_item"` へ分類できたはずの候補も `supersededReason: null` に
   * 劣化し、`groupSupersededCandidatesByOperation` の `"unknown"` グループへ合流する。
   * **「最初から由来が無かった」候補と「由来はあったが掃除で消えた」候補は、この型・
   * この関数のどちらからも区別できない**——別々の操作の敗者が、たまたま同じ `null` に
   * なって1グループへ誤って統合されうる。詳細・採らなかった案は
   * [ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)
   * の同日付追記を参照。
   */
  onlyMemoryIds?: MemoryId[];
};

/**
 * {@link groupSupersededCandidatesByOperation} が返す1グループ。
 * [Issue #515](https://github.com/takecchi/mnemora/issues/515) 方向①
 * （[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）。
 */
export type SupersededOperationGroup = {
  /** 群を作った `superseded` イベントの `meta.reason`（自由文をそのまま運ぶ。無ければ `null`）。 */
  supersededReason: string | null;
  /** この群に入る Memory の id。 */
  memoryIds: MemoryId[];
  /**
   * この `memoryIds` の区切りが、1回の操作と一致することをどこまで
   * 保証できるかを正直に示す。⛔ **`"unknown"` は「安全」の意味ではない**
   * ——「同じ操作かもしれないし、別の操作かもしれない。mnemora はこれを
   * 区別する情報を持たない」という宣言である。
   *
   * - `"structural"`: `consolidate` が作る群。統合先は常に新規作成される
   *   という構造的な保証により、同じ reason の候補は必ず1操作分である。
   * - `"per_item"`: `resolveContested` が作る群。1件が必ず1操作
   *   （`resolve-contested-loser-invariant.test.ts` の歯が固定する不変条件）
   *   ——このとき `memoryIds` は常にちょうど1件になる。
   * - `"unknown"`: `reextract` が作る群、または `supersededReason` が
   *   取れなかった候補。既存の情報だけでは1回の操作と一致するかを
   *   判定できない（ADR 0230 訂正4、ADR 0258）。
   */
  boundaryConfidence: "structural" | "per_item" | "unknown";
};

/**
 * `previewRestoreSupersededBy?` が返す候補を、推定される「1回の操作」単位へ
 * グルーピングする補助（[Issue #515](https://github.com/takecchi/mnemora/issues/515)
 * 方向①、[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）。
 *
 * 🔴 **これは検出だけである。書き込みには一切触れない**
 * （[ADR 0223](../../../docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
 * 決定2「機械は検出まで」）。**どのグループを実際に `restoreSuperseded` の
 * `onlyMemoryIds` へ渡すかは、呼び出し側が決める**——この関数はその判断を
 * 代行しない。
 *
 * グルーピングの規則（`RestoreSupersededTarget.onlyMemoryIds` の doc
 * コメント参照。ここでは要約だけ）:
 * - `supersededReason === "consolidated"`: 同じ reason の候補をまとめて
 *   1グループにする。`boundaryConfidence: "structural"`。
 * - `supersededReason === "contested_resolved"`: 1件ずつ別グループにする
 *   （`memoryIds` は常に1件）。`boundaryConfidence: "per_item"`。
 * - それ以外（`"reextract_superseded"` を含む未知の reason、および
 *   `null`）: **同じ `supersededReason` の値ごとにまとめて返す**——
 *   ⛔ **1件ずつには分割しない。**分割すると「1件ずつが別操作である」という
 *   *偽の構造*を呼び出し側に与える——分けるのは「分からない」を「分かって
 *   いる」に化けさせる操作であり、`docs/north-star.md` の問い3（この記憶が
 *   選ばれた理由を、後から説明できるか）に反する。`boundaryConfidence:
 *   "unknown"` を付けたうえで、まとめた配列をそのまま返す。
 *
 * 入力の順序は保持しない（`supersededReason` の初出順にグループを並べる）。
 * 空配列を渡すと空配列を返す。
 *
 * ⚠ **2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:
 * この関数自身は渡された `supersededReason` をそのまま group key として使うだけであり、
 * `null` になった理由（最初から由来が記録されていなかったのか、
 * `MemoryStore.purgeExpiredEvents?` の保持期間の掃除で消えたのかのどちらか）は問わない。**
 * `purgeExpiredEvents?`（[ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)）
 * が走った後は、本来なら別々の `"consolidated"`/`"contested_resolved"` だった候補も
 * `null` に劣化してここへ渡され、同じ `"unknown"` グループへ合流しうる——
 * `boundaryConfidence: "unknown"` の宣言どおり「分からない」という顔のままだが、
 * この場合の「分からない」は**掃除によって後天的に作られたもの**であり、判定材料が
 * 最初から無かった場合と地続きに扱われる。詳細は
 * [ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)
 * の同日付追記を参照。
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
   * ⚠ **省略時の規律が `RestoreArchivedOptions.reason`/`ForgetOptions.reason` とは
   * 違う。**あちらは省略すると `meta` に `reason` キー自体を持たせないが、こちらは
   * 省略すると固定タグ `"unsuperseded"` が入る（`MemoryStore.restoreSupersededBy` の
   * 契約節、`meta` の doc 参照）。**この操作は群単位（複数の Memory にまたがる）
   * であり、`meta.supersededById`（外した相手の id）と組み合わせて監査ログから
   * 「どの群が、なぜ戻ったか」を引けるようにするには、`reason` キー自体が常に
   * 存在するほうが検索・集計しやすい——1件ずつの CAS である `restoreArchived` とは
   * 前提が違う、という判断。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * 🔴 **下見（Issue #515、ADR 0237、方向3「戻す前に何が戻るかを返す」）。**
   * `true` のとき、一切の書き込み（`memories` の `UPDATE`・`memory_events` への
   * `INSERT`・`reinforce`）を行わず、「実際に呼べば何が戻るか」だけを
   * {@link RestoreSupersededOutcome} の `"would_restore"` として返す。省略時 `false`
   * ——⚠ **既定は変えていない。省略・`false` のどちらでも、この PR 以前と1バイトも
   * 違わない「実際に戻す」経路を通る**（`PurgeOptions.dryRun` と同じ規律。あちらは
   * 対象 id が既知だが、こちらは「群」を範囲走査で選ぶ点が違う——選ぶ内容は
   * `MemoryStore.previewRestoreSupersededBy?` が `restoreSupersededBy?` と同じ
   * `WHERE` で選ぶ。前者が無い adapter では `supported: false`）。
   */
  dryRun?: boolean;
}

/**
 * `runtime.restoreSuperseded` が対象1件ごとに返す結果。
 *
 * `RestoreArchivedOutcome` と違い、`"not_found"`/`"status_not_archived"`/`"conflicted"`/
 * `"not_attempted"` を持たない——このメソッドは個別 id への compare-and-swap ではなく、
 * `MemoryStore.restoreSupersededBy` が1トランザクションで選んで戻した行の集合を
 * そのまま返すだけである。`status = 'superseded'` を条件に含めた `WHERE` 句が選定
 * そのものを兼ねるため、「対象ではあったが状態が違った」という分岐がそもそも
 * 発生しない——一致しない行は最初から選ばれていない。
 *
 * - `"restored"`: `status` を `"superseded"` から `"active"` へ動かし、
 *   `superseded_by_id` を `null` にし、`memory_events` に `kind: "unsuperseded"`
 *   （`MemoryEventKind` が本 PR で足す新しい値）を1件積んだ。続けて試みた
 *   `MemoryStore.reinforce` が失敗した場合だけ `reinforceError` が入る
 *   （`RestoreArchivedOutcome.reinforceError` と同じ規律——status の復帰そのものは
 *   reinforce の成否と無関係に確定している）。`decayFloorAt` は reinforce の
 *   成否に関わらず、この呼び出しが最後に観測した値（reinforce が成功していれば
 *   その結果、失敗していれば復帰直後の値）。
 * - `"would_restore"`: **Issue #515、ADR 0237。**`opts.dryRun: true` のとき、`status = 'superseded'`
 *   かつ `superseded_by_id` が対象と一致する行について、実際に呼べば `"restored"` に
 *   なったはずであることを示す。**書き込みは一切起きていない**（`reinforce` も呼ばない）。
 *   `supersededReason` は `MemoryStore.previewRestoreSupersededBy?` の doc コメント参照
 *   ——「なぜその群に入っているか」を運ぶが、`memory_events` に一致する行が無ければ
 *   `null`（**取れないことを `null` で正直に返す。取れるふりをしない**）。
 * - `"failed"`: 🔴 **現在の実装では到達しない防御的な分類**（`PurgeOutcome.conflicted`
 *   と同じ立場——`forget`/`restoreArchived` と同じ「上限の無い再試行にしない安全弁」の
 *   一族だが、こちらは元になる並行の競合そのものが構造的に起こらない）。
 *   `restoreSupersededBy` の1トランザクションが成功したあと、個々の Memory について
 *   `Runtime` が行うのは `reinforce` の呼び出しだけであり、その失敗は必ず
 *   `reinforceError` に運ぶ（`"failed"` には落ちない）。このメンバーは、将来 store 側が
 *   行ごとの部分失敗を報告するようになったときのための予約であり、今日のコードパスからは
 *   一度も生成されない。
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
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363、2026-09-30 追記）:
       * drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、`cause` の連鎖と
       * SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    };

/**
 * `runtime.restoreSuperseded` の結果。
 *
 * ⛔ `restoredCount` のような派生値を持たない（`RestoreArchivedResult`/`ForgetResult` と
 * 同じ理由——`outcomes` を数えれば得られる値を欄として複製すると、片方だけ直して
 * ずれるという、このリポジトリが繰り返し踏んできた欠陥を新しく作ることになる）。
 */
export interface RestoreSupersededResult {
  /**
   * `opts.dryRun` の有無で、見ている口が違う。**`dryRun` 省略・`false`**:
   * `MemoryStore.restoreSupersededBy?` が実装されていたか。**`dryRun: true`**:
   * `MemoryStore.previewRestoreSupersededBy?` が実装されていたか（Issue #515）
   * ——2つの口は独立した任意メソッドであり、片方だけを実装した adapter があり得る。
   * どちらの場合も `false` のとき `outcomes` は常に空配列**——`SweepArchiveResult.supported`
   * と同じ規律（「対応していないので0件」であって「対応していて0件だった」ではない。
   * 呼び出し側はこの2つを取り違えないよう、必ず `supported` を先に見ること）。
   */
  supported: boolean;
  /**
   * 置き換えた側（新しいほう）の id——`target.supersededById` をそのまま運ぶ。
   *
   * 🔴 **この操作は、この id が指す Memory に一切触れない。**消さない・`forget` しない・
   * `status` を変えない。呼び出し側がそれを見落とさないよう、返り値自身にも明示的に
   * 運ぶ——`recall()` は戻した直後、古いほう（`outcomes` に載る Memory）も新しいほう
   * （この `supersedingMemoryId`）も両方 `active` として返しうる。始末したいなら
   * 呼び出し側が `forget(ctx, supersedingMemoryId)` を別途呼ぶ、あるいは
   * `markContested` で対にすること——**この分岐をこのメソッドの `opts` には足さない**
   * （`Runtime.restoreSuperseded` の doc コメント「やらないこと」参照）。
   */
  supersedingMemoryId: MemoryId;
  /**
   * `MemoryStore.restoreSupersededBy` が返した `restored` の順序をそのまま引き継ぐ
   * （順序の契約は store 側に委ねる。`RestoreArchivedResult.outcomes` のような
   * 「入力と同じ順序」という契約は無い——入力がそもそも id の配列ではなく単一の群
   * 指定子であるため）。
   */
  outcomes: RestoreSupersededOutcome[];
}

/**
 * `runtime.purge` の対象（Issue #198、ADR 0124）。`ForgetTarget`/`RestoreArchivedTarget` と
 * 意図的に同じ形——`{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論であり、
 * 内部で `MemoryId[]` に正規化してから処理する。
 */
export type PurgeTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.purge` の任意オプション（Issue #198、ADR 0124）。`ForgetOptions`/`RestoreArchivedOptions` と同じ形に `dryRun` を足す。 */
export interface PurgeOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * 🔴 **下見（issue #198 の受け入れ条件が名指しする「dryRun 相当の下見」）。**
   * `true` のとき、一切の書き込み（`content`/`digest`/`purgedAt` の更新、
   * `memory_events` への追記、`VectorStore.deleteAcrossSpaces`）を行わず、「実行していたら
   * 何が起きたか」だけを {@link PurgeOutcome} の `"would_purge"`/`"already_purged"`/
   * `"status_not_forgotten"`/`"not_found"` として返す。**`already_purged` のときも
   * `dryRun: true` では `VectorStore.deleteAcrossSpaces` を呼ばない**（Issue #1425、
   * ADR 0382）——`dryRun` は名前どおり「何も書かない」ことが約束であり、`already_purged`
   * が既に書き込み0件を意味していても、この欄がある限りベストエフォートの副作用
   * （embedding の削除）も止める。省略時 `false`。
   */
  dryRun?: boolean;
}

/**
 * `"purged"` / `"already_purged"` の後始末（`VectorStore.deleteAcrossSpaces`）が失敗したことの知らせ
 * （ADR 0399、ADR 0382「引き受けた負債」1）。
 *
 * **失敗したときだけ付く。成功したときはプロパティ自体が無い。** `kind` は変わらない
 * （MemoryStore 側の書き込みは確定している）。`error` は例外の整形（`"failed"` outcome の `error` と同じ。outbox の `last_error` と同じ
 * 整形——params を落とし、cause と SQLSTATE を足し、4096字で切る。ADR 0363）。
 * `status` は将来の値のための判別子。
 */
export type PurgeEmbeddingCleanup = { status: "failed"; error: string };

function embeddingCleanupFailed(error: unknown): PurgeEmbeddingCleanup {
  return { status: "failed", error: describeFailure(error) };
}

/**
 * `runtime.purge` が対象1件ごとに返す結果（Issue #198、ADR 0124）。
 * `ForgetOutcome`/`RestoreArchivedOutcome` と同じ「無い」の分類（ADR 0008）に、
 * `purge` 固有の2値（`"would_purge"`/`"already_purged"`）を足す。
 *
 * - `"purged"`: この呼び出しで実際に `content`/`digest` をトゥームストーンで上書きし、
 *   `purgedAt` を設定し、`memory_events` に `kind: 'purged'` を積んだ
 *   （`VectorStore.deleteAcrossSpaces` もベストエフォートで試みた——失敗してもこの kind は
 *   変わらない。`Runtime.purge` の doc コメント参照）。**その試みが失敗したときだけ**
 *   `embeddingCleanup`（{@link PurgeEmbeddingCleanup}、ADR 0399）が付く。成功時は無い。
 *   `previousStatus` は常に `"forgotten"`。
 * - `"would_purge"`: `opts.dryRun: true` のとき、対象が `status === "forgotten"` かつ
 *   未 purge（`purgedAt` が `null`）であり、`dryRun: false` で呼べば `"purged"` に
 *   なったはずであることを示す。**書き込みは一切起きていない。**
 * - `"already_purged"`: 対象は既に purge 済み（`purgedAt` が非 `null`）だった。
 *   **`MemoryStore` への書き込みは一切起きていない**（`dryRun` の有無に関わらず同じ
 *   kind——「何も起きない」という結論自体は `dryRun` で変わらない）。**`dryRun` が
 *   `false`（省略時を含む）なら、`VectorStore.deleteAcrossSpaces` をベストエフォートで
 *   試みる**（Issue #1425、ADR 0382——埋め込みモデルを移した後に purge を再実行すると、
 *   旧 space に残った埋め込みをこの kind でも後始末できる）。`dryRun: true` のときは
 *   呼ばない。失敗したときだけ `embeddingCleanup` が付く（`"purged"` と同じ）。
 * - `"status_not_forgotten"`: 対象の `status` が `"forgotten"` ではなかった
 *   （`purge` は `forgotten` からのみ遷移できる、ADR 0124 決定1）。`status` に現在値が入る。
 *   **書き込みは一切起きていない。**
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い。
 * - `"conflicted"`: compare-and-swap が破れ、1回だけ再読した結果も上の3分岐のどれにも
 *   明確に分類できなかった——`forgotten` から抜け出す経路も、`purge` 以外に `purgedAt`
 *   を書く経路も本 PR の時点で存在しないため、**現在の実装では到達しない防御的な分類**
 *   （`forget`/`restoreArchived` と同じ、上限の無い再試行にしない安全弁）。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になった、または
 *   `MemoryStore.purgeMemory` が実装されていない（`PurgeResult.supported: false`）ため、
 *   この要素はまだ見ていない。
 */
export type PurgeOutcome =
  | {
      memoryId: MemoryId;
      kind: "purged";
      previousStatus: "forgotten";
      embeddingCleanup?: PurgeEmbeddingCleanup;
    }
  | { memoryId: MemoryId; kind: "would_purge"; previousStatus: "forgotten" }
  | { memoryId: MemoryId; kind: "already_purged"; embeddingCleanup?: PurgeEmbeddingCleanup }
  | { memoryId: MemoryId; kind: "status_not_forgotten"; status: Exclude<MemoryStatus, "forgotten"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | {
      memoryId: MemoryId;
      kind: "failed";
      /**
       * 失敗の説明。整形は outbox の `last_error` と同じ（ADR 0363、2026-09-30 追記）:
       * drizzle が包んだ文の `params:` 以降（SQL に付けた値）は落とし、`cause` の連鎖と
       * SQLSTATE（`(code: XXXXX)`）を足し、全体を4096字で切る。SQL の文そのものは残る。
       * 🔴 **文字列の形は「例外の `message` そのまま」ではない**——パースして使わないこと。
       */
      error: string;
    }
  | { memoryId: MemoryId; kind: "not_attempted" };

/**
 * `runtime.purge` の結果（Issue #198、ADR 0124）。
 *
 * ⛔ `purgedCount` のような派生値を持たない（`ForgetResult`/`RestoreArchivedResult` と
 * 同じ理由——`outcomes` を数えれば得られる値を欄として複製すると、片方だけ直してずれる
 * という、このリポジトリが繰り返し踏んできた欠陥を新しく作ることになる）。
 */
export interface PurgeResult {
  /**
   * `MemoryStore.purgeMemory` が実装されていたか。**`false` のとき `outcomes` は
   * 全要素が `"not_attempted"`**（`opts.dryRun` の有無に関わらず——`SweepArchiveResult.supported`
   * （ADR 0114）と同じ「無い」の扱い。この口を実装しない adapter に対しては、実際の
   * purge も下見も一様に「見ていない」と名乗る）。
   */
  supported: boolean;
  /**
   * 入力（`PurgeTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: PurgeOutcome[];
}

/**
 * `runtime.markContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性
 * （Issue #197、ADR 0134）。**新しい語彙を作らない**——`ForgetOutcome`/`ConsolidateSourceOutcome`
 * が既に使っている `"not_found"`/`"status_not_active"`/`"eligible"` にそのまま揃える。
 *
 * - `"eligible"` — `status === "active"`。書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_active"` — 存在はするが `status !== "active"`
 *   （既に `contested`・`superseded`・`archived`・`forgotten` のいずれか）。
 */
export type MarkContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> };

/**
 * `runtime.markContested` 全体の結末（Issue #197、ADR 0134）。ADR 0008 の「無い」の分類の
 * 適用——「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を
 * 1つの `false`/例外に潰さない。
 *
 * - `"contested"` — 両側を `status: 'contested'` へ動かし、`contestedWithId` を相互に
 *   設定した。**部分成功は無い**——`supersedeWithNewMemories` の `conflicted`（対象ごとに
 *   独立で部分成功を許す設計）とは違い、対向ペアは本質的に結合しているため全部成功する
 *   か全部失敗するかのどちらかである。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が
 *   `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。1回だけ再読した現在の
 *   `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.markContestedPair` が実装されていない
 *   （`MarkContestedResult.supported: false`）。フォールバック経路は無い
 *   （`archiveDecayed`/`purgeMemory` と同じ理由——`contestedWithId` を書ける経路は
 *   この口以外に無い）。
 */
export type MarkContestedOutcome =
  | { kind: "contested"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [MarkContestedSideOutcome, MarkContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.markContested` の任意オプション（Issue #197、ADR 0134）。`ConsolidateOptions`/
 * `ForgetOptions` と同じ形。
 */
export interface MarkContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested'` であり、
   * この欄では上書きしない——`consolidate`/`reflect` の `opts.reason` → `meta.note` と
   * 同じ形）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.markContested` の結果（Issue #197、ADR 0134）。
 */
export interface MarkContestedResult {
  /**
   * `MemoryStore.markContestedPair` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`**（`PurgeResult.supported`（ADR 0124）と同じ「無い」の
   * 扱い）。
   */
  supported: boolean;
  /** どう終わったか（{@link MarkContestedOutcome}）。 */
  outcome: MarkContestedOutcome;
}

/**
 * `runtime.resolveContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性
 * （Issue #197、ADR 0150）。**新しい語彙を作りすぎない**——`MarkContestedSideOutcome` が
 * 既に持つ `"not_found"`/`"eligible"` はそのまま使う。この操作固有に足すのは2つだけである。
 *
 * - `"eligible"` — `status === "contested"` かつ、相手の `contestedWithId` が互いを指して
 *   いる（`first.contestedWithId === second.id` かつ `second.contestedWithId === first.id`）。
 *   書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。`status` に現在値が
 *   入る。
 * - `"pair_broken"` — `status === "contested"` ではあるが、相互参照が成立していない
 *   （`contestedWithId` が相手を指していない、または `null`）。[ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md)
 *   が数え上げた「一対一が破れた状態」の読み取り側の反映であり、`markContestedPair`
 *   （ADR 0134）を経由する限り今日の実装では到達しないはずだが、`PurgeOutcome` の
 *   `"conflicted"` と同じ「防御的な分類」として残す。`contestedWithId` に観測した現在値
 *   （`null` を含む）が入る。
 */
export type ResolveContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_contested"; status: Exclude<MemoryStatus, "contested"> }
  | { memoryId: MemoryId; kind: "pair_broken"; contestedWithId: MemoryId | null };

/**
 * `runtime.resolveContested` に「どちらが正しいか」を渡すための判別可能 union
 * （Issue #197、ADR 0150）。**この型自身は何も判定しない**——呼び出し側が既に下した決定を
 * 運ぶだけである（`resolveContested` の interface JSDoc 参照）。
 *
 * - `"supersede"` — `winnerId` 側が勝ち残る。勝った側は `status: "active"`、負けた側は
 *   `status: "superseded"` + `supersededById: <勝者>` になる。
 * - `"both_active"` — どちらも正しかった（対向ではなかったと分かった）。両側とも
 *   `status: "active"` に戻る。`docs/memory-model.md` §11 lifecycle 行7の
 *   「（負けた側は）」という括弧書きが、負けた側が存在しない決着を許している。
 */
export type ContestedResolution =
  { kind: "supersede"; winnerId: MemoryId } | { kind: "both_active" };

/**
 * `runtime.resolveContested` 全体の結末（Issue #197、ADR 0150）。`MarkContestedOutcome`
 * と対称——「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を
 * 1つの `false`/例外に潰さない（ADR 0008 の「無い」の分類の適用）。
 *
 * - `"resolved"` — 両側を解決後の状態へ動かした。**部分成功は無い**——対向ペアは本質的に
 *   結合しているため（`MarkContestedOutcome` の `"contested"` と同じ理由）。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が
 *   `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。`markContested` と同じく
 *   **1回だけ**再読した現在の `status` を `conflicts` に積み、そこで打ち切る
 *   （上限の無い再試行ループにしない）。
 * - `"not_attempted"` — `MemoryStore.resolveContestedPair` が実装されていない
 *   （`ResolveContestedResult.supported: false`）。フォールバック経路は無い
 *   （`markContestedPair`/`archiveDecayed`/`purgeMemory` と同じ理由——`contestedWithId` を
 *   `null` へ戻せる口はこの口以外に無い。`resolveContestedPair` の interface JSDoc 参照）。
 */
export type ResolveContestedOutcome =
  | { kind: "resolved"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [ResolveContestedSideOutcome, ResolveContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.resolveContested` の任意オプション（Issue #197、ADR 0150）。`MarkContestedOptions`
 * と同じ形。
 */
export interface ResolveContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値
   * `'contested_resolved'` であり、この欄では上書きしない——`markContested`/`consolidate`/
   * `reflect` の `opts.reason` → `meta.note` と同じ形）。省略時は `meta` に `note` キー
   * 自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.resolveContested` の結果（Issue #197、ADR 0150）。
 */
export interface ResolveContestedResult {
  /**
   * `MemoryStore.resolveContestedPair` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`**（`MarkContestedResult.supported`（ADR 0134）と同じ
   * 「無い」の扱い）。
   */
  supported: boolean;
  /** どう終わったか（{@link ResolveContestedOutcome}）。 */
  outcome: ResolveContestedOutcome;
}

/**
 * `runtime.resolveOrphanedContested` が生存側1件を分類する適格性
 * ([Issue #825](https://github.com/takecchi/mnemora/issues/825)、ADR 0150 追記)。
 * `ResolveContestedSideOutcome`（上）と同じ「無いを分類して返す」流儀に倣うが、
 * この口は対の**もう一方**を分類しない——対向はもう `contested` ではない前提の口だから
 * である。
 *
 * - `"eligible"` — `status === "contested"` かつ `contestedWithId` が非 null で、その id の
 *   Memory が `"forgotten"` であるか、そもそも見つからない（purge 済み等）。
 * - `"not_found"` — そのテナントに `survivorId` の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。
 * - `"no_contested_with_id"` — `status === "contested"` だが `contestedWithId` が `null`
 *   （ADR 0150 負債2「片側だけの `contested`」と同じ形の壊れ方。**この口はそれを直さない**
 *   ——対象外として ineligible で返す）。
 * - `"opposite_not_orphaned"` — `contestedWithId` の指す Memory が見つかったが、
 *   `status` が `"forgotten"` ではない（`active`/`contested`/`superseded`/`archived` のいずれか）。
 *   まだ `resolveContestedPair`（決定3の CAS）で正規に解決できる可能性がある対象を、
 *   この口が代わりに割り込んで処理しないためのガード。
 *   ⚠ 2026-09-28 訂正: ここは以前 `archived` を挙げていなかったが、実装は `"forgotten"` かどうかだけを見るので、
 *   対向が `archived` のときもこの値になる（`oppositeStatus: "archived"`）。文書を実装に合わせた（実装は変えていない）。
 *   `Runtime` の口には `contested` な記憶を `archived` にするものは無い（`sweepArchive` が掃くのは `active` だけ）が、
 *   `MemoryStore.updateStatus` を直接呼べば作れる。歯は
 *   `packages/postgres/src/__tests__/resolve-orphaned-contested-opposite-archived.postgres.test.ts`
 *   （Postgres と testkit の fixture）。
 */
export type ResolveOrphanedContestedEligibility =
  | { kind: "eligible"; contestedWithId: MemoryId }
  | { kind: "not_found" }
  | { kind: "status_not_contested"; status: Exclude<MemoryStatus, "contested"> }
  | { kind: "no_contested_with_id" }
  | { kind: "opposite_not_orphaned"; contestedWithId: MemoryId; oppositeStatus: MemoryStatus };

/**
 * `runtime.resolveOrphanedContested` 全体の結末
 * ([Issue #825](https://github.com/takecchi/mnemora/issues/825)、ADR 0150 追記)。
 * `ResolveContestedOutcome`（上）と対称の語彙を使う。
 *
 * - `"resolved"` — 生存側を `status: "active"`・`contestedWithId: null` へ動かした。
 * - `"ineligible"` — 読んだ時点で `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。`resolveContested` と同じく
 *   **1回だけ**再読して打ち切る（上限の無い再試行ループにしない）。
 * - `"not_attempted"` — `MemoryStore.resolveOrphanedContested` が実装されていない
 *   （`ResolveOrphanedContestedResult.supported: false`）。フォールバック経路は無い。
 */
export type ResolveOrphanedContestedOutcome =
  | { kind: "resolved"; memory: Memory }
  | { kind: "ineligible"; eligibility: ResolveOrphanedContestedEligibility }
  | { kind: "conflict"; observedStatus: MemoryStatus | null }
  | { kind: "not_attempted" };

/**
 * `runtime.resolveOrphanedContested` の任意オプション
 * ([Issue #825](https://github.com/takecchi/mnemora/issues/825)、ADR 0150 追記)。
 * `ResolveContestedOptions`（上）と同じ形。
 */
export interface ResolveOrphanedContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値
   * `'contested_resolved'` であり、この欄では上書きしない）。省略時は `meta` に `note`
   * キー自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.resolveOrphanedContested` の結果
 * ([Issue #825](https://github.com/takecchi/mnemora/issues/825)、ADR 0150 追記)。
 */
export interface ResolveOrphanedContestedResult {
  /**
   * `MemoryStore.resolveOrphanedContested` が実装されていたか。**`false` のとき
   * `outcome` は必ず `{ kind: "not_attempted" }`。**
   */
  supported: boolean;
  /** どう終わったか（{@link ResolveOrphanedContestedOutcome}）。 */
  outcome: ResolveOrphanedContestedOutcome;
}

/**
 * `runtime.markContestedGroup` がメンバー1件を分類する適格性（Issue #207/#933 PR2、
 * ADR 0327 §4-c、ADR 0378、ADR 0381）。`MarkContestedSideOutcome`（2者版）と同じ
 * 「無いを分類して返す」流儀だが、`MemoryStore.markContestedGroup` の CAS が
 * `active`/`contested`（穴A の相方吸収）/`contested`（既存群の合併吸収）の3通りを
 * 許すぶん、分類も3者版になる（interface 側の `MemoryStore.markContestedGroup` JSDoc の
 * 契約と1対1対応）。
 *
 * - `"eligible"` — 次のいずれか: (1) `status === 'active'`。(2) `status === 'contested'` かつ
 *   `contestedWithId` が渡された `members` の**他の**誰かの id と一致する（穴Aの吸収）。
 *   (3) `status === 'contested'` かつ `contestedWithId === null`（既存群の合併吸収——
 *   実際にその群と `members` がつながっているかは `Runtime` 側で
 *   `detectClaimKeyContested`/呼び出し側が `RelationStore.listRelated` を使って確かめる
 *   前提であり、この分類自体は行レベルの形だけを見る）。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_conflict"` — 上の3通りのいずれにも当てはまらない（`contested` だが
 *   `contestedWithId` が `members` の外を指す、または `superseded`/`archived`/`forgotten`）。
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
 * `runtime.markContestedGroup` 全体の結末（Issue #207/#933 PR2、ADR 0327 §4-c、ADR 0378、
 * ADR 0381）。`MarkContestedOutcome`（2者版）と対称の語彙——「対象が適格でなかった」
 * 「書き込み時点で競合した」「対応していない」を1つの `false`/例外に潰さない。
 *
 * - `"contested_group"` — 全メンバーを `status: 'contested'`・`contestedWithId: null` へ
 *   動かし、有効期間が重なる組に `memory_relations` を張った。**部分成功は無い。**
 * - `"ineligible"` — `getMany` で読んだ時点で、1件以上が `"eligible"` でなかった。
 *   **書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では全員 `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。1回だけ再読した現在の
 *   `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.markContestedGroup` が実装されていない
 *   （`MarkContestedGroupResult.supported: false`）。フォールバック経路は無い。
 */
export type MarkContestedGroupOutcome =
  | { kind: "contested_group"; members: Memory[] }
  | { kind: "ineligible"; sides: MarkContestedGroupSideOutcome[] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.markContestedGroup` の任意オプション（Issue #207/#933 PR2、ADR 0381）。
 * `MarkContestedOptions`（2者版）と同じ形。
 */
export interface MarkContestedGroupOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested'` であり、
   * この欄では上書きしない——`markContested` の `opts.reason` → `meta.note` と同じ形）。
   * 省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.markContestedGroup` の結果（Issue #207/#933 PR2、ADR 0381）。
 */
export interface MarkContestedGroupResult {
  /**
   * `MemoryStore.markContestedGroup` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`。**
   */
  supported: boolean;
  /** どう終わったか（{@link MarkContestedGroupOutcome}）。 */
  outcome: MarkContestedGroupOutcome;
}

/**
 * `runtime.resolveContestedGroup` がメンバー1件を分類する適格性（Issue #207/#933 PR2、
 * ADR 0327 §4-c、ADR 0378 決定3、ADR 0381）。`ResolveContestedSideOutcome`（2者版）と
 * 違い、群のメンバーは `contestedWithId` を持たない設計（`markContestedGroup` 契約）なので
 * `"pair_broken"` に相当する分類は無い——`status` だけを見る。
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
 * `runtime.resolveContestedGroup` 全体の結末（Issue #207/#933 PR2、ADR 0381）。
 * `ResolveContestedOutcome`（2者版）と対称の語彙。
 *
 * - `"resolved"` — 全メンバーを `resolution` に従って `active`/`superseded` へ動かし、
 *   このメンバー間の `memory_relations` を双方向とも削除した。
 * - `"ineligible"` — 読んだ時点で、1件以上が `"eligible"` でなかった——**うち `members` が
 *   `memory_relations` でつながった「今も `contested` な」群の一部しか渡されていなかった
 *   場合も含む**（2026-09-30 の直し、ADR 0381）。この場合は `sides` に含めきれない欠けた
 *   メンバーの id を `missingMembers` に積む（`sides` は渡された `members` だけを分類する
 *   ため、渡されなかった欠けたメンバーはそもそも `sides` に現れない）。**書き込みは一切
 *   試みていない。**
 * - `"conflict"` — 読んだ時点では全員 `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU、または store 側の
 *   全体一致 CAS 違反）。1回だけ再読した現在の `status` を `conflicts` に積む。
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
 * `runtime.resolveContestedGroup` に「どちらが正しいか」を渡すための判別可能 union
 * （Issue #207/#933 PR2、ADR 0378 決定3、ADR 0381）。`ContestedResolution`（2者版）と
 * 完全に同じ形——新しい決着の種類は増やさない。`"supersede"` の `winnerId` は
 * `members` のうちのちょうど1件を指す。
 */
export type ContestedGroupResolution = ContestedResolution;

/**
 * `runtime.resolveContestedGroup` の任意オプション（Issue #207/#933 PR2、ADR 0381）。
 * `ResolveContestedOptions`（2者版）と同じ形。
 */
export interface ResolveContestedGroupOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested_resolved'`
   * であり、この欄では上書きしない）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.resolveContestedGroup` の結果（Issue #207/#933 PR2、ADR 0381）。
 */
export interface ResolveContestedGroupResult {
  /**
   * `MemoryStore.resolveContestedGroup` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`。**
   */
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
   * `docs/architecture.md` §3.5 の Observation 冪等キー（`externalId`）は、その Observation
   * から生まれた Memory がその後どうなったかを問わない（2026-09-26 追記、クローン miku の
   * 判断、[Issue #897](https://github.com/takecchi/mnemora/issues/897)）。`forget()` で
   * `forgotten` になった、あるいはさらに `purge()` でトゥームストーン化された Memory の
   * 元になった Observation と同じ `externalId` で `observe()` を呼び直しても、
   * `createObservationWithOutbox`（`handleExtractableObservation` 参照）は既存の
   * Observation を `created: false` で返し、抽出はやり直さない——
   * `{ memoryIds: [], extraction: 'skipped', extractionFailure: null }` がそのまま返る。
   * `extract: 'sync'`/`'deferred'` のどちらでも同じ形になる（`created: false` の分岐は
   * `extractMode` を見るより前にあるため）。この振る舞いは `forgotten`（`purge` 前）の
   * 段階でも同じである——`createObservationWithOutbox` は Observation どうしの一致だけを
   * 見ており、対応する Memory の `status` を一度も読まない。
   *
   * 理由: 抽出をやり直すと、`purge()` で消した内容が同じ `externalId` の再送だけで
   * 蘇りうる。それは「忘れさせる」という約束と正面から食い違う。
   *
   * ⚠ 呼び出し側は、この返り値だけでは「正常な冪等の再送」と「forgotten/purged が原因で
   * 無視された」を区別できない。`ObserveResult` に内訳を持たせる案は見送った（公開の型が
   * 増えるため）——将来の選択肢としては残っている。
   *
   * 投げる例外（現状の振る舞いを約束として書く）:
   * - `input` を `ObserveInputSchema` で検証し、合わなければ zod の `ZodError` を投げる
   *   （何も書く前）。
   * - `extract: "deferred"` と `subjectCandidates`（空でない）、または `claimKey` を同時に
   *   渡すと、{@link SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX} /
   *   {@link CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX} で始まる `Error` を投げる（何も書く前）。
   * - LLM の呼び出しの失敗は投げない。全文フォールバックへ倒し、`extractionFailure` に載せる
   *   （docs/memory-model.md §4）。
   * - store が投げた例外は、そのまま伝わる。ただし抽出した候補の書き込み（`createMemoryWithOutbox`）の例外は下のとおり。
   *   ⚠ 2026-09-28 変更（[Issue #1063](https://github.com/takecchi/mnemora/issues/1063)、
   *   [ADR 0347](../../../docs/decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)。
   *   クローン miku の判断であり、オーナーの判断ではない）: LLM の抽出結果が schema は通るが保存できない値を含むと、
   *   **その候補だけを落とし、残りの候補は書いて、投げない。**候補の書き込みが投げたことだけを根拠にする（core は
   *   保存できない値と一時的な障害を見分けられない）。**全件が落ちたら、最初の例外をそのまま投げ、何も書かない**
   *   （この変更の前から例外になっていた入力であり、投げる入力は減る側にだけ変わった）。
   *   - 落とした候補は、残った候補の `created` イベントの `meta.droppedCandidates`（`index`・`contentHash`・
   *     最も内側の原因の `code`・`message`。候補の本文は写さない）に残る。**この戻り値には出ない**
   *     （`memoryIds` が候補の数より少なくなるだけ。`extraction` は `"ok"`・`extractionFailure` は `null` のまま）。
   *   - 全文フォールバックの Memory は作られない（docs/memory-model.md §4 の安全弁は、LLM の呼び出しの失敗だけを覆う）。
   *   - 本文の NUL は `@mnemora/postgres` も testkit の fixture も拒む。語の多い 1MB 超の本文は、どちらも受け入れる
   *     （Postgres は migration 0025 以降。それ以前は Postgres だけが tsvector の上限で拒んでいた。Issue #1222・ADR 0364）。
   *   - 候補を全件書いてから、`created` を積む（落とした候補は全件を書き終えるまで分からない）。
   *   【実測 2026-09-28】`packages/postgres/src/__tests__/observe-unsaveable-candidate.postgres.test.ts`。
   *   ⚠ 例: 孤立サロゲートを含む `text` などの欄は、`@mnemora/postgres` では Observation を
   *   書く前に例外になり、testkit / core の Fake では通る（`MemoryStore.createObservation` の
   *   doc、Issue #1075）。
   *
   * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)。クローン miku の判断）:
   * 任意の第3引数 `opts?: AbortOptions` を足した。** `opts.signal` は、この Observation が
   * `extract: 'sync'`（既定）で LLM を呼ぶ間だけ効く——**Observation と `extract` ジョブは、
   * LLM を呼ぶ前に既に書かれている**（`createObservationWithOutbox`）。abort されると:
   * - `observe()` は reject する（`signal.reason`。無ければ `AbortError` 相当）。
   *   **上の「LLM の呼び出しの失敗は投げない。全文フォールバックへ倒す」には倒さない**
   *   ——中断と LLM の失敗を同じ顔にしない。
   * - 全文フォールバックの Memory は作られない。抽出候補も1件も書かれない。
   * - `extract` ジョブは `complete()` されず、claim もされていないまま残る——後の `tick()`
   *   がそのジョブを処理する（`processExtractJob`）。ただし、この observe 呼び出しにだけ渡した
   *   `subjectCandidates`・`claimKey` は永続化されないため、後の `tick()` からの再抽出には
   *   **届かない**（`runExtraction` の doc コメントの「`processExtractJob` は渡さない」と同じ理由）。
   * - `claimKey.enabled: true` を渡していた場合、claim key の LLM 呼び出し
   *   （`deriveClaimKeys`）は抽出の LLM 呼び出しの**後**・Memory の書き込みの**前**に行う
   *   （`runExtraction` の実装順）。abort がどちらの呼び出し中に起きても、Memory の書き込みは
   *   まだ始まっていない——重複や部分書き込みの余地は無い。
   * `extract: 'deferred'` の経路・`kind: 'memory_usage'` の経路は LLM を呼ばないため、
   * `opts.signal` を渡しても何も変わらない。
   */
  observe(ctx: Ctx, input: ObserveInput, opts?: AbortOptions): Promise<ObserveResult>;
  /**
   * outbox に溜まったジョブを消化する（docs/architecture.md §3.3）。
   * `extract: 'deferred'` かつ `InlineScheduler`（キュー無し）構成では、これを誰かが
   * 明示的に呼ばない限り抽出・埋め込みは永久に走らない——「キューが無ければ黙って
   * 何も起きない」を作らない、という設計方針をそのまま体現する。
   *
   * `opts.leaseMs` は必須（ADR 0032）。`tick(ctx)` を引数無しで呼ぶことはできない
   * ——`claimBatch` の claim リース長は運用方針であり、`packages/core` が既定値を
   * 発明せず呼び出し側に決めさせるための意図した破壊的変更。`leaseMs` を省略したとき（型を外した呼び出し）の
   * 例外は、Runtime ではなく store が投げ、顔が store で違う（{@link TickOptions.leaseMs}）。
   *
   * 🔴 **処理する kind は {@link TICK_SUPPORTED_JOB_KINDS} が唯一の出所である**
   * （ADR 0082、issue #105）。`opts.kinds` の既定値もそこを指す。そこに無い kind を
   * `opts.kinds` に明示して渡した場合、そのジョブは claim され、**終端で失敗し**
   * （`fail()`。Phase 1 に自動リトライは無い）、{@link TickResult.unsupported} に
   * **名指しで**出る。黙って何も起きないまま lease が切れる形にはしない。
   *
   * ⚠ `OutboxJobKind` に名前が在ることと `tick` が処理することは**別である**——
   * その型の JSDoc も参照。
   */
  tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
  /**
   * roadmap.md 段階4「想起」・段階5「説明」。docs/recall.md §2 の7段パイプライン
   * （実装は `./recall-runtime.js` の `runRecall`）。
   *
   * 投げる例外（現状の振る舞いを約束として書く）:
   * - `query` を `RecallQuerySchema` で検証し、合わなければ zod の `ZodError` を投げる
   *   （store を読む前・書く前）。
   * - `channels` に `"lexical"` が在るのに `RuntimeDeps.lexicalStore` が無ければ、
   *   `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`（`recall.ts`）で始まる `Error` を投げる（ADR 0084 §4）。
   * - `RuntimeDeps.outputValidation` が `"throw"` のときだけ、組み立てた結果が検証に落ちると
   *   `RecallOutputValidationError` を投げる（ADR 0098。既定の `"report"` では投げない）。
   *   この検証は recall の記録（`recallId`）を書いた後に走る。
   * - store が投げた例外は、そのまま伝わる。
   *
   * `consolidate` / `reflect` の `{ query }` 形と `findCorrectionCandidates` は内部で
   * `recall()` を呼ぶので、同じ例外がそのまま届く。
   *
   * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)。クローン miku の判断）:
   * 任意の第3引数 `opts?: AbortOptions` を足した。** `opts.signal` はクエリの埋め込み
   * （`EmbeddingProvider.embed`）を待つ間だけ効く。abort されると `recall()` は reject し
   * （`signal.reason`。無ければ `AbortError` 相当）、`embedding_provider_unavailable` の
   * omission には倒さない。段6（記録、`MemoryStore.createRecall`）はクエリの埋め込みより
   * 後にしか走らないため、abort の時点では recall の記録も `activity_seq` の前進も
   * 起きていない。
   */
  recall(ctx: Ctx, query: RecallQuery, opts?: AbortOptions): Promise<RecallResult>;
  /**
   * [Issue #312](https://github.com/takecchi/mnemora/issues/312) /
   * [ADR 0161](../../../docs/decisions/0161-runtime-get-recall.md):
   * `recall()` が返した `RecallId` から、その recall が実際に何を・どの内訳で返したかを
   * **後から**読み戻す。
   *
   * ⚠ **その場の {@link RecallResult}（`recall()` の戻り値）ではなく、後から `recallId` で
   * 引く口である。**`recall()` を呼んだ時点の変数がスコープを抜けた後でも、`recallId` さえ
   * 持っていれば同じ内訳（`score`/`retrievedVia`/`companionOf`/`associationOf`）に
   * 後から届く——`docs/north-star.md`「目指す姿」の「なぜそれを思い出したのかを、
   * 後から説明できる。」の**「後から」**を、`Runtime` だけを持つ採用側にも届かせるための
   * 口である（ADR 0155 は `MemoryStore.getRecall` を用意したが、`Runtime` には出していない
   * ——本 issue はその欠落を埋める）。
   *
   * 見つからない（そもそも存在しない `recallId`）、または別テナントの recall なら
   * `null` を返す（例外にしない。`MemoryStore.get`/`getObservation`/`getRecall` と同じ規律）。
   *
   * 引数と返り値は {@link RecallId} / {@link RecallRecord} を**そのまま使う**（`TickOptions`
   * のように別の型を立てない）。この口は
   * `MemoryStore.getRecall`（`../interfaces/memory-store.js`）へそのまま素通しするだけで、
   * runtime 側が足す選択肢が1つも無いためである——`reembed`（ADR 0079、上の doc コメント
   * 参照）と同じ理由: **同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。**
   *
   * 🔴 **`RecallRecord.returnedMemories` は `memoryId`/`score`/`retrievedVia`/
   * `companionOf`/`associationOf` までしか運ばない——`digest` には届かない。**`recall()`
   * の戻り値（`RecalledMemory`）には `digest` が在るのに対して非対称である（ADR 0155
   * 決定1が `digest` を「後から `MemoryStore.get()` で再現できる」という理由で
   * `recalls` へ複製しなかったため）。`Runtime` には記憶を1件読む口が無いため、
   * `digest` まで要る採用側は `MemoryStore` を自前で保持する必要がある——検討の詳細は
   * ADR 0161 の「検討して採らなかった案」を参照。
   */
  getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
  /**
   * [Issue #369](https://github.com/takecchi/mnemora/issues/369) (C)「訂正の口」:
   * 採用側が「これは訂正だ」と明示的に宣言したとき、mnemora 側が**既存の recall で
   * 相手の候補を探す**ための口。[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)。
   *
   * 🔴 **測定の結果、「機械が相手を選んでそのまま `supersede` する」という形は採らないと
   * 決まった**——訂正してはいけない8ケース中6ケースで、失効させてはいけない事実を
   * 1位に置いてしまい、閾値をどこに引いても「訂正すべき」と「訂正してはいけない」を
   * 分離できなかった（実測、[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）。**⟹ この口は「候補を返すところまで」である。**
   *
   * この口が**やらないこと**（設計の芯。曲げない）:
   * - ⛔ **記憶と監査ログには書き込まない。** `Memory` の `status` を一切動かさない。
   *   `memory_events` に一切積まない。**`markContested`/`resolveContested` の
   *   *前*に立つ**——「訂正の相手をこれに決めて、実際に対にする／置き換える」という
   *   確定と書き込みは、常に採用側が `markContested`/`resolveContested`/
   *   `reextract` 等の既存の書き込み口を明示的に呼んで行う。この口はその前段の
   *   「相手を探す」だけを引き受ける。
   *   ⚠ 2026-09-27 訂正（[Issue #1244](https://github.com/takecchi/mnemora/issues/1244)）: 以前は「書き込みを1件もしない」と
   *   書いていたが、実装と合っていなかった。中で1回呼ぶ `recall()` が、recall の記録を1件書き（戻り値の `recallId`）、
   *   `decay_clock` が `'wall'` 以外のテナントでは `activity_seq` を1進める（ADR 0165 決めたこと5）。活動時計の
   *   テナントでは、訂正の相手を探すたびに記憶が1回ぶん沈む。【実測 2026-09-27】`@mnemora/postgres` と testkit の
   *   fixture で同じ（`correction-candidates-recall-record.postgres.test.ts`）。
   * - ⛔ **LLM を1回も呼ばない。** 相手探しは既存の `recall()`（ANN + 既存のスコア
   *   `strategies/scoring.ts`）だけで行う——訂正かどうかの判定・相手の良し悪しの
   *   判定のどちらにも LLM を使わない。
   * - ⛔ **新しい閾値を置かない。** 候補の足切りは `recall()` の段2が使う既存の
   *   `RecallQuery.scoreThreshold`（既定 `DEFAULT_SCORE_THRESHOLD` = 0.1）を
   *   そのまま通すだけであり、この口専用の閾値（「これ以上のスコアなら訂正の
   *   相手として妥当」）は発明しない。**理由は上記の測定そのもの**——閾値では
   *   「訂正すべき」と「訂正してはいけない」を分離できないことが分かっているので、
   *   分離できない閾値を1つ増やしても北極星の問い3（説明できるか）に答えられる
   *   ものにならない。
   * - ⛔ **新しい探索を書かない。** 既存の `recall(ctx, { text: input.text })` を
   *   **1回だけ**呼ぶ——`consolidate`/`reflect` の `{ seedMemoryId }` 形が
   *   「新しい『似ている』の判定を作らない」ために採った作法と同じ（`ConsolidateTarget`
   *   の doc コメント参照）。`text` 以外のフィールド（`limit`/`channels`/
   *   `overFetchFactor`/`scoreThreshold` 等）は一切変えず、`recall()` の既定に委ねる。
   *
   * ⭐ **`CorrectionCandidate.recallRank` は `excludeMemoryIds` で除外した後に詰め
   * 直さない。** `recall()` が返した並びでの、1始まりの順位をそのまま運ぶ——
   * 採用側が「これは recall の何位だった候補か」を、除外の有無に関係なく説明できる
   * ようにするため（北極星の問い3）。1位を自己除外で落としても、次に残る候補の
   * `recallRank` は「2」のままである。
   *
   * ⛔ **この口には「探していない」状態が無い。** `findCorrectionCandidates` を呼んだら
   * 必ず `recall()` を1回呼ぶ——`limit` の検証で早期に `RangeError` を投げる場合を除き、
   * 呼び出しが成立した以上、探索そのものをスキップする経路は無い。「見つからなかった」は
   * `FindCorrectionCandidatesResult.outcome: "no_candidates"` と、`recall()` から
   * そのまま運ばれる `omitted`（「候補はあったが除外条件で落ちた」等の内訳）の
   * **両方**で説明される——`ConsolidateOutcome`/`ReflectOutcome` と同じ「無い」の
   * 分類（ADR 0008）の適用。
   *
   * ⚠ **`tick()`/`observe()` からは一度も呼ばれない。** `markContested` と同じ立場——
   * 呼び出し側が明示的に呼んだときだけ動く。「訂正の口」は Phase 1 の自動化（背景で
   * 勝手に走る訂正）を意図しておらず、採用側が UI・ワークフローの中で明示的に
   * 「これは訂正だ」と宣言した瞬間にだけ動く。
   *
   * 実装（`createRuntime` 内）: `input.limit` が指定されていて整数でない・`1` 未満なら
   * `RangeError` を投げる（`markContested` の `firstId === secondId` と同じ位置づけ——
   * 書き込みも `recall()` も試みる前に落とす）。そうでなければ
   * `recall(ctx, { text: input.text })` を1回呼び、`excludeMemoryIds` を `Set` にして
   * 除外し、`limit` 件（既定 {@link DEFAULT_CORRECTION_CANDIDATE_LIMIT}）に切って返す。
   *
   * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)。クローン miku の判断）:
   * 任意の第3引数 `opts?: AbortOptions` を足した。**内部で1回呼ぶ `recall()` へそのまま渡す
   * だけであり、この口自身は中断を新しく判定しない——`recall()` の同日付追記のとおり、
   * クエリの埋め込みを待つ間だけ効く。abort されると reject する。
   */
  findCorrectionCandidates(
    ctx: Ctx,
    input: FindCorrectionCandidatesInput,
    opts?: AbortOptions,
  ): Promise<FindCorrectionCandidatesResult>;
  /**
   * ADR 0028: ADR 0013 が未解決のまま残した「失敗した抽出をやり直す」操作。
   * 指定した Observation に対してもう一度 `extractCandidates` を走らせ、成功したら
   * 同じ `(sourceObservationId, extractorVersion)` を持つ既存の `active` Memory のうち
   * 今回作られなかったもの（content_hash が今回の集合に無いもの）を `superseded` にする。
   * 安全弁3つ（LLM がまた失敗したら何もしない・候補0件なら何もしない・compare-and-swap で
   * TOCTOU の競合を検知する）は `ReextractResult` の doc コメントを参照。
   *
   * 抽出をやり直せない対象には、LLM も書き込みも試みる前に `Error` を投げる。Observation が
   * 見つからないとき（別テナントの id・形式の合わない id を含む）と、使用報告の Observation
   * （`kind: "usage"`。`observe({ kind: "memory_usage" })` が作る。抽出器を通らない、
   * docs/memory-model.md §6）を渡したとき（Issue #1099）である。
   *
   * ⚠ **2026-09-26 追記（Issue #873）: `extractorVersion` は `this`（この runtime インスタンス）
   * が生成時に固定した値であり、`reextract()` の引数ではない。** supersede の判定
   * （`listBySourceObservation(ctx, observationId, extractorVersion)`、ADR 0028 決定1）は
   * 「今回の runtime が持つ `extractorVersion` に一致する既存 Memory」しか見ない。
   * ⟹ **`extractorVersion` を上げた別の runtime インスタンスで同じ Observation を
   * reextract しても、旧い版の Memory は `toSupersede`/`skipped` のどちらにも現れず、
   * supersede されずに `active` のまま残る**——「supersede しなかった」とすら記録されない
   * （実測、Fake。`packages/core/src/__tests__/runtime-fakes.ts`）。新しい版の Memory も
   * `active` として作られるため、同じ Observation に由来する新旧2件の Memory が同時に
   * `active` になり、`recall()` の候補集合に両方出続ける。**旧い版の Memory を退役させる
   * のは運用側（呼び出し側）の責務であり、`reextract()` はその経路を持たない**——
   * `forget`/`consolidate` 等の既存の口を個別に呼ぶこと。版の並行比較
   * （`docs/roadmap.md` §4 技術上のリスク表）はこの性質の上に成り立っている。
   * 詳細は [ADR 0028](../../../docs/decisions/0028-reextract-superseded-cleanup.md) の
   * 2026-09-26 追記。
   *
   * ⚠ 2026-09-27 追記（新しい Memory に何が引き継がれるか。今の振る舞いを書くだけ。Postgres と testkit で実測）:
   * - **有効期間・`occurredAt` は、Observation から引き継ぐ**（`observe()` と同じ経路。`validUntil` が過去の
   *   Observation なら、新しい Memory も期限切れになる）。
   * - **`claimKey` は常に null である。**`reextract` には `observe()` の `claimKey`（opt-in）の口が無く、
   *   その鍵は保存もされない（ADR 0320 決定4・6、ADR 0324 負債3）。⟹ `claimKey` 付きで observe した
   *   Memory を置き換えると、置き換えた側（新しい Memory）は鍵を持たず、鍵は `superseded` の旧い Memory
   *   にだけ残る。同じ鍵の主張による矛盾の検出（ADR 0324）の対象からも外れる。
   * - **`subjectCandidates` の口も無い**（`sanitizeCandidateSubjectId` の doc。この行はコードを読んで
   *   確かめただけで、実測はしていない）。LLM が返した候補の
   *   `subjectId` は一覧で検査されず、省略された候補は Observation の `subjectId` へ落ちる。
   *
   * ⚠ **2026-09-28 変更（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・
   * [Issue #1149](https://github.com/takecchi/mnemora/issues/1149)）: 利用者の意思で退けた記憶を持つ Observation では、
   * 抽出をやり直さない。**`observe()` の再送が forget・purge した記憶について抽出をやり直さない規律（ADR 0124 の追記、
   * #897）と同じである。やり直すと、LLM の言い方しだいで、退けた事実が印の無い新しい `active` な Memory として戻るため。
   * - **退けた記憶として数えるもの**（同じ Observation・今の `extractorVersion` の記憶のうち、1件でも在れば）:
   *   `forgotten`（purge を含む）、`contested`（利用者の訂正でできたものも、claimKey の自動検出でできたものも）、
   *   訂正の解決で負けた `superseded`（その記憶の最新の `superseded` イベントの `meta.reason` が `"contested_resolved"`）。
   * - **数えないもの:** 機構（`reextract`・`consolidate`）で置き換えた `superseded`、`archived`、理由を読めない
   *   `superseded`（`superseded` イベントが無い・保持期間の掃除で消えた）。理由を読めないものを数えない側に倒すのは、
   *   やり直せなくなるほうが利用者に見えにくい失敗になるためである。
   * - **やり直さないときの戻り値:** LLM を呼ばず、何も書かない。`extraction: "skipped"`、`atomicity: "not_attempted"`、
   *   `memoryIds: []`、`supersededMemoryIds: []`、`extractionFailure: null`、`skipped` には退けた記憶ごとに
   *   `status_not_active`。同じ Observation の他の `active` な記憶も作り直さない（Observation 全体をやり直さない）。
   * - 判定のために、`superseded` の記憶1件ごとに `EventStore.list` を1回読む。
   * - ⚠ 2026-09-28 のこの変更の前は、退けたことを知らずにやり直していた（言い換えなら新しい `active` を作っていた）。
   * 歯: `packages/postgres/src/__tests__/reextract-withdrawn-memories.postgres.test.ts`（2実装。退けた記憶の4形と、
   * やり直す側の4形——退けた記憶が無い・機構の superseded 2形・理由の読めない superseded）。
   *
   * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)。クローン miku の判断）:
   * 任意の第3引数 `opts?: AbortOptions` を足した。** `opts.signal` は抽出の LLM 呼び出しを
   * 待つ間だけ効く。abort されると `reextract()` は reject し（`signal.reason`。無ければ
   * `AbortError` 相当）、`extraction: "llm_failed_whole_observation"` には倒さない。
   * LLM 呼び出しは、supersede 対象を読む・書くよりも前に行う——abort の時点では何も
   * 書かれていない。
   *
   * ⚠ **2026-09-30 変更（[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、
   * [ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）:
   * 「退けた記憶」の判定（上の2026-09-28 変更）は、`extractorVersion` を**問わなくなった**。**
   * 2026-09-28 時点では「同じ Observation・**今の** `extractorVersion` の記憶」だけを見ており、
   * `extractorVersion` を上げた runtime インスタンスで reextract すると、前の版で
   * forget・contest した記憶を見落とし、退けたはずの内容と同じ意味の Memory を印の無い新しい
   * `active` として書き直しうる欠陥があった（実測、Fake・Postgres 双方、Issue #1432 本文）。
   * いまは {@link MemoryStore.listBySourceObservationAllVersions} を使い、版を問わず
   * `forgotten`・`contested`・訂正の解決で負けた `superseded` を数える。
   * - **帰結**: 版を跨いでも、1件でも退けたものがあれば、その Observation の抽出全体を打ち切る
   *   （同じ版のときと同じ規律）。⟹ 運用側が旧い版の記憶を forget すると、その Observation の
   *   ほかの（退けていない）事実も、以後 reextract では新しい版の記憶として作られなくなる。
   *   `skipped` に `status_not_active` が出た Observation では、旧い版の記憶を残すことが
   *   運用側の手がかりになる。
   * - **変えていないもの**: **supersede 対象の判定**（`existingBefore`、下の実装）は今どおり
   *   `listBySourceObservation(ctx, observationId, extractorVersion)` のまま——**今の
   *   `extractorVersion` に一致する `active` な Memory しか supersede しない**。上の
   *   2026-09-26 追記（Issue #873「版を跨いだ旧い版は退役させない・運用側の責務」）はそのまま
   *   有効である。版を跨いで退けたものが無い Observation では、今どおり新しい版で抽出され、
   *   旧い版の `active` は supersede されない。
   * - 詳細・却下した案・EXPLAIN の実測は ADR 0380。
   *
   * ⚠ **2026-09-30 追記（[ADR 0406](../../../docs/decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)。
   * [Issue #1226](https://github.com/takecchi/mnemora/issues/1226) と同じ穴）: LLM を待つ間に、その
   * Observation から出た記憶が `forget`（`purge` を含む）されたら、何も書かずに打ち切る。**
   * 以前は、上の「退けた記憶」の確認が LLM の**前**だけで、待つ間の `forget` を見なかった——LLM が返った
   * 後に、言い換えが新しい `active` として書かれ、イベントが `created` → `forgotten` → `created` と
   * 積まれた（実測、Postgres）。今は LLM が返った直後に、LLM の前に読んだその Observation の記憶
   * （版・status を問わない）を `getMany` で読み直し、1件でも `forgotten` なら打ち切る。書き込み
   * （`supersedeWithNewMemories`／口が無い adapter 向けの `createMemoryWithOutbox`）にも
   * `opts.abortIfForgotten` を渡し、実装する adapter（`@mnemora/postgres`）は書き込みと同一
   * トランザクションでもう一度見直す（{@link SourceMemoryForgottenError}）。
   * - **打ち切ったときの戻り値**は、退けた記憶を持つ Observation の早期 return と同じ形——`memoryIds: []`・
   *   `supersededMemoryIds: []`・`extraction: "skipped"`・`atomicity: "not_attempted"`・`skipped` に
   *   forgotten だった記憶ごとの `status_not_active`。**例外は投げない。公開の型は増やしていない**
   *   （`consolidate`/`reflect` の `outcome: 'aborted_source_forgotten'` に当たる欄は `ReextractResult` に無い）。
   *   LLM は呼んだ（この場合 `extraction: "skipped"` でも LLM の呼び出しは起きている）。
   * - `abortIfForgotten` を実装しない adapter（testkit の `InMemoryMemoryStore`・core の fake）では、
   *   読み直しだけが保護になる（`consolidate`/`reflect` と同じ。読み直しと書き込みの間の窓は残る）。
   * - 見直すのは `forgotten` だけ。待つ間に `contested` になった記憶は見直さない（ADR 0406「引き受けた負債」1）。
   * 歯: `packages/postgres/src/__tests__/reextract-forget-race.postgres.test.ts`・
   * `reextract-source-forgotten-for-update-race.postgres.test.ts`。
   */
  reextract(ctx: Ctx, observationId: ObservationId, opts?: AbortOptions): Promise<ReextractResult>;
  /**
   * ADR 0079: 索引に載っていない Memory を**もう一度索引へ載せに行く**。
   *
   * `recall` は `omitted` に `{ kind: 'not_indexed', reason }` を積んで
   * 「索引されていない N 件がある」と正しく名乗る。docs/recall.md §4 はその `reason` に
   * 応じた次の一手（`pending` は待つ・再試行する、`failed` は埋め込みパイプラインを疑う）
   * まで案内している。**この口は、その案内どおりに動くための操作である**——
   * 埋め込みの provider が落ちていた間に入った Memory は、provider が直っても
   * 自力では索引へ戻らない（`fail` は終端であり、Phase 1 に自動リトライは無い。ADR 0032）。
   *
   * ⚠ **埋め込みの入力上限を超えて `failed` になった Memory は、この口だけでは戻らない**
   * （Issue #753）——次の `tick()` がまた同じ `memory.content` を送り、同じ理由で
   * `failed` に戻る。戻すには {@link RuntimeDeps.embeddingInput}（任意フック、ADR 0336）を
   * 渡した runtime でこの口を呼び、続けて `tick(ctx, { kinds: ['embed'], leaseMs })` を呼ぶ
   * （`Memory.content` は変わらない）。既定では何も切らない。
   *
   * ⚠ **埋め込み空間を切り替えた後の、古い空間で `ready` の記憶は、この口では積み直せない**
   * （[Issue #1015](https://github.com/takecchi/mnemora/issues/1015)）。`statuses` は `NotIndexedReason`
   * （`pending`/`failed`/`skipped`）だけを受け付け、`embeddingStatus` は空間を区別しないので、
   * そうした記憶は `ready` のまま今の空間に行を持たない。Phase 1 は空間の切り替えを支えない
   * （`docs/memory-model.md` §10）。
   *
   * ⚠ **`reextract` とは別の操作である。**`reextract` は**抽出**をやり直す
   * （Observation から Memory を作り直す）。こちらは既にある Memory の**埋め込み**を
   * やり直す。
   *
   * **このメソッド自身は埋め込みを行わない。**`MemoryStore.requeueEmbedJobs` を呼んで
   * `embed` ジョブを積み直すだけであり、実際に埋め込むのは次の `tick()` である
   * ——「キューが無ければ黙って何も起きない」を作らない、という `tick` の設計方針
   * （上の doc コメント）をここでも崩さない。**呼んだだけでは索引は埋まらない。**
   *
   * 引数と返り値は {@link RequeueEmbedJobsOptions} / {@link RequeueEmbedJobsResult} を
   * **そのまま使う**（`TickOptions` のように別の型を立てない）。この口は store の同名
   * メソッドへ素通しするだけで、runtime 側が足す選択肢が1つも無いためである——
   * 同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。
   */
  reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
  /**
   * [ADR 0114](../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md):
   * `docs/memory-model.md` §11 行8「`decay_floor_at < now()` を検出する低頻度の掃引…
   * → `status='archived'` + `archived` イベント」を実行する。
   *
   * `MemoryStore.archiveDecayed`（任意メソッド）へ素通しする——`reembed`（ADR 0079）と
   * 同じ形。引数の型 {@link ArchiveDecayedOptions} を store 側とそのまま共有している
   * のも同じ理由（同じ形の型を2つ置くと片方だけ直したときに黙ってずれる）。
   *
   * ⭐ **`opts.clock` を省略した場合に限り、この口が `tenant_settings.decay_clock` を
   * 読んで補う**（Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * `'wall'`（既定）なら `decayFloorAt <= now` のまま、`'activity'`/`'either'` なら
   * `nowSeq`（`tenant_activity.activity_seq`）も併せて読んで store へ渡す。**`opts.clock`
   * を明示で渡したときはそちらが勝ち、`tenant_settings`（`decay_clock`）は読まない。**
   * ⚠ 2026-09-27 訂正（[Issue #1217](https://github.com/takecchi/mnemora/issues/1217)）: 以前は「`tenant_activity`
   * も一切読まない」と書いていたが、実装（ADR 0186 決めたこと1）と合っていなかった。`opts.clock` に
   * `activity`/`either` を明示して `opts.nowSeq` を省くと、`tenant_activity` は1回読む。
   * どちらも読まないのは、`clock: wall` を明示したときと、`clock` と `nowSeq` の両方を明示したときだけである。 `decay_clock` を設定していないテナントの挙動は本 ADR の前後で
   * 1バイトも変わらない。
   *
   * store がこの口を実装していなければ `{ supported: false, archived: [], reachedLimit:
   * false }` を返す——黙って0件を返すのではなく「対応していない」と名指しする
   * （ADR 0082「黙って何も起きない形にしない」の哲学をここでも守る）。
   *
   * ⚠ **`reextract`/`consolidate`（ADR 0100）と違い、フォールバック経路を持たない。**
   * `supersedeWithNewMemories` は「口が無ければ今日どおりの2段の書き込みで代替できる」
   * 既存の経路があったが、この掃引には代替経路がそもそも存在しない——`decay_floor_at`
   * を読んで `archived` にする経路はこの口以外に無い。⟹ 「対応していない」を返す
   * だけで、それ以上の代替を試みない。
   *
   * 🔴 **この掃引は自動では一度も走らない。**`tick()`/`observe()` からは呼ばれない
   * ——呼び出し側が明示的にこれを呼んだときだけ走る保守操作である（`reembed` と
   * 同じ立場。`opts.now`/`opts.limit` のどちらにも既定値を置かない規律も共有する）。
   */
  sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult>;
  /**
   * Issue #195（[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md)）:
   * `archived` な Memory を、呼び出し側が**明示的に**取り戻す。`sweepArchive`
   * （ADR 0114）が閉じる方向（`active` → `archived`）だけを持っていた片道を、
   * 開く方向（`archived` → `active`）で埋める——`docs/north-star.md` が引くオーナー
   * 仕様§48「必要な場合だけ過去の記憶を再び呼び戻せる」の、その「呼び戻せる」側。
   *
   * 🔴 **`MemoryStore` に新しい任意メソッドを足していない。**`sweepArchive`
   * （`archiveDecayed?`）と違い、この操作は「`status` を1つ動かし、同一トランザクションで
   * `memory_events` に1件積む」という、**既に必須メソッドとして存在する
   * `MemoryStore.updateStatusWithEvent`（ADR 0031）がそのまま満たせる形**をしている
   * ——`archived` → `active` への compare-and-swap を撃つだけであり、`archiveDecayed`
   * のような「範囲走査して複数件を一度に選ぶ」独自のクエリ形状を必要としない。
   * **⟹ `supported: false` を名乗る余地が無い**（`MemoryStore` を実装するすべての
   * adapter で、追加のコードなしに今日から動く）。
   *
   * 手順（`forget` (`ForgetOutcome` の doc コメント) と同じ骨格。**新しいメソッドを
   * 足さない代わりに、アルゴリズムの形をできる限り揃えた**）:
   * 1. `target` を `MemoryId[]` に正規化する。空配列は store に一切触れず
   *    `{ outcomes: [] }`。
   * 2. `getMany` で一括読み。存在しなければ `"not_found"`。`status !== "archived"`
   *    なら `"status_not_archived"`（現在の `status` を添える。書き込み無し）。
   *    在るかどうかは `getMany` の答えに従い、store が返した id と渡された id を小文字にそろえて突き合わせる
   *    （`@mnemora/postgres` では大文字の UUID も在る記憶になる）。大文字小文字だけが違う id を同じ呼び出しに
   *    混ぜたときは、渡された文字列どおりに突き合わせる。
   * 3. それ以外（`status === "archived"`）は、観測した `"archived"` を `expectedStatus`
   *    にした compare-and-swap で `updateStatusWithEvent(ctx, id, "active",
   *    { expectedStatus: "archived" }, { kind: "restored", ... })` を呼ぶ。
   *    {@link MemoryStatusConflictError} が投げられたら**1回だけ**再読し、
   *    再読した `status` が `"active"`（＝別の呼び出しが先に同じ復帰を済ませていた）
   *    なら `"status_not_archived"`、`null`（行が無くなっていた）なら `"not_found"`、
   *    それ以外なら `"conflicted"` として `observedStatus` を返す——**上限の無い
   *    再試行ループにはしない**（`forget` と同じ安全弁）。
   * 4. それ以外の例外は `"failed"` を積んだ上で**その場で処理を打ち切り**、残りの
   *    対象は一切試みずに `"not_attempted"` として返す。例外はこのメソッドの外へは
   *    投げない。
   *    ⚠ **上の再読そのもの（`get`）が失敗した場合もここに入る**——その要素は書き込まれて
   *    いない（CAS に弾かれた後である）ので `"failed"` の「安全に再試行できる」は保たれる。
   *    ループ前の読み（`getMany`・活動時計の読み）が失敗した場合も同じく、1件目を `"failed"`、残りを
   *    `"not_attempted"` にして返す（Issue #964。まだ1件も書いていない）。
   *
   * `memory_events` へ積むイベントの `kind` は `"restored"`
   * （[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md) が
   * `MemoryEventKind` へ足した新しい値）。`digestSnapshot` にはその Memory の
   * 現在の `digest` を入れ、**`content`（本文）は運ばない**（`forget`/`reextract` と
   * 同じ規律。docs/memory-model.md §9）。`opts.reason` を渡すと `meta.reason` に入り、
   * 省略すると `meta` に `reason` キー自体を持たせない。
   *
   * ⚠ **2026-09 訂正（マネージャー決定、Issue #196 / [ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）:
   * `decay_floor_at` は動かす。** ADR 0122 の当初決定は「復帰と強化は別の操作であり、
   * `decay_floor_at` の再計算は複製しない。居着かせたい呼び出し側が `reinforce` を
   * 別途呼ぶこと」だった。**この決定は ADR 0153 が覆した。** 理由は、ADR 0153 が
   * `recall()` に既定 ON の忘却ゲート（`decayFloorAt <= now` の Memory を候補から
   * 除外する）を導入したことで、上記の「引き受けた負債」が実害に変わったため——
   * `sweepArchive` が `archived` にする選定条件は、テナントの `decay_clock`（既定
   * `'wall'`）に従う——`'wall'` なら `decayFloorAt <= now`、`'activity'`/`'either'`
   * なら `decayFloorSeq <= nowSeq` を軸に含む（Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * `restoreArchived` の対象は定義上、いずれの軸であってもこの条件を満たす。⟹ `reinforce` を
   * 別途呼ばない限り、`status` は `"active"` に戻っても**既定では recall に二度と
   * 現れない**——呼び出し側から見ると「restored と言われたのに何も返ってこない」。
   * これは `docs/north-star.md`「目指す姿」の逐語「必要な場合だけ過去の記憶を
   * 再び呼び戻せる」と正面から食い違う（`AGENTS.md`「正典と実装が食い違ったら、
   * バグなのは実装のほう」）。**⟹ このメソッドは、`status` の復帰に成功した対象へ
   * 続けて `MemoryStore.reinforce(ctx, id, now)` を呼ぶ**（新しい interface・adapter
   * は増やさない。既存の契約された口をそのまま呼ぶだけ）。**復帰させるという行為
   * そのものが「この記憶がいま必要だ」という明示の信号であり、北極星が言う
   * 「必要な場合」に当たる、というのが ADR 0153 の意味づけである。**
   *
   * `reinforce` が失敗しても、既に成功した `status` の復帰は握り潰さない——`outcomes`
   * の `kind` は `"restored"` のままで、失敗は `RestoreArchivedOutcome` の
   * `reinforceError` に運ぶ（`RestoreArchivedOutcome` の doc コメント参照）。
   *
   * ⚠ **`recall()` 自身は一切変更していない。**`status` が `"active"` へ戻った時点で、
   * 段1の候補生成が使う既存の status ゲート（`["active","contested"]`、
   * `recall-runtime.ts`）へ他の `active` な Memory と全く同じ経路で合流する——
   * `docs/recall.md` §2 段0「スコープの外延」・§5 の被覆不変条件のどちらも、
   * この操作のために1行も変更していない。**変わったのはこのメソッドが `reinforce`
   * も呼ぶようになったことだけであり**、それによって `decayFloorAt` が「いま」より
   * 先へ進むので、既定の忘却ゲート（ADR 0153）を通過できるようになる。
   */
  restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult>;
  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」を、呼び出し側が
   * **明示的に**取り戻す。`consolidate`/`reextract`/`resolveContested` が閉じる方向
   * （`active` → `superseded`）だけを持っていた片道を、開く方向（`superseded` →
   * `active`）で埋める——`restoreArchived`（ADR 0122）が `sweepArchive`（ADR 0114）に
   * 対して果たしたのと同じ役割を、`superseded` という別の起点に対して果たす。
   *
   * 🔴 **粒度の既定は「群」である。**`target: { supersededById }` は、置き換えた側
   * （新しいほう）の id を指す——`target.onlyMemoryIds` を省略した場合、個別の
   * Memory id を渡す形は無い。理由は {@link RestoreSupersededTarget} の doc
   * コメントを参照（要約: `superseded` な Memory は `recall()` に出てこないため、
   * 呼び出し側は戻したい id を知る手段をそもそも持たない。手元にある唯一の
   * 取っ手が「置き換えた側」である）。
   *
   * ⭐ **[Issue #515](https://github.com/takecchi/mnemora/issues/515) 方向①
   * （[ADR 0258](../../../docs/decisions/0258-restore-superseded-operation-scope.md)）:
   * `target.onlyMemoryIds` を指定すると、群のうちこの id 集合だけに対象を絞る。**
   * 省略時は従来どおり群全体——**既定は1バイトも変えない。**`MemoryStore.
   * restoreSupersededBy?`/`previewRestoreSupersededBy?` の `filter.onlyMemoryIds`
   * へそのまま素通しする（下の手順2参照）。どの id をまとめて渡すべきかは
   * {@link RestoreSupersededTarget.onlyMemoryIds} の doc コメントを参照——
   * mnemora 自身はこの判断をしない。
   *
   * 🔴 **`MemoryStore` に新しい任意メソッド `restoreSupersededBy?` を足している。**
   * `restoreArchived` が `updateStatusWithEvent`（既存の必須メソッド）にそのまま
   * 収まったのとは違う——理由は {@link MemoryStore.restoreSupersededBy} の doc
   * コメントを参照（要約: (1) 個別 CAS ではなく群単位の範囲走査+一括更新であること、
   * (2) `updateStatusWithEvent` には `superseded_by_id` を `NULL` へ戻す経路が
   * 型にも SQL にも無いこと、の2点）。**adapter がこの口を実装していなければ
   * `{ supported: false, supersedingMemoryId, outcomes: [] }` を返す**——
   * `sweepArchive`/`archiveDecayed?` と同じ「対応していない、と名指しする」形
   * （ADR 0082）。フォールバック経路は持たない。
   *
   * 🔴 **`opts.dryRun: true`（Issue #515、ADR 0237）は、ここまでの「実際に戻す」経路を
   * 一切通らない別の枝である。**呼ぶのは `MemoryStore.previewRestoreSupersededBy?`
   * （もう1つの新しい任意メソッド、`restoreSupersededBy?` とは独立）だけで、
   * `memories` の更新も `memory_events` への追記も `reinforce` の呼び出しも起きない。
   * 対象の選び方（`WHERE`）は `restoreSupersededBy?` と完全に一致させてあるので、
   * `dryRun: true` で見た `outcomes`（`kind: "would_restore"`）の `memoryId` 集合は、
   * 直後に `dryRun` 無しで呼んだときの `outcomes`（`kind: "restored"`）の `memoryId`
   * 集合と一致する——**ただし「一致することを保証する仕組み」は無い**。2回の呼び出しの
   * 間に別の書き込みが起きれば、当然ずれる（他の compare-and-swap 系メソッドと同じ、
   * 「見てから呼ぶ」に内在する race）。`previewRestoreSupersededBy?` を実装しない
   * adapter では `dryRun: true` も `{ supported: false, supersedingMemoryId,
   * outcomes: [] }`——`restoreSupersededBy?` を実装済みでも、この2つは独立した
   * 任意メソッドなので免除されない。
   *
   * ⭐ **2026-09-26 追記 —— これが今の契約である（[Issue #515](https://github.com/takecchi/mnemora/issues/515) クローズ）。**
   * 群（`target.supersededById` と一致する `superseded_by_id` を持つ、`status =
   * 'superseded'` の行すべて）は、**1回の操作の単位とは限らない**——
   * `resolveContested` の勝者は前から在る Memory であり、`reextract` のアンカーも
   * 冪等な `ON CONFLICT` 経由で前から在る Memory に解決されうるため、別々の操作の
   * 敗者が同じ群へ積み上がることがある（{@link RestoreSupersededTarget} の doc
   * コメント、[ADR 0230](../../../docs/decisions/0230-restore-superseded-recovery-path.md)
   * 冒頭の訂正1・訂正4）。**これはバグではなく確定した契約である。**呼び出し側は
   * `opts.dryRun: true` で戻す前に群の中身（`supersededReason` を含む）を確かめ、
   * 必要なら `target.onlyMemoryIds` で絞ってから呼ぶこと——この2つが、群の広さを
   * 呼び出し側が制御する既定の手段である。群をさらに細かい鍵（`memory_events` への
   * 操作 id 新設、Issue #515 方向2）で絞る案は v1.0.0 では採らない。理由・
   * 経緯は ADR 0230 末尾の 2026-09-26 追記を参照。
   *
   * 手順:
   * 1. `deps.memoryStore.restoreSupersededBy` が無ければ
   *    `{ supported: false, supersedingMemoryId: target.supersededById, outcomes: [] }`。
   * 2. 在れば `restoreSupersededBy(ctx, target.supersededById, { reason, actor, at: now },
   *    { onlyMemoryIds: target.onlyMemoryIds })` を呼ぶ——store 側が1トランザクションで
   *    対象行（`status = 'superseded'` かつ `superseded_by_id = target.supersededById`、
   *    `target.onlyMemoryIds` が在れば追加で `id` がその集合に含まれる行）を選び、
   *    `status='active'`・`superseded_by_id=null` へ更新し、行ごとに `memory_events` へ
   *    `kind: 'unsuperseded'` を積んで、戻した `Memory[]` を返す。
   * 3. `status` の復帰に成功した各対象について、続けて `MemoryStore.reinforce` を
   *    呼ぶ——理由は `restoreArchived` と同じ「ADR 0153 の忘却ゲート」だが、
   *    **前提が違う**点に注意（下記「⚠ reinforce する理由」）。`reinforce` が
   *    例外を投げても、既に成功した `status` の復帰は握り潰さない——`kind` は
   *    `"restored"` のままで、失敗は `reinforceError` に運ぶ（`RestoreArchivedOutcome`
   *    と同じ規律。`restoreArchived` の doc コメント参照）。
   * 4. 対象が0件なら `{ supported: true, supersedingMemoryId, outcomes: [] }`。
   *    **例外にしない。**
   * 5. `target.supersededById` に実在しない・形式不正な id を渡しても例外にしない
   *    （対象0件と同じ——`MemoryStore.restoreSupersededBy` の契約節参照）。
   *
   * ⚠ **reinforce する理由は `restoreArchived` と同じだが、前提は違う。** ADR 0153 が
   * `recall()` に既定 ON の忘却ゲート（`decayFloorAt <= now` の Memory を候補から
   * 除外する）を導入したため、`status` だけを戻しても `decayFloorAt` が過去のままなら
   * recall に出てこない＝復旧になっていない、という事情は同じである。ADR 0048
   * （`reinforce` は減衰の起点を巻き戻さない）により、床がまだ未来の Memory に対して
   * 呼んでも縮まないため、無条件に呼んで安全であることも同じ。**しかし
   * `restoreArchived` の対象（`sweepArchive` が `archived` にした行）は、掃引の選定
   * 条件そのものにより床が必ず過去である**のに対し、**`superseded` な Memory の床は
   * 過去とは限らない**——`consolidate`/`reextract` は「まだ活発に使われている
   * Memory を統合する」ことを妨げておらず、統合された直後の Memory の
   * `decayFloorAt` は先の未来を指しうる。⟹ **「`restoreArchived` と形を揃えた」から
   * reinforce するのではなく、「recall の忘却ゲートが同じ土俵にある」から reinforce
   * する**——床が既に未来を指す対象に対しても、ADR 0048 により安全に呼べるので、
   * 呼ぶかどうかを対象ごとに出し分ける理由が無い。
   *
   * ⛔ **この操作が「やらないこと」（設計上、意図的に持たない機能）:**
   * - **置き換えた側（`target.supersededById` が指す Memory）に一切触らない。**
   *   消さない・`forget` しない・`status` を変えない。理由:
   *   (1) `consolidate` の統合先は、supersede が誤りだったとしても中身自体は
   *   正しいことがある——黙って消すと作業を破壊する。(2) `forget` が既に在る
   *   ＝呼び出し側が明示的に選べる。(3) `docs/north-star.md` の迷ったときの問い3
   *   （説明できるか）——操作1つにイベント1つのほうが後から辿れる。(4) 同じ問い4
   *   （推論と事実を区別できるか）——統合先の `provenance.kind` は多くの場合
   *   `'consolidated'`（推論由来）、戻す側は `'stated'` のことが多い。どちらを
   *   残すかをこの枠組みが勝手に決めない。
   * - ⟹ **戻した直後は、古いほう（`outcomes` に載る Memory）も新しいほう
   *   （`supersedingMemoryId`）も両方 `active` であり、`recall()` は両方を返しうる。**
   *   始末したいなら呼び出し側が `forget(ctx, supersedingMemoryId)` を別途呼ぶ、
   *   あるいは `markContested` で対にすること。**この分岐をこのメソッドの `opts` には
   *   足さない**——1つの操作が2つの意思決定（「戻す」と「置き換えた側をどうするか」）
   *   を暗黙に束ねないため。
   *
   * `recall()` 自身は一切変更していない——`restoreArchived` と同じく、`status` が
   * `'active'` へ戻った時点で既存の status ゲートへ他の `active` な Memory と全く
   * 同じ経路で合流する。
   *
   * ⚠ 2026-09-28 追記（今の振る舞いを書くだけ。[Issue #1079](https://github.com/takecchi/mnemora/issues/1079) のコメント）:
   * 置き換えた側（`supersededById`）が `forgotten` でも、この口はその群を `active` に戻す（置き換えた側の状態は見ない。
   * 置き換えた側は `forgotten` のまま）。【実測 2026-09-28】`@mnemora/postgres` と testkit の fixture で同じ
   * （`reextract-withdrawn-memories.postgres.test.ts`）。
   */
  restoreSuperseded(
    ctx: Ctx,
    target: RestoreSupersededTarget,
    opts?: RestoreSupersededOptions,
  ): Promise<RestoreSupersededResult>;
  /**
   * Issue #102: Memory を**論理的に**忘れさせる。
   *
   * **行も `content` も消さない。**`status` を `'forgotten'` へ動かすだけで、
   * 物理削除（`purge()`）は別操作である（{@link Runtime.purge}、Issue #198 / ADR 0124。
   * docs/memory-model.md「forget() と purge() を分ける」）。`status` の更新と `memory_events` への
   * `kind: 'forgotten'` の追記は `MemoryStore.updateStatusWithEvent`
   * （ADR 0031）で**同一トランザクション**として行う——片方だけ起きることはない。
   *
   * `memory_events` の `digestSnapshot` にはその Memory の `digest` を入れる。
   * **`content`（本文）は運ばない**（docs/memory-model.md §9: 監査ログに残す
   * 記録項目は digest のスナップショットに限る）。
   *
   * `forgotten` は `recall()` の候補生成の status ゲート（`['active','contested']`）
   * に含まれないため、このメソッドを呼んだ後の `recall()` には対象の Memory が
   * 一切出てこなくなる（`omitted` に `{ kind: 'filtered', condition: 'forgotten' }`
   * として計上される。ADR 0027）。**`recall` 側のコードはこの機能のために
   * 一切変更していない**——ゲートも `omitted` の分類も既に在ったものをそのまま使う。
   *
   * **冪等である。**既に `forgotten` な Memory を対象に含めても書き込みは起きず
   * `{ kind: 'already_forgotten' }` を返す。同じ id を同じ呼び出しの中に複数回
   * 渡しても、`memory_events` に積まれるのは高々1件——1回目の結果を2回目が見る。
   *
   * 対象は `target` を `MemoryId[]` に正規化した上で**入力順に**処理する:
   * - 対象が存在しない、または compare-and-swap の再読で `null` になった場合は
   *   `{ kind: 'not_found' }`。在るかどうかは `getMany` の答えに従い、store が返した id と渡された id を
   *   小文字にそろえて突き合わせる（`@mnemora/postgres` では大文字の UUID も在る記憶になる）。大文字小文字
   *   だけが違う id を同じ呼び出しに混ぜたときは、渡された文字列どおりに突き合わせる。
   * - 既に `forgotten` の場合は `{ kind: 'already_forgotten' }`（書き込み無し）。
   * - それ以外は観測した現在の status を `expectedStatus` にした
   *   compare-and-swap で `forgotten` へ更新する。{@link MemoryStatusConflictError}
   *   が投げられたら**1回だけ**再読し、再読の結果に応じて `not_found` /
   *   `already_forgotten` / `{ kind: 'conflicted', observedStatus }` のいずれかを
   *   返す——**上限の無い再試行ループにはしない。**
   * - それ以外の例外（DB 接続断等）は `{ kind: 'failed', error }` を積んだ上で
   *   **その場で処理を打ち切り**、残りの対象は一切試みずに
   *   `{ kind: 'not_attempted' }` として返す。例外はこのメソッドの外へは
   *   投げない。
   *   ⚠ **上の再読そのもの（`get`）が失敗した場合もここに入る**——その要素は書き込まれて
   *   いない（CAS に弾かれた後である）ので `"failed"` の「安全に再試行できる」は保たれる。
   *   ループ前の読み（`getMany`）が失敗した場合も同じく、1件目を `"failed"`、残りを
   *   `"not_attempted"` にして返す（Issue #964。まだ1件も書いていない）。
   *
   * `kind` の意味と呼び出し側の次の一手は {@link ForgetOutcome} の doc コメントに
   * 詳しい。`target` が空配列（`{ memoryIds: [] }`）なら、store に一切触れずに
   * `{ outcomes: [] }` を返す。
   */
  forget(ctx: Ctx, target: ForgetTarget, opts?: ForgetOptions): Promise<ForgetResult>;
  /**
   * Issue #198（docs/roadmap.md §5.3、[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）:
   * `forgotten` な Memory を**物理削除**する。`forget()` が可逆な論理削除（`status` を
   * 動かすだけ）であるのに対し、`purge()` は不可逆——`content`/`digest` を固定の
   * トゥームストーン文字列で上書きし、`purgedAt` を設定する。**行そのものは消さない**
   * （`memory_events` からの外部キー参照整合性のため。docs/memory-model.md
   * 「forget() と purge() を分ける」）。
   *
   * 🔴 **`forgotten` からのみ遷移できる。**`active`/`archived`/`superseded`/`contested`
   * な Memory を直接 purge することはできない——`forget → purge` の二段階を、不可逆操作
   * に対する最小の安全弁にする（ADR 0124 決定1。`docs/memory-model.md` §11 lifecycle 表
   * 行10が既に `forgotten → purged` とだけ書いている）。`status` がそれ以外の対象は
   * `status_not_forgotten` を返し、書き込みは一切起きない。
   *
   * 🔴 **`MemoryStore.purgeMemory`（任意メソッド）が無い adapter では、この操作は
   * 一切実行できない。**`{ supported: false, outcomes: [...すべて "not_attempted"] }`
   * を返す——`sweepArchive`（ADR 0114）と同じ「フォールバック経路を持たない」形
   * （`content`/`digest`/`purgedAt` を書く経路はこの口以外に無いため）。`opts.dryRun`
   * の有無に関わらず同じ扱いにする——下見だけを許して実際の purge を許さない adapter を
   * 作ると、下見が約束する内容と実際の振る舞いが食い違いうる。
   *
   * 手順（`forget`/`restoreArchived` と同じ骨格。**CAS の条件だけが違う**——下記参照）:
   * 1. `target` を `MemoryId[]` に正規化する。空配列は store に一切触れず
   *    `{ supported: <purgeMemory の有無>, outcomes: [] }`。
   * 2. `deps.memoryStore.purgeMemory` が無ければ、ここで打ち切り全対象を
   *    `{ supported: false, outcomes: [...すべて "not_attempted"] }` として返す。
   * 3. `getMany` で一括読み。存在しなければ `"not_found"`。`status !== "forgotten"`
   *    なら `"status_not_forgotten"`（現在の `status` を添える。書き込み無し）。
   *    在るかどうかの突き合わせは `restoreArchived` の手順2と同じ（大文字小文字だけが違う id を同じ呼び出しに
   *    混ぜたときは、渡された文字列どおりに突き合わせる）。
   *    `status === "forgotten"` かつ `purgedAt` が非 `null` なら `"already_purged"`
   *    （`MemoryStore` への書き込み無し）。**`opts.dryRun` が `false`（省略時を含む）
   *    なら、`deps.vectorStore.deleteAcrossSpaces(ctx, [id])` をベストエフォートで試みる**
   *    （Issue #1425、ADR 0382——既に purge 済みの記憶を、埋め込みモデルを移した後に
   *    再実行したときの後始末。`dryRun: true` のときは呼ばない）。
   * 4. それ以外（`status === "forgotten"` かつ `purgedAt === null`）は、`opts.dryRun`
   *    なら書き込みをせず `"would_purge"` を返す。そうでなければ
   *    `deps.memoryStore.purgeMemory(ctx, id, { content: PURGE_TOMBSTONE_CONTENT,
   *    digest: PURGE_TOMBSTONE_DIGEST }, event)` を呼ぶ。成功したら `"purged"` を返し、
   *    続けて `deps.vectorStore.deleteAcrossSpaces(ctx, [id])` を
   *    ベストエフォートで試みる（例外は握り潰す——ADR 0124 決定5・ADR 0382。`MemoryStore`
   *    側の書き込みは既に確定しているため、この失敗を理由に `"purged"` を `"failed"` に
   *    格下げすると「安全に再試行できる」という `"failed"`/`"not_attempted"` の意味を
   *    裏切る。**今の `embeddingProvider.space` だけでなく、adapter が持つ全 space から
   *    消す**——Issue #1425、旧 space に残った埋め込みも対象にする）。
   * 5. {@link MemoryPurgeConflictError} が投げられたら**1回だけ**再読し、
   *    再読した `purgedAt` が非 `null` なら `"already_purged"`（この分岐は `dryRun` では
   *    到達しない——`purgeMemory` 自体を呼んでいないため。手順3と同じく
   *    `deps.vectorStore.deleteAcrossSpaces(ctx, [id])` をベストエフォートで試みる）、
   *    `status` が `"forgotten"` でなければ `"status_not_forgotten"`、行が消えていれば
   *    `"not_found"`、それ以外（`status === "forgotten"` かつ `purgedAt === null` の
   *    まま）なら `"conflicted"`——**上限の無い再試行ループにはしない。**
   * 6. それ以外の例外（DB 接続断等）は `"failed"` を積んだ上で**その場で処理を打ち切り**、
   *    残りの対象は一切試みずに `"not_attempted"` として返す。例外はこのメソッドの外へは
   *    投げない。
   *    ⚠ **上の再読そのもの（`get`）が失敗した場合もここに入る**——その要素は書き込まれて
   *    いない（CAS に弾かれた後である）ので `"failed"` の「安全に再試行できる」は保たれる。
   *    ループ前の読み（`getMany`）が失敗した場合も同じく、1件目を `"failed"`、残りを
   *    `"not_attempted"` にして返す（Issue #964。まだ1件も書いていない）。
   *
   * `memory_events` へ積むイベントの `kind` は `"purged"`（`MemoryEventKind` に
   * 既に在る値——追加していない）。`digestSnapshot` には上書き**前**の digest を入れ、
   * **`content`（本文）は運ばない**（`forget`/`restoreArchived` と同じ規律。
   * docs/memory-model.md §9）。`opts.reason` を渡すと `meta.reason` に入り、省略すると
   * `meta` に `reason` キー自体を持たせない。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**`TICK_SUPPORTED_JOB_KINDS` に
   * `purge` 相当の job kind を足していない・`observe()` の入力分岐に `purge` を混ぜて
   * いない——issue #198 が要求する「明示的でない経路からは絶対に呼ばれない」ことを、
   * 歯（`purge.test.ts`）で実測する。
   *
   * ⚠ **`recall()`/`aggregateScope` 側は一切変更していない。**`purge` は `status` を
   * 動かさないため、purge された Memory は purge の前後を通じて常に `status = 'forgotten'`
   * であり——`docs/recall.md` §2 段0・§5 の決定（スコープ = tenant + subject + period +
   * taxonomy + status ゲート、status ゲートで落ちた Memory はスコープ内に含まれない）
   * により、そもそも一度も「スコープ内」に入ったことが無い。群カウント
   * （`ScopeAggregate.groups`/`totalInScope`）に触れようがない（ADR 0124 決定6）。
   */
  purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult>;
  /**
   * Issue #197（ADR 0134）: `docs/memory-model.md` §11 lifecycle 行6「判定できない対向を
   * 検出 → 両側の `status='contested'`、`contested_with_id` を相互に設定」を実行する
   * **明示的操作**。
   *
   * **この操作自身は「矛盾しているかどうか」を判定しない。**呼び出し側（人・上位のアプリ
   * ケーション層・将来の自動検出）が「この2件は対向する」と既に決めていることを前提に、
   * その決定を`docs/memory-model.md` §5 が要求する形（一対一・相互参照・機構2の
   * mandatory companion retrieval が働く状態）で機械的に書き込むだけである。
   * ⟹ **順序（新しい方を勝たせる）で判定しない・LLM を呼ばない**——
   * どちらの北極星の制約も、判定そのものをこの口が持たないことで自動的に満たす
   * （`docs/decisions/0134-*.md` 参照）。
   *
   * `docs/memory-model.md` §11 行7「`contested` → `active | superseded`」（解決）は
   * この PR の範囲外——別の issue/PR で扱う（ADR 0134「採らなかった案」参照）。
   *
   * 手順:
   * 1. `firstId === secondId` は呼び出し前の programmer error として扱い、
   *    `RangeError`（`Runtime.markContested: firstId and secondId must differ`）を投げる。
   *    書き込みは一切試みない（`supersedeWithNewMemories` の
   *    `supersededByIndex out of range` と同じ「開く前に落とす」位置）。
   * 2. `deps.memoryStore.markContestedPair` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す
   *    ——フォールバック経路は無い（interface 側の doc コメント参照）。
   * 3. `getMany([firstId, secondId])` で一括読み、それぞれを {@link MarkContestedSideOutcome}
   *    に分類する（`"not_found"`/`"status_not_active"`/`"eligible"`）。どちらか一方でも
   *    `"eligible"` でなければ、書き込みを一切試みず
   *    `{ supported: true, outcome: { kind: "ineligible", sides: [...] } }` を返す。
   *    在るかどうかの突き合わせは `restoreArchived` の手順2と同じ（同じ記憶を小文字と大文字で渡したときは、
   *    渡された文字列どおりに突き合わせるので、store が返す id と同じ綴りで渡した側だけが在る記憶になり、
   *    もう一方は `"not_found"` になる。どちらの位置に渡したかによらない——`@mnemora/postgres` では大文字で
   *    渡した側が `"not_found"`。どちらの側も store の id と綴りが違えば、両側とも `"not_found"`）。
   * 4. 両側とも `"eligible"` なら `deps.memoryStore.markContestedPair` を呼ぶ。成功すれば
   *    `{ supported: true, outcome: { kind: "contested", first, second } }`。
   * 5. {@link MemoryStatusConflictError} が投げられたら（3で読んだ後、4で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、**1回だけ**再読して `conflicts` に両側の現在の
   *    `status` を積み、`{ supported: true, outcome: { kind: "conflict", conflicts } }`
   *    を返す——上限の無い再試行ループにはしない（`forget`/`restoreArchived`/`purge` と
   *    同じ安全弁）。
   *
   * `memory_events` へ両側それぞれ1件ずつ積む。`kind: 'updated'`・`meta.reason: 'contested'`
   * （`docs/memory-model.md` §11 行6 が定める固定値。`consolidate`/`reflect` の
   * `meta.reason` と同じ「操作の種類を表す固定タグ」の扱いであり、`forget`/`restoreArchived`
   * の「呼び出し側の自由文」とは別物）。`opts.reason` を渡すと `meta.note` に追加で入る。
   * `meta.contestedWithId` には相手の id が入る（A のイベントには B、B には A。Issue #1160——解決で
   * `contested_with_id` はクリアされるので、監査ログに残さないと誰と対だったかを後から追えない）。
   * 入るのは store が返した相手の id（列の値と同じ形。`@mnemora/postgres` では小文字）であり、渡された id ではない。
   * `digestSnapshot` にはその Memory の現在の `digest` を入れる（`content` は運ばない。
   * `forget`/`reextract` と同じ規律）。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` になった時点で、
   * 既存の段1 status ゲート（`["active","contested"]`）・段3の mandatory companion
   * retrieval（`contestedWithId` を辿って対向を取得する既存実装）へ他の `contested` な
   * Memory と全く同じ経路で合流する——この操作のために `recall-runtime.ts` は1行も
   * 変更していない（変更したのは「ここは一度も通らない」という古くなったコメントだけ）。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く
   * ——`forget`/`purge`/`restoreArchived` と同じ立場。
   */
  markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult>;
  /**
   * Issue #197（ADR 0150）: `docs/memory-model.md` §11 lifecycle 行7「`contested` →
   * `active | superseded`」を実行する**明示的操作**。`markContested`（`docs/decisions/
   * 0134-mark-contested-explicit-operation.md`）の解決側であり、その形を手本に対称に
   * 書いてある。
   *
   * **この操作自身も「どちらが正しいか」を判定しない。**`markContested` と同じ理由——
   * 呼び出し側（人・上位のアプリケーション層）が既に下した決定（{@link ContestedResolution}）
   * を、`docs/memory-model.md` が要求する形（CAS・イベント・1トランザクション）で機械的に
   * 書き込むだけである。⟹ **`recordedAt`/`occurredAt` を一度も参照しない**——
   * `docs/memory-model.md` §5「順序では解かない」に抵触しない。**LLM を呼ばない。**
   *
   * 手順:
   * 1. `firstId === secondId` は呼び出し前の programmer error として扱い、`RangeError`
   *    （`Runtime.resolveContested: firstId and secondId must differ`）を投げる。書き込みは
   *    一切試みない（`markContested` と同じ「開く前に落とす」位置）。
   * 2. `resolution.kind === "supersede"` のとき、`resolution.winnerId` が `firstId`/`secondId`
   *    のどちらでもなければ、同じく書き込み前に `RangeError`
   *    （`Runtime.resolveContested: resolution.winnerId must be firstId or secondId`）を
   *    投げる。⚠ `winnerId` が片側と大文字小文字だけ違うときは、store の `get` で同じ記憶かを確かめ、同じ記憶なら
   *    その側を勝者として扱う（`@mnemora/postgres` の uuid。大文字小文字を区別する store では今どおり `RangeError`）。
   * 3. `deps.memoryStore.resolveContestedPair` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す——フォールバック
   *    経路は無い（`MemoryStore.resolveContestedPair` の interface JSDoc 参照）。
   * 4. `getMany([firstId, secondId])` で一括読み、それぞれを {@link ResolveContestedSideOutcome}
   *    に分類する（`"not_found"`/`"status_not_contested"`/`"pair_broken"`/`"eligible"`。
   *    適格性は「両側とも `status === 'contested'` かつ相互参照が成立している」——
   *    [ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md) の対不変
   *    条件を読む側からも守る）。どちらか一方でも `"eligible"` でなければ、書き込みを
   *    一切試みず `{ supported: true, outcome: { kind: "ineligible", sides: [...] } }` を返す。
   *    在るかどうかの突き合わせは `restoreArchived` の手順2と同じ（同じ記憶を小文字と大文字で渡したときは、
   *    渡された文字列どおりに突き合わせる）。相互参照は store が返した相手の id と比べる。
   * 5. 両側とも `"eligible"` なら `deps.memoryStore.resolveContestedPair` を呼ぶ。
   *    - `resolution.kind === "both_active"`: 両側とも `status: "active"`。
   *    - `resolution.kind === "supersede"`: `winnerId` 側は `status: "active"`、もう一方は
   *      `status: "superseded"` + `supersededById: <winnerId>`。
   *
   *    成功すれば `{ supported: true, outcome: { kind: "resolved", first, second } }`。
   * 6. {@link MemoryStatusConflictError} が投げられたら（4で読んだ後、5で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、`markContested` と同じく**1回だけ**再読して
   *    `conflicts` に両側の現在の `status` を積み、
   *    `{ supported: true, outcome: { kind: "conflict", conflicts } }` を返す——上限の無い
   *    再試行ループにはしない。
   *
   * `memory_events` へ両側それぞれ1件ずつ積む（`docs/memory-model.md` §11 行7
   * 「`updated` または `superseded`」）:
   * - `"supersede"`: 勝者に `kind: 'updated'`、敗者に `kind: 'superseded'`。
   * - `"both_active"`: 両側とも `kind: 'updated'`。
   *
   * どちらも `meta.reason` は固定値 `'contested_resolved'`、`meta.resolution` に
   * `'supersede' | 'both_active'`（監査ログから「なぜ contested が消えたか」を追えるように
   * するための欄——`meta.reason` だけでは決着の種類までは分からない）。`opts.reason` を
   * 渡すと `meta.note` に追加で入る（`meta.reason`/`meta.resolution` は上書きしない）。
   * どのイベント（勝者・敗者・`both_active` の両側）にも `meta.contestedWithId`（相手の id）が入る（Issue #1160）。
   * 敗者の `superseded` は、加えて `meta.supersededById`（勝者の id。値は同じ）も持つ。
   * どちらの meta の id も store が返した id（列の値と同じ形）であり、渡された id ではない。
   * `digestSnapshot` にはその Memory の現在の `digest` を入れる（`content` は運ばない。
   * `markContested`/`forget`/`reextract` と同じ規律）。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` から
   * `'active'`/`'superseded'` へ離れた時点で、既存の段1 status ゲート
   * （`["active","contested"]`）・段3 mandatory companion retrieval（`contestedWithId` を
   * 辿る既存実装）から自然に外れる——敗者側は次の `recall` から二度と単独でも同伴でも
   * 出てこない（同伴として出てくるのは、対向がまだ `contested` のときだけ）。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く
   * ——`markContested`/`forget`/`purge`/`restoreArchived` と同じ立場。
   */
  resolveContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
    opts?: ResolveContestedOptions,
  ): Promise<ResolveContestedResult>;
  /**
   * [Issue #825](https://github.com/takecchi/mnemora/issues/825)（ADR 0150 追記、
   * 2026-09-26）: `resolveContested`（上）の決定3（CAS「両側とも `contested` かつ
   * 相互参照が成立」）は、対の片側を `forget()` すると満たせなくなる——forget は
   * `status` を `'forgotten'` に動かすだけで `contestedWithId` には触れない
   * （`forget` の doc コメント参照）ため、生存側は `contested`・`contestedWithId` が
   * 対向を指したまま残るのに、対向はもう `contested` ではなくなる。この状態になった
   * 生存側は、`resolveContested` を呼んでも対向側が `status_not_contested` で ineligible
   * になり、二度と解消できない（Issue #825 の再現）。
   *
   * **この口は決定3の CAS には一切触れない。**`resolveContested`/`MemoryStore.
   * resolveContestedPair` は1文字も変更していない——既存の呼び出しの振る舞いは変わらない。
   * 代わりに、**生存側1件だけ**を対象にした別の任意メソッドとして足す
   * （[ADR 0150](../../../docs/decisions/0150-resolve-contested-explicit-operation.md)
   * 追記「案D を部分的に覆す」参照）。
   *
   * **この操作も「どちらが正しいか」を判定しない。**`markContested`/`resolveContested` と
   * 同じ理由——判定するのは「対向が forget という正規操作で `forgotten` になった（または
   * 既に purge 済みで見つからない）かどうか」という機械的な事実だけであり、`content` の
   * 正しさには一切触れない。⟹ `recordedAt`/`occurredAt` を参照しない。LLM を呼ばない。
   *
   * 手順:
   * 1. `deps.memoryStore.resolveOrphanedContested` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す——フォールバック
   *    経路は無い（`MemoryStore.resolveOrphanedContested` の interface JSDoc 参照）。
   * 2. `survivorId` を読み、{@link ResolveOrphanedContestedEligibility} に分類する:
   *    - 見つからない → `"not_found"`。
   *    - `status !== "contested"` → `"status_not_contested"`。
   *    - `contestedWithId` が `null` → `"no_contested_with_id"`（ADR 0150 負債2の形。
   *      この口はそれを対象にしない）。
   *    - `contestedWithId` の指す Memory を読み、見つからないか `status === "forgotten"`
   *      なら `"eligible"`。それ以外（`active`/`contested`/`superseded`/`archived` のいずれか）なら
   *      `"opposite_not_orphaned"`（{@link ResolveOrphanedContestedEligibility} の 2026-09-28 訂正）。
   * 3. `"eligible"` でなければ、書き込みを一切試みず
   *    `{ supported: true, outcome: { kind: "ineligible", eligibility } }` を返す。
   * 4. `"eligible"` なら `deps.memoryStore.resolveOrphanedContested` を呼ぶ。成功すれば
   *    `{ supported: true, outcome: { kind: "resolved", memory } }`。
   * 5. {@link MemoryStatusConflictError} が投げられたら（2で読んだ後、4で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、`resolveContested` と同じく**1回だけ**再読して
   *    `observedStatus` に積み、`{ supported: true, outcome: { kind: "conflict",
   *    observedStatus } }` を返す——上限の無い再試行ループにはしない。
   *
   * `memory_events` へ生存側1件だけに `kind: 'updated'` を積む（対向〔forgotten〕の行には
   * 一切触れない）。`meta.reason` は `resolveContested` と同じ固定値 `'contested_resolved'`
   * を使う——**この経路で解消したことは `meta.resolution: 'orphan_reclaimed'` という、
   * `ContestedResolution`（`'supersede'`/`'both_active'`）のどちらとも異なる値**で
   * 区別する（監査ログだけを見て「`resolveContested` の正規経路で決着したのか、
   * この救済経路で戻したのか」を後から読めるようにするため）。`opts.reason` を渡すと
   * `meta.note` に追加で入る。
   * `meta.contestedWithId` には、forget された（または見つからない）対向の id が入る（Issue #1160）。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` から `'active'` へ
   * 離れた時点で、既存の段1 status ゲート・段3 mandatory companion retrieval から自然に
   * 外れる——`resolveContested` と同じ理由。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く。
   *
   * 🔴 **任意メソッドである（2026-09-26 追記、Issue #825 続き）。**当初は必須メソッドとして
   * 着地したが、`@mnemora/core` は v1.0.0 として npm に公開済みであり、`Runtime` interface
   * を自前で実装している利用者（`docs/migration-v1.md` §12/§14/§16 が `restoreSuperseded`/
   * `findCorrectionCandidates`/`applyCorrection` の必須化をそのように破壊的変更として数えた、
   * まさにその立場）にとって、v1.0.0 の後に必須メソッドが増えることは次のメジャー版を要求する
   * 破壊的変更になる。`@mnemora/testkit` の `supportsTaxonomyMode`/`supportsLabels`/
   * `supportsFindActiveByClaimKey`（[Issue #818](https://github.com/takecchi/mnemora/issues/818)、
   * PR #827）で同じ形（v1.0.0 後の必須化）を任意へ戻した前例に倣い、`?` へ戻した
   * （クローン miku の判断。[ADR 0150](../../../docs/decisions/0150-resolve-contested-explicit-operation.md)
   * 追記参照）。⟹ **`createRuntime` が返す `Runtime` には必ずこのメソッドが実装されている**
   * ——省略されるのは、利用者が独自に `Runtime` を実装する場合の後方互換のためだけである。
   * `createRuntime()` の戻り値からこの口を呼ぶ側は、`MemoryStore` の任意メソッドを呼ぶ既存の
   * 慣習（`store.markContestedPair!(...)` 等）と同じく、非 null アサーション
   * （`runtime.resolveOrphanedContested!(...)`）で呼んでよい——**この repo にはこれ以外の
   * 前例（`createRuntime` の戻り値の型を狭める工夫）が無いことを確認した上でこの形にした。**
   */
  resolveOrphanedContested?(
    ctx: Ctx,
    survivorId: MemoryId,
    opts?: ResolveOrphanedContestedOptions,
  ): Promise<ResolveOrphanedContestedResult>;
  /**
   * Issue #207/#933 PR2（ADR 0327 §4-c、ADR 0378、ADR 0381）: `docs/memory-model.md` §11
   * lifecycle 行6「`active → contested`」を、**3件以上**（群）へ書く**明示的操作**。
   * `markContested`（2者専用、ADR 0134）の形を手本にした N者版——「対象が適格だったか」
   * を読み側で判定してから `MemoryStore.markContestedGroup` を呼ぶ、という2段構えを
   * そのまま踏襲する。
   *
   * **この操作自身も「矛盾しているかどうか」を判定しない。**呼び出し側
   * （`detectClaimKeyContested` の `contested_group` 分岐、または人・上位のアプリケーション
   * 層）が「この `members` は対向する」と既に決めていることを前提に、その決定を
   * 機械的に書き込むだけである。**穴Aの吸収（既存の2者間の対の相方を含める）・合併
   * （複数の既存群を1つに束ねる）の判定は、この口の呼び出し側の責務である**
   * （`MemoryStore.markContestedGroup` の interface JSDoc の契約 2・3）——この口は
   * 渡された `members` をそのまま検査して書くだけで、`RelationStore` を自分で読みには
   * 行かない。
   *
   * 手順（`markContested` と同じ順で追える）:
   * 1. `memberIds.length < 3` は呼び出し前の programmer error として扱い、`RangeError`
   *    （`Runtime.markContestedGroup: memberIds must have at least 3 entries`）を投げる。
   *    書き込みは一切試みない。
   * 2. `memberIds` に同じ id が2回以上現れるのも programmer error として扱い、`RangeError`
   *    （`Runtime.markContestedGroup: memberIds must be unique`）を投げる。
   * 3. `deps.memoryStore.markContestedGroup` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す——フォールバック
   *    経路は無い。
   * 4. `getMany(memberIds)` で一括読み、それぞれを
   *    {@link MarkContestedGroupSideOutcome} に分類する（`"not_found"`/`"status_conflict"`/
   *    `"eligible"`。適格性は `MemoryStore.markContestedGroup` の契約2・3と同じ3通り）。
   *    1件でも `"eligible"` でなければ、書き込みを一切試みず
   *    `{ supported: true, outcome: { kind: "ineligible", sides } }` を返す。
   * 5. 全員 `"eligible"` なら、この口自身が各メンバーの `event`（`kind: 'updated'`・
   *    `meta.reason: 'contested'`、下記）を組み立てて `deps.memoryStore.markContestedGroup`
   *    を呼ぶ——`markContested`（2者版）が `firstId`/`secondId` だけを受け取り `event` は
   *    自分で組み立てるのと同じ分担（`MemoryStore.markContestedGroup` の `members[].event` は
   *    この口が埋める）。成功すれば
   *    `{ supported: true, outcome: { kind: "contested_group", members } }`。
   * 6. {@link MemoryStatusConflictError} が投げられたら（4で読んだ後、5で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、**1回だけ**再読して `conflicts` に全員の現在の
   *    `status` を積み、`{ supported: true, outcome: { kind: "conflict", conflicts } }`
   *    を返す——上限の無い再試行ループにはしない。
   *
   * `memory_events` へ全メンバーそれぞれ1件ずつ積む。`kind: 'updated'`・
   * `meta.reason: 'contested'`（`markContested` と同じ固定値）。`opts.reason` を渡すと
   * `meta.note` に追加で入る。**`meta.contestedWithId` は積まない**——群のメンバーは
   * `contestedWithId` 自体を持たない設計（ADR 0378 決定1 §3.3）であり、「誰と対だったか」は
   * `memory_relations` の行（`RelationStore.listRelated`）から辿る。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` になった時点で、
   * 既存の段1 status ゲート・段3 mandatory companion retrieval と全く同じ経路へ合流する
   * ——`markContested` と同じ理由。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く。
   *
   * 🔴 **任意メソッドである。**`resolveOrphanedContested?`（上、Issue #825 続き）と同じ理由
   * ——`@mnemora/core` は v1.0.0 として npm に公開済みであり、`Runtime` interface を自前で
   * 実装している利用者にとって、v1.0.0 の後に必須メソッドが増えることは破壊的変更になる。
   * ⟹ **`createRuntime` が返す `Runtime` には必ずこのメソッドが実装されている**
   * ——省略されるのは利用者が独自に `Runtime` を実装する場合の後方互換のためだけである。
   */
  markContestedGroup?(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    opts?: MarkContestedGroupOptions,
  ): Promise<MarkContestedGroupResult>;
  /**
   * Issue #207/#933 PR2（ADR 0327 §4-c、ADR 0378 決定3、ADR 0381）: `docs/memory-model.md`
   * §11 lifecycle 行7「`contested` → `active | superseded`」を、群へ書く**明示的操作**。
   * `markContestedGroup`（上）の解決側であり、`resolveContested`（2者版）の形を手本に
   * 対称に書いてある。
   *
   * **この操作自身も「どちらが正しいか」を判定しない。**呼び出し側が既に下した決定
   * （{@link ContestedGroupResolution}）を機械的に書き込むだけである。
   *
   * 手順:
   * 1. `memberIds.length < 3` は `RangeError`
   *    （`Runtime.resolveContestedGroup: memberIds must have at least 3 entries`）。
   * 2. `memberIds` の id 重複は `RangeError`
   *    （`Runtime.resolveContestedGroup: memberIds must be unique`）。
   * 3. `resolution.kind === "supersede"` のとき、`resolution.winnerId` が `memberIds` の
   *    どの id とも一致しなければ `RangeError`
   *    （`Runtime.resolveContestedGroup: resolution.winnerId must be one of memberIds`）。
   *    ただし `winnerId` が memberIds のどれかと大文字小文字だけ違うときは、`resolveContested`
   *    （2者版）と同じ規則で救済する（Issue #1449 項目6。旧版は「群は候補を一意に絞れない
   *    ことが多い」として見送っていたが、**一意に絞れたときだけ**救済し、絞れなければ今どおり
   *    落とす形なら2者版と同じ規則を持ち上げられる）: 小文字にそろえて memberIds から候補を集め、
   *    **ちょうど1件**かつ `memoryStore.get` が `winnerId` と候補に同じ id の記憶を返したとき
   *    だけ、その memberId の綴りを勝者として使う（敗者の `supersededById` は memberIds の綴り
   *    ＝store の列の値になる）。候補が2件以上・`get` が食い違う・どの member とも大文字小文字を
   *    無視しても違う（この場合は store を読まない）ときは `RangeError`。
   * 4. `deps.memoryStore.resolveContestedGroup` が無ければ
   *    `{ supported: false, outcome: { kind: "not_attempted" } }`。
   * 5. `getMany(memberIds)` で一括読み、{@link ResolveContestedGroupSideOutcome}
   *    に分類する（`"not_found"`/`"status_not_contested"`/`"eligible"`）。
   * 6. ⚠ **2026-09-30 の直し（ADR 0381）: store 側の CAS（`MemoryStore.resolveContestedGroup`
   *    契約）が「`members` は `memory_relations` でつながった今も `contested` な群の全員と
   *    一致しなければならない」を要求するのに合わせ、この読み側でも同じ確認を行う**——
   *    `deps.relationStore`（配線されていれば）で `memberIds` から `kind: 'contradicts'`
   *    を辿って到達する id を求め、そのうち `status === 'contested'`（`getMany` で追加で
   *    読む）のものが `memberIds` の外にあれば、それを `missingMembers` に積んで
   *    `{ supported: true, outcome: { kind: "ineligible", sides, missingMembers } }` を返す
   *    ——書き込みは一切試みない。`deps.relationStore` が配線されていなければ、この
   *    読み側の確認は行わず store 側の CAS だけに任せる（store が
   *    {@link MemoryStatusConflictError} を投げれば手順8の `conflict` に落ちる——
   *    `expectedStatus === observedStatus === 'contested'` という特別な形で区別できる、
   *    `MemoryStore.resolveContestedGroup` の interface JSDoc 参照）。
   * 7. 手順5・6のどちらでも1件でも `"eligible"` でなければ、書き込みを一切試みず
   *    `{ supported: true, outcome: { kind: "ineligible", sides, missingMembers: [] } }`
   *    を返す（手順6で既に `missingMembers` が埋まっている場合を除く）。
   * 8. 全員 `"eligible"` なら、この口自身が各メンバーの `status`/`supersededById`/`event` を
   *    `resolution` から組み立てて `deps.memoryStore.resolveContestedGroup` を呼ぶ
   *    （`resolveContested`（2者版）が `resolution` だけを受け取り、`MemoryStore.
   *    resolveContestedPair` へ渡す `status`/`event` は自分で組み立てるのと同じ分担）。
   *    - `resolution.kind === "both_active"`: 全員 `status: "active"`。
   *    - `resolution.kind === "supersede"`: `winnerId` 側は `status: "active"`、
   *      他の全員は `status: "superseded"` + `supersededById: <winnerId>`。
   *
   *    成功すれば `{ supported: true, outcome: { kind: "resolved", members } }`。
   *    {@link MemoryStatusConflictError} が投げられたら（TOCTOU、または store 側の全体一致
   *    CAS 違反）、**1回だけ**再読して `conflicts` に積み、
   *    `{ supported: true, outcome: { kind: "conflict", conflicts } }` を返す。
   *
   * `memory_events` へ全メンバーそれぞれ1件ずつ積む。`"supersede"` は勝者に `kind: 'updated'`、
   * 他の全員に `kind: 'superseded'`。`"both_active"` は全員 `kind: 'updated'`。
   * `meta.reason` は固定値 `'contested_resolved'`、`meta.resolution` に
   * `'supersede' | 'both_active'`。`opts.reason` を渡すと `meta.note` に追加で入る。
   * `meta.contestedWithId` は積まない（`markContestedGroup` と同じ理由——群のメンバーは
   * その欄自体を持たない）。負けた側の `superseded` は `meta.supersededById` に勝った側の id
   * （`memberIds` の綴りに寄せた `winnerId`。store へ渡す値と同じ）を持つ——2者版
   * `resolveContested` と同じ形（ADR 0150 追記。ADR 0421 で揃えた）。勝者の `updated` には足さない。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`markContested`/`resolveContested` と同じ
   * 理由。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**
   *
   * 🔴 **任意メソッドである。**`markContestedGroup?`（上）と同じ理由。
   */
  resolveContestedGroup?(
    ctx: Ctx,
    memberIds: readonly MemoryId[],
    resolution: ContestedGroupResolution,
    opts?: ResolveContestedGroupOptions,
  ): Promise<ResolveContestedGroupResult>;
  /**
   * 北極星「目指す姿」項目5「間違いを正すと、古いほうが先に出てこなくなる」を、
   * **出荷される面**（`Runtime` の公開 interface）から駆動できるようにする、
   * `findCorrectionCandidates`（発見、ADR 0232）と `markContested`/`resolveContested`
   * （書き込み、ADR 0134/ADR 0150）の**間**——「選択」の段（Issue #369、
   * [ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）。
   *
   * 実体は `examples/chat/src/correction-demo.ts` に**だけ**あった3態の状態機械
   * （選択待ち／候補外／解決）を、`packages/core` の公開 API へ持ち上げたものである
   * ——`examples/chat` は `private: true` であり出荷されない。⟹ この口が無い間、
   * 北極星 項目5 は「出荷される面」からは一度も駆動できなかった。
   *
   * ⛔ **この口も「相手を選ぶ」ことは一切しない。** {@link ApplyCorrectionInput.correctedId}
   * は必ず呼び出し側が渡す——`discovery.candidates[0]` を自動的に採る経路は無い。
   * この設計は [ADR 0134](../../../docs/decisions/0134-mark-contested-explicit-operation.md)
   * 決定2・[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)
   * の核心（「機械は選ばない」）をそのまま引き継ぐ——ADR 0232 が実測した危険
   * （B群: 訂正してはいけない8件中、棄権率 0/8・深い誤爆 6/8。閾値は分離できない）が、
   * この口を足したことで再び現れることはない。
   *
   * 手順（`createRuntime` 内の実装。他に判定は無い——ここが実装の全体である）:
   * 1. `input.correctedId` が `undefined` なら、何も呼ばずに
   *    `{ kind: "awaiting_choice" }` を返す。
   * 2. `input.discovery.candidates` から `memoryId === input.correctedId` を探す。
   *    見つからなければ、何も呼ばずに
   *    `{ kind: "not_a_candidate", correctedId: input.correctedId }` を返す。
   * 3. 見つかれば `markContested(ctx, input.correctedId, input.correctingId, {
   *    actor: input.actor, reason: input.reason })` を呼ぶ。
   * 4. `input.resolution` が `undefined` なら、ここで止まり
   *    `{ kind: "contested", ..., markResult }` を返す——`resolveContested` は
   *    一度も呼ばない。
   * 5. `input.resolution` があれば、続けて `resolveContested(ctx, input.correctedId,
   *    input.correctingId, input.resolution, { actor: input.actor, reason: input.reason })`
   *    を呼び、`{ kind: "resolved", ..., markResult, resolveResult }` を返す。
   *
   * ⛔ **`markContested`/`resolveContested` 自身の失敗（`ineligible`/`conflict`/
   * `not_attempted`）を握り潰さない。** {@link MarkContestedResult}/{@link ResolveContestedResult}
   * をそのまま `markResult`/`resolveResult` として運ぶ——`applyCorrection` はそれらを
   * 別の顔（例外・`boolean`）に変換しない。`kind: "resolved"` は「`resolveContested` まで
   * 呼んだ」ことだけを意味し、実際に解決が成功したことは `resolveResult.outcome.kind`
   * を見て判断すること。
   *
   * ⛔ **この口自身は監査理由を自動生成しない。** `input.reason` は
   * `buildCorrectionReason`（`apply-correction.ts`）（ADR 0238 が定めた形を `packages/core` へ持ち上げたもの）
   * で呼び出し側が組み立てた文字列、またはその他の自由文をそのまま `markContested`/
   * `resolveContested` の両方へ渡すだけである——`meta.note` に載る `recallId` が
   * `RecallResult.explain`（`getRecall` 経由）への橋になる、という ADR 0238 の形は
   * 変わらない。
   *
   * ⭐ **`markContested` だけを呼んだ後（`resolution` を渡さない呼び出し）、別の
   * `applyCorrection` 呼び出しで改めて `resolution` を渡す、という2段の使い方ができる。**
   * `applyCorrection` は呼び出しの間で状態を持たない——2回目の呼び出しでも手順3で
   * `markContested` は呼ばれるが、対象は既に `status: 'contested'` なので
   * {@link MarkContestedResult} は書き込み無しで `ineligible` を返すだけであり、続く
   * `resolveContested` は正常に解決へ進む。`examples/chat/src/correction-demo.ts` の
   * `runCorrectionDemo` がこの2段呼び出しを使い、`markContested` 相当の直後に
   * `recall()` で対（mandatory companion）を見せてから解決へ進む、という Issue #303
   * 由来の実演を保っている。
   *
   * ⚠ **`correctedId === correctingId` を特別扱いしない。** 手順2の照合を通り抜けた場合
   * （呼び出し側が `excludeMemoryIds` で自己除外していない等）、`markContested` 自身が
   * `firstId === secondId` の `RangeError` を投げる——`applyCorrection` はそれを
   * 捕まえない（`markContested`/`resolveContested` の「開く前に落とす」位置をそのまま
   * 引き継ぐ、呼び手のバグ）。
   *
   * ⚠ **`tick()`/`observe()` からは一度も呼ばれない。** `markContested`/`resolveContested`
   * と同じ立場——呼び出し側が明示的に呼んだときだけ動く。
   */
  applyCorrection(ctx: Ctx, input: ApplyCorrectionInput): Promise<ApplyCorrectionResult>;
  /**
   * Issue #103（ADR 0089）: 複数の Memory を1件に統合する（docs/vision.md「5動詞」の1つ）。
   *
   * **`forget`/`purge`/減衰のどれでもない、第4の位置——`status: 'superseded'`
   * （機構の都合）を使う。** 統合元は `status: 'superseded'` + `supersededById: <統合先>` へ
   * 動き、行も `content` も消えない（`superseded_by_id` で統合先を辿れる。docs/north-star.md
   * 表4「元を消さない」）。**`forgotten` は絶対に統合元にしない**——利用者が意図して
   * 忘れさせたものを、機構の都合（統合）で上書きしない（`runtime.forget` の先例と同じ理由）。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1248](https://github.com/takecchi/mnemora/issues/1248)）:
   * 下の手順が「書き込み無し」「書き込みゼロ」と書くのは、Memory・`memory_events`・outbox のことである。**
   * `target` が `{ query }`・`{ seedMemoryId }` のときは、手順1の `recall()` が recall の記録を1件書き、`decay_clock` が
   * `'wall'` 以外のテナントでは `activity_seq` を1進める（ADR 0165 決めたこと5）。**`dryRun`、eligible が0件・1件、
   * LLM の失敗など、どの枝で終わっても起きる。**⟹ 活動時計のテナントでは、`dryRun` で確かめるだけでも記憶が1回ぶん
   * 沈む。`tick()` の `consolidate` ジョブ（`{ seedMemoryId }` で呼ぶ）も同じ。`{ memoryIds }` は `recall()` を呼ばないので、
   * どちらも起きない。【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ
   * （`consolidate-reflect-recall-side-effects.postgres.test.ts`）。
   *
   * 手順（ADR 0089 §3。**この順序が冪等性と安全性を買っている**）:
   * 1. `target` を正規化する。`{ memoryIds }` はそのまま（重複・入力順を保つ）。空配列は
   *    store に一切触れず `outcome: 'not_examined'`。`{ query, maxCandidates }` は
   *    `recall(ctx, query)` を1回呼び、返った `memories` の id を順に採る
   *    （`maxCandidates` があれば先頭からその件数で切る）。0件も `not_examined`。
   *    `{ seedMemoryId, maxCandidates?, minAffinity? }`（Issue #135、ADR 0152）は
   *    種の Memory を `get` し、その `digest` を `text` にして `recall()` を1回呼ぶ
   *    （`{ query }` とまったく同じ経路）。`recall()` が返した候補のうち、
   *    `RecalledMemory.score` から `computeAffinity`（`max(similarity, lexicalMatch)`、
   *    `strategies/consolidate.ts`）が `minAffinity`（既定
   *    {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）未満のものは落とす。**種そのものは
   *    この判定を受けず、必ず先頭に含める**（種の embedding がまだ無いと ANN に
   *    載らないため）。`maxCandidates` は結果の配列全体（種＋近傍）を先頭から切る。
   *    種が見つからない、または種が forget・purge された記憶なら（Issue #1136）、`recall()` を
   *    呼ばず、対象は種の id 1件のみになる。
   * 2. `getMany` で一括読み。無ければ `not_found`、`status !== 'active'` なら
   *    `status_not_active`、`active` なら eligible。在るかどうかの突き合わせは `restoreArchived` の手順2と同じ
   *    （大文字小文字だけが違う id を同じ呼び出しに混ぜたときは、渡された文字列どおりに突き合わせる）。
   * 3. eligible が0件なら `nothing_to_consolidate`/`no_eligible_sources`、1件だけなら
   *    `nothing_to_consolidate`/`single_eligible_source`——どちらも `llmCalls: 0`・書き込み無し。
   *    **eligible は重複を除いて数える**（`reflect` の手順3と同じ。2026-09-27 追記、ADR 0089 の
   *    追記）——`{ memoryIds: [a, a] }` は eligible 1件として `single_eligible_source` になり、
   *    同じ Memory を自分自身と統合しない。`sources` は入力と同じ長さ（重複も保つ）のまま
   *    （歯は `packages/core/src/__tests__/consolidate-duplicate-ids.test.ts`）。
   *    **これが冪等性の芯**——同じ id 集合で2回目を呼ぶと eligible が0件になり、LLM も
   *    呼ばず何も書かずに終わる。⚠ **2026-09-26 追記（Issue #869）: 「同じ id 集合」は
   *    `{ memoryIds }` では保証されるが、`{ seedMemoryId }`（手順1）では保証されない**
   *    ——`neighborIds` を毎回 `recall()` で拾い直すため、1回目で `recall()` の窓から
   *    溢れて `active` のまま残った近傍が2回目には eligible に入り、書き込みゼロにならない
   *    ことがある（{@link ConsolidateTarget} の doc コメント、ADR 0152 負債5・ADR 0089 の
   *    2026-09-26 追記）。
   * 4. `dryRun: true` ならここで打ち切る。eligible は `{ kind: 'eligible' }`、他は2の判定の
   *    まま。`outcome: 'dry_run'`、`llmCalls: 0`、書き込みゼロ。
   * 5. LLM を1回呼ぶ（`completeStructured`）。失敗したら `outcome: 'llm_failed'`・
   *    `llmFailure`・`llmCalls: 1`・書き込みゼロ（失敗を根拠に既存の記憶を置き換えない。
   *    `ReextractResult.supersededMemoryIds` の doc と同じ規律）。
   *    ⭐ **2026-09-30 追記（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
   *    ADR 0375 決定7、クローン miku の判断）: LLM が返った直後・統合先を作る前に、
   *    eligible を `getMany` で読み直す。**1件でも `status === 'forgotten'`（`forget()` のみ・
   *    `purge()` 済みのどちらも含む）なら、**統合先を一切作らずに打ち切る**
   *    （`outcome: 'aborted_source_forgotten'`、`atomicity: 'not_attempted'`、`llmCalls: 1`。
   *    forgotten だった要素は `sources` で `"forgotten_before_write"`、他の eligible は
   *    `"not_attempted"`）。**この読み直しと次の書き込みの間には、まだ小さな窓が残る**
   *    ——`atomicity: 'store_unsupported'` の経路（下の手順7）は、この読み直しだけが保護であり、
   *    それ以上の見直しは無い。`atomicity: 'store_supported'` の経路（口が在る adapter）は、
   *    この読み直しに加えて、手順7の `supersedeWithNewMemories` 呼び出し自体に
   *    `opts.abortIfForgotten: eligibleIds` を渡し、**書き込みと同一トランザクションの中で
   *    `SELECT … FOR UPDATE` によりもう一度見直す**（`@mnemora/postgres` の実装。
   *    {@link SourceMemoryForgottenError} 参照）——ここで forgotten が見つかれば
   *    {@link SourceMemoryForgottenError} を投げ、`news`（統合先）も `supersede`（統合元の更新）も
   *    一切コミットされずに rollback する。runtime はこの例外を捕まえ、同じ
   *    `outcome: 'aborted_source_forgotten'` として返す——呼び出し側からは、読み直しの直後に
   *    打ち切られたのか・書き込みのトランザクション内で打ち切られたのかは区別できない
   *    （どちらも「何も書かれていない」という点で同じであり、区別する意味が無い）。
   *    `packages/testkit` の `InMemoryMemoryStore` と `packages/core` のテスト用
   *    `FakeMemoryStore` は `opts.abortIfForgotten` を実装しないため、これらの adapter では
   *    上の読み直しだけが保護になる（残る窓については `docs/memory-model.md` の該当箇所参照）。
   * 6. 統合先を1件作る（`createMemoryWithOutbox`。`buildConsolidatedMemory` 参照）。
   *    ⚠ **統合先は `embeddingStatus: 'pending'` で作られ、`embed` ジョブを積むだけ——
   *    `tick()` が回るまで ANN の候補に入らない。**統合元は同じ呼び出しの中で
   *    `superseded` へ動くため、**元はもう引けないが統合先もまだ引けない窓が開く**
   *    （[ADR 0089](../../../docs/decisions/0089-runtime-consolidate-shape.md)
   *    「引き受けた負債」4。塞いでいない——今は決めない、と書いてある）。
   * 7. eligible を1件ずつ `updateStatusWithEvent` で `superseded` へ CAS する（`reextract` の
   *    ループと同じ形。**`atomicity: 'store_unsupported'`——`MemoryStore.supersedeWithNewMemories`
   *    が無い adapter のときだけこの手順を通る**）。`MemoryStatusConflictError` はその1件だけ
   *    `status_changed_concurrently` として飛ばして続行、それ以外の例外は `failed` を積んで
   *    その場で打ち切り、残りを `not_attempted` として返す（投げない。`forget`/ADR 0087 決定5
   *    と同じ）。
   *    🔴 **`atomicity: 'store_supported'`（口が在る adapter）はこの手順そのものを使わない**
   *    ——統合先の作成と統合元の supersede を1トランザクションで撃ち、CAS の競合は例外では
   *    なく戻り値の `conflicted`（`status_changed_concurrently` に写す）として届く。**それ以外の
   *    予期しない例外はここでは投げる**——ADR 0089 決定5（「予期しない例外は打ち切って
   *    `not_attempted` として返す。投げない」）を**この経路だけ**部分的に覆す。決定5が
   *    「投げない」とした理由（部分的に起きたことを呼び出し側から見えなくしないため）は、
   *    1トランザクションでは部分的に起きたこと自体が無い（統合先の作成も supersede も全部
   *    巻き戻る）ため、この経路では別の手段で既に満たされている（ADR 0100 決定8）。
   *    ⚠ **2026-09-30 訂正（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
   *    ADR 0375 決定7）: この段落は 2026-09-27 に「今の振る舞い」として書いたが、もう成り立たない。**
   *    当時は、LLM を待つ間に eligible の1件が `forget`（さらに `purge`）されても、どちらの経路も
   *    書き込みの前に見直さなかった——その1件は `status_changed_concurrently` として飛ばされる
   *    だけで、統合先はその本文を入れた LLM の出力から作られ、`active` で書かれていた
   *    （`purge()` が `"purged"` を返した後でも）。**今は、手順5の直後の読み直し（上）が
   *    この場合を検出し、`outcome: 'aborted_source_forgotten'` で打ち切る**——`forget`/`purge`
   *    された要素が `status_changed_concurrently` に分類されて統合先が書かれることはもう無い。
   *    【実測 2026-09-30】`@mnemora/postgres` と testkit の fixture で確認（歯は
   *    `consolidate-reflect-forget-race.postgres.test.ts`）。**`status_changed_concurrently` 自体は
   *    今日も存在する**——`forgotten`/`purged` 以外の理由（例: 別の呼び出しが同じ eligible を
   *    先に `superseded`/`contested` へ動かした）で CAS が破れたときは、今どおり部分成功として扱う
   *    （その1件だけ `status_changed_concurrently`、統合先は書かれる）。
   * 8. `outcome: 'consolidated'`、`consolidatedMemoryId`、`llmCalls: 1`。
   *
   * `memory_events.meta.reason` は `superseded` イベントに `'consolidated'` を積む
   * （`reextract_superseded` に次ぐ2つ目の値、ADR 0074 が予言した形）。`digestSnapshot` は
   * 積むが **`content` は積まない**（`forget`/`reextract` と同じ規律）。
   *
   * ⭐ **`tick()` は `'consolidate'` の outbox ジョブが在ればこれを駆動する**
   * （Issue #204 / ADR 0157。`TICK_SUPPORTED_JOB_KINDS` に足された）。ジョブの
   * `payload` は `{ memoryId }`（既存の `embed` ジョブと同じ形）で、`tick` はそれを
   * `seedMemoryId` として `consolidate(ctx, { target: { seedMemoryId } })` を呼ぶ
   * だけである——このメソッド自身の意味論・呼び出し方は一切変わっていない。
   * ⚠ **そのジョブが自動で積まれるとは限らない**——`extract` がこの種を積むのは
   * `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にした
   * ときだけである。無効のままでも `consolidate()` を直接呼ぶ経路は変わらず動く
   * （北極星の問い2）。
   */
  consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult>;
  /**
   * Issue #104: 複数の Memory から一般化・気づきを1件作る（docs/vision.md「5動詞」の1つ）。
   *
   * **`consolidate` の双子だが、意味論は正反対である。** `consolidate` は N→1 の**置換**
   * （統合元を `superseded` へ動かす）だが、`reflect` は**足すだけ**の操作であり、
   * 既存の行の `status` を1つも動かさない。書き込みは新しい Memory 1件と `created`
   * イベントだけであり、`updateStatus`/`updateStatusWithEvent` は1度も呼ばない
   * ——`reflect` に `superseded`/`forgotten` へ動かす根拠は無い（`consolidate` が
   * `superseded` を使えるのは N→1 の置換だからである）。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1248](https://github.com/takecchi/mnemora/issues/1248)）:
   * 下の手順が「書き込み無し」「書き込みゼロ」と書くのは、Memory・`memory_events`・outbox のことである。**
   * `target` が `{ query }`・`{ seedMemoryId }` のときは、手順1の `recall()` が recall の記録を1件書き、`decay_clock` が
   * `'wall'` 以外のテナントでは `activity_seq` を1進める（ADR 0165 決めたこと5）。**`dryRun`、eligible が0件・1件、
   * LLM の失敗など、どの枝で終わっても起きる。**⟹ 活動時計のテナントでは、`dryRun` で確かめるだけでも記憶が1回ぶん
   * 沈む。`tick()` の `reflect` ジョブ（`{ seedMemoryId }` で呼ぶ）も同じ。`{ memoryIds }` は `recall()` を呼ばないので、
   * どちらも起きない。【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ
   * （`consolidate-reflect-recall-side-effects.postgres.test.ts`）。
   *
   * 手順（`consolidate` §3 と同じ段取りを踏むが、書き込みの終盤だけ違う）:
   * 1. `target` を正規化する。`{ memoryIds }` はそのまま（重複・入力順を保つ）。空配列は
   *    store に一切触れず `outcome: 'not_examined'`。`{ query, maxCandidates }` は
   *    `recall(ctx, query)` を1回呼び、返った `memories` の id を順に採る
   *    （`maxCandidates` があれば先頭からその件数で切る）。0件も `not_examined`。
   *    `{ seedMemoryId, maxCandidates?, minAffinity? }`（Issue #204、ADR 0154）は
   *    `consolidate` の `{ seedMemoryId }`（ADR 0152）と同じ土台選定——種の Memory を
   *    `get` し、その `digest` を `text` にして `recall()` を1回呼ぶ（`{ query }` と
   *    まったく同じ経路）。`recall()` が返した候補のうち、`RecalledMemory.score` から
   *    `computeAffinity`（`max(similarity, lexicalMatch)`、`strategies/consolidate.ts`）が
   *    `minAffinity`（既定 {@link DEFAULT_REFLECT_MIN_AFFINITY}）未満のものは落とす。
   *    **種そのものはこの判定を受けず、必ず先頭に含める**（種の embedding がまだ無いと
   *    ANN に載らないため）。`maxCandidates` は結果の配列全体（種＋近傍）を先頭から切る。
   *    種が見つからない、または種が forget・purge された記憶なら（Issue #1136）、`recall()` を
   *    呼ばず、対象は種の id 1件のみになる。
   * 2. `getMany` で一括読み。**この優先順で**分類する: 無ければ `not_found`、
   *    `status !== 'active'` なら `status_not_active`、`active` かつ、いまの時点で有効期間
   *    （`validFrom`/`validUntil`）の外なら `expired`/`not_yet_valid`（2026-09-29 追記、Issue #1188。
   *    `consolidate()`・`recall()` と同じ `classifyValidity` 述語、`clock.now()` に対して見る）、
   *    `active` かつ期間の内側で `provenance.kind === 'reflected'` なら `basis_is_reflected`（reflect の産物を
   *    土台にまた reflect する自己増幅を、形の側で止める）、それ以外は eligible。
   *    在るかどうかの突き合わせは `restoreArchived` の手順2と同じ（大文字小文字だけが違う id を同じ呼び出しに
   *    混ぜたときは、渡された文字列どおりに突き合わせる）。
   * 3. eligible（重複除去）が0件なら `nothing_to_reflect`/`no_eligible_basis` で打ち切る
   *    ——**LLM を呼ばない**（`llmCalls: 0`）。`consolidate` と違い、eligible が1件だけでも
   *    ここでは打ち切らない（1件からの一般化も意味を持ちうる）。
   * 4. `dryRun: true` ならここで打ち切る。eligible は `{ kind: 'eligible' }`、他は2の判定の
   *    まま。`outcome: 'dry_run'`、`llmCalls: 0`、書き込みゼロ。
   * 5. LLM を1回呼ぶ（`completeStructured`、スキーマは判別子 `outcome: 'reflected' | 'nothing'`
   *    を持つ判別可能ユニオン——断れないスキーマを渡すと、モデルは毎回何かを捏造するため、
   *    モデルが「一般化するものは無い」と答えられる形にしてある）。失敗したら
   *    `outcome: 'llm_failed'`・`llmFailure`・`llmCalls: 1`・書き込みゼロ（失敗を根拠に
   *    新しい記憶を作らない。`ReextractResult`/`ConsolidationResult` と同じ規律）。
   * 6. LLM が `outcome: 'nothing'` を返したら `nothing_to_reflect`/`llm_declined`、
   *    `llmCalls: 1`、書き込みゼロ。
   *    ⭐ **2026-09-30 追記（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
   *    ADR 0375 決定7、クローン miku の判断）: LLM が `'reflected'` を返した直後・新しい
   *    Memory を組み立てる前に、eligible を `getMany` で読み直す。**1件でも
   *    `status === 'forgotten'`（`forget()` のみ・`purge()` 済みのどちらも含む）なら、
   *    **内省の Memory を一切作らずに打ち切る**（`outcome: 'aborted_source_forgotten'`、
   *    `llmCalls: 1`。forgotten だった要素は `basis` で `"forgotten_before_write"`、他の
   *    eligible は `"eligible"`）。この読み直しと次の手順7（書き込み）の間には小さな窓が
   *    残る——`reflect` は `consolidate` の `atomicity: 'store_supported'` に相当する
   *    「複数行を1トランザクションで」という仕組みを持たない（既存行を1つも動かさないため
   *    `supersedeWithNewMemories` を使わない）が、手順7の `createMemoryWithOutbox` 自体に
   *    `opts.abortIfForgotten: eligibleIds` を渡し、`@mnemora/postgres` はこの INSERT と
   *    同一トランザクションの中で `SELECT … FOR UPDATE` によりもう一度見直す
   *    （{@link SourceMemoryForgottenError} 参照）——ここで forgotten が見つかれば
   *    {@link SourceMemoryForgottenError} を投げ、INSERT は一切コミットされずに rollback
   *    する。runtime はこの例外を捕まえ、同じ `outcome: 'aborted_source_forgotten'` として
   *    返す。`packages/testkit` の `InMemoryMemoryStore` と `packages/core` のテスト用
   *    `FakeMemoryStore` は `opts.abortIfForgotten` を実装しないため、これらの adapter では
   *    上の読み直しだけが保護になる（`consolidate` の同日付の追記と同じ形。残る窓については
   *    `docs/memory-model.md` の該当箇所参照）。
   * 7. `buildReflectedMemory(...)` で新しい Memory を1件組み立て
   *    （`createMemoryWithOutbox(ctx, newMemory, ['embed'])`）。`provenance` は
   *    `{ kind: 'reflected', sources: <eligible の memoryId> }`——**`sources` は必ず埋める**
   *    （`ReflectedProvenance.sources` は型としては省略可のままだが、この実装が作る値は
   *    常に埋める。公開型の破壊的変更を避けるため型は変えていない）。
   *    ⚠ **2026-09-30 訂正（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)）:
   *    この段落は 2026-09-27 に「今の振る舞い」として書いたが、もう成り立たない。**
   *    当時は、LLM を待つ間に eligible の1件が `forget`（さらに `purge`）されても、
   *    書き込みの前に見直さず、内省の Memory はその本文を入れた LLM の出力から作られ
   *    `active` で書かれていた。**今は、手順6の直後の読み直し（上）がこの場合を検出し、
   *    `outcome: 'aborted_source_forgotten'` で打ち切る。**【実測 2026-09-30】
   *    `@mnemora/postgres` と testkit の fixture で確認（歯は
   *    `consolidate-reflect-forget-race.postgres.test.ts`）。
   * 8. `created` イベントを1件積む。`meta.reason: 'reflected'`、`meta.sources: <eligible の
   *    id>`、`opts.reason` があれば `meta.note` にも積む（`consolidate` の `superseded`
   *    イベントと同じ形）。
   * 9. `outcome: 'reflected'`、`reflectedMemoryId`、eligible を `'used'` にして返す。
   *
   * ⚠ **冪等性は買っていない。**`sourceObservationId: null` なので `createMemoryWithOutbox`
   * の部分一意索引（`WHERE source_observation_id IS NOT NULL`）は効かず、既存の行の
   * `status` を動かさない（上の手順に `superseded`/`forgotten` が無い）ため `consolidate` の
   * 「読んで status で弾く」も使えない。**⟹ 同じ target で2回呼ぶと、内容が同じ
   * `reflected` Memory が2件できる。**これを塞ぐために `MemoryStore` へメソッドや索引を
   * 足すことはしていない（`reflect.test.ts` がこの挙動を歯で固定している）。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの）: `tick()` の `'reflect'` ジョブも同じ理由で冪等でない。**
   * outbox の処理は at-least-once である（`OutboxStore` の doc、ADR 0032）——`reflect()` が内省の
   * Memory を書いた後、`complete` の前にワーカーが止まると、リースが切れた後の `tick()` が同じ
   * ジョブをもう一度処理し、**内省の Memory が2件になる**（created イベントと embed ジョブも2つずつ）。
   * 【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ。比べて、`'embed'`・
   * `'consolidate'` のジョブは同じ再配達でも1回だけ処理したときと同じ状態になる（consolidate は
   * 上の「読んで status で弾く」が効く）。歯は
   * `packages/postgres/src/__tests__/tick-sequential-redelivery.postgres.test.ts`。
   *
   * ⭐ **`tick()` は `'reflect'` の outbox ジョブが在ればこれを駆動する**
   * （Issue #204 / ADR 0157。`TICK_SUPPORTED_JOB_KINDS` に足された）。`consolidate` と
   * 対称——ジョブの `payload` は `{ memoryId }` で、`tick` はそれを `seedMemoryId` として
   * `reflect(ctx, { target: { seedMemoryId } })` を呼ぶだけである。
   * ⚠ **`reflect()` の *実運用*（Background Cognition・Scheduler による自動起動）は
   * 依然として Phase 1 の範囲外のままである**（docs/roadmap.md §1.3。⚠ 2026-09-29 追記:
   * 併記していた §1.1 は削除した（#762）。当時の本文は
   * https://github.com/takecchi/mnemora/blob/635c93d/docs/roadmap.md#11-オーナー指定の範囲 ）——ここで
   * 変わったのは「`tick` に渡されたジョブを処理できるようになった」ことだけであり、
   * ジョブを**自動で積む**かどうかは別の決定である。`extract` がこの種を積むのは
   * `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効に
   * したときだけであり、無効のままでも `reflect()` を直接呼ぶ経路は変わらず動く
   * （北極星の問い2）。
   */
  reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult>;
}

/**
 * `observations.payload`（`kind = 'usage'`）の形。`ObserveMemoryUsageInputSchema`
 * （observation.ts、非公開）と同じ2欄——`externalId` は payload ではなく Observation 行の
 * 列そのもの（他3種と同じ規約）なので、ここには含めない。
 *
 * Issue #870: `handleMemoryUsage` が、冪等な再送で保存済み Observation の payload を
 * 読み直す（＝ `recordUsage`/`reinforce` を保存済みの `recallId`/`usedMemoryIds` で
 * 呼ぶ）ために使う。**runtime 内部専用**——公開 API 表面（ADR 0178）を増やさないよう
 * export しない。
 */
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
      // Issue #1185: `extractData: true` のときだけ payload に印を足す。`false`・省略では
      // `payload` は今までと1バイトも変わらない（`extractData` キー自体が増えない）
      // ——`observationPayloadText`（observation-text.ts）はこの印を見て `data` を本文へ合成する。
      return {
        name: input.name,
        data: input.data ?? {},
        ...(input.extractData === true ? { extractData: true } : {}),
        ...context,
      };
    case "document":
      // Issue #1185: `extractTitle: true` のときだけ payload に印を足す（`event` の
      // `extractData` と同じ規律）。
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
 * Issue #1063（ADR 0347）: 抽出で保存できずに落とした候補1件の記録。残った候補の `created` イベントの
 * `meta.droppedCandidates` に入る（公開の型ではない。`meta` は自由形式の欄である）。
 *
 * 🔴 **候補の本文は写さない。**落ちた理由がまさに本文（NUL・1MB 超）であることが多く、写すと
 * `created` の追記まで同じ理由で落ちる。候補は `index`（LLM が返した順の 0 起点）と `contentHash` で指す。
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

/**
 * `createMemoryWithOutbox` が投げた例外から {@link DroppedCandidate} を作る。
 *
 * 外側の `message` は使わない——drizzle の `Failed query: <SQL> params: …` は params（候補の本文）を
 * 含むので、本文を写さない規律が破れる。`cause` の連鎖の最も内側（pg のエラー文・fixture の文言）を使う。
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
 * `getMany` が返した記憶を、渡された id で引き当てるときの鍵を作る関数を返す（`forget`・`restoreArchived`・`consolidate`・`reflect`・
 * `purge`・`markContested`・`resolveContested`）。`ids` はその呼び出しに渡された id の全部。
 *
 * store が返す `Memory.id` は、渡した id と文字列として一致するとは限らない——`@mnemora/postgres` は uuid を
 * 大文字小文字を区別せずに比べ、小文字で返す（`get("…ABC…")` が `id: "…abc…"` の記憶を返す）。渡された id のまま
 * 引くと、store が「在る」と言う記憶を `not_found` にしていた（`uppercase-uuid-lookup.postgres.test.ts`）。
 * ⟹ 両側を小文字にして突き合わせる。**store へ渡す id は変えない**——在るかどうかは store の `get`/`getMany` が
 * 決め、Runtime はそれに従うだけである（大文字小文字を区別する store では、大文字の id は今どおり `not_found`）。
 *
 * ⚠ **大文字小文字だけが違う id を同じ呼び出しに混ぜたときは、その id どうしは渡された文字列どおりに突き合わせる**
 * （小文字にそろえる前と同じ）。`getMany` の戻りだけでは、「store がどちらも在ると言った」と「片方だけ在ると
 * 言った」を区別できないため。⟹ store が返す id と同じ綴りで渡した id だけが在る記憶になり、ほかの綴りは
 * `not_found` のまま残る。**並びの位置によらない**——`@mnemora/postgres` の `forget({ memoryIds: [小文字, 大文字] })`
 * でも `[大文字, 小文字]` でも、`not_found` になるのは大文字の側である。どの綴りも store の id と違えば
 * （`[先頭だけ大文字, 大文字]` など）、全部が `not_found` になる。
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
 * ⚠ **組み立ての時点では、`deps` も `deps.config` も検査しない**（今の振る舞い。
 * 2026-09-27 に Postgres と testkit の fixture の両方で当てた）。省略した欄は各欄の doc にある
 * 既定値に倒れ、足りない依存や型の外の値は、組み立てでは落ちずに最初の呼び出しで現れる:
 * - 必須の store・`hashContent` が無い: それを使う最初の呼び出しが `TypeError` を投げる
 *   （メッセージは欠けた依存の名前ではなく、呼ぼうとしたメソッドの名前を言う）。
 * - `llmProvider` が無い: 例外にならない。`observe()` の抽出は LLM の失敗と同じ扱いになり、
 *   `extraction: "llm_failed_whole_observation"` で観測の全文を1件の Memory として残す
 *   （`extractionFailure.message` に `Cannot read properties of undefined` が出る）。
 * - `embeddingProvider` が無い: `recall()` は `stage_skipped`（`embedding_provider_unavailable`）を
 *   名乗って ANN を飛ばし、`tick()` の `embed` ジョブは `failed` になる。
 * - `clock.now()` が Invalid Date を返す: 最初の書き込み・`recall()`・`tick()` が例外を投げる
 *   （Postgres は DB の例外、testkit の fixture は `RangeError` などで、文言は揃っていない）。
 * - `outputValidation` が `"off"`/`"report"`/`"throw"` のどれでもない: `"report"` と同じに振る舞う。
 * - `config.autoQueueConsolidateReflectOnExtract` が真偽値でない: 真偽として評価される
 *   （例: 文字列 `"no"` は真として扱われ、consolidate / reflect の job を積む）。
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const clock = deps.clock ?? systemClock;
  const extractorVersion = deps.config?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
  // 空文字は省略と同じに扱う（`RuntimeConfig.llmModelId`・`promptVersion` の TSDoc）。空文字のまま書くと、
  // inferred の provenance が `ProvenanceSchema`（`model`・`promptVersion` は `min(1)`）を通らなくなる。
  const llmModelId = deps.config?.llmModelId || DEFAULT_LLM_MODEL_ID;
  const promptVersion = deps.config?.promptVersion || DEFAULT_PROMPT_VERSION;
  const digestFallbackLength = deps.config?.digestFallbackLength ?? DEFAULT_DIGEST_FALLBACK_LENGTH;
  const defaultClaimedBy = deps.config?.defaultClaimedBy ?? DEFAULT_CLAIMED_BY;
  const autoQueueConsolidateReflectOnExtract =
    deps.config?.autoQueueConsolidateReflectOnExtract ?? false;

  /**
   * 抽出候補から Memory を作る核（`runExtraction` と `reextract` の共通経路）。
   * `createMemoryWithOutbox` の ON CONFLICT により冪等——同じ候補で複数回呼んでも
   * 新規行は増えない（`created: false` の場合はイベントも積まない）。
   * `contentHashes` は `reextract` が「今回作られた集合」を判定するために使う。
   */
  /**
   * 候補から `NewMemory` を組み立てるだけ（**書き込まない**）。
   *
   * Issue #134 / ADR 0100 で切り出した。`reextract` は「今回作る content_hash の集合」を
   * supersede 判定（`classifyReextractTargets`）に渡す必要があり、かつ ADR 0100 の
   * `supersedeWithNewMemories` は**作成と supersede を1回の呼び出しで**受け取る——
   * ⟹ 作成より前に content_hash を知る必要がある。組み立てと書き込みを分けないと、
   * この2つを同時に満たせない。
   */
  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと1・3・5・12:
   * Memory 書き込み側（抽出・consolidate 手順6・reflect 手順7）が共通して要る、
   * 活動時計の入力のうち **subject に依らない部分**（`T` と `halfLifeRecalls`）。
   *
   * **`decay_clock === 'wall'` のテナントでは `tenant_activity` を一度も読まない**
   * ——`undefined` を返し、`activityClockInputsFor` は `{}` を返す。`activitySeq`/`halfLifeRecalls` は
   * `undefined` のまま `buildNewMemoryFromCandidate` 等へ渡る。これらの関数は両方揃っているときだけ
   * 活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）を作る
   * （`extraction.ts` の doc 参照）ので、`'wall'` のテナントで作られる Memory は
   * 本 ADR の前後で1バイトも変わらない。
   *
   * ⚠ **これは 0163 の話であり、tick が consolidate/reflect を駆動する ADR 0157 とは無関係**
   * ——ここで読むのは `decay_clock`/`activity_seq` だけで、tick のスケジューリングには触れない。
   *
   * ⭐ [ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)
   * （ADR 0353 の負債1の解消）: 「いま」の `S_x` は、ここでは足さない。`x` は**これから作る
   * Memory 自身の `subjectId`**であって `ctx.subjectId` ではない（`tick` の ctx には通常
   * `subjectId` が無く、抽出は候補ごとに `subjectId` が違いうる）。各 Memory の `subjectId` が
   * 決まった後で、`readActivitySeqForSubjects` が distinct な subject の `S_x` をまとめて引き、
   * `activityClockInputsFor` が Memory ごとに `T + S_x` を組む。
   *
   * 🔴 **まだ残っている負債**（ADR 0394「引き受けた負債」）: 書く側の subject の取り違えは直したが、
   * 次の3つは**変えていない**（オーナーに問い合わせ中）——(1) 保守の操作（consolidate・reflect・
   * `sweepArchive` 等）の中の `recall()` が活動時計を進めること、(2) `tick` の自動ジョブに
   * `activityCounting` を届けないこと、(3) recall 側の前進が `T` か `S_ctx` か。
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
   * ADR 0394: 渡した subject（`null`/`undefined` は主題なし。読まない）のうち distinct なものの
   * `S_x`（`tenant_subject_activity.activity_seq`）を、まとめて1回で引く。
   *
   * `hasSubjectActivityCounters` が `false`（`tenant_subject_activity` に行が1本も無い、または
   * 未実装）のテナントでは**何も引かない**——`S_x` はどの subject でも `0` で、`T` のみと同じ値になる
   * （ADR 0353 決めたこと4。段1 SQL 等と同じ規律）。
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
   * ADR 0394: 1つの Memory（`subjectId` が決まったもの）の活動時計の入力。`activitySeq` は
   * `T + S_x`（`x` = その Memory 自身の `subjectId`。主題なし・`subjectSeqs` に無い subject は
   * `T` のみ）。`base` が `undefined`（`'wall'` のテナント）なら `{}`。
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
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   * `reinforce` の呼び出し側（使用報告ループ・`restoreArchived`・`restoreSuperseded`）が共通して要る、
   * 活動時計の「いま」の解決。**`ReinforceOptions` そのものを返す。**
   *
   * `resolveActivityClockBase` と同じく `decay_clock === 'wall'` のテナントでは
   * `tenant_activity` を一度も読まない（`undefined`）。`reinforce` は Memory 単位の `halfLifeRecalls` を
   * 対象の Memory 自身から読む（store 側の実装、`ReinforceOptions.nowSeq` の doc
   * コメント参照）ので、ここでは `activitySeq`（`T`）だけを読めば足り、`default_half_life_recalls` は不要。
   *
   * ⭐ [ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)
   * （ADR 0353 の負債1の解消）: `nowSeq` には **`T` だけ**を入れ、`S_x` は足さない。
   * `reinforceMany` は同じ `opts` を全件に適用し、使用報告は subject の違う Memory を1回の呼び出しで
   * 強化しうる——呼び出し側は Memory ごとの subject を知らない（強化の前に読み直さない）ので、
   * 「Memory 自身の subject の `S_x` を足す」ことを `addOwnSubjectSeq: true` で store に頼む
   * （store が UPDATE の中で行ごとに解く）。`tenant_subject_activity` に行が無いテナント
   * （`hasSubjectActivityCounters` が `false`）では `S_x` はどの行でも `0` なので、この項目は付けない
   * （store は相関サブクエリを足さず、今日と同じ SQL のまま）。
   *
   * ⭐ **`addOwnSubjectSeq` を渡すのは、store が `MemoryStore.supportsAddOwnSubjectSeq?()` で `true` を
   * 宣言しているときだけ**（第三者 adapter の挙動を今より悪くしないため）。宣言の無い store には、
   * ADR 0394 以前と同じ `T + S_ctx` をフラグなしの `nowSeq` として渡す。
   *
   * 🔴 **引き受けた負債**: 宣言の無い store では、強化される Memory の subject が `ctx.subjectId` とずれる呼び出しで、
   * ADR 0394 以前と同じ取り違え（起点が `ctx` の subject の `S_x` で書かれる）が残る。直すには、その adapter が
   * `reinforce` に `addOwnSubjectSeq` を実装して宣言すること（`ReinforceOptions.addOwnSubjectSeq`・
   * `MemoryStore.supportsAddOwnSubjectSeq` の TSDoc、testkit の適合テスト）。
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
    // store が `addOwnSubjectSeq` を読めると宣言しているときだけ、`T` とフラグを渡す。
    if (deps.memoryStore.supportsAddOwnSubjectSeq?.() === true) {
      return { nowSeq, addOwnSubjectSeq: true };
    }
    // 宣言の無い store（フラグを知らない第三者 adapter）には、今までどおり `T + S_ctx`
    // （ctx の subject の `S_x`。ctx に subject が無ければ `T` のみ）をそのまま `nowSeq` として渡す。
    // 対象の subject が ctx とずれる呼び出しでは食い違う値のままだが、ADR 0394 以前より悪くならない。
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
    // Issue #371: `deriveClaimKeys` の結果（`candidates` と同じ長さ・同じ順序）。
    // 省略、または opt-in を使わなかった呼び出しでは `undefined` のまま——各候補は
    // `claimKey: null` として作られる（`buildNewMemoryFromCandidate` の既定）。
    claimKeys?: readonly (ClaimKey | null)[],
  ): Promise<NewMemory[]> {
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 活動時計の3つ組を、書き込み側3箇所のうちの1つとして
    // ここで織り込む。
    // ADR 0394: 「いま」の `S_x` の x は、候補ごとに決まる**その Memory 自身の subjectId**
    // （候補の `subjectId` → observation の `subjectId`。`ctx.subjectId` ではない）。
    // distinct な subject の `S_x` をまとめて1回で引き、候補ごとに `T + S_x` を組む。
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

  /**
   * 新しく作られた Memory の `created` イベントを組み立てる（**書かない**）。`appendCreatedEvent`
   * （別コミットで `EventStore.append`）と、`createMemoriesFromCandidates` が
   * `MemoryStore.createMemoriesWithOutboxAndEvents?` へ渡す `buildCreatedEvent`（store が同じトランザクションで
   * INSERT する）が共有する——`meta` の中身が2つの経路でずれないように、組み立てはここ1箇所に置く
   * （ADR 0410）。
   */
  function buildCreatedEventFor(
    ctx: Ctx,
    memory: Memory,
    observation: Observation,
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
    droppedCandidates: readonly DroppedCandidate[] = [],
  ): NewMemoryEvent {
    const languageMismatch =
      outcome === "llm_failed_whole_observation"
        ? null
        : detectLanguageMismatch(observationPayloadText(observation), memory.content);
    return {
      tenantId: ctx.tenantId,
      memoryId: memory.id,
      kind: "created",
      at: clock.now(),
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
        // `meta` は既存の jsonb NOT NULL 列へのキー追加のみ（マイグレーション不要）。
        // 失敗経路（outcome: "llm_failed_whole_observation"）のときだけ足す——
        // 成功経路の meta.reason: "extracted" の形は変えない。
        ...(outcome === "llm_failed_whole_observation"
          ? { failureKind: failure?.kind ?? null }
          : {}),
        // Issue #1063（ADR 0347）: 同じ抽出で保存できずに落とした候補があったときだけ足す——
        // 落とした候補が無い呼び出しの meta の形は変えない。
        ...(droppedCandidates.length > 0 ? { droppedCandidates: [...droppedCandidates] } : {}),
        // Issue #1370（ADR 0391）: 言語の事後検査。日本語の観測から、かな・漢字の無い（ラテン文字の）
        // 本文が出たときだけ足す——疑いが無い呼び出しの meta の形は変えない。**印を付けるだけ**で、
        // 再試行も書き換えもしない。全文フォールバックの本文は観測そのものなので検査しない。
        ...(languageMismatch !== null ? { languageMismatch } : {}),
      },
    };
  }

  /**
   * 新しく作られた Memory について `created` イベントを積む。
   *
   * ⚠ **このイベントは `memories` への INSERT と同一トランザクションではない**
   * （`EventStore.append` は別コミット）。**この関数を通るのは次の経路だけである**（ADR 0410・0416）:
   * - 抽出（sync／deferred）のうち、`MemoryStore.createMemoriesWithOutboxAndEvents?` を**持たない** adapter。
   *   持つ adapter は `createMemoriesFromCandidates` がその口で `created` を同じトランザクションに積む。
   * - `reextract` の、(a) 口あり経路（`supersedeWithNewMemories`）で store が `createdEventsWritten: true` を
   *   **名乗らなかった**とき（`opts.buildCreatedEvent` を知らない adapter。名乗ったら省く）、(b) 口なし経路
   *   （`createMemoryWithOutbox` のループ。直さない負債）。
   * - ⚠ `consolidate`・`reflect` は `eventStore.append` を直に呼ぶ（この関数を通らない）が、同じ形の別コミットである
   *   （ADR 0416。`consolidate` の口あり経路は名乗られたら省く、口なし経路は直さない。`reflect` は
   *   `createMemoriesWithOutboxAndEvents?` があればそれで積み、無ければ別コミット）。
   *
   * ADR 0100 が満たしたのは docs/memory-model.md §11 行5 が名指しした「旧行の更新」と「新 Memory の作成」の
   * 対であり、`created` イベントはその要求文に含まれていない——この非同時性は ADR 0100 の「守れないもの」に
   * 記録してあり、ADR 0410・0416 が口を持つ adapter の経路について直した（口を持たない adapter の経路は同じ記録のまま）。
   */
  async function appendCreatedEvent(
    ctx: Ctx,
    memory: Memory,
    observation: Observation,
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
    droppedCandidates: readonly DroppedCandidate[] = [],
  ): Promise<void> {
    await deps.eventStore.append(
      ctx,
      buildCreatedEventFor(ctx, memory, observation, outcome, failure, droppedCandidates),
    );
  }

  /**
   * Issue #372（(B) 第2段。ADR 0185 決定2・決定4、ADR 0320 の続き）: 新しく `active` に
   * なった Memory 1件について、同じ鍵の衝突を**列と索引だけで**（LLM を一度も呼ばずに）
   * 見つけ、ちょうど1件、かつその1件が `active` なら `markContested` を呼ぶ
   * （2026-09-30 の直し、ADR 0378 追記。下の手順3参照）。
   *
   * 手順:
   * 1. `memory.claimKey` が無ければ何もしない（`null` を返す——鍵が無ければ引くものが無い）。
   * 2. `deps.memoryStore.findActiveByClaimKey` が無ければ何もしない（任意メソッド。
   *    フォールバック経路は無い——`markContested` と同じ判断）。
   * 2.5. **（Issue #933 案2、ADR 0378）`deps.memoryStore.findContestedByClaimKey` が
   *    実装されていれば、同じ query で追加に呼び、`status = 'contested'` の一致も集める。**
   *    実装していない adapter では、この手順は何もせず（後方互換）、今まで通り
   *    `findActiveByClaimKey` の一致（`active` のみ）だけを使う。
   * 2.6. **（ADR 0377、Issue #835 候補1）合わせた一致（`active` + `contested`）から、
   *    `memory.sourceObservationId` と同じ `sourceObservationId` を持つものを、件数を
   *    数える前に除く。** `memory.sourceObservationId` が `null` のときは何も除かない
   *    （`null` 同士を「同じ観測」と見なさない——`null` は「分からない」であって
   *    「観測0番」ではない）。**この除外は core 側だけで行う**——`MemoryStore.
   *    findActiveByClaimKey?`/`findContestedByClaimKey?` の interface・Postgres 実装・
   *    testkit は変えない（下の doc コメント最後の段落、ADR 0377・ADR 0378 参照）。
   * 3. 残った一致件数と、その `status` で分岐する（ADR 0324 決定5・決定6 が定めた
   *    分岐そのものは変えていない——手順2.5・下記2026-09-30の直しが変えるのは
   *    「何を一致として数えるか」「`markContested` へ進めてよい一致かどうか」だけである）:
   *    - **0件**: 何もしない（`{ kind: "no_conflict" }`）。
   *    - **ちょうど1件、かつその1件が `active`**: `markContested(ctx, memory.id,
   *      other.id, { reason: <構造化JSON> })` を呼ぶ。判定の根拠（鍵・重なった有効期間・
   *      両側の `contentHash`・id）を `memory_events.meta.note` に構造として載せる
   *      （問い3）。`markContested` 自身が `ineligible`/`conflict` を返すことがある
   *      （TOCTOU で、読んでから呼ぶまでの間に相手が別件で `contested`/`active` 以外に
   *      なっていた場合）——**この関数はその結果をそのまま運ぶだけで、追加の再試行や
   *      フォールバックはしない**（ADR 0134 が確立した「開く前に落とす」「上限の無い
   *      再試行ループを作らない」規律をそのまま継承する）。
   *    - **それ以外（2件以上、または、ちょうど1件だがその1件が既に `contested`）**:
   *      [#207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`、
   *      多対多）が無いと1対1の `contestedWithId` では表現できない（ADR 0185 決定5）。
   *      **`markContested` を一切呼ばない**——状態は一切動かさず、根拠（鍵・関係する各
   *      `id`/`contentHash`/有効期間・`status`・件数）を `memory_events` へ1件、構造
   *      として残すだけに留める（`kind: "updated"`、`meta.reason:
   *      "claim_key_conflict_unresolved"`——`"contested"` と紛れないよう別のタグを使う。
   *      `MemoryEventKind` という公開 union には値を足さない——`meta` はもともと自由
   *      形式である）。これにより「同じ鍵に3件以上が並んだ」件数を `memory_events` から
   *      数えられる（Issue #933 が直る前は、この分岐は `findContestedByClaimKey?` が
   *      無い限り実質到達不能だった——3件目以降は必ず `no_conflict` に落ちていた。
   *      ADR 0378 参照）。
   *
   *      ⚠ **2026-09-30 の直し（ADR 0378 追記、Issue #933 PR1 の穴埋め）**:
   *      「ちょうど1件だがその1件が既に `contested`」は、直す前は `markContested` へ
   *      進み、相手が既に `contested`（＝`active` でない）なので CAS が `ineligible` を
   *      返し、検出中の Memory は `active` のまま・`memory_events` にも痕跡が残らなかった
   *      （例: 3件目の有効期間が、既に対になった1件目・2件目のうち片方とだけ重なる場合）。
   *      **今は、一致の `status` を見てから分岐する**——`active` な1件だけが
   *      `markContested` の対象になり、`contested` な1件は（2件以上のときと同じ形で）
   *      evidence だけを積む。
   *
   * ⛔ **この関数のどこにも `superseded` への言及が無い。**`contested` までで止める
   * （ADR 0185 決定4・北極星 問い4「AI の推論と、ユーザーが言った事実を区別する」——
   * `claimKey` は LLM が作る鍵＝推論であり、推論から導いた「矛盾」でユーザーが言った
   * 事実を消してはならない）。
   *
   * ⚠ **ADR 0377（Issue #835 候補1）**: ADR 0347（PR #1318）が抽出の書き込みを
   * 「全件書く → 全件について `created`/検出」の2ループへ分けたことで、同じ observation
   * （＝同じ発話）から抽出された兄弟候補どうしが、互いの検出時点で既に `active` になって
   * いた。`rawMatches`（`findActiveByClaimKey`/`findContestedByClaimKey` の返り値を
   * 合わせたもの）は `sourceObservationId` を持つ `Memory[]` である——手順2.6 はそこから
   * 「検出中の memory と同じ observation」の行を除いてから件数を数える。**両口の契約
   * （interface の doc コメント）自体は変えていない**——除外は、この関数（呼び出し側）が
   * 返り値を使う際に行う。store 側（Postgres 実装・testkit）へ押し下げなかった理由と、
   * その限界（両口の contract に `LIMIT` の規定が無いため、この除外を core 側で行っても
   * 正しさは保てるが、interface 自体は adapter が独自に `LIMIT` を付けることを禁じて
   * いない）は ADR 0377 を見ること。
   *
   * ⚠ **ADR 0378（Issue #933 案2、PR1 の範囲）**: `findContestedByClaimKey?` を足したのは
   * このPR（PR1）の範囲であり、**`RelationStore`・多者間グループを実際に `contested` として
   * 束ねる書き込み（`markContestedGroup` 相当、ADR 0327）は範囲外**——「2件以上」の分岐は
   * 今まで通り `markContested` を呼ばず evidence を積むだけである。すでに `contested` な
   * 対（例: 1件目・2件目）は、3件目・4件目が届いても**壊れない**——この関数は一致の
   * `status`/`contestedWithId` を一切書き換えない。
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
    // Issue #933 案2（ADR 0378）: `findContestedByClaimKey?` を実装している store でだけ、
    // 既に `contested` になった相手も一致に数える。実装していない adapter では
    // `undefined` のままなので、今まで通り `active` の一致だけになる（後方互換）。
    const findContestedByClaimKey = deps.memoryStore.findContestedByClaimKey;
    const rawContestedMatches =
      findContestedByClaimKey === undefined
        ? []
        : await findContestedByClaimKey.call(deps.memoryStore, ctx, query);
    const rawMatches = [...rawActiveMatches, ...rawContestedMatches];
    // ADR 0377（Issue #835 候補1）: 同じ observation（＝同じ発話）から抽出された兄弟
    // どうしを、互いへの誤検出の相手にしない。`memory.sourceObservationId` が `null`
    // のときは何も除かない（`null` 同士を「同じ観測」と見なさない）。
    const memorySourceObservationId = memory.sourceObservationId ?? null;
    const matches =
      memorySourceObservationId === null
        ? rawMatches
        : rawMatches.filter((m) => (m.sourceObservationId ?? null) !== memorySourceObservationId);

    if (matches.length === 0) {
      return { memoryId: memory.id, claimKey, matchCount: 0, result: { kind: "no_conflict" } };
    }

    // ADR 0378: `status` も evidence に含める——一致のどれが `active` 由来・どれが
    // `findContestedByClaimKey` 由来（既に `contested`）かを、監査ログから読めるようにする
    // （北極星 問い3）。
    const describeSide = (m: Memory) => ({
      id: m.id,
      status: m.status,
      contentHash: m.contentHash,
      validFrom: m.validFrom ?? null,
      validUntil: m.validUntil ?? null,
    });

    // 2026-09-30 の直し（ADR 0378 追記、Issue #933 PR1 の穴埋め）: `markContested` へ
    // 進めてよいのは、一致がちょうど1件で、かつその1件がまだ `active` のときだけ。
    // `findContestedByClaimKey` 由来で一致がちょうど1件になっても、その1件は既に
    // `contested`（＝`active` でない）なので、直す前は `markContested` を呼んで
    // `ineligible` になり、検出中の Memory は `active` のまま痕跡も残らなかった。
    if (matches.length === 1 && matches[0]!.status === "active") {
      const other = matches[0]!;
      // 問い3: 根拠を構造として `meta.note`（`MarkContestedOptions.reason`）へ載せる。
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

    // それ以外（matches.length >= 2、または matches.length === 1 だがその1件が既に
    // `contested`）: 1対1の `contestedWithId` だけでは表せない（ADR 0185 決定5）。
    //
    // 2026-09-30 の直し（Issue #207/#933 PR2、ADR 0327、ADR 0378、ADR 0381、段階B。
    // 2026-09-30 のさらなる直し、オーナー側クローンの判断で `ClaimKeyOptions.
    // formContestedGroups` フラグを廃止し、`deps.relationStore` の配線を条件にした）:
    // `deps.relationStore` が配線されており、かつ `deps.memoryStore.markContestedGroup`
    // も配線されていれば、evidence だけに留めず実際に群として書き込みを試みる——
    // `deps.memoryStore.markContestedGroup` が在るだけでは群を作らない（`relationStore`
    // が無いと、後述の穴A吸収・合併の判定に使う `listRelated` そのものが呼べないため）。
    // **`deps.relationStore` を配線しない呼び出しでは、この分岐は1ビットも変わらない**
    // ——Issue #933 PR1（ADR 0378）が確立した evidence-only の挙動のままになる
    // （PR1 の歯を1つも書き換えていない理由。PR1 の歯は `relationStore` を一度も
    // 配線していないため、影響を受けない）。群のメンバーを次の順で広げる:
    //   1. 種——検出中の `memory` 自身と、`matches` の全員。
    //   2. 穴A（既存の2者間の対の吸収）——`matches` のうち `status === 'contested'` かつ
    //      `contestedWithId !== null` なものは、その相手（`contestedWithId` が指す id）も
    //      群に加える。相方自身は claim key の一致条件（有効期間の重なり等）を満たさない
    //      ことがあるため、`matches` に現れないことがある——`contestedWithId` を直接
    //      辿ることでその欠けを埋める。
    //   3. 合併（複数の既存群の統合）——`deps.relationStore` が配線されていれば、ここまでの
    //      メンバーのうち `status === 'contested'` な id から `kind: 'contradicts'` を
    //      辿って到達できる id をすべて候補に加える（BFS）。**候補は `getMany` で読み直し、
    //      `status === 'contested'` のものだけを実際に群へ加える**——decision10（forget 等で
    //      群を離れたメンバーの関係の行は残す）により、BFS は既に群を離れた id も拾い
    //      うるため、そのまま加えると `markContestedGroup` の CAS 全体が
    //      `status_conflict` で落ちてしまう（`resolveContestedGroup` の fix2 と同じ
    //      「行の有無ではなく status で今の群を判定する」規律）。resolve 済みの群は関係の
    //      行を削除している（`resolveContestedGroup` 契約）ので、ここで見つかるのは今も
    //      現存する群だけである。`matches` が2つの既存群それぞれのメンバーを1件ずつ
    //      含んでいた場合、両方の群の全メンバーがここで合流し、1つの群になる。
    // 広げた結果が3件未満（`markContestedGroup` の最小人数を満たさない——例:
    // `relationStore` が配線されておらず、既存群の残りのメンバーを辿れない場合）のときは
    // 呼ばない。`markContestedGroup` を呼んで `outcome.kind !== "contested_group"`
    // （`ineligible`/`conflict`。TOCTOU 等）になった場合も含め、どちらも今まで通りの
    // evidence-only の `memory_events` 追記 + `unresolved_conflict` へフォールバックする
    // ——状態が動かなかった呼び出しで、根拠だけは必ず残す（ADR 0378 決定5の踏襲）。
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
        // 幅優先を1段ずつ進める。1段ぶんは `listRelatedMany?` があれば1往復（Issue #1449、ADR 0402）、
        // 無ければ今までどおり起点ごとに直列。処理する順（= 先入れ先出しの queue と同じ）は変わらない。
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
        const note = JSON.stringify({
          kind: "claim_key_conflict_group",
          claimKey,
          subjectId: memory.subjectId ?? null,
          triggering: describeSide(memory),
          matches: matches.map(describeSide),
          matchCount: matches.length,
          memberIds,
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

    // markContestedGroup を呼ばなかった（配線されていない／群が3件未満にしか広がらな
    // かった）、または呼んだが `contested_group` にならなかった: 今まで通り
    // markContested を呼ばず、根拠だけを memory_events に残す。
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
          matches: matches.map(describeSide),
          matchCount: matches.length,
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
    // Issue #204 / ADR 0157: 既定 `["embed"]` のみ。opt-in（config.autoQueueConsolidateReflectOnExtract）
    // が true のときだけ、同じ memoryId を種にした consolidate/reflect ジョブも積む——
    // `createMemoryWithOutbox` は jobKinds の各要素に同じ payload `{ memoryId }` を使うので、
    // 新しい payload 形を発明する必要がない（下の processConsolidateJob/processReflectJob 参照）。
    const jobKinds: OutboxJobKind[] = autoQueueConsolidateReflectOnExtract
      ? ["embed", "consolidate", "reflect"]
      : ["embed"];
    // Issue #1063（ADR 0347）: 保存できない候補（store が拒む値——本文の NUL など。Postgres の tsvector の上限は migration 0025 で拒まなくなった、#1222）は、
    // その候補だけを落として残りを書く。core は「保存できない値」と一時的な障害を見分けられず、上限も adapter の
    // 都合なので事前には検査できない——`createMemoryWithOutbox` が投げたことだけを根拠にする。
    // ⚠ 捕まえるのは `createMemoryWithOutbox` だけ。書けた後の `created` の追記・衝突の検出の失敗は今どおり投げる。
    // 🔴 全件が落ちたら、最初の例外をそのまま投げる（今も例外になる入力であり、例外の集合は増えない。
    // 店が丸ごと落ちている一時的な障害も、今どおり例外で伝わる）。
    // 落とした候補は、残った候補の `created` の `meta.droppedCandidates` に残す。そのために、候補を全件
    // 書いてから `created` を積む（落とした候補は、全件を書き終えるまで分からない）。
    // ADR 0410（穴 D-3）: store が `createMemoriesWithOutboxAndEvents?` を持つなら、全候補の書き込みと `created` の
    // 追記を1つのトランザクションに任せる。**口が在るかどうかだけで選ぶ**——撃って投げられたときに、下の旧経路で
    // 撃ち直さない（二重に書きうる。ADR 0100 の `supersedeWithNewMemories` と同じ規律）。
    // 落とした候補の記述（`describeDroppedCandidate`）は core が作り、store は落とした候補の例外を返すだけ。
    // Issue #1237: この呼び出し全体で1回だけ読む——同じ observation から作る候補すべてに
    // 同じ outbox の `now` を使う（`consolidate`/`reflect` と同じ規律）。
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
          ),
        { now: outboxNow },
      );
      for (const { memory, created } of batch.written) {
        memoryIds.push(memory.id);
        // Issue #372: 冪等な再送（`created === false`）では走らせない（下の旧経路と同じ）。
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
        await appendCreatedEvent(ctx, memory, observation, outcome, failure, dropped);
        // Issue #372: 書き込み時（新しい Memory が active になる時点）の延長として、
        // opt-in のときだけ検出を走らせる。**冪等な再送（`created === false`）では
        // 走らせない**——「新しく active になった」わけではないため。
        if (detectContested === true) {
          const outcomeForMemory = await detectClaimKeyContested(ctx, memory);
          if (outcomeForMemory !== null) {
            contestedDetection.push(outcomeForMemory);
          }
        }
      }
      // embed/consolidate/reflect ジョブは常に outbox 経由（非同期、docs/memory-model.md §11 行3）。
      // ここでは何もしない — tick() の各 processXxxJob が処理する。
    }
    return { memoryIds, contentHashes, contestedDetection };
  }

  /**
   * Issue #691続き（ADR 0326「採らなかった案B」の実装、ADR 0329）:
   * `ClaimKeyOptions.knownPredicates`（呼び出し側が明示的に渡した語彙）と
   * `ClaimKeyOptions.knownPredicatesFromStore`（store から動的に集める語彙）を合成する。
   *
   * - `knownPredicatesFromStore` が偽（省略/`false`）、または
   *   `deps.memoryStore.listActiveClaimPredicates` が無い adapter では、
   *   `claimKeyOptions.knownPredicates` をそのまま返す（**store を一度も読まない**——
   *   opt-in していない呼び出しで既存の挙動を1バイトも変えないため）。
   * - それ以外は `listActiveClaimPredicates` を1回呼び、**利用者の `knownPredicates` を
   *   先に**、集めた一覧を**後ろに重複を除いて**連結する（ADR 0329 決定2）。
   *   `subjectId` は `observation.subjectId ?? null`——1回の `observe()` 呼び出しが
   *   持つ唯一の subjectId であり、候補ごとの `subjectId` 上書き（ADR 0271）は
   *   `deriveClaimKeys` 呼び出しより後（`buildNewMemoryFromCandidate`）にしか
   *   確定しないため、ここでは観測全体の既定値を使う（ADR 0329 決定3、確かめていないこと
   *   参照）。
   * - 合成の結果、一覧が空（利用者も渡さず、store にも1件も無い）なら `undefined` を返す
   *   ——`deriveClaimKeys`/`buildClaimKeyPrompt` の「空配列＝渡していない」規約
   *   （`buildKnownPredicateInstruction` の呼び出し条件）に合わせる。
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
   * Issue #372負債6（ADR 0324「real-fixture 実測で、誤検出（30%）のほぼ全量が claim key
   * の `subject` 誤帰属だと分かった」）への対処、ADR 0334: `deriveClaimKeys` へ渡す
   * `knownSubjects` を決める。
   *
   * **`ClaimKeyOptions.knownSubjects`（呼び出し側が明示的に渡した語彙）だけを見る。**
   * `subjectCandidates`（Issue #608 項目②(b)、この observe() 呼び出しに渡された抽出用の
   * 主題候補一覧）への暗黙の転用は行わない——ADR 0334 追記（2026-09-26）参照。
   *
   * ⚠ **当初案は `knownSubjects` 省略時に `subjectCandidates` を既定値として転用して
   * いたが、取り下げた。** `claimKey.enabled: true` と `subjectCandidates` を既存で
   * 併用している呼び出し側が、この opt-in（`knownSubjects`）を一切選んでいないのに
   * claim key プロンプト・カセット鍵が動いてしまう——「off のときのプロンプトは1バイトも
   * 変えない」（`buildClaimKeyPrompt` の doc コメント）に反する。`subjectCandidates` を
   * ヒントに転用したい呼び出し側は、同じ配列を明示的に `claimKeyOptions.knownSubjects`
   * へ渡すこと。
   *
   * ⚠ **store から動的に集める版（`knownPredicatesFromStore` の対）は意図的に実装して
   * いない**（ADR 0334「採らなかった案」）。store が自己蓄積した `claim_key_subject` の
   * 値（LLM が自由記述で作った曖昧な値になりがち）を汎用語彙として横流しすると、
   * 無関係な話題の主張にまでその値が誤って使い回される汚染を実測で確認したため
   * （`claim-key.ts` の `ClaimKeyOptions.knownSubjects` doc コメント参照）。
   */
  function resolveKnownSubjects(claimKeyOptions: ClaimKeyOptions): string[] | undefined {
    if (claimKeyOptions.knownSubjects !== undefined && claimKeyOptions.knownSubjects.length > 0) {
      return claimKeyOptions.knownSubjects;
    }
    return undefined;
  }

  /**
   * 1件の Observation に対して抽出を実行し、作られた（または冪等に既存の）Memory の id を返す。
   *
   * `subjectCandidates`（Issue #608 項目②(b)）は `handleExtractableObservation` の sync
   * 経路からだけ渡る——`processExtractJob`（deferred 側）は渡さない。渡す先が無いのは
   * 「保存していないから」であって「対応していないから」ではない（`SubjectCandidatesInput`
   * の doc コメント、observation.ts 参照）。`reextract` も同じ理由でこの引数を使わない。
   *
   * `claimKeyOptions`（Issue #371）も同じ理由で sync 経路からだけ渡る。**既定は無効**
   * ——`claimKeyOptions` が `undefined`、または `{ enabled: false }` なら
   * `deriveClaimKeys`（claim-key.ts）は一度も呼ばれない。抽出プロンプト（`extraction.ts`）
   * は一切変更しない——`extractCandidates` の呼び出しはこの関数の変更前と1バイトも
   * 変わっていない（ADR 0315 決定1・決定2）。
   *
   * `signal`（Issue #1200、ADR 0359）は `extractCandidates`・`deriveClaimKeys` の両方へ
   * そのまま渡す。abort されたときの例外は、どちらの呼び出しも `createMemoriesFromCandidates`
   * （書き込み）より前で投げるため、この関数の呼び出し側（`handleExtractableObservation`・
   * `processExtractJob`）はまだ何も書いていない状態でその例外を受け取る。
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
      candidates,
      usedWholeObservationFallback,
      failure,
      rejectedSubjectIds: rawRejectedSubjectIds,
    } = await extractCandidates(deps.llmProvider, ctx, observation, subjectCandidates, signal);
    // `ExtractCandidatesResult.rejectedSubjectIds` は型としては optional
    // （`docs/decisions/0178-public-api-surface-gate.md` 対応。extraction.ts の doc
    // コメント参照）だが、`extractCandidates` の両方の経路が必ず値を埋めるため、
    // 実際には常に配列——ここでの `?? []` は型を合わせるためだけの防御。
    const rejectedSubjectIds = rawRejectedSubjectIds ?? [];
    const outcome: ExtractionOutcome = usedWholeObservationFallback
      ? "llm_failed_whole_observation"
      : "ok";
    if (candidates.length === 0) {
      // ADR 0315 決定2「候補が0件なら+0回にできる」: ここで早期 return するため、
      // `deriveClaimKeys` の呼び出しにすら到達しない。Issue #372 の検出も同じ理由で
      // 候補が無ければ何も走らない（鍵が付いた Memory が1件も作られないため）。
      return {
        memoryIds: [],
        outcome,
        failure,
        rejectedSubjectIds,
        claimKeyFailure: null,
        contestedDetection: [],
      };
    }
    // Issue #371: opt-in のときだけ、候補群の content をまとめて claim key を取る
    // 別の構造化呼び出しを1回行う（ADR 0315 決定2 の (ii) separate）。
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
    // Issue #372: `enabled: true` と組み合わせたときだけ意味を持つ（`ClaimKeyOptions.
    // detectContested` の doc コメント参照）。`enabled` が false/省略なら `claimKeys` が
    // 無いため、`createMemoriesFromCandidates` 内で各 Memory の `claimKey` は常に `null`
    // になり、検出は呼ばれても何も見つけようがない（`detectClaimKeyContested` の
    // 早期 return）。
    const { memoryIds, contestedDetection } = await createMemoriesFromCandidates(
      ctx,
      observation,
      candidates,
      outcome,
      failure,
      claimKeys,
      claimKeyOptions?.detectContested === true,
    );
    return { memoryIds, outcome, failure, rejectedSubjectIds, claimKeyFailure, contestedDetection };
  }

  /**
   * ADR 0028: `observe()` が LLM 障害で全文フォールバックへ倒れた（または単に古い抽出器版で
   * 作られた）Observation に対して、抽出をやり直す。
   *
   * 🔴 安全弁1: LLM がまた失敗したら（`usedWholeObservationFallback`）、何も supersede せずに
   * 返す。失敗を根拠に既存の記憶を置き換えない。
   * 🔴 安全弁2: 候補が0件なら、何も supersede しない。「何も記憶に値しない」という正常な
   * 抽出結果を根拠に既存を消さない（`superseded_by_id` の指す先も無い）。
   * 🔴 安全弁3（ADR 0030）: `classifyReextractTargets` が「今回作る前」に読んだ時点で
   * `active` だった Memory でも、実際に書きに行くまでの間（TOCTOU の窓）に別の書き込みで
   * status が変わっていることがある。`updateStatus` を `expectedStatus: "active"` の
   * compare-and-swap で呼び、弾かれたら `classifySupersedeFailure` で判定して `skipped` に
   * 積む（`supersededMemoryIds` には入れず、`superseded` イベントも積まない）。
   *
   * supersede 対象は、同じ `(sourceObservationId, extractorVersion)` を持つ既存 Memory のうち
   * **`status: 'active'`** かつ今回作られた content_hash の集合に含まれないものだけ。
   * `forgotten`（利用者が意図して忘れさせた）は絶対に含めない。`contested` も対象外にする
   * ——contested は対向 Memory との対で初めて意味を持つ契約（mandatory companion retrieval）を
   * 持つため、機構都合の reextract がその対の片方だけを動かすと契約を壊しかねない
   * （ADR 0028「確かめていないこと」参照）。
   */
  /**
   * Issue #1079・#1149・[#1432](https://github.com/takecchi/mnemora/issues/1432): その
   * Observation から作られた記憶のうち、利用者の意思で退けたものを返す。**`extractorVersion` を
   * 問わない**（[ADR 0380](../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)、
   * 2026-09-30）——`extractorVersion` を上げた runtime インスタンスで reextract しても、前の版で
   * forget・contest した記憶を見落とさないようにするため。数えるのは `forgotten`（purge を含む）・
   * `contested`（利用者の訂正でも、claimKey の自動検出でも）・訂正の解決で負けた `superseded`
   * （最新の `superseded` イベントの `meta.reason` が `"contested_resolved"`）。機構
   * （reextract・consolidate）で置き換えた `superseded` と、理由を読めない `superseded`
   * （イベントが無い・保持期間の掃除で消えた）は数えない——やり直せなくなるほうが、利用者に
   * 見えにくい失敗になるため。
   *
   * ⚠ **2026-09-30 変更（Issue #1432・ADR 0380）: 以前は `listBySourceObservation(ctx,
   * observationId, extractorVersion)` を使い、今の runtime の `extractorVersion` に一致する
   * Memory しか見ていなかった。** 前の版で forget・contest した記憶は見えず、`extractorVersion`
   * を上げて reextract すると、退けたはずの内容が印の無い新しい `active` として書き直されて
   * いた（実測、Fake・Postgres 双方、Issue #1432 本文）。いまは
   * {@link MemoryStore.listBySourceObservationAllVersions} を使い、版を問わず退けたものを見る。
   * **帰結**: 版を跨いでも、1件でも退けたものがあれば、その Observation の抽出全体を打ち切る
   * （同じ版のときと同じ規律）——版を上げても、退けたものを含む Observation は新しい版の記憶を
   * 1件も作らない。⟹ 運用側が旧い版の記憶を退役させる（forget する）と、その Observation の
   * ほかの事実も、以後 reextract では想起から作られなくなる。**版を跨いだ `active` の扱い
   * （#873「運用側の責務」）は変えていない**——退けたものが無い Observation では、今どおり
   * 新しい版で抽出され、旧い版の `active` は supersede されない。
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

  async function reextract(
    ctx: Ctx,
    observationId: ObservationId,
    opts?: AbortOptions,
  ): Promise<ReextractResult> {
    // Issue #1237: この呼び出し全体で1回だけ読む（`consolidate`/`reflect` と同じ規律——
    // 積む `superseded`/`created` イベントの `at` と、`createMemoryWithOutbox` の
    // outbox 行にすべて同じ値を使う）。
    const now = clock.now();
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.reextract: observation not found: ${observationId}`);
    }
    // Issue #1099: 使用報告（`kind: "usage"`）は抽出器を通らない（docs/memory-model.md §2・§6）。
    // 抽出をやり直す対象ではないので、存在しない Observation と同じく、LLM も書き込みも
    // 試みる前に落とす。以前は payload の JSON を LLM に送り、それを本文とする Memory を作っていた。
    if (observation.kind === observeInputKindToObservationKind("memory_usage")) {
      throw new Error(
        `runtime.reextract: observation ${observationId} is a usage report (kind: "usage") and is never extracted`,
      );
    }

    // Issue #1079・#1149: 利用者の意思で退けた記憶が1件でも在れば、抽出をやり直さない（observe の再送の
    // #897 と同じ規律）。やり直すと、LLM の言い方しだいで退けた事実が印の無い `active` として戻るため。
    // LLM を呼ぶ前に確かめ、何も書かない。
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

    const { candidates, usedWholeObservationFallback, failure } = await extractCandidates(
      deps.llmProvider,
      ctx,
      observation,
      undefined,
      opts?.signal,
    );

    if (usedWholeObservationFallback) {
      // ADR 0029: この早期 return は `listBySourceObservation` を呼ぶ前に return する——
      // つまり既存 Memory を「見ていない」。`skipped: []`（既定値の顔）にすると
      // 「何も飛ばさなかった」と嘘をつくことになるため、`not_examined` を明示する。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "llm_failed_whole_observation" }],
        // 安全弁1 で早期 return——書き込みを1件も試みていない。
        atomicity: "not_attempted",
        extraction: "llm_failed_whole_observation",
        extractionFailure: failure,
      };
    }
    if (candidates.length === 0) {
      // ADR 0029: 同じ理由でここも `listBySourceObservation` の前——既存を見ていない。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "no_candidates" }],
        // 安全弁2 で早期 return——書き込みを1件も試みていない。
        atomicity: "not_attempted",
        extraction: "ok",
        extractionFailure: null,
      };
    }

    // Issue #1226 と同じ穴（ADR 0406）: LLM を待つ間に、この Observation から出た記憶が `forget`
    // （`purge` を含む）されても、上の退けた記憶の確認（LLM の前）は古いままである。LLM が
    // 返った直後・書く前に、LLM の前に見えていた記憶を読み直し、1件でも forgotten なら
    // 何も書かずに打ち切る（`consolidate`/`reflect` の「書く直前の読み直し」と同じ作法）。
    // 戻り値は、退けた記憶を持つ Observation の早期 return と同じ形（公開の型は増やさない）。
    // `abortIfForgotten` を実装しない adapter（InMemory・core の fake）では、この読み直しだけが
    // 保護になる。実装する adapter（`@mnemora/postgres`）は、下の書き込み自身が同一
    // トランザクションの `SELECT … FOR UPDATE` で、この読み直しと書き込みの間の窓も閉じる。
    const knownMemoryIds = existingAllVersions.map((memory) => memory.id);
    const abortedSourceForgotten = (forgottenIds: readonly MemoryId[]): ReextractResult => ({
      observationId,
      memoryIds: [],
      supersededMemoryIds: [],
      skipped: forgottenIds.map((memoryId) => ({
        kind: "status_not_active" as const,
        memoryId,
        status: "forgotten" as const,
      })),
      atomicity: "not_attempted",
      extraction: "skipped",
      extractionFailure: null,
    });
    if (knownMemoryIds.length > 0) {
      const rechecked = await deps.memoryStore.getMany(ctx, knownMemoryIds);
      const forgottenNow = rechecked.filter((memory) => memory.status === "forgotten");
      if (forgottenNow.length > 0) {
        return abortedSourceForgotten(forgottenNow.map((memory) => memory.id));
      }
    }

    // supersede 判定は「今回作る前」の既存 Memory を基準にする——これから作る Memory 自身が
    // 混ざって「今回作ったものを今回 supersede する」という自己矛盾を起こさないため。
    const existingBefore = await deps.memoryStore.listBySourceObservation(
      ctx,
      observationId,
      extractorVersion,
    );

    // ADR 0100: content_hash は**作る前**に分かる（`buildNewMemoriesForCandidates` は
    // 書き込まない）——`supersedeWithNewMemories` が「作成と supersede を1回の呼び出しで」
    // 受け取るには、supersede 判定を作成より前に済ませておく必要がある。
    const newMemories = await buildNewMemoriesForCandidates(ctx, observation, candidates);
    const contentHashes = new Set(newMemories.map((m) => m.contentHash));

    // ADR 0029: 判定そのものは純関数（`classifyReextractTargets`）に切り出してある——
    // ここでは判定結果（`toSupersede`・`skipped`）を受け取って I/O するだけ。
    // supersede する対象・順序・イベントの中身は ADR 0028 からミリも変えていない。
    const { toSupersede, skipped } = classifyReextractTargets(existingBefore, contentHashes);

    // `supersededById` を省略すると `meta` からその欄を落とす——ADR 0100 の口を使う経路では
    // アンカーの id が呼び出し前に存在しないため、store が解決した id で埋める契約になって
    // いる（`MemoryStore.supersedeWithNewMemories` の doc 参照）。⟹ 監査ログの中身は
    // 口が在る adapter と無い adapter で**同一**になる。⛔ 同じ論理操作が adapter ごとに
    // 別の監査記録を残す形にはしない。
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

    // ------------------------------------------------------------------
    // ADR 0100: 口が在れば、作成と supersede を1トランザクションで撃つ。
    // 🔴 フォールバックは**口の不在に対してだけ**（書き込みの前に1度判定する）。
    // ⛔ 撃って投げられたときに今日の経路で撃ち直さない——それをすると
    // 「トランザクションを張れなかった」と「張ったが失敗した」が呼び手から
    // 区別できなくなる（Issue #134 が潰すなと명示した破れ）。
    // ------------------------------------------------------------------
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      // `supersededByIndex: 0` は「この呼び出しの news[0]」——今日の
      // `const supersededById = memoryIds[0]!` と同じ対象を指す（ADR 0028 の
      // 「今回作った Memory の1件」）。
      let result: Awaited<ReturnType<typeof supersedeWithNewMemories>>;
      try {
        result = await supersedeWithNewMemories.call(
          deps.memoryStore,
          ctx,
          newMemories.map((input) => ({ input, jobKinds: ["embed"] as OutboxJobKind[] })),
          toSupersede.map((existing) => ({
            id: existing.id,
            supersededByIndex: 0,
            expectedStatus: "active" as MemoryStatus,
            // `meta.supersededById` は store が解決した id で埋める（上のコメント参照）。
            event: buildSupersedeEventFor(existing),
          })),
          // ADR 0406: 書き込みと同一トランザクションでの見直し（実装する adapter だけ）。
          // ADR 0416（穴 D-3 の続き）: `created` も同じトランザクションで積ませる（実装する adapter だけ。
          // 積んだかどうかは戻り値の `createdEventsWritten` で判断する——下を見ること）。
          {
            now,
            abortIfForgotten: knownMemoryIds,
            buildCreatedEvent: (memory) =>
              buildCreatedEventFor(ctx, memory, observation, "ok", null),
          },
        );
      } catch (error) {
        if (isSourceMemoryForgottenError(error)) {
          // 作成も supersede も rollback された——書き込みを試みていないのと区別が付かない。
          return abortedSourceForgotten(error.forgottenIds);
        }
        throw error;
      }

      const memoryIds = result.created.map((c) => c.memory.id);
      // ADR 0416: store が `createdEventsWritten: true` と**名乗ったときだけ**別の append を省く。名乗らない
      // adapter（`opts.buildCreatedEvent` を黙って無視する既存の第三者の実装）では、今までどおり別の文で積む——
      // 引数を渡したことだけで「積まれた」と決めると、そういう adapter で `created` がまるごと消える。
      // ⛔ 投げられたときに撃ち直さない（上の `catch` は投げ直すだけ。ADR 0100）。
      if (result.createdEventsWritten !== true) {
        for (const { memory, created } of result.created) {
          if (created) {
            await appendCreatedEvent(ctx, memory, observation, "ok", null);
          }
        }
      }

      // CAS に弾かれた対象は**既存の語彙**へ写す（⛔ `ReextractSkip` に新しい kind を
      // 足さない。exhaustive switch を持つ第三者を壊しうる）。
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

    // 口が無い adapter——今日どおりの2段（作成 → supersede ループ）。
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
          if (memoryIds.length === 0) return abortedSourceForgotten(error.forgottenIds);
          // 2件目以降で打ち切られた（この経路は1件ずつ書くため、1件目は既にコミット済み）。
          // 書いた分は隠さず返し、既存の supersede には進まない。
          return {
            ...abortedSourceForgotten(error.forgottenIds),
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
        await appendCreatedEvent(ctx, memory, observation, "ok", null);
      }
    }
    // `candidates.length === 0` を上で早期リターンしている以上 `memoryIds` は非空
    // ——ここは構造的に保証されている（防御的な二重チェックをあえて置かない。
    // ADR 0028「変異A」参照）。
    const supersededById = memoryIds[0]!;

    const supersededMemoryIds: MemoryId[] = [];
    for (const existing of toSupersede) {
      try {
        // 🔴 安全弁3（ADR 0030）: 読んだ時点で active だったからといって、書きに来た今この
        // 瞬間も active だとは限らない（TOCTOU）。`expectedStatus: "active"` の
        // compare-and-swap で「読んでから書くまでの間に status が変わった」ケースを
        // 検知不能なまま通さない。
        //
        // ADR 0031: status の更新と `superseded` イベントの追記を1トランザクションで行う。
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
          // 競合以外の例外——飲み込まずそのまま投げる（classifySupersedeFailure の doc 参照）。
          throw error;
        }
        // CAS に弾かれた——supersededMemoryIds に入れず、superseded イベントも積まない
        // （積むと「置き換えた」という監査ログが嘘になる）。
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
   * Issue #870: `externalId` を渡した場合、`createObservation` の冪等性
   * （docs/architecture.md §3.5、`(tenant_id, external_id)` の一意制約）が `observations`
   * 行にもそのまま効く。**その上で、以下2点を守る**:
   *
   * 1. **`recordUsage`/`reinforce` は、返ってきた（保存済みの）Observation の payload で
   *    呼ぶ**——`input` の値ではない。初回はこの2つは同じ値。再送では、最初の呼び出しが
   *    `createObservation` の後・`recordUsage` の前で落ちていた場合でも、保存済みの
   *    payload を読み直すことで `recordUsage`/`reinforce` を完了させられる。同じ
   *    `externalId` で違う payload（`recallId`/`usedMemoryIds`）が来た場合、後着の
   *    payload は無視される——他 kind の冪等な再送（`handleExtractableObservation` の
   *    `!created` 分岐）と同じ規約。
   * 2. **返ってきた Observation の `kind` が `usage` 以外**（別 kind の Observation と
   *    `externalId` が衝突した場合）**なら、`recordUsage`/`reinforce` を呼ばない**——
   *    payload の形が `{ recallId, usedMemoryIds }` である保証が無いため。他 kind の
   *    冪等な再送と同じ形（`memoryIds: []`、`extraction: 'skipped'`）で返す。
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

    // ADR 0009・docs/memory-model.md §6: 使用報告は抽出器を通らず recall_usages へ直接反映される。
    // 上の doc コメント1: 保存済みの Observation の payload を読み直して使う。
    const storedPayload = UsageObservationPayloadSchema.parse(observation.payload);
    const reinforcedAt = clock.now();
    // ADR 0165 決めたこと16: 'wall' 以外のテナントでは活動時計の「いま」も一緒に渡し、
    // decayBaseSeq/decayFloorSeq を同じ強化イベントとして進める。
    const reinforceOpts = await resolveReinforceOptions(ctx);
    // ⚠ `insertedMemoryIds` の status は確かめない——`MemoryStore.reinforce`/
    // `MemoryStore.reinforceMany` の doc コメント（Issue #840）が、status を絞らない
    // ことの帰結を status ごとに明記している。
    //
    // [Issue #961](https://github.com/takecchi/mnemora/issues/961): 使用の記録と強化を
    // 別々にコミットすると、その間で落ちたとき記録だけが残り、同じ `externalId` の再送では
    // `recordUsage` が `insertedMemoryIds: []` を返すため強化が二度と呼ばれない。
    // `MemoryStore.recordUsageAndReinforce`（任意メソッド）が在れば、両方を1トランザクション
    // で撃つ——強化が失敗すれば記録も巻き戻るので、再送がそのまま両方をやり直す。
    // 無い adapter では下の従来の2段のまま（その窓は残る。ADR 0009 の 2026-09-27 追記）。
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
    // [Issue #874](https://github.com/takecchi/mnemora/issues/874): `reinforce` を
    // `insertedMemoryIds` の件数だけ直列に呼ぶと、使用報告1件ごとに往復数が線形に
    // 増える（N+1）。`MemoryStore.reinforceMany`（任意メソッド、`archiveDecayed` と
    // 同じ「口が在るかどうかで分岐する」作法）が在ればそれを1回呼んで束ね、無ければ
    // 従来どおり1件ずつのループへ戻る——`reinforceMany` を実装しない adapter の挙動は
    // 1バイトも変えない。`insertedMemoryIds` が空なら（従来のループも0回だったのと
    // 同じく）どちらの経路も呼ばない。
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

  /** ADR 0407: sync の observe が積んだ extract ジョブを持つ間の `claimedBy`。 */
  const SYNC_OBSERVE_CLAIMED_BY = "runtime.observe:sync";

  async function handleExtractableObservation(
    ctx: Ctx,
    input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
    signal?: AbortSignal,
  ): Promise<ObserveResult> {
    const kind = observeInputKindToObservationKind(input.kind);
    const payload = extractObservationPayload(input);
    const extractMode = input.extract ?? "sync";
    // Issue #1237: `recordedAt` と outbox 行の `now` に同じ値を使う。
    const now = clock.now();

    const newObservation: NewObservation = {
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? ctx.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind,
      payload,
      occurredAt: input.occurredAt ?? null,
      recordedAt: now,
      // Issue #280: `occurredAt` と同じ経路（`Observation.validFrom`/`validUntil` の
      // doc コメント参照。deferred 抽出でも値が残るよう Observation に持たせる）。
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      // Issue #152（ADR 0312）: 同じ経路。runtime は常に `{}` 以上の値を書く
      // （`Observation.attributes` の doc コメント参照）。
      attributes: input.attributes ?? {},
    };

    const { observation, created, jobs } = await deps.memoryStore.createObservationWithOutbox(
      ctx,
      newObservation,
      ["extract"],
      // ADR 0407: sync のときだけ、observe 自身が LLM を待つあいだ tick に取られないよう、
      // 「observe が claim 済み」の状態で積む（deferred は tick に渡すためのジョブなので従来どおり）。
      extractMode === "sync" ? { now, claimedBy: SYNC_OBSERVE_CLAIMED_BY } : { now },
    );

    if (!created) {
      // 冪等な再送（docs/architecture.md §3.5）。extract ジョブは積まれておらず、
      // sync/deferred のどちらであっても、ここで新たに抽出をやり直す必要はない
      // （最初の呼び出しで既に処理済みのはず）。
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
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

    // extract: 'sync' — その場で抽出する（docs/architecture.md §3.2）。
    // Issue #608 項目②(b): `input.subjectCandidates` はここでだけ使う——deferred 側
    // （上の早期 return・`processExtractJob`）には渡らない。`observe()` が deferred と
    // 同時に渡された組み合わせを先に弾いているため、ここに来る時点で
    // `extractMode === 'sync'` であることは保証済み。
    const { memoryIds, outcome, failure, rejectedSubjectIds, claimKeyFailure, contestedDetection } =
      await runExtraction(ctx, observation, input.subjectCandidates, input.claimKey, signal);
    const extractJob = jobs.find((job) => job.kind === "extract");
    if (extractJob) {
      // CAS（ADR 0142）: ジョブは observe が claim 済みの状態で作られている（ADR 0407。
      // `attempts` は 1）。作ったときに返った `attempts` を、自分のフェンシングトークンとして渡す。
      try {
        await deps.outboxStore.complete(ctx, extractJob.id, extractJob.attempts, {
          at: clock.now(),
        });
      } catch (err) {
        // ADR 0407: LLM がリースより長くかかり、tick に取り直されていた。observe の書き込み
        // （Observation と抽出した Memory）は既に済んでおり、ジョブの終端は取り直した側が持つ。
        // ここで投げると「書き込み済みなのに失敗」になり `memoryIds` が失われる。良性なので握る
        // （tick 側の `leaseConflicts` と同じ扱い）。それ以外の例外は今までどおり投げる。
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
      // Issue #608 項目②(b): `subjectCandidates` を渡した呼び出しだけ、この欄を持たせる
      // （ObserveResult.rejectedSubjectIds の doc コメント参照。空配列＝渡していないと
      // 同じ規約、observation.ts の `SubjectCandidatesInput` 参照）。
      ...(input.subjectCandidates !== undefined && input.subjectCandidates.length > 0
        ? { rejectedSubjectIds }
        : {}),
      // Issue #371: `claimKey.enabled` を渡した呼び出しだけこの欄を持たせる
      // （ObserveResult.claimKeyFailure の doc コメント参照。同じ「渡していない」規約）。
      ...(input.claimKey?.enabled === true ? { claimKeyFailure } : {}),
      // Issue #372: `claimKey.detectContested: true` を渡した呼び出しだけこの欄を持たせる
      // （ObserveResult.contestedDetection の doc コメント参照。同じ「渡していない」規約）。
      ...(input.claimKey?.detectContested === true ? { contestedDetection } : {}),
    };
  }

  async function observe(
    ctx: Ctx,
    input: ObserveInput,
    opts?: AbortOptions,
  ): Promise<ObserveResult> {
    const parsed = ObserveInputSchema.parse(input);
    if (parsed.kind === "memory_usage") {
      return handleMemoryUsage(ctx, parsed);
    }
    // Issue #608 項目②(b): `extract: 'deferred'` と `subjectCandidates` の組み合わせは
    // 検証の段（DB へ何も書く前）で明示的に落とす——`subjectCandidates` はどこにも
    // 永続化されないため、deferred 側の実行時（`processExtractJob`）はこの一覧を
    // 構造的に見られない。「渡されたのに黙って落とす」と、呼び出し側は候補一覧が
    // 効いたと思い込む（`SubjectCandidatesInput` の doc コメント、observation.ts 参照）。
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
    // Issue #371: `claimKey` と `extract: 'deferred'` の組み合わせも同じ理由で落とす
    // （`CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX` の doc コメント、observation.ts 参照）。
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
    // Issue #1092（ADR 0347）: 再配達（1回目が書いた後・`complete` の前に止まり、リースが切れた後の2回目）で
    // 違う LLM の出力を足さない。その Observation から今の抽出器の版で作られた Memory が1件でも在れば、抽出は
    // 済んでいるものとして LLM を呼ばずに返す（`tick` が `complete` する）。
    // - status では絞らない: 全文フォールバック・forget / purge した Memory も「在る」に数える
    //   （再配達で、忘れさせた内容を蘇らせない。#897 と同じ向き）。
    // - 版で絞る: 旧い版の Memory しか無ければ、今どおり新しい版で抽出する（#873）。
    // - ここ（extract ジョブの handler）にだけ置く。sync の observe は Observation を作った直後であり、
    //   `reextract` は既存が在ってもやり直すのが目的なので、どちらもこの判定を通らない。
    // ⚠ 塞げないもの: 並行の2本（どちらも書く前にこの読みを通る。#1092 本文）。1回目が候補の一部だけを書いて
    //   止まった場合の残り（作られない。`reextract` で回復する）。
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

  /**
   * Issue #753 / `RuntimeDeps.embeddingInput`: `deps.embeddingInput` が省略されていれば
   * `memory.content` をそのまま返す——この関数の有無は既定の挙動を1ビットも変えない。
   * 指定されていれば、その戻り値を `embed()` へ送る文字列として使う（`memory.content`
   * 自体は変えない。呼び出し元の `try` の中で呼ぶので、フックが例外を投げても今までの
   * `catch` がそのまま `embeddingStatus: 'failed'` にして再送出する）。
   */
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
    try {
      const [vector] = await runAbortable(signal, (raced) =>
        deps.embeddingProvider.embed(ctx, [resolveEmbeddingInput(memory)], { signal: raced }),
      );
      if (!vector) {
        throw new Error("runtime.tick: embedding provider returned no vector");
      }
      // 2026-09-30 / ADR 0393: provider が宣言した `space.dimensions` と違う長さのベクトルは
      // upsert に渡さない。Postgres では pgvector の `expected N dimensions` で落ちて原因が
      // SQL の失敗に見え、InMemory / Fake は黙って 'ready' にしていた。既存の失敗の経路
      // （下の catch: `failed` を書いて投げ直す）に乗せる。
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
      // ⚠ 2026-09-30 追記（今の振る舞いを書いたもの）: `upsert` に成功したあとのこの `ready` の書き込みが
      // 一時的に失敗しても、下の `catch` は「埋め込みの失敗」と区別しない——`failed` を書いて投げ直す。
      // 結果: ベクトルは書けているのに記憶は `failed`（`recall` は `not_indexed{ reason: "failed" }` と名乗る）、
      // ジョブは `fail()` で終端になる（Phase 1 に自動リトライは無い）ので、次の `tick` では回復しない。
      // 戻すには `reembed({ statuses: ["failed"], … })` で積み直して `tick` する（`failed → ready` は許される）。
      // 直さない理由: この `catch` の中の `failed` は「ここまでの store 呼び出しのどれかが落ちた」を等しく扱う
      // 唯一の口で、`ready` だけ分けても、ジョブが終端になる点（＝リトライが無い点）は変わらず、
      // 一時的な失敗が1件の記憶を `reembed` が要る状態にする、という同じ形が `memoryStore.get` などにもある。
      // 【実測 2026-09-30】`packages/core/src/__tests__/embed-job-ready-write-fails.test.ts`。
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    } catch (err) {
      // Issue #1200 / ADR 0359: abort による reject は、埋め込みの失敗と同じ顔にしない
      // ——`embeddingStatus` を `'failed'` にせず、そのまま投げ直す（`tick()` がこれを
      // 見て `fail()` を呼ばない——`tick` 本体の catch 節を参照）。
      if (isAbort(signal)) {
        throw err;
      }
      // 索引の遅れ・失敗を黙って無かったことにしない（docs/architecture.md 原則の姿3）。
      // Issue #962: `failed` の書き込み自体が失敗しても、元の例外（なぜ埋め込めなかったか）を
      // 失わない——`cause` に残し、`tick()` が `lastError` に載せるメッセージにも両方を書く。
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
   * `job.payload` から `memoryId` を取り出す共通部分（Issue #204 / ADR 0157）。
   * `processEmbedJob` の `memoryId` 取り出しと同じ形——`consolidate`/`reflect` の
   * ジョブも `createMemoryWithOutbox` が作る以上、payload の形は embed と同じ
   * `{ memoryId }` である（新しい payload 形を発明しない、ADR 0157 決定2）。
   *
   * 🔴 **payload が壊れていた（`memoryId` が無い/文字列でない）場合は投げる。**
   * `processEmbedJob` と同じ規律——黙って何もしない・空処理として `complete()` しない
   * （ADR 0082 の哲学）。呼び出し元の `tick()` がこれを catch し、`outboxStore.fail()`
   * で終端に落として `TickResult.failed` に数える。
   */
  function readSeedMemoryIdFromPayload(job: OutboxJobRecord): MemoryId {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error(`runtime.tick: ${job.kind} job payload missing memoryId`);
    }
    return memoryId;
  }

  /**
   * Issue #849 / ADR 0157 決定2 追記: `consolidate()`/`reflect()` は ADR 0089 の公開の
   * 約束により、LLM 呼び出しが失敗しても例外を投げず `outcome: "llm_failed"`（`llmFailure`
   * 付き）を正常な戻り値として返す。ADR 0157 決定2「種が見つからない場合は、投げない」節は
   * 「LLM/store が本当に失敗したときの例外だけが伝播して `tick()` に `fail()` させる」と
   * 書いていたが、この前提は検証されておらず、実際には `consolidate()`/`reflect()` が
   * 例外を投げないため成り立っていなかった（`processConsolidateJob`/`processReflectJob`
   * が戻り値を捨てていたため、`tick()` は LLM が落ちても `complete()` して `processed`
   * に数えていた）。
   *
   * `processConsolidateJob`/`processReflectJob` だけがここで結果を見て `llm_failed` を
   * 例外に変え、`tick()` の既存の catch → `outboxStore.fail()` 経路（`OutboxStore` 契約の
   * 「Phase 1 では失敗したジョブの自動リトライを行わない」どおり、終端に落ちるだけ）に
   * 乗せる。`consolidate()`/`reflect()` を直接呼ぶ同期 API の契約（ADR 0089: LLM 失敗は
   * 例外にしない）はここでは一切変えていない——変えているのは `tick()` 経由の自動ジョブの
   * 扱いだけである。
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
   * `tick` の `consolidate` ジョブハンドラ（Issue #204 / ADR 0157）。
   *
   * **`seedMemoryId` が指す Memory が見つからない場合は投げない。**
   * `consolidate()` 自身が「種が見つからない」を `nothingReason` 経由の正規の結末
   * （`not_found` → `nothing_to_consolidate`/`no_eligible_sources` 等、ADR 0152 決定6）
   * として扱うため、ここで二重に判定しない——`processEmbedJob` が `memory not found` を
   * 例外にしているのとは事情が違う（embed には「対象が無かった」を表す正規の結末が無い）。
   *
   * 🔴 **LLM 呼び出しが本当に失敗したときは `throwIfLlmFailed` が例外に変える
   * （Issue #849 / ADR 0157 決定2 追記）。** `consolidate()` は ADR 0089 の公開の約束により
   * `outcome: "llm_failed"` を正常な戻り値として返す——例外は投げない。ADR 0157 決定2は
   * 以前「LLM/store が本当に失敗したときの例外だけが伝播して `tick()` に `fail()` させる」
   * と書いていたが、この前提は検証されておらず実際には成り立っていなかった。ここで結果を
   * 見て `llm_failed` を例外に変え、`tick()` の既存の catch → `fail()` 経路に乗せる。
   *
   * **種の `subjectId` を `ctx.subjectId` に置いてから `consolidate()` を呼ぶ**
   * （[Issue #579](https://github.com/takecchi/mnemora/issues/579) /
   * [ADR 0317](../../../docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)）。
   * `tick()` はジョブを subject で絞って claim できない（`ClaimOutboxJobsOptions` に
   * `subjectId` が無い）ため、`tick()` に渡された `ctx.subjectId` と種の `subjectId` が
   * 食い違うことが、subject をまたぐ統合（`consolidate()` 内の近傍探索が種と別の subject
   * から候補を拾い、統合後の `Memory.subjectId` が `null` に畳まれる）の主な経路だった
   * （ADR 0310 実測）。種の `subjectId` を優先すれば、近傍探索は
   * `recall(ctx, { text: seed.digest })` の scope が種と同じ subject に絞られ、
   * 混在は構造的に 0% になる（ADR 0310 §「近傍探索を種の subject に絞れば 0%」）。
   *
   * 種が見つからない、または種の `subjectId` が `null`（帰属が割れて畳まれた統合済みの
   * 記憶を種にした場合など）のときは、**今日どおり** `tick()` に渡された `ctx` のまま
   * `consolidate()` を呼ぶ——ここで新しい判定を発明しない。
   *
   * ⚠ **`deps.memoryStore.get()` をここで1回呼ぶのは、`consolidate()` が
   * `{ seedMemoryId }` 分岐の中でも同じ id を `get()` する（`runtime.ts` の
   * `consolidate()` 手順1）ため、1件の自動ジョブにつき `get()` が2回になる。**
   * わざと避けていない——`MemoryStore.get` は主キー1件の索引読みで安価であり、
   * この経路はそもそも opt-in（`autoQueueConsolidateReflectOnExtract`、既定 `false`）
   * の内側だけで、かつ同じジョブが既に払っている代償（近傍探索の `recall()` 1回・
   * 再埋め込み1回、条件により LLM 呼び出し1回、ADR 0152/0157 の負債）に比べて小さい。
   * `consolidate()` の内部関数へ `ctx` と一緒に「既に読んだ種」を渡す形（二重読みを
   * 避ける）は、`consolidate()` 本体の手順1を分岐ごとに割る変更になり、`{ memoryIds }`/
   * `{ query }` 分岐に触らずに済ませられる範囲を超えるため、今回は採らない。
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
    // Issue #1200 / ADR 0359: abort されたら `consolidate()` 自体が reject する
    // （`outcome: "llm_failed"` には倒さない）ため、`throwIfLlmFailed` には届かない
    // ——その例外がそのまま `tick()` の catch 節まで伝わる。
    const result = await consolidate(scopedCtx, { target: { seedMemoryId }, signal });
    throwIfLlmFailed("consolidate", result);
  }

  /**
   * `tick` の `reflect` ジョブハンドラ（Issue #204 / ADR 0157）。
   * `processConsolidateJob` と対称——理由は同じ（`reflect()` も種が見つからない場合を
   * `not_found` 経由の正規の結末として扱う、ADR 0154 決定5）。
   *
   * **種の `subjectId` を `ctx.subjectId` に置いてから `reflect()` を呼ぶ**
   * （[Issue #820](https://github.com/takecchi/mnemora/issues/820) / ADR 0317 決定3
   * 「確かめていないこと」を埋めた変更、[ADR 0317](../../../docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)
   * 案 S を `processConsolidateJob` と同じ形でそのまま写している）。ADR 0310/0317 が
   * `consolidate` について実測したのと同じ構造的事情——`tick()` はジョブを subject で
   * 絞って claim できない（`ClaimOutboxJobsOptions` に `subjectId` が無い）——が
   * `reflect` にもそのまま当てはまる。種が見つからない、または種の `subjectId` が
   * `null` のときは、今日どおり `tick()` に渡された `ctx` のまま `reflect()` を呼ぶ
   * ——ここで新しい判定は発明しない。
   *
   * 🔴 **LLM 呼び出しが本当に失敗したときは `throwIfLlmFailed` が例外に変える**
   * （Issue #849 / ADR 0157 決定2 追記。`processConsolidateJob` と同じ理由——上の
   * `throwIfLlmFailed` の doc コメント参照）。
   */
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
    // Issue #1200 / ADR 0359: `processConsolidateJob` と同じ理由——abort されたら
    // `reflect()` 自体が reject する。
    const result = await reflect(scopedCtx, { target: { seedMemoryId }, signal });
    throwIfLlmFailed("reflect", result);
  }

  /**
   * `tick` がジョブを配る先。**キーの集合は {@link TICK_SUPPORTED_JOB_KINDS} と型で結ばれている**
   * ——`Record<TickSupportedJobKind, JobHandler>` なので、片方だけ足す/消すと型検査が落ちる。
   * issue #105（型に `consolidate` が在るのに分岐が無い）と同じずれを、次からは
   * コンパイル時に止めるための結び目である。
   */
  const jobHandlers: Record<TickSupportedJobKind, JobHandler> = {
    extract: processExtractJob,
    embed: processEmbedJob,
    consolidate: processConsolidateJob,
    reflect: processReflectJob,
  };
  /**
   * `job.kind`（開いたユニオン＝任意の文字列）で引くための索引。
   *
   * 🔴 **`Map` である理由は1つだけ**——プレーンなオブジェクトを索引にすると
   * `job.kind` が `"constructor"` / `"toString"` のとき `Object.prototype` 側の関数が
   * 返り、**「対応している」と誤判定して呼んでしまう**。`kind` は DB の `text` 列から
   * 来る任意の文字列であり、この2語を弾く仕組みはどこにも無い（`OutboxJobKind` は
   * 開いたユニオンなので型でも止まらない）。`Map` は prototype を持たない。
   * `Object.entries(jobHandlers)` から作るので、出所は `TICK_SUPPORTED_JOB_KINDS` のままである。
   */
  const jobHandlerLookup = new Map<string, JobHandler>(Object.entries(jobHandlers));

  async function tick(ctx: Ctx, opts: TickOptions): Promise<TickResult> {
    // Issue #1200 / ADR 0359（クローン miku の判断）: `signal` を1変数に固定しておく——
    // 下の分岐が何度も `opts.signal` を読み直さない（`opts` を再代入しないので値は動かない）。
    const signal = opts.signal;
    const claimOpts: ClaimOutboxJobsOptions = {
      // 既定は「tick が処理できる kind だけ」——ここを広げると、処理できない kind を
      // 呼び出し側が頼んでもいないのに claim して終端で焼くことになる（ADR 0082）。
      kinds: opts.kinds ?? [...TICK_SUPPORTED_JOB_KINDS],
      limit: opts.limit ?? DEFAULT_TICK_LIMIT,
      now: clock.now(),
      claimedBy: opts.claimedBy ?? defaultClaimedBy,
      leaseMs: opts.leaseMs,
    };
    const jobs = await deps.outboxStore.claimBatch(ctx, claimOpts);

    let processed = 0;
    let failed = 0;
    const unsupported: UnsupportedOutboxJob[] = [];
    const leaseConflicts: OutboxLeaseConflict[] = [];
    for (const job of jobs) {
      // Issue #1200 / ADR 0359: abort されたら、claim 済みで未着手のこのジョブ以降には
      // 手を付けない——`fail()` もしない。claim されたまま残り、リースが切れれば次の
      // `tick` が取る。ループを抜けた後、下でこの `tick()` 自体を reject する。
      if (signal?.aborted) {
        break;
      }
      const handler = jobHandlerLookup.get(job.kind);
      if (handler === undefined) {
        // 🔴 ADR 0082 / issue #105: 処理する分岐が無い kind。ここで2つのことを同時にやる。
        // 1. `fail()` で**終端に落とす**。claim したまま何もしないと lease が切れて
        //    再び claim され、「claim され続けるがいつまでも進まない」になる。
        // 2. `unsupported` に**名指しで積む**。`failed` に数えるだけだと、
        //    「試して失敗した」と同じ顔になって呼び出し側から区別が付かない。
        // CAS（ADR 0142）: `job` はこの tick が `claimBatch` からたった今受け取った
        // ものであり、`job.attempts` は「自分の claim」を指すフェンシングトークンである。
        // 🔴 ADR 0142 決定3: fail() 自体がリース競合（OutboxLeaseConflictError）で
        // 弾かれることもある——別のワーカーが、この worker が fail() を呼ぶより先に
        // このジョブを再 claim して終端まで進めていた場合。良性の競合なので
        // `leaseConflicts` に記録し、`unsupported`/`failed` には数えず次のジョブへ進む。
        //
        // ⚠ この分岐は provider を一切呼ばないため、abort の対象にしない
        // （Issue #1200: 中断が効くのは provider を待っている間と呼ぶ前だけでよい）。
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
        // 🔴 ADR 0142: `complete` がリース競合で弾かれることがある——`handler` の
        // 処理自体には成功したが、その完了を記録しようとした時点で、既に別の
        // ワーカーがこのジョブを再 claim して終端まで進めていた場合。良性の競合
        // なので `leaseConflicts` に記録するだけで、`fail()` は呼ばない
        // （呼んでも同じ理由でまた弾かれるだけであり、かつ「処理には成功した」
        // ジョブを `failed` にも数えない——事実と違う顔になる）。
        await deps.outboxStore.complete(ctx, job.id, job.attempts, { at: clock.now() });
        processed += 1;
      } catch (err) {
        // Issue #1200 / ADR 0359: `handler` の中で provider 呼び出しが abort された
        // 例外は、`OutboxLeaseConflictError` と同じく「良性」だが性質が違う——
        // このジョブは処理を試みた結果失敗したのではなく、待つのをやめただけである。
        // `fail()` しない・`failed` にも数えない。ここで claim したジョブは claim
        // されたまま残る（リースが切れれば次の `tick` が取る）。
        if (signal?.aborted) {
          break;
        }
        if (isOutboxLeaseConflictError(err)) {
          leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "complete" });
          continue;
        }
        // ⚠ 2026-09-26 追記（Issue #836）: ここに来る `err` は「`complete()` が
        // `OutboxLeaseConflictError` 以外の例外を返した」ことしか意味しない——
        // `handler` は既に成功しており、`complete()` が DB 上ではコミット済みなのに
        // （コミット後の接続断・タイムアウト等で）例外だけをクライアントへ返した
        // ケースを、この catch は「処理が失敗した」ケースと区別できない。前者の場合、
        // 下の `fail()` は既に `completed_at` が付いた行に対する無言の no-op になり
        // （Issue #826）、行は `completed` のまま変わらないが、それでも `failed` は
        // 1増える（`TickResult.failed` の doc コメント参照）。
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
    // Issue #1200 / ADR 0359: abort されていたら、`tick()` 自体を reject する
    // （`TickResult` には新しい欄を作らない——戻り値そのものを返さない）。abort までに
    // `complete()` まで記録できたジョブの完了は、上のループで既に store へ書かれている
    // ため、ここで reject してもそれらは覆らない。
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

  /**
   * `Runtime.getRecall` の実装（Issue #312、ADR 0161）。doc コメントは interface 側にある
   * ——ここは素通しそのものだけ。
   */
  async function getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null> {
    return deps.memoryStore.getRecall(ctx, recallId);
  }

  /**
   * `Runtime.findCorrectionCandidates` の実装（Issue #369 (C)、[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）。doc コメントは
   * interface 側（`findCorrectionCandidates` の JSDoc）にある——ここはアルゴリズムそのもの
   * だけ。`consolidate` の `{ seedMemoryId }` 形と同じく、`recall()` を1回呼ぶだけで
   * 新しい「似ている」の判定を作らない。
   */
  async function findCorrectionCandidates(
    ctx: Ctx,
    input: FindCorrectionCandidatesInput,
    opts?: AbortOptions,
  ): Promise<FindCorrectionCandidatesResult> {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new RangeError("Runtime.findCorrectionCandidates: limit must be a positive integer");
    }
    const limit = input.limit ?? DEFAULT_CORRECTION_CANDIDATE_LIMIT;

    // `text`/`activityCounting` 以外のフィールドを一切渡さない——閾値・limit・
    // channels・overFetchFactor はすべて recall() の既定に委ねる（interface 側の
    // doc コメント参照）。ADR 0353（Issue #338）: `activityCounting` は
    // `input.activityCounting` をそのまま渡す（省略時は recall() 側の既定
    // "tenant" に落ちる）。
    const recallResult = await recall(
      ctx,
      {
        text: input.text,
        activityCounting: input.activityCounting,
      },
      opts,
    );

    const excludeSet = new Set(input.excludeMemoryIds ?? []);
    // recallRank は「recall() が返した並びでの、1始まりの順位」——除外の前に固定する。
    const ranked = recallResult.memories.map((memory, index) => ({
      memory,
      recallRank: index + 1,
    }));
    const remaining = ranked.filter(({ memory }) => !excludeSet.has(memory.memoryId));
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
    return deps.memoryStore.requeueEmbedJobs(ctx, opts, { now: clock.now() });
  }

  /**
   * `Runtime.sweepArchive` の実装（ADR 0114、Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * doc コメントは interface 側にある——ここは「口が在るかどうかで分岐する」という
   * アルゴリズムと、`opts.clock` 省略時の解決の2つだけ。
   *
   * `deps.memoryStore.archiveDecayed` を一度ローカル変数へ受けてから `undefined` を
   * 判定するのは、ADR 0100 の `supersedeWithNewMemories` 呼び出しと同じ作法——
   * `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す必要があるため
   * （分割代入したメソッドは `this` を失うので、呼び出し時に元のオブジェクトを渡す）。
   *
   * ADR 0186: `opts.clock` を省略したら `tenant_settings.decay_clock` に従う
   * （`resolveActivityClockBase`/`resolveReinforceOptions` と同じ `readDecayClock`/
   * `readActivitySeq` を使う、同じ規律）。**`opts.clock` を明示で渡した呼び出し元の
   * 挙動は変えない**（`??` で省略時だけ補う）。解決した `clock` が `'wall'` のときは
   * `tenant_activity` を一度も読まない——`resolveActivityClockBase` 等と同じ理由で、
   * `decay_clock` を設定していないテナント（既定 `'wall'`）の挙動を1バイトも変えない。
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
    // ADR 0353（Issue #338）: 掃引はテナント全体を対象にする（subject を絞らない）ため、
    // 行ごとに違う subject の `S_x` を都度計算する必要がある——
    // `hasSubjectActivityCounters?` が false（一度も subject カウンタを使っていない
    // テナント）なら相関サブクエリを足さない（プラン族を変えない、`archiveDecayed`
    // 実装側の `usesSubjectActivityCounters` の doc コメント参照）。
    const usesSubjectActivityCounters =
      opts.usesSubjectActivityCounters ??
      (clock === "wall"
        ? false
        : await readHasSubjectActivityCounters(deps.tenantSettingsStore, ctx));
    const result = await archiveDecayed.call(deps.memoryStore, ctx, {
      ...opts,
      clock,
      nowSeq,
      usesSubjectActivityCounters,
    });
    return { supported: true, archived: result.archived, reachedLimit: result.reachedLimit };
  }

  /**
   * `Runtime.restoreArchived` の実装（Issue #195、ADR 0122）。doc コメントは interface
   * 側（`restoreArchived` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   * `forget` の実装と意図的に同じ骨格を持つ（`ForgetOutcome`/`RestoreArchivedOutcome`
   * の対応は両者の doc コメント参照）。
   */
  async function restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc）。
    const lookupKey = memoryLookupKeyFor(ids);
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const outcomes: RestoreArchivedOutcome[] = [];
    // 競合以外の例外で打ち切る: `i` 番目を `failed` にし、残りを「見ていない」として返す。
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

    // Issue #964: ループ前の読みの失敗も「競合以外の例外」である——まだ1件も書いていない
    // ので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    let reinforceOpts: ReinforceOptions | undefined;
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
      // ADR 0165 決めたこと16: この呼び出し全体で1回だけ読む（`buildNewMemoriesForCandidates`
      // が `resolveActivityClockBase` を候補バッチ1つにつき1回だけ読むのと同じ理由——
      // 対象 id ごとに読み直すと 'activity'/'either' のテナントで id の数だけ
      // `tenant_activity` への往復が増える）。
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

        // マネージャー決定（Issue #196 / ADR 0153「restoreArchived と忘却ゲートの
        // 相互作用」）: 復帰そのものが「いま必要だ」という明示の信号なので、
        // reinforce して decay_floor_at を復帰の瞬間から引き直す。これをしないと、
        // status は active に戻ったのに decayFloorAt が過去を指したままなので、
        // recall() の既定の忘却ゲート（ADR 0153、`RecallQuery.includeFullyDecayed`
        // の既定 false）に阻まれて recall に二度と現れない——「必要な場合だけ過去の
        // 記憶を再び呼び戻せる」（docs/north-star.md「目指す姿」）と正面から食い違う。
        // interface/adapter は増やさない——既存の契約された口 `reinforce`
        // （`docs/memory-model.md` §7、ADR 0041・ADR 0048）をそのまま呼ぶだけである。
        //
        // ⚠ status の復帰は既にここで成功している。reinforce が失敗しても、
        // 既に成功した復帰を握り潰さない——outcome は "restored" のままにし
        // （`kind` を "failed" に落とさない）、reinforce の失敗は追加欄
        // `reinforceError` で運ぶ（additive。既存欄の意味は変えない）。
        // これは既存の「競合以外の例外は打ち切って残りを not_attempted にする」
        // という規律（下の catch 節）とは別の規律である——あちらは「書き込みその
        // ものが起きなかった」場合の安全弁だが、こちらは「主たる書き込み
        // （status の復帰）は成功したあとの、副次的な強化の失敗」であり、
        // 呼び出し側にとっての意味が違う（前者は「何も変わっていない」、
        // 後者は「復帰はしたが、忘却ゲートに再び阻まれるかもしれない」）。
        // だから reinforce 専用の内側の try/catch で切り離し、外側の catch
        // （`MemoryStatusConflictError` 分岐・打ち切り分岐）に一切触れさせない。
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
          // 安全弁（`forget` と同じ形。1回だけ再読して打ち切る——上限の無い
          // 再試行ループを作らない）。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」である——下と同じく
            // 打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から
            // 見えなくなる（interface の doc コメント「例外はこのメソッドの外へは投げない」）。
            return abortAt(i, refetchError);
          }
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if (refetched.status === "active") {
            // 別の呼び出しが先に同じ復帰（archived → active）を済ませていた——
            // 求めていた状態に既に居るのは対立ではない（`forget` の
            // `already_forgotten` と同じ扱い。interface doc コメント参照）。
            byId.set(lookupKey(id), refetched);
            outcomes.push({ memoryId: id, kind: "status_not_archived", status: "active" });
          } else {
            // active 以外の別の状態に変わっていた（または archived のまま、という
            // 二重の競合）——求めていない状態への変化なので conflicted として扱う。
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { outcomes };
  }

  /**
   * `Runtime.restoreSuperseded` の実装。doc コメントは interface 側
   * （`restoreSuperseded` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   *
   * `sweepArchive` と同じ「口が在るかどうかで分岐する」骨格
   * （`deps.memoryStore.restoreSupersededBy` を一度ローカル変数へ受けてから
   * `undefined` を判定し、`.call(deps.memoryStore, ...)` で `this` を明示的に
   * 束ね直す——分割代入したメソッドは `this` を失うため。ADR 0100 の
   * `supersedeWithNewMemories` 呼び出しと同じ作法）。
   */
  async function restoreSuperseded(
    ctx: Ctx,
    target: RestoreSupersededTarget,
    opts?: RestoreSupersededOptions,
  ): Promise<RestoreSupersededResult> {
    const supersedingMemoryId = target.supersededById;

    // Issue #515、ADR 0237: `opts.dryRun` は既存の既定（省略時・false 時は実際に戻す）を
    // 1バイトも変えない別の枝——別のメソッド（`previewRestoreSupersededBy?`）へ
    // 分岐するだけで、下の「実際に戻す」経路には一切触れない。
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

    // ADR 0165 決めたこと16 と同じ理由（`restoreArchived` の実装コメント参照）:
    // この呼び出し全体で1回だけ読む。
    const reinforceOpts = await resolveReinforceOptions(ctx);

    // 群の強化を1回に束ねる（`MemoryStore.reinforceMany?` が在るとき）。群の復帰そのものは
    // SQL 1本なのに、以前は強化を1件ずつ呼んでいたため、群が1件増えるごとに往復が増えていた
    // （使用報告を Issue #874 で束ねたのと同じ形。歯は
    // `packages/postgres/src/__tests__/restore-superseded-roundtrip-count.postgres.test.ts`）。
    // ⚠ **束ねた強化が失敗したら、下の1件ずつの強化へ戻る**——「強化の失敗は、その要素の
    // `reinforceError` に入り、outcome は restored のまま」という1件ごとの約束を、束ねた
    // 経路でも崩さないため。強化は減衰の起点を巻き戻さない（ADR 0048）ので、束ねた強化が
    // 途中まで書いてから失敗していても、1件ずつやり直して害は無い。
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
      // status の復帰は既に `restoreSupersededBy` の1トランザクションで成立している
      // ——ここから先は `restoreArchived` と同じ「reinforce 専用の内側の try/catch」
      // （復帰の成功を reinforce の失敗で握り潰さない）。
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

  /**
   * `Runtime.forget` の実装（Issue #102）。doc コメントは interface 側
   * （`forget` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function forget(
    ctx: Ctx,
    target: ForgetTarget,
    opts?: ForgetOptions,
  ): Promise<ForgetResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc）。
    const lookupKey = memoryLookupKeyFor(ids);
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const outcomes: ForgetOutcome[] = [];
    // 競合以外の例外で打ち切る: `i` 番目を `failed` にし、残りを「見ていない」として返す。
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

    // Issue #964: ループ前の一括読みの失敗も「競合以外の例外」である——まだ1件も書いて
    // いないので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
    } catch (error) {
      return abortAt(0, error);
    }
    // 呼び出しの中で同じ id が複数回現れたとき、1回目の書き込み結果を2回目が見るための
    // ローカルの写し。書き込みが成功するたびに更新する。
    //
    // ⚠ **これは正しさのためではない。**この更新を消しても `outcomes` は変わらない
    // ——2回目は「書き込み前」の status で CAS を撃ち、それが弾かれ、読み直して
    // `already_forgotten` に落ち着くからである（変異試験で確認した。ADR 0087）。
    // **買っているのは往復である**: この写しが無いと、重複した id 1つにつき
    // 「必ず失敗する UPDATE」1回と「読み直しの SELECT」1回が余分に DB へ飛ぶ。
    // 🔴 効果が `outcomes` に出ない以上、歯は**呼び出し回数のほうを数える**
    // （`forget.test.ts` の「重複した id は…往復を増やさない」）。
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
          // 安全弁（ADR 0030 と同じ形。ただし `reextract` と違い、ここは1回だけ
          // 再読して打ち切る——上限の無い再試行ループを作らない、という明示の決定）。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」である——下と同じく
            // 打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から
            // 見えなくなる（interface の doc コメント「例外はこのメソッドの外へは投げない」）。
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
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { outcomes };
  }

  /**
   * `Runtime.purge` の実装（Issue #198、ADR 0124。Issue #1425/ADR 0382 で
   * `vectorStore.deleteAcrossSpaces` に置き換え、`already_purged` でも呼ぶよう広げた）。
   * doc コメントは interface 側（`purge` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   * `forget`/`restoreArchived` と意図的に同じ骨格を持つ。CAS の条件・`dryRun`・`supported`・
   * `vectorStore.deleteAcrossSpaces` の4点だけが違う。
   */
  async function purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc）。
    const lookupKey = memoryLookupKeyFor(ids);

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（ADR 0100/ADR 0114 と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
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
    // 競合以外の例外で打ち切る: `i` 番目を `failed` にし、残りを「見ていない」として返す。
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

    // Issue #964: ループ前の一括読みの失敗も「競合以外の例外」である——まだ1件も書いて
    // いないので、1件目を `failed`、残りを `not_attempted` にして返す（例外を外へ投げない）。
    let found: Memory[];
    try {
      found = await deps.memoryStore.getMany(ctx, ids);
    } catch (error) {
      return abortAt(0, error);
    }
    // `forget` と同じ理由（往復の節約。`ADR 0087`）——正しさのためではない。
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(lookupKey(memory.id), memory);
    }

    const actor = opts?.actor ?? { type: "system" };
    const dryRun = opts?.dryRun ?? false;

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
        // Issue #1425 / ADR 0382: 既に purge 済みでも、埋め込みの後始末はベストエフォート
        // で試みる——埋め込みモデルを移した後に再実行すれば、旧 space に残った行を
        // 消せるようにするため（`kind` の意味は変えない。書き込みが起きていない、という
        // 判定はそのまま）。`dryRun` のときは呼ばない。
        if (!dryRun) {
          try {
            await deps.vectorStore.deleteAcrossSpaces(ctx, [id]);
          } catch (cleanupError) {
            // 結果は変えず、失敗だけを任意の欄で知らせる（ADR 0399）。
            alreadyPurged.embeddingCleanup = embeddingCleanupFailed(cleanupError);
          }
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

        // ADR 0124 決定5・ADR 0382: ベストエフォート。失敗しても "purged" の判定は変えない
        // ——MemoryStore 側の書き込みは既に確定しており、ここで "failed" に格下げすると
        // 「安全に再試行できる」という failed/not_attempted の意味を裏切る。Issue #1425:
        // 今の space だけでなく、この adapter が持つ全 space から消す。
        try {
          await deps.vectorStore.deleteAcrossSpaces(ctx, [id]);
        } catch (cleanupError) {
          // "purged" のまま、失敗だけを任意の欄で知らせる（ADR 0399。成功時は欄を出さない）。
          purgedOutcome.embeddingCleanup = embeddingCleanupFailed(cleanupError);
        }
      } catch (error) {
        if (isMemoryPurgeConflictError(error)) {
          // 安全弁（`forget`/`restoreArchived` と同じ形。1回だけ再読して打ち切る
          // ——上限の無い再試行ループを作らない）。
          let refetched: Memory | null;
          try {
            refetched = await deps.memoryStore.get(ctx, id);
          } catch (refetchError) {
            // 再読そのものの失敗（DB 接続断等）も「競合以外の例外」である——下と同じく
            // 打ち切る。ここで投げると、先に確定した要素の outcome まで呼び出し側から
            // 見えなくなる（interface の doc コメント「例外はこのメソッドの外へは投げない」）。
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
            // Issue #1425 / ADR 0382: この分岐は purgeMemory を呼んだ後の競合の後始末
            // であり dryRun では到達しない（dryRun は purgeMemory 自体を呼ばない）——
            // 上の already_purged 分岐と同じくベストエフォートで埋め込みを消す。
            try {
              await deps.vectorStore.deleteAcrossSpaces(ctx, [id]);
            } catch (cleanupError) {
              // 握り潰さず、他の2箇所と同じく欄で知らせる（ADR 0399 の 2026-09-30 追記。
              // 0399 は「握り潰しは2箇所」と書いたが、この3つ目が残っていた）。
              racedAlreadyPurged.embeddingCleanup = embeddingCleanupFailed(cleanupError);
            }
          } else if (refetched.status !== "forgotten") {
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "status_not_forgotten",
              status: refetched.status as Exclude<MemoryStatus, "forgotten">,
            });
          } else {
            // status === "forgotten" かつ purgedAt === null のまま——本 PR の時点では
            // 到達しないはずの防御的な分岐（ADR 0124 決定2「並行呼び出し」参照）。
            byId.set(lookupKey(id), refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        return abortAt(i, error);
      }
    }

    return { supported: true, outcomes };
  }

  /**
   * `Runtime.markContested` の実装（Issue #197、ADR 0134）。doc コメントは interface 側
   * （`markContested` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult> {
    if (firstId === secondId) {
      throw new RangeError("Runtime.markContested: firstId and secondId must differ");
    }

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（ADR 0100/ADR 0114 と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
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
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc）。同じ記憶を小文字と大文字で
    // 渡したときは渡された文字列どおりに突き合わせるので、store の id と綴りが違う側は今どおり `not_found`
    // （`ineligible`）になる。どちらの位置に渡したかによらない。
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
    // Issue #1160: 両側のイベントに対向の id（`contestedWithId`）を載せる——解決のときに
    // `contested_with_id` はクリアされるので、監査ログに残さないと「誰と対だったか」が後から追えない。
    // 載せるのは store が返した相手の id である（渡された id ではない）——列（`contested_with_id`）の値と揃える
    // （`@mnemora/postgres` に大文字の UUID を渡しても、列もこの meta も小文字になる）。
    const firstMemory = byId.get(lookupKey(firstId))!;
    const secondMemory = byId.get(lookupKey(secondId))!;
    const buildMeta = (contestedWithId: MemoryId): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested", contestedWithId }
        : { reason: "contested", note: opts.reason, contestedWithId };

    try {
      // Issue #1237: 両側の `updated` イベントに同じ `at` を使う。
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
        // 安全弁（`forget`/`restoreArchived`/`purge` と同じ形。1回だけ再読して打ち切る
        // ——上限の無い再試行ループを作らない）。
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

  /**
   * `Runtime.resolveContested` の実装（Issue #197、ADR 0150）。doc コメントは interface 側
   * （`resolveContested` の JSDoc）にある——ここはアルゴリズムそのものだけ。`markContested`
   * の実装と対称に書いてある（読み方も同じ順で追える）。
   */
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
    let winnerSideId: MemoryId | undefined;
    if (resolution.kind === "supersede") {
      if (resolution.winnerId === firstId || resolution.winnerId === secondId) {
        winnerSideId = resolution.winnerId;
      } else {
        // `winnerId` が片側と大文字小文字だけ違うときは、同じ記憶かを store に聞く（`@mnemora/postgres` は uuid を
        // 大文字小文字を区別せずに比べる）。store が同じ記憶と言えば勝者として扱い、言わなければ今どおり
        // `RangeError`（大文字小文字を区別する store では今どおり）。どちらの側とも大文字小文字を無視しても違う
        // `winnerId` は、今どおり store を読まずに落とす。`firstId`/`secondId` 自身が大文字小文字だけ違う
        // （どちらとも一致しうる）ときも、どちらと決められないので今どおり落とす。
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

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（`markContested` と同じ作法。
    // 分割代入したメソッドは `this` を失う）。
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
      // 相互参照は、store が返した相手の id と比べる（`contestedWithId` も store の値である）。相手が見つからない
      // ときは、今どおり渡された id と比べる。
      if (memory.contestedWithId !== (otherMemory?.id ?? otherId)) {
        // ADR 0046 が数え上げた「一対一が破れた状態」——今日の実装では
        // `markContestedPair`（ADR 0134）経由でしか `contestedWithId` は書かれないため
        // 到達しないはずだが、防御的に分類する（`PurgeOutcome.conflicted` と同じ立場）。
        return {
          memoryId: id,
          kind: "pair_broken",
          contestedWithId: memory.contestedWithId ?? null,
        };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const found = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc。`markContested` と同じ形）。
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
    // Issue #1160: 勝者・敗者・決着の種類によらず、どのイベントにも対向の id（`contestedWithId`）を
    // 載せる——解決のときに `contested_with_id` はクリアされるので、`both_active` の対は監査ログに
    // 残さないと誰と対だったかが消える。敗者の `superseded` は `supersededById` も持つ（値は同じ）が、
    // 同じキーで相手を引けるように `contestedWithId` も入れる。
    // meta に載せる id（`contestedWithId`・`supersededById`）は store が返した id である（渡された id ではない）
    // ——列の値と揃える（`@mnemora/postgres` に大文字の UUID を渡しても、この meta は小文字になる）。
    const buildMeta = (contestedWithId: MemoryId): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested_resolved", resolution: resolutionKind, contestedWithId }
        : {
            reason: "contested_resolved",
            resolution: resolutionKind,
            note: opts.reason,
            contestedWithId,
          };

    // `docs/memory-model.md` §11 行7「`updated` または `superseded`」: `both_active` は
    // 両側とも `updated`、`supersede` は勝者が `updated`・敗者が `superseded`。
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
        // 敗者の superseded には、置き換えた側（勝者）の id を残す——consolidate・reextract の
        // superseded と同じ形（ADR 0150 追記）。勝者の updated には足さない（相手は contestedWithId で引ける）。
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
      // store へ渡す `supersededById` は渡された `winnerId` のまま（store へ渡す値は変えない）。meta には
      // 勝者の store の id（＝この側の相手）を載せる。
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
        // 安全弁（`markContested` と同じ形。1回だけ再読して打ち切る——上限の無い再試行
        // ループを作らない）。
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

  /**
   * `Runtime.resolveOrphanedContested` の実装
   * ([Issue #825](https://github.com/takecchi/mnemora/issues/825)、ADR 0150 追記)。
   * doc コメントは interface 側（`resolveOrphanedContested` の JSDoc）にある——ここは
   * アルゴリズムそのものだけ。`resolveContested` の実装と対称に書いてある。
   */
  async function resolveOrphanedContested(
    ctx: Ctx,
    survivorId: MemoryId,
    opts?: ResolveOrphanedContestedOptions,
  ): Promise<ResolveOrphanedContestedResult> {
    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（`resolveContested` と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
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
        // 安全弁（`resolveContested` と同じ形。1回だけ再読して打ち切る——上限の無い
        // 再試行ループを作らない）。
        const refetched = await deps.memoryStore.get(ctx, survivorId);
        return {
          supported: true,
          outcome: { kind: "conflict", observedStatus: refetched?.status ?? null },
        };
      }
      throw error;
    }
  }

  /**
   * `Runtime.markContestedGroup` の実装（Issue #207/#933 PR2、ADR 0327 §4-c、ADR 0378、
   * ADR 0381）。doc コメントは interface 側（`markContestedGroup` の JSDoc）にある——
   * ここはアルゴリズムそのものだけ。`markContested`（2者版）の実装と同じ形で書いてある。
   */
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

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（`markContested` と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
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
        // 安全弁（`markContested`/`resolveContested`/`forget`/`restoreArchived`/`purge` と
        // 同じ形。1回だけ再読して打ち切る——上限の無い再試行ループを作らない）。
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

  /**
   * `Runtime.resolveContestedGroup` の実装（Issue #207/#933 PR2、ADR 0327 §4-c、
   * ADR 0378 決定3、ADR 0381）。doc コメントは interface 側
   * （`resolveContestedGroup` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   * `resolveContested`（2者版）の実装と同じ形で書いてある。
   */
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
    let winnerId: MemoryId | undefined;
    if (resolution.kind === "supersede") {
      if (memberIds.includes(resolution.winnerId)) {
        winnerId = resolution.winnerId;
      } else {
        // `winnerId` が memberIds のどれかと大文字小文字だけ違うときは、同じ記憶かを store に聞く
        // （`resolveContested`〔2者版〕と同じ規則、Issue #1449 項目6。`@mnemora/postgres` は uuid を
        // 大文字小文字を区別せずに比べる）。小文字にそろえて memberIds から候補を集め、ちょうど1件で、
        // かつ store の `get` が両者に同じ id の記憶を返したときだけ、その memberId の綴りを勝者として
        // 使う（敗者の `supersededById`・イベントの meta が、memberIds＝store の列の値の綴りになる）。
        // 候補が2件以上（memberIds に同じ記憶の別の綴りが混じる）・`get` が食い違う・どの member とも
        // 大文字小文字を無視しても違う、は今どおり `RangeError`（最後の場合は store を読まない）。
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

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（`resolveContested` と
    // 同じ作法）。
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

    // 2026-09-30 の直し（ADR 0381、fix2「resolve で群の一部だけを渡したら弾く」の
    // Runtime 側の確認）: `deps.relationStore` が配線されていれば、`memberIds` から
    // `kind: 'contradicts'` を辿って到達する id のうち、`status === 'contested'` な
    // ものが `memberIds` の外にあれば、部分解消として拒む。store 側の CAS
    // （`MemoryStore.resolveContestedGroup`）と同じ「forget 等で群から抜けたメンバー
    // （もう `contested` ではない）は数えない」規律で判定する。
    const memberKeySet = new Set(memberIds.map((id) => lookupKey(id)));
    let missingMembers: MemoryId[] = [];
    if (deps.relationStore !== undefined) {
      const visitedKeys = new Set(memberKeySet);
      const visitedIds: MemoryId[] = [...memberIds];
      // 幅優先を1段ずつ進める（1段ぶんは `listRelatedMany?` があれば1往復。Issue #1449、ADR 0402）。
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
    // 敗者の superseded イベントの meta には、勝者の id を `supersededById` として残す
    // （2者版 `resolveContested` と同じ。ADR 0150 追記、ADR 0421）。store へ渡す値と同じ
    // （`memberIds` の綴りに寄せた winnerId）。勝者・both_active の updated には足さない。

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
      // 2026-09-30 のさらなる直し（ADR 0381 §7 解消）: store 側が
      // ContestedGroupMembershipMismatchError を投げた場合（部分解消）は、
      // `deps.relationStore` の配線の有無に関わらず ineligible に写す——TOCTOU による
      // 競合（MemoryStatusConflictError、下）とは別の意味（読んだ時点から呼び出し側が
      // 最初から適格でない集合を渡していた）であり、`conflict`（1回だけ再読して打ち切る
      // 安全弁）には分類しない。`sides` は手順5で読んだ時点の分類（全員 "eligible"）を
      // そのまま運び、`missingMembers` にエラーが名指しした1件を積む。
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

  /**
   * `Runtime.applyCorrection` の実装（Issue #369、[ADR 0242](../../../docs/decisions/0242-runtime-apply-correction.md)）。
   * doc コメントは interface 側（`applyCorrection` の JSDoc）にある——ここは手順そのもの
   * だけ。`markContested`/`resolveContested` を呼ぶだけの薄い orchestration であり、
   * それ自身の CAS・イベント・「無い」の分類は一切増やさない。
   */
  async function applyCorrection(
    ctx: Ctx,
    input: ApplyCorrectionInput,
  ): Promise<ApplyCorrectionResult> {
    if (input.correctedId === undefined) {
      return { kind: "awaiting_choice" };
    }
    const correctedId = input.correctedId;

    // ⛔ 相手を選ばない: discovery.candidates[0] は一切見ない。ここでやっているのは
    // 「呼び出し側が指名した correctedId が候補一覧に居るかどうか」の照合だけである。
    const candidate = input.discovery.candidates.find((c) => c.memoryId === correctedId);
    if (candidate === undefined) {
      return { kind: "not_a_candidate", correctedId };
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

  /**
   * `Runtime.consolidate` の実装（Issue #103、ADR 0089）。doc コメントは interface 側
   * （`consolidate` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult> {
    const target = opts.target;

    // 1. 対象の正規化。
    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      // Issue #135（ADR 0152）: 「この記憶に似ているものを mnemora 自身が集めて、
      // 1つに畳め」。ConsolidateTarget の doc コメント参照。
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null || isWithdrawnSeed(seed)) {
        // 種が無い——recall を呼ばない。対象は種の id 1件のみとなり、後続の getMany が
        // not_found に分類する（新しい nothingReason は発明しない）。
        // Issue #1136: 種が forget・purge された記憶のときも同じく recall を呼ばない。
        // 後続の getMany が status_not_active(forgotten) に分類する。
        ids = [target.seedMemoryId];
      } else {
        // 種の digest を text にして recall() を1回呼ぶ——{ query } 形とまったく同じ
        // 経路を通す（新しい「似ている」の判定を作らない）。
        // ADR 0353（Issue #338）: `target.activityCounting` をそのまま渡す
        // （省略時は recall() 側の既定 "tenant" に落ちる）。
        // Issue #1200 / ADR 0359: `opts.signal` をそのまま渡す——abort されればこの
        // `recall()` が reject し、その例外がそのまま `consolidate()` の呼び出し側へ届く。
        const recallResult = await recall(
          ctx,
          {
            text: seed.digest,
            activityCounting: target.activityCounting,
            // ADR 0415: この recall は `memories` しか読まない（`totalInScope`・目次帯・`filtered*` は読まない）ので、
            // 件数の集計（`aggregateScope` の `GROUP BY subject_id`）を発行しない。
            scopeAggregate: "skip",
          },
          { signal: opts.signal },
        );
        const minAffinity = target.minAffinity ?? DEFAULT_CONSOLIDATE_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          // 種を除く比較は、store が返した種の id（`seed.id`）で行う——`recall()` が返すのも store の id である。
          // 渡された `seedMemoryId` のままだと、`@mnemora/postgres` に大文字の UUID を渡したとき種が近傍にも
          // 入り、同じ記憶が大文字と小文字で2回並んでいた（`uppercase-uuid-store-entry.postgres.test.ts`）。
          .filter((m) => m.memoryId !== seed.id)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと
        // recall() の結果に現れないため——ConsolidateTarget の doc コメント参照）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      // ADR 0415: 利用者が `scopeAggregate` を明示していなければ "skip"（件数の集計を発行しない）。
      // ここは `memories` しか読まない。明示された値（"exact" を含む）は尊重する。
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
      // store に一切触れない——「見ていない」。
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "not_examined",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 2. `getMany` で一括読み、id ごとに「まだ何も書いていない時点」の分類を固定する。
    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "expired"; validUntil: Date }
      | { kind: "not_yet_valid"; validFrom: Date }
      | { kind: "active" };

    // Issue #1188: `active` でも、いまの時点で有効期間の外にある記憶は統合元にしない。統合先は
    // 有効期間を持たない（ADR 0164「射程外にしたもの」1）ので、期限切れ・未到来の事実が、
    // 期限の無い `active` な記憶として `recall()` に戻るため。述語は `recall()` の期間のゲート
    // （`recall-runtime.ts` の `survivesValidityGate`、ADR 0164 決定1）と同じで、対象の形によらない。
    // ⚠ 2026-09-29 追記: 述語そのものは `classifyValidity`（`./validity.js`）に切り出した——
    // `reflect()` も同じ関数を呼ぶ（1箇所に置く規律、`classifyValidity` の doc コメント参照）。
    const validAt = clock.now();

    const uniqueIds = Array.from(new Set(ids));
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc。`forget` と同じ形）。
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

    /**
     * `ids`（入力順・重複を保つ）を `ConsolidateSourceOutcome[]` へ写す。`active` と分類された
     * id だけ `activeOutcome` に委ねる——`not_found`/`status_not_active`/`expired`/`not_yet_valid`
     * はどの分岐でも同じ顔。
     */
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

    // eligible: 重複を除いた active id を、`ids` の中で最初に現れた順に並べる。
    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "active" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    // 3. eligible が0件・1件なら、ここで打ち切る（冪等性の芯）。
    if (eligibleIds.length === 0) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
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
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "nothing_to_consolidate",
        nothingReason: "single_eligible_source",
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 4. dryRun はここで打ち切る。1件も書かない。
    if (opts.dryRun === true) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
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

    // 5. LLM を1回呼ぶ。失敗したら1件も書かず、eligible だったものは not_attempted に落とす。
    let llmResult: ConsolidationLLMResult;
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
    } catch (error) {
      // Issue #1200 / ADR 0359: abort による reject は `"llm_failed"` に丸めず、
      // そのまま投げ直す——この時点ではまだ何も書いていない（下の手順6より前）。
      if (isAbort(opts.signal)) {
        throw error;
      }
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "llm_failed",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 1,
        llmFailure: describeExtractionFailure(error),
      };
    }

    // Issue #1226 / ADR 0375 決定7（クローン miku の判断）: LLM が返った直後・統合先を
    // 作る前に、eligible を読み直す。1件でも forgotten（`forget()` のみ・`purge()` 済みの
    // どちらも含む）なら、統合先を一切作らずに打ち切る（interface の doc コメント、
    // `consolidate` の JSDoc 手順5の追記参照）。
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
        // 書き込みを1件も試みていない（ADR 0100 と同じ扱い——このトランザクション自体を
        // 開いていない）。
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

    // 6. 統合先を作る。
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 書き込み側3箇所のうちの1つ（consolidate 手順6）。
    // ADR 0394: 統合先の subject（eligible 全件が一致すればその値、割れれば null）の `T + S_x`。
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
    // ADR 0416: 口あり経路では store が同じトランザクションで呼ぶ（`supersedeWithNewMemories` の
    // `opts.buildCreatedEvent`）ため、Memory を受け取って `memoryId`/`digestSnapshot` を埋める形にした
    // （以前は `memoryId: ""` のプレースホルダを呼び出し側が上書きしていた）。
    const buildCreatedEvent = (memory: Memory) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "created",
        at: now,
        // `ConsolidateOptions.actor`/`reason` は、この操作が積むイベントすべてに当たる
        // （統合元の superseded と同じ。`reflect` の created と同じ形）。
        actor,
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "consolidated",
          sources: eligibleIds,
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
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
          // 口を使う経路では store が解決した id で埋める（ADR 0100）。⟹ 監査ログの中身は
          // 口が在る adapter と無い adapter で同一になる。
          ...(supersededById === undefined ? {} : { supersededById }),
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
        },
      }) satisfies NewMemoryEvent;

    const finalOutcomeById = new Map<MemoryId, ConsolidateSourceOutcome>();

    // ------------------------------------------------------------------
    // ADR 0100: 口が在れば、統合先の作成と統合元の supersede を1トランザクションで撃つ。
    // 🔴 フォールバックは**口の不在に対してだけ**。⛔ 投げられたときに今日の経路で
    // 撃ち直さない（「張れなかった」と「張ったが失敗した」を潰さない）。
    //
    // 🔴 ADR 0089 決定5 を**部分的に覆す**: あちらは「予期しない例外が出たらそこで打ち切り、
    // 残りを not_attempted にして返す（投げない）」と決めていた。この経路では**投げる**。
    // 理由——ADR 0089 が「投げない」とした理由は逐語で「部分的に起きたことを呼び出し側から
    // 見えなくしないためである」。1トランザクションでは**部分的に起きたことが無くなる**
    // （統合先の作成も supersede も全部巻き戻る）ので、その理由は満たされたままである。
    // ⚠ 型は変わらないため、例外を受け止めていない呼び手はコンパイルでは気づけない。
    // ADR 0100「引き受ける負債」参照。オーナー承認済み（`docs/autonomy.md:114`）。
    // ------------------------------------------------------------------
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      // Issue #1226 / ADR 0375 決定7: 上の読み直しに続く、書き込みそのものの中での見直し。
      // `@mnemora/postgres` はこれを INSERT/UPDATE と同一トランザクションの `SELECT …
      // FOR UPDATE` として実装する（`abortIfForgotten` の doc コメント参照）——上の
      // 読み直しと、この呼び出しの間に開いた小さな窓を、adapter が対応していれば閉じる。
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
          // ADR 0416（穴 D-3 の続き）: 統合先の `created` も同じトランザクションで積ませる（実装する adapter だけ。
          // 積んだかどうかは戻り値の `createdEventsWritten` で判断する）。
          { now, abortIfForgotten: eligibleIds, buildCreatedEvent },
        );
      } catch (error) {
        if (isSourceMemoryForgottenError(error)) {
          const forgottenLate = new Set(error.forgottenIds);
          return {
            // `news`/`supersede` どちらも rollback された——書き込みを試みていないのと
            // 呼び出し側からは区別が付かない（`consolidate` の JSDoc 手順5の追記参照）。
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
        throw error;
      }

      const consolidated = result.created[0]!;
      // ADR 0416: 名乗られたときだけ別の append を省く（reextract の同じ箇所のコメント参照）。
      // ⛔ 投げられたときに撃ち直さない。
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

    // 口が無い adapter——今日どおりの2段（作成 → supersede ループ）。
    // Issue #1226: `abortIfForgotten` を渡す——この adapter が実装していれば
    // （`@mnemora/postgres` は常に `supersedeWithNewMemories` も実装するため、実際に
    // ここへ来るのは third-party adapter だけである）、上の読み直しに続く見直しになる。
    // 実装していなければ無視されるだけで、今日どおり（上の読み直しだけが保護）。
    let consolidatedMemory: Memory;
    let created: boolean;
    try {
      const createResult = await deps.memoryStore.createMemoryWithOutbox(
        ctx,
        newMemory,
        ["embed"],
        { now, abortIfForgotten: eligibleIds },
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
      throw error;
    }
    // ADR 0416: この口なしの経路の `created` は別コミットのまま（直さない負債）。
    if (created) {
      await deps.eventStore.append(ctx, buildCreatedEvent(consolidatedMemory));
    }
    // embed ジョブは常に outbox 経由（`createMemoryWithOutbox` が積む）。ここでは何もしない
    // — tick() の processEmbedJob が処理する。

    // 7. eligible を1件ずつ superseded へ CAS する（`reextract` のループと同じ形）。
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
        // 競合以外の例外——ここで打ち切り、残りは「見ていない」として返す。例外は外へ投げない
        // （ADR 0089 決定5。⚠ この経路では書き込みが部分的に起きているため、ADR 0100 の
        // 判断はここには当てはまらない——投げずに返す形をそのまま残す）。
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

    // 8. 統合先は既に作られている——途中で supersede が打ち切られても outcome は変わらない
    // （ADR 0089 決定5）。
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

  /**
   * `Runtime.reflect` の実装（Issue #104）。doc コメントは interface 側
   * （`reflect` の JSDoc）にある——ここはアルゴリズムそのものだけ。`consolidate` の実装の
   * 双子だが、書き込みの終盤（手順7以降）が違う——既存の行へは一切書き込まない。
   */
  async function reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult> {
    const target = opts.target;

    // 1. 対象の正規化。
    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      // Issue #204（ADR 0154）: `consolidate` の { seedMemoryId }（ADR 0152）と同じ土台選定。
      // ReflectTarget の doc コメント参照。
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null || isWithdrawnSeed(seed)) {
        // 種が無い——recall を呼ばない。対象は種の id 1件のみとなり、後続の getMany が
        // not_found に分類する（新しい nothingReason は発明しない）。
        // Issue #1136: 種が forget・purge された記憶のときも同じく recall を呼ばない。
        // 後続の getMany が status_not_active(forgotten) に分類する。
        ids = [target.seedMemoryId];
      } else {
        // 種の digest を text にして recall() を1回呼ぶ——{ query } 形とまったく同じ
        // 経路を通す（新しい「似ている」の判定を作らない）。
        // ADR 0353（Issue #338）: `target.activityCounting` をそのまま渡す
        // （省略時は recall() 側の既定 "tenant" に落ちる）。
        // Issue #1200 / ADR 0359: `opts.signal` をそのまま渡す（`consolidate` と同じ形）。
        const recallResult = await recall(
          ctx,
          {
            text: seed.digest,
            activityCounting: target.activityCounting,
            // ADR 0415: この recall は `memories` しか読まない（`totalInScope`・目次帯・`filtered*` は読まない）ので、
            // 件数の集計（`aggregateScope` の `GROUP BY subject_id`）を発行しない。
            scopeAggregate: "skip",
          },
          { signal: opts.signal },
        );
        const minAffinity = target.minAffinity ?? DEFAULT_REFLECT_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          // 種を除く比較は、store が返した種の id（`seed.id`）で行う——`recall()` が返すのも store の id である。
          // 渡された `seedMemoryId` のままだと、`@mnemora/postgres` に大文字の UUID を渡したとき種が近傍にも
          // 入り、同じ記憶が大文字と小文字で2回並んでいた（`uppercase-uuid-store-entry.postgres.test.ts`）。
          .filter((m) => m.memoryId !== seed.id)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと
        // recall() の結果に現れないため——ReflectTarget の doc コメント参照）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      // ADR 0415: 利用者が `scopeAggregate` を明示していなければ "skip"（件数の集計を発行しない）。
      // ここは `memories` しか読まない。明示された値（"exact" を含む）は尊重する。
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
      // store に一切触れない——「見ていない」。
      return {
        outcome: "not_examined",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 2. `getMany` で一括読み、id ごとに「まだ何も書いていない時点」の分類を固定する。
    // 優先順: not_found → status_not_active → expired/not_yet_valid → basis_is_reflected → eligible。
    // Issue #1188（2026-09-29 追記）: status の判定の後・provenance の判定の前に、いまの時点で
    // 有効期間の外にある記憶を弾く。内省の記憶は有効期間を持たない（ADR 0164「射程外にしたもの」1）
    // ので、期限切れ・未到来の記憶を材料にすると、その内容が期限の無い `active` な記憶として
    // `recall()` に戻ってしまうため（`consolidate` の同じ判定と同じ理由・同じ述語）。
    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "expired"; validUntil: Date }
      | { kind: "not_yet_valid"; validFrom: Date }
      | { kind: "basis_is_reflected" }
      | { kind: "eligible" };

    // 述語は `classifyValidity`（`consolidate` と同じ関数）——対象の形（memoryIds/query/seedMemoryId）
    // によらず全候補に当てる。時刻は呼んだ時点の `clock.now()` で固定する（土台ごとに違う時刻を見ない）。
    const validAt = clock.now();

    const uniqueIds = Array.from(new Set(ids));
    // store が返した id と渡された id の突き合わせ（`memoryLookupKeyFor` の doc。`forget` と同じ形）。
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

    /**
     * `ids`（入力順・重複を保つ）を `ReflectBasisOutcome[]` へ写す。`eligible` と分類された
     * id だけ `eligibleOutcome` に委ねる——それ以外はどの分岐でも同じ顔。
     */
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

    // eligible: 重複を除いた「active かつ provenance.kind !== 'reflected'」の id を、`ids`
    // の中で最初に現れた順に並べる。
    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "eligible" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    // 3. eligible が0件なら、LLM を呼ばずに打ち切る（`consolidate` と違い、1件だけでも
    // ここでは打ち切らない——1件からの一般化も意味を持ちうる）。
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

    // 4. dryRun はここで打ち切る。1件も書かない。
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

    // 5. LLM を1回呼ぶ。失敗したら1件も書かない。
    let llmResult: ReflectionLLMResult;
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
      }
    } catch (error) {
      // Issue #1200 / ADR 0359: abort による reject は `"llm_failed"` に丸めず、
      // そのまま投げ直す——この時点ではまだ何も書いていない。
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

    // 6. LLM が「一般化するものは無い」と答えた——書き込みゼロ。
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

    // Issue #1226 / ADR 0375 決定7（クローン miku の判断）: LLM が `'reflected'` を返した
    // 直後・内省の Memory を組み立てる前に、eligible を読み直す。1件でも forgotten
    // （`forget()` のみ・`purge()` 済みのどちらも含む）なら、内省の Memory を一切作らずに
    // 打ち切る（interface の doc コメント、`reflect` の JSDoc 手順6の追記参照）。
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

    // 7. 新しい Memory を1件作る（既存の行へは一切書き込まない——決定4）。
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 書き込み側3箇所のうちの1つ（reflect 手順7）。
    // ADR 0394: 反映先の subject（eligible 全件が一致すればその値、割れれば null）の `T + S_x`。
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
    // Issue #1226: 上の読み直しに続く、書き込みそのものの中での見直し。`@mnemora/postgres`
    // はこれを INSERT と同一トランザクションの `SELECT … FOR UPDATE` として実装する
    // （`abortIfForgotten` の doc コメント参照）。
    //
    // ADR 0416（穴 D-3 の続き）: store が `createMemoriesWithOutboxAndEvents?` を持つなら、内省の Memory と
    // `created` をその口で**1トランザクション**に書く（1件。`abortIfForgotten` も同じ呼び出しに渡す）。
    // 口が無い adapter は今までどおり `createMemoryWithOutbox` + 別の `eventStore.append`（直さない負債）。
    // 🔴 口の有無だけで経路を選ぶ。⛔ 撃って投げられたときに旧経路で撃ち直さない（二重に書きうる。ADR 0100）。
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
          sources: eligibleIds,
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
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
          { now, abortIfForgotten: eligibleIds },
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
          { now, abortIfForgotten: eligibleIds },
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
      throw error;
    }
    if (created && !createdEventWritten) {
      // 8. `created` イベントを1件積む（口が無い adapter の経路。口がある adapter は上の呼び出しで同じ
      // トランザクションに積み済み）。`reflect` はこれ以外のイベントを一切積まない
      // （既存の行の status を動かさないため、`superseded`/`forgotten` の類は存在しない）。
      await deps.eventStore.append(ctx, buildReflectedCreatedEvent(reflectedMemory));
    }
    // embed ジョブは常に outbox 経由（`createMemoryWithOutbox` が積む）。ここでは何もしない
    // — tick() の processEmbedJob が処理する。

    // 9. eligible は全件 used——`reflect` は既存の行を一切動かしていないので、`consolidate`
    // の手順7のような「途中で打ち切られる」分岐は存在しない。
    return {
      outcome: "reflected",
      nothingReason: null,
      reflectedMemoryId: reflectedMemory.id,
      basis: mapBasis((id) => ({ memoryId: id, kind: "used" })),
      llmCalls: 1,
      llmFailure: null,
    };
  }

  return {
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
  };
}
