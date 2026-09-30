/**
 * `exactOptionalPropertyTypes: true` の利用者が、入力側の公開型の任意欄へ `undefined` を渡せることを見る
 * 検査の対象ソース（ADR 0429）。`scripts/__tests__/exact-optional-input-types.test.mjs` が、この
 * ファイルだけを `exactOptionalPropertyTypes: true` で型検査し、診断が0件であることを確かめる。
 *
 * 実行はされない（`_` で始まる名前は使われないまま型検査だけされる）。
 *
 * 1. 名前のある入力型は、任意欄のすべてについて `{ 欄: undefined }` が代入できることを、型の等価で確かめる
 *    （`BadKeys` が `never` でなければ、その行の `true` の代入が赤くなる）。
 * 2. 穴探し8巡目 AA で実際に落ちた3つの呼び出しの形を、そのまま書く。
 *
 * 出力兼用の型（`Memory`・`MemoryEvent`・`RecallBudget` など）は、意図して対象に入れていない
 * （ADR 0429「広げなかった型」）。
 */
import type {
  AbortOptions,
  AggregateScopeOptions,
  ApplyCorrectionInput,
  ArchiveDecayedOptions,
  BuildConsolidatedMemoryParams,
  BuildNewMemoryParams,
  BuildReflectedMemoryParams,
  ClaimKeyOptions,
  ClaimOutboxJobsOptions,
  ConsolidateOptions,
  Ctx,
  DecayParams,
  EraseTenantOptions,
  EraseTenantStoreOptions,
  EventFilter,
  FindCorrectionCandidatesInput,
  ForgetOptions,
  FullLogComparisonInput,
  LexicalFilter,
  MarkContestedGroupOptions,
  MarkContestedOptions,
  MemoryStore,
  NewMemoryEvent,
  NewObservation,
  NewRecallRecord,
  ObserveDocumentInput,
  ObserveEventInput,
  ObserveMemoryUsageInput,
  ObserveUtteranceInput,
  OutboxJob,
  OutboxStore,
  PurgeCompletedJobsOptions,
  PurgeExpiredEventsByRetentionOptions,
  PurgeExpiredEventsForTenantOptions,
  PurgeExpiredEventsOptions,
  PurgeExpiredRecallsOptions,
  PurgeOptions,
  RecallFootprintShape,
  RecallQuery,
  RecallRuntimeDeps,
  RecallScope,
  ReflectOptions,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  ResolveContestedGroupOptions,
  ResolveContestedOptions,
  ResolveOrphanedContestedOptions,
  RestoreArchivedOptions,
  RestoreSupersededOptions,
  Runtime,
  RuntimeConfig,
  RuntimeDeps,
  ScoringInput,
  TickOptions,
  VectorFilter,
} from "@mnemora/core";
import type { CreateBullmqTickDriverOptions } from "@mnemora/bullmq";
import type { AnthropicLLMProviderOptions } from "@mnemora/anthropic";
import type {
  LocalEmbeddingProviderOptions,
  LocalEmbeddingRetryOptions,
} from "@mnemora/local-embedding";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import type { OpenAILLMProviderOptions } from "@mnemora/openai";
import type {
  AnalyzeMemoriesOptions,
  PostgresMemoryStore,
  PostgresOutboxStore,
  RegisterEmbeddingSpaceOptions,
  RunMigrationsOptions,
  SchemaNamespaceOptions,
} from "@mnemora/postgres";
import type {
  EmbeddingProviderConformanceOptions,
  LLMProviderConformanceOptions,
  MemoryStoreConformanceOptions,
  OutboxStoreConformanceOptions,
  RecordedEmbeddingProviderOptions,
  RecordedLLMProviderOptions,
  RelationStoreConformanceOptions,
  TenantSettingsStoreConformanceOptions,
  VectorStoreConformanceOptions,
} from "@mnemora/testkit";
import type { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";

// ---------------------------------------------------------------------------
// 1. 任意欄のすべてに `undefined` を渡せること
// ---------------------------------------------------------------------------

type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/** `{ 欄: undefined }` が代入できない任意欄の名前（無ければ `never`）。 */
type BadKeys<T> = {
  [K in OptionalKeys<T>]: { [P in K]: undefined } extends Pick<T, K> ? never : K;
}[OptionalKeys<T>];

type Ok<T> = [BadKeys<T>] extends [never] ? true : BadKeys<T>;

/** 引数の位置の型（省略可の引数は `undefined` を除く）。 */
type Arg<F extends (...args: never[]) => unknown, I extends number> = NonNullable<Parameters<F>[I]>;

// core: 入力側
export const _core: {
  abort: Ok<AbortOptions>;
  applyCorrection: Ok<ApplyCorrectionInput>;
  claimKey: Ok<ClaimKeyOptions>;
  claimKeyFromStore: Ok<Exclude<NonNullable<ClaimKeyOptions["knownPredicatesFromStore"]>, boolean>>;
  findCorrection: Ok<FindCorrectionCandidatesInput>;
  ctx: Ok<Ctx>;
  eraseTenant: Ok<EraseTenantOptions>;
  purgeForTenant: Ok<PurgeExpiredEventsForTenantOptions>;
  eventFilter: Ok<EventFilter>;
  lexicalFilter: Ok<LexicalFilter>;
  vectorFilter: Ok<VectorFilter>;
  aggregateScope: Ok<AggregateScopeOptions>;
  aggregateScopeDigestBand: Ok<NonNullable<AggregateScopeOptions["digestBand"]>>;
  eraseStore: Ok<EraseTenantStoreOptions>;
  reinforce: Ok<ReinforceOptions>;
  archiveDecayed: Ok<ArchiveDecayedOptions>;
  purgeEvents: Ok<PurgeExpiredEventsOptions>;
  purgeRecalls: Ok<PurgeExpiredRecallsOptions>;
  purgeRetention: Ok<PurgeExpiredEventsByRetentionOptions>;
  requeue: Ok<RequeueEmbedJobsOptions>;
  claimOutbox: Ok<ClaimOutboxJobsOptions>;
  purgeJobs: Ok<PurgeCompletedJobsOptions>;
  outboxJob: Ok<OutboxJob>;
  buildNew: Ok<BuildNewMemoryParams>;
  buildConsolidated: Ok<BuildConsolidatedMemoryParams>;
  buildReflected: Ok<BuildReflectedMemoryParams>;
  recallScope: Ok<RecallScope>;
  newRecall: Ok<NewRecallRecord>;
  utterance: Ok<ObserveUtteranceInput>;
  event: Ok<ObserveEventInput>;
  document: Ok<ObserveDocumentInput>;
  memoryUsage: Ok<ObserveMemoryUsageInput>;
  recallQuery: Ok<RecallQuery>;
  recallDeps: Ok<RecallRuntimeDeps>;
  runtimeConfig: Ok<RuntimeConfig>;
  runtimeDeps: Ok<RuntimeDeps>;
  consolidate: Ok<ConsolidateOptions>;
  reflect: Ok<ReflectOptions>;
  forget: Ok<ForgetOptions>;
  tick: Ok<TickOptions>;
  restoreArchived: Ok<RestoreArchivedOptions>;
  restoreSuperseded: Ok<RestoreSupersededOptions>;
  purge: Ok<PurgeOptions>;
  markContested: Ok<MarkContestedOptions>;
  resolveContested: Ok<ResolveContestedOptions>;
  resolveOrphaned: Ok<ResolveOrphanedContestedOptions>;
  markGroup: Ok<MarkContestedGroupOptions>;
  resolveGroup: Ok<ResolveContestedGroupOptions>;
  decayParams: Ok<DecayParams>;
  scoringInput: Ok<ScoringInput>;
  footprintShape: Ok<RecallFootprintShape>;
  fullLog: Ok<FullLogComparisonInput>;
  newMemoryEventAt: Ok<Pick<NewMemoryEvent, "at">>;
  newObservationRecordedAt: Ok<Pick<NewObservation, "recordedAt">>;
  // port のメソッド引数の opts
  storeCreateObservation: Ok<Arg<MemoryStore["createObservationWithOutbox"], 3>>;
  storeCreateMemory: Ok<Arg<MemoryStore["createMemoryWithOutbox"], 3>>;
  storeUpdateStatus: Ok<Arg<MemoryStore["updateStatus"], 3>>;
  outboxComplete: Ok<Arg<OutboxStore["complete"], 3>>;
  outboxFail: Ok<Arg<OutboxStore["fail"], 4>>;
} = {
  abort: true,
  applyCorrection: true,
  claimKey: true,
  claimKeyFromStore: true,
  findCorrection: true,
  ctx: true,
  eraseTenant: true,
  purgeForTenant: true,
  eventFilter: true,
  lexicalFilter: true,
  vectorFilter: true,
  aggregateScope: true,
  aggregateScopeDigestBand: true,
  eraseStore: true,
  reinforce: true,
  archiveDecayed: true,
  purgeEvents: true,
  purgeRecalls: true,
  purgeRetention: true,
  requeue: true,
  claimOutbox: true,
  purgeJobs: true,
  outboxJob: true,
  buildNew: true,
  buildConsolidated: true,
  buildReflected: true,
  recallScope: true,
  newRecall: true,
  utterance: true,
  event: true,
  document: true,
  memoryUsage: true,
  recallQuery: true,
  recallDeps: true,
  runtimeConfig: true,
  runtimeDeps: true,
  consolidate: true,
  reflect: true,
  forget: true,
  tick: true,
  restoreArchived: true,
  restoreSuperseded: true,
  purge: true,
  markContested: true,
  resolveContested: true,
  resolveOrphaned: true,
  markGroup: true,
  resolveGroup: true,
  decayParams: true,
  scoringInput: true,
  footprintShape: true,
  fullLog: true,
  newMemoryEventAt: true,
  newObservationRecordedAt: true,
  storeCreateObservation: true,
  storeCreateMemory: true,
  storeUpdateStatus: true,
  outboxComplete: true,
  outboxFail: true,
};

// provider・adapter・testkit の options
export const _adapters: {
  anthropic: Ok<AnthropicLLMProviderOptions>;
  bullmq: Ok<CreateBullmqTickDriverOptions>;
  localEmbedding: Ok<LocalEmbeddingProviderOptions>;
  localEmbeddingRetry: Ok<LocalEmbeddingRetryOptions>;
  openaiLlm: Ok<OpenAILLMProviderOptions>;
  openaiEmbedding: Ok<ConstructorParameters<typeof OpenAIEmbeddingProvider>[0]>;
  runMigrations: Ok<RunMigrationsOptions>;
  analyze: Ok<AnalyzeMemoriesOptions>;
  registerSpace: Ok<RegisterEmbeddingSpaceOptions>;
  schema: Ok<SchemaNamespaceOptions>;
  pgStoreReinforce: Ok<Arg<PostgresMemoryStore["updateStatus"], 3>>;
  pgOutboxComplete: Ok<Arg<PostgresOutboxStore["complete"], 3>>;
  inMemoryReinforce: Ok<Arg<InMemoryMemoryStore["updateStatus"], 3>>;
  embeddingConformance: Ok<EmbeddingProviderConformanceOptions>;
  llmConformance: Ok<LLMProviderConformanceOptions<unknown>>;
  memoryStoreConformance: Ok<MemoryStoreConformanceOptions>;
  outboxConformance: Ok<OutboxStoreConformanceOptions>;
  relationConformance: Ok<RelationStoreConformanceOptions>;
  tenantSettingsConformance: Ok<TenantSettingsStoreConformanceOptions>;
  vectorConformance: Ok<VectorStoreConformanceOptions>;
  recordedEmbedding: Ok<RecordedEmbeddingProviderOptions>;
  recordedLlm: Ok<RecordedLLMProviderOptions>;
} = {
  anthropic: true,
  bullmq: true,
  localEmbedding: true,
  localEmbeddingRetry: true,
  openaiLlm: true,
  openaiEmbedding: true,
  runMigrations: true,
  analyze: true,
  registerSpace: true,
  schema: true,
  pgStoreReinforce: true,
  pgOutboxComplete: true,
  inMemoryReinforce: true,
  embeddingConformance: true,
  llmConformance: true,
  memoryStoreConformance: true,
  outboxConformance: true,
  relationConformance: true,
  tenantSettingsConformance: true,
  vectorConformance: true,
  recordedEmbedding: true,
  recordedLlm: true,
};

// ---------------------------------------------------------------------------
// 2. 穴探し8巡目 AA で実際に TS2379 になった呼び出しの形
// ---------------------------------------------------------------------------

declare const rt: Runtime;
declare const ctx: Ctx;
declare const lim: number | undefined;
declare const key: string | undefined;
declare const signal: AbortSignal | undefined;

export async function _callSites(): Promise<void> {
  new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 1536, apiKey: key });
  new OpenAILLMProvider({ model: "gpt-4o-mini", apiKey: key });
  await rt.tick(ctx, { leaseMs: 1000, signal, limit: lim });
  await rt.recall(ctx, { text: "x", limit: lim });
  await rt.observe(
    ctx,
    { kind: "utterance", text: "x", subjectId: key, externalId: key },
    { signal },
  );
}
