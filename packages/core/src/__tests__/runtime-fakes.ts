import type { ClaimKey } from "../claim-key.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { Relation, RelationKind, RelationStore } from "../interfaces/relation-store.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import type {
  ClaimOutboxJobsOptions,
  OutboxStore,
  PurgeCompletedJobsOptions,
  PurgeCompletedJobsResult,
} from "../interfaces/outbox-store.js";
import type { OutboxJobKind } from "../interfaces/scheduler.js";
import {
  assertValidDecayClock,
  assertValidEventRetentionDays,
  assertValidEventRetentionKind,
  assertValidHalfLifeRecalls,
  assertValidTaxonomyMode,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_RECALLS,
  DEFAULT_TAXONOMY_MODE,
} from "../interfaces/tenant-settings-store.js";
import type {
  DecayClock,
  EventRetention,
  EventRetentionSetting,
  TaxonomyMode,
  TenantSettingsStore,
} from "../interfaces/tenant-settings-store.js";
import type { VectorStore, VectorFilter, VectorHit } from "../interfaces/vector-store.js";
import type { LexicalStore, LexicalFilter, LexicalHit } from "../interfaces/lexical-store.js";
import type { NotIndexedReason, RecallResult, RecalledScore, ScoreBreakdown } from "../recall.js";
import { FILTERED_CONDITION_SCOPE_RELATION, RecallResultSchema } from "../recall.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import { isHalfLifeRecallsInRange } from "../interfaces/tenant-settings-store.js";
import {
  DigestSourceSchema,
  EmbeddingStatusSchema,
  isStrengthInRange,
  MAX_STRENGTH,
  MemoryStatusSchema,
} from "../memory.js";
import { ProvenanceKindSchema } from "../provenance.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { EventActor, MemoryEvent, NewMemoryEvent, EventFilter } from "../event.js";
import { MemoryEventKindSchema } from "../event.js";
import type { EventId } from "../ids.js";
import {
  ContestedGroupMembershipMismatchError,
  isEmbeddingStatusRollback,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
} from "../interfaces/memory-store.js";
import type {
  AggregateScopeOptions,
  ArchiveDecayedOptions,
  ArchiveDecayedResult,
  EraseTenantResult,
  EraseTenantStoreOptions,
  EraseTenantStoreResult,
  LabelSummary,
  MemoryStore,
  PurgeExpiredEventsByRetentionOptions,
  PurgeExpiredEventsByRetentionOutcome,
  PurgeExpiredEventsOptions,
  PurgeExpiredRecallsOptions,
  PurgeExpiredRecallsResult,
  PurgeExpiredEventsResult,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "../interfaces/memory-store.js";
import { computeEventRetentionCutoff } from "../event-retention-purge.js";
import type { NewRecallRecord, RecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { OutboxJobRecord } from "../outbox.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "../strategies/decay.js";
import { resolveIdempotentCreate } from "../idempotent-create.js";
import {
  assertWellFormedCtx,
  assertWellFormedFilter,
  assertWellFormedIdentifier,
} from "../identifier.js";
import type { IdempotentCreateResult } from "../idempotent-create.js";

/**
 * ADR 0543: 孤立サロゲートを U+FFFD に置き換える（`packages/testkit` の `__fixtures__/well-formed-text.ts` の
 * `replaceLoneSurrogates` と同じ規則。`@mnemora/postgres` は `text` 列に入る文字列を node-postgres が UTF-8 へ変換するとき、
 * 孤立サロゲートを 1 単位ずつ U+FFFD に置き換える）。core は testkit を import できない（`dependency-boundary.test.ts`）ので写しを持つ。
 * 対象は `text` 列に入る欄だけ（識別子は ADR 0423 が断る。`jsonb` 列の欄は触らない）。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function wf(value: string): string;
function wf(value: string | null): string | null;
function wf(value: string | undefined): string | undefined;
function wf(value: string | null | undefined): string | null | undefined;
function wf(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.replace(LONE_SURROGATE, "\uFFFD") : value;
}
function wfClaimKey<T extends ClaimKey | null | undefined>(claimKey: T): T {
  if (claimKey === null || claimKey === undefined) return claimKey;
  return { ...claimKey, subject: wf(claimKey.subject), predicate: wf(claimKey.predicate) } as T;
}

/**
 * 読みの口の条件の日時が Invalid Date なら断る（ADR 0493。`packages/testkit` の `assertQueryDate` と同じ判定・同じ文面）。
 * Postgres はクエリの時点で `timestamptz` への変換を拒む。省略（`undefined`/`null`）は検査しない。
 */
function assertFakeQueryDate(method: string, field: string, value: Date | null | undefined): void {
  if (value != null && Number.isNaN(value.getTime())) {
    throw new Error(`${method}: ${field} must be a valid Date (got Invalid Date)`);
  }
}

/** 読みの口の条件の整数（通し番号）が `bigint` へ渡せる整数でなければ断る（ADR 0493。testkit の `assertQueryInteger` と同じ文面）。省略は検査しない。 */
function assertFakeQueryInteger(
  method: string,
  field: string,
  value: number | null | undefined,
): void {
  if (value != null && !Number.isInteger(value)) {
    throw new Error(`${method}: ${field} must be an integer (got ${value})`);
  }
}

/** `bigint` の範囲まで見る版（ADR 0493。testkit の `assertQueryBigint` と同じ判定）。 */
function assertFakeQueryBigint(
  method: string,
  field: string,
  value: number | null | undefined,
): void {
  assertFakeQueryInteger(method, field, value);
  if (value != null && (value >= 2 ** 63 || value < -(2 ** 63))) {
    throw new Error(`${method}: ${field} must fit in a Postgres bigint (got ${value})`);
  }
}

/** `memory_events.size_before_bytes`（int4）へ書けない数を断る（ADR 0493。testkit の `assertInt4Column` と同じ判定）。数でない値は見ない。 */
function assertFakeInt4Column(method: string, field: string, value: unknown): void {
  if (typeof value !== "number") return;
  if (!Number.isInteger(value)) {
    throw new Error(`${method}: ${field} must be an integer (got ${value})`);
  }
  if (value < -(2 ** 31) || value > 2 ** 31 - 1) {
    throw new Error(
      `${method}: ${field} does not fit in a Postgres "integer" (int4) column (got ${value})`,
    );
  }
}

/** 文字列が NUL か孤立サロゲートを含むか（testkit の `memory-event-check.ts` の `hasNulOrLoneSurrogate` と同じ判定）。 */
function fakeHasNulOrLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function fakeContainsNulOrLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return fakeHasNulOrLoneSurrogate(value);
  if (Array.isArray(value)) return value.some((v) => fakeContainsNulOrLoneSurrogate(v));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([k, v]) => fakeHasNulOrLoneSurrogate(k) || fakeContainsNulOrLoneSurrogate(v),
    );
  }
  return false;
}

function fakeContainsBigInt(value: unknown): boolean {
  if (typeof value === "bigint") return true;
  if (Array.isArray(value)) return value.some((v) => fakeContainsBigInt(v));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => fakeContainsBigInt(v));
  }
  return false;
}

/** 列挙の列（`memories.status` など）へ書けない値を断る（ADR 0493。testkit の `assertStorableMemoryColumn` と同じ文面）。 */
function assertFakeMemoryColumn(
  column: "status" | "digest_source" | "embedding_status",
  value: unknown,
): void {
  const schema =
    column === "status"
      ? MemoryStatusSchema
      : column === "digest_source"
        ? DigestSourceSchema
        : EmbeddingStatusSchema;
  if (!schema.safeParse(value).success) {
    throw new Error(
      `memories.${column} must be one of ${schema.options.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
}

/** `eraseTenant` の `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む（ADR 0493。負数そのものは拒まない）。 */
function assertFakeEraseLimit(limit: number): void {
  assertFakeQueryBigint("eraseTenant", "limit", limit);
}

/**
 * outbox の行を**実際に書く**ときに Postgres が拒む入力を、何も書く前に断る（ADR 0493。testkit の `assertOutboxRowsWritable` と同じ判定）。
 * `jobKinds` の要素は `text` 列なので NUL を、`opts.now` は `timestamptz` なので Invalid Date を、`opts.claimedBy` は `text` 列なので NUL を断る。
 * 行を書かない（`jobKinds` が空・冪等の既存の行に当たる）ときは見ない。
 */
function assertFakeOutboxRowsWritable(
  method: string,
  jobKinds: ReadonlyArray<string>,
  opts: { now?: Date | undefined; claimedBy?: string | undefined } | undefined,
): void {
  if (jobKinds.length === 0) return;
  assertFakeQueryDate(method, "opts.now", opts?.now);
  if (jobKinds.some((kind) => typeof kind === "string" && kind.includes("\u0000"))) {
    throw new Error(`${method}: jobKinds must not contain NUL characters (U+0000)`);
  }
  if (typeof opts?.claimedBy === "string" && opts.claimedBy.includes("\u0000")) {
    throw new Error(`${method}: claimedBy must not contain NUL characters (U+0000)`);
  }
}

// `packages/testkit` の `in-memory-memory-store.ts` の同名の関数と同じ判定（Issue #816 の NUL 側の残り）。
/**
 * `value` を `jsonb` 列へ書くとき、Postgres が NUL（U+0000）で拒むかどうか。
 *
 * `packages/postgres` は `jsonb` 列へ `JSON.stringify(value)` を送る。Postgres は、
 * 文字列の値にもキーにも `\u0000` が現れると `unsupported Unicode escape sequence` で拒む
 * （実測）。同じ文字列を JSON として往復させた値を辿るので、`toJSON` などによる変換も
 * Postgres が受け取る形と同じになる。文字どおりの `\\u0000`（バックスラッシュ + `u0000`）は
 * NUL ではないので拒まない。
 */
function jsonContainsNul(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (text === undefined || !text.includes("\\u0000")) {
    return false;
  }
  const visit = (v: unknown): boolean => {
    if (typeof v === "string") {
      return v.includes("\u0000");
    }
    if (Array.isArray(v)) {
      return v.some(visit);
    }
    if (v !== null && typeof v === "object") {
      return Object.entries(v).some(([k, inner]) => k.includes("\u0000") || visit(inner));
    }
    return false;
  };
  return visit(JSON.parse(text));
}

/**
 * ADR 0506: `createRecall` で、Postgres が `recalls` の行を書けずに拒む入力を、何も書く前に断る
 * （testkit の `InMemoryMemoryStore` の `assertRecallRecordStorable` と同じ判定。ADR 0480 の `createdAt` は呼び出し側）。
 * `subjectId` は `text` 列（NUL を拒む）。`query`・`omitted`・`usage`・`indexBand`・`explain`・`returnedMemories` は
 * `NOT NULL` の `jsonb` 列、`budget` は `jsonb` 列で、`packages/postgres` は `JSON.stringify` した値を送る——
 * NUL を含めば拒み、JSON にならない値（`undefined`）は `NOT NULL` の列で拒む。
 */
function assertFakeRecallRecordStorable(record: NewRecallRecord): void {
  if (record.subjectId != null && record.subjectId.includes("\u0000")) {
    throw new Error("createRecall: subjectId must not contain NUL characters (U+0000)");
  }
  const jsonColumns: Array<[string, unknown, boolean]> = [
    ["query", record.query, true],
    ["budget", record.budget, false],
    ["omitted", record.omitted, true],
    ["usage", record.usage, true],
    ["indexBand", record.indexBand, true],
    ["explain", record.explain, true],
    ["returnedMemories", record.returnedMemories, true],
  ];
  for (const [field, value, required] of jsonColumns) {
    if (required && JSON.stringify(value) === undefined) {
      throw new Error(
        `createRecall: ${field} must be JSON-serializable (Postgres "jsonb" column is NOT NULL)`,
      );
    }
    if (jsonContainsNul(value)) {
      throw new Error(`createRecall: ${field} must not contain NUL characters (U+0000)`);
    }
  }
}

/**
 * Observation を書く口（`createObservation` / `createObservationWithOutbox`）で、Postgres が
 * NUL を拒む欄を先に検査する（Issue #816 の NUL 側の残り）。`subjectId`・`externalId`・
 * `kind` は `text` 列（`invalid byte sequence for encoding "UTF8": 0x00`）、`payload`・
 * `attributes` は `jsonb` 列（`unsupported Unicode escape sequence`）。Postgres は
 * `externalId` の衝突を見る前、クエリの時点で拒むので、冪等の判定より前に見る。
 */
function assertObservationHasNoNul(owner: string, input: NewObservation): void {
  for (const [field, value] of [
    ["subjectId", input.subjectId],
    ["externalId", input.externalId],
    ["kind", input.kind],
  ] as const) {
    if (value != null && value.includes("\u0000")) {
      throw new Error(`${owner}: ${field} must not contain NUL characters (U+0000)`);
    }
  }
  if (jsonContainsNul(input.payload)) {
    throw new Error(`${owner}: payload must not contain NUL characters (U+0000)`);
  }
  if (jsonContainsNul(input.attributes ?? {})) {
    throw new Error(`${owner}: attributes must not contain NUL characters (U+0000)`);
  }
}

/**
 * `packages/core` 自身の runtime テスト用フェイク一式。
 *
 * **`@mnemora/testkit` を import しない。** core は誰にも依存されるが誰にも依存しない
 * （docs/architecture.md §4）——`testkit` は `core` に依存するパッケージであり、逆方向の
 * 依存を core のテストからも作らない。ここでのフェイクは testkit の in-memory 実装と
 * 似ているが意図的に独立している（1つを直せばもう1つが壊れる、という結合を作らない）。
 */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

type OutboxJobMutable = OutboxJobRecord;

/**
 * `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。`FakeEventStore.append`
 * と `FakeMemoryStore.updateStatusWithEvent`（ADR 0031）の両方がこれを使う
 * ——`packages/testkit` の `buildStoredMemoryEvent`（`in-memory-event-store.ts`）と
 * 同じ形だが、ファイル冒頭のコメントの通り意図的に独立している。
 */
/**
 * 9回目の棚卸し: testkit の fixture（`assertStorableMemoryEvent`、`memory-event-check.ts`）と `@mnemora/postgres`
 * （`memory_events` の CHECK 制約）が拒むイベントの形のうち、この Fake が持っていなかった2つを同じく拒む——
 * `kind` が列挙に無いとき、`events_purged` なのに `memoryId` が `null` でないとき。文面は fixture と同じ形。
 * `buildStoredEvent`（イベントを積むすべての口の合流点）が呼ぶ。
 */
function assertStorableFakeEvent(event: NewMemoryEvent): void {
  if (event.kind === "events_purged" && event.memoryId !== null) {
    throw new Error(
      `memory_events.memoryId must be null for kind "events_purged" (got ${JSON.stringify(event.memoryId)})`,
    );
  }
  if (!MemoryEventKindSchema.safeParse(event.kind).success) {
    throw new Error(
      `memory_events.kind must be one of ${MemoryEventKindSchema.options.join(", ")} (got ${JSON.stringify(event.kind)})`,
    );
  }
}

function buildStoredEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  assertBuildableFakeEvent(event);
  return {
    id: nextId("evt"),
    tenantId: ctx.tenantId,
    // ADR 0469: uuid の列は小文字の正規形で読み戻る（`@mnemora/postgres`）。大文字で渡された `memoryId` も小文字にそろえて積む。
    memoryId: event.memoryId === null ? null : event.memoryId.toLowerCase(),
    kind: event.kind,
    at: event.at ?? new Date(),
    actor: event.actor,
    // ADR 0543: `memory_events.digest_snapshot` は `text` 列。孤立サロゲートは U+FFFD に置き換えて保存する。
    digestSnapshot: wf(event.digestSnapshot) ?? null,
    sizeBeforeBytes: event.sizeBeforeBytes ?? null,
    meta: event.meta,
  };
}

/**
 * `buildStoredEvent` が投げる検査だけを、イベントを組み立てずに走らせる（id を採番しない）。
 * `supersedeWithNewMemories` は `meta.supersededById` に作った記憶の id を入れるので、記憶を作る前には
 * イベントを組み立て切れない——そこで、記憶を作る前にこの検査だけを全対象について済ませる
 * （testkit の fixture が同じ段で `assertStorableMemoryEvent` を呼ぶのと同じ形）。
 */
function assertBuildableFakeEvent(event: NewMemoryEvent): void {
  // ADR 0493: testkit の `assertStorableMemoryEvent`（`memory-event-check.ts`）と同じ判定。BigInt は他のどれより先に断る
  // （Postgres は `JSON.stringify` の時点で `TypeError` になり、問い合わせを送らない）。
  if (fakeContainsBigInt(event.actor) || fakeContainsBigInt(event.meta)) {
    throw new TypeError(`Do not know how to serialize a BigInt`);
  }
  // Issue #807: `memory_events.at` は Postgres の `timestamptz` 列であり、Invalid Date
  // （`.getTime()` が `NaN`）を渡すと `PostgresEventStore.append` はクエリ実行時に
  // `invalid input syntax for type timestamp with time zone` で例外を投げる（実測。
  // `packages/testkit` の `buildStoredMemoryEvent` と同じ判定・同じ理由）。`event.at` が
  // 省略されている（`undefined`）場合は「無い」であって Invalid Date ではないので
  // 検査しない——`buildStoredEvent` の `?? new Date()` で現在時刻になる。`buildStoredEvent` は `FakeEventStore.append`
  // だけでなく `FakeMemoryStore` の `updateStatusWithEvent` 等、イベントを積むすべての口が
  // 通る単一の合流点であり、ここで検査すればそれらすべてを一度に覆える。
  if (event.at !== undefined && Number.isNaN(event.at.getTime())) {
    throw new Error(`memory_events.at must be a valid Date (got Invalid Date)`);
  }
  assertStorableFakeEvent(event);
  if (fakeContainsNulOrLoneSurrogate(event.actor)) {
    throw new Error(
      `memory_events.actor must not contain NUL (U+0000) or a lone surrogate code unit`,
    );
  }
  if (fakeContainsNulOrLoneSurrogate(event.meta)) {
    throw new Error(
      `memory_events.meta must not contain NUL (U+0000) or a lone surrogate code unit`,
    );
  }
  if (typeof event.digestSnapshot === "string" && event.digestSnapshot.includes("\u0000")) {
    throw new Error(`memory_events.digestSnapshot must not contain NUL characters (U+0000)`);
  }
  // `size_before_bytes` は int4。`markContestedGroup`・`resolveContestedGroup` だけは Postgres が `jsonb` の配列で渡すので
  // `NaN`・`±Infinity` が `null` になって通る（testkit の `asJsonSerializedSizeBeforeBytes`）。この Fake はそこまで写さず、全口で断る。
  assertFakeInt4Column("memory_events", "sizeBeforeBytes", event.sizeBeforeBytes);
}

/**
 * Issue #207/#933 PR2（ADR 0381）: `memory_relations` の1行相当。
 * `packages/testkit` の `StoredRelation`（`in-memory-memory-store.ts`）と同じ形——
 * このファイルは意図的に独立している（ファイル冒頭のコメント参照）ので複製する。
 */
interface FakeStoredRelation {
  id: string;
  tenantId: string;
  fromMemoryId: MemoryId;
  toMemoryId: MemoryId;
  kind: RelationKind;
  createdAt: Date;
}

class FakeBackingStore {
  observations = new Map<string, Observation>();
  memories = new Map<string, Memory>();
  extractionIndex = new Map<string, MemoryId>();
  usages = new Set<string>();
  recalls = new Map<string, NewRecallRecord & { tenantId: string; createdAt: Date }>();
  outboxJobs: OutboxJobMutable[] = [];
  /**
   * ADR 0031: `FakeMemoryStore.updateStatusWithEvent` と `FakeEventStore` が共有する
   * memory_events 相当の配列。以前は `FakeEventStore` が独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`outboxJobs` と同じ「同一トランザクションで
   * 書く2つの書き込み先を共有する」という形に揃えた。
   */
  events: MemoryEvent[] = [];
  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと2・5:
   * `tenant_activity.activity_seq` 相当。`FakeMemoryStore.createRecall` と
   * `FakeTenantSettingsStore.getActivitySeq` が同じ `FakeBackingStore` を共有することで、
   * 本番の「`MemoryStore` と `TenantSettingsStore` は別 adapter だが、`activity_seq` は
   * `createRecall` と同一トランザクションで進む」という契約を、フェイクの世界でも
   * 「書く側（`createRecall`）と読む側（`getActivitySeq`）が同じ値を見る」という
   * 観測可能な形で再現する。
   */
  activitySeq = new Map<string, number>();
  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `tenant_subject_activity` 相当。`tenantId` → `subjectId` → `S_x`
   * の2段の `Map`。`FakeMemoryStore.createRecall`（書く側）と
   * `FakeTenantSettingsStore.getSubjectActivitySeqs`/`hasSubjectActivityCounters`
   * （読む側）が同じ `FakeBackingStore` を共有する——`activitySeq`（上）と同じ理由。
   */
  subjectActivitySeq = new Map<string, Map<string, number>>();
  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `labels` 相当。`packages/testkit` の `InMemoryMemoryStore` と同じ key 形式
   * （`JSON.stringify([tenantId, name])`）——`recall-taxonomy-filter.test.ts` が `listLabels`/
   * `registerLabel` 経由でここを操作する。
   */
  labels = new Map<string, LabelSummary>();
  /**
   * Issue #995/#1207 / [ADR 0375](../../../docs/decisions/0375-purge-scope-widened.md):
   * `memory_labels` 相当——`(tenantId, memoryId)` からその Memory が紐づく label 名の
   * 集合へ。`packages/testkit` の `InMemoryMemoryStore.memoryLabels` と同じ形・同じ理由
   * ——`purgeMemory` がこの紐付けを外し `proposedCount` を減らすために使う。
   */
  memoryLabels = new Map<string, Set<string>>();
  /**
   * Issue #1232 / [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * `tenant_settings.event_retention_days` 相当。`FakeMemoryStore.purgeExpiredEventsByRetention`
   * （読む側）と `FakeTenantSettingsStore.setEventRetention`（書く側）が同じ `FakeBackingStore` を
   * 共有する——`activitySeq`（上）と同じ理由。キーが無ければ `unset`、`null` なら `unlimited`、
   * 数値なら `days` （`packages/testkit` の `InMemoryMemoryStore.eventRetentionDays` と同じ形）。
   */
  eventRetentionDays = new Map<string, number | null>();
  /**
   * Issue #207/#933 PR2（ADR 0381）: `memory_relations` 相当。`packages/testkit` の
   * `InMemoryMemoryStore.relations`（`StoredRelation`）と同じ形——このファイルは
   * 意図的に独立している（ファイル冒頭のコメント参照）ので、ここでも同じ形を
   * 複製して持つ。`FakeMemoryStore.markContestedGroup`/`resolveContestedGroup` が書き、
   * `FakeRelationStore.listRelated` が読む。
   */
  relations: FakeStoredRelation[] = [];

  extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    // 区切り文字で繋がず、`JSON.stringify` の配列で表す。`tenantId`・`extractorVersion`・
    // `contentHash` は呼び手の値で `:` を含んでよく、繋ぐと別の組と同じキーになる
    // （`joined-string-keys.postgres.test.ts`）。
    return JSON.stringify([tenantId, sourceObservationId, extractorVersion, contentHash]);
  }
}

/** ADR 0431: `markContestedGroup` が書いても状態が変わらないメンバー（既に群の一員として contested）。 */
function isUnchangedGroupMember(memory: Pick<Memory, "status" | "contestedWithId">): boolean {
  return memory.status === "contested" && (memory.contestedWithId ?? null) === null;
}

/**
 * ⭐ Issue #329 / [ADR 0173](../../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md):
 * `aggregateScope` が `filteredDecayed` を数えるための述語。
 *
 * **`recall-runtime.ts` の `survivesDecayGate`（段1の押し下げ・後置フィルタの両方が使う
 * もの）の否定**であり、`PostgresMemoryStore.aggregateScope` の `isDecayed`（SQL）と
 * 同じものでなければならない。`period`/`validAt` と同じ「4箇所の複製」の5つ目である
 * ——**この一致そのものを、適合テストと `recall-decay-cross-day.postgres.test.ts` が検算する。**
 *
 * - 壁時計の軸が生きている: `decayFloorAt > decayFloorAtAfter`（狭義の `>`）
 * - 活動時計の軸が生きている: `decayFloorSeq` が無い（この軸に床が無い、ADR 0165 決めたこと4）
 *   か `decayFloorSeq > decayFloorSeqAfter`
 * - `decayFloorAnyAxis`（`decay_clock: 'either'`）: 2軸の **OR**（最も緩い）
 * - 軸が1本も渡されていない（ゲート無効）: 常に `false`（0件と数える）
 */
function isDecayedForScope(
  memory: Pick<Memory, "decayFloorAt" | "decayFloorSeq" | "subjectId">,
  scope: RecallScope,
  // ADR 0353（Issue #338）: このテナントの subject 単位カウンタ（`Map<subjectId, S_x>`）。
  // `scope.decayFloorSeqUsesSubjectCounters` が true のときだけ参照する。
  subjectActivitySeqByTenant: Map<string, number> | undefined,
): boolean {
  const { decayFloorAtAfter, decayFloorSeqAfter } = scope;
  if (decayFloorAtAfter === undefined && decayFloorSeqAfter === undefined) return false;
  const wallAlive =
    decayFloorAtAfter === undefined ? undefined : memory.decayFloorAt > decayFloorAtAfter;
  const effectiveDecayFloorSeqAfter =
    decayFloorSeqAfter === undefined
      ? undefined
      : scope.decayFloorSeqUsesSubjectCounters === true && memory.subjectId != null
        ? decayFloorSeqAfter + (subjectActivitySeqByTenant?.get(memory.subjectId) ?? 0)
        : decayFloorSeqAfter;
  const activityAlive =
    effectiveDecayFloorSeqAfter === undefined
      ? undefined
      : memory.decayFloorSeq === undefined ||
        memory.decayFloorSeq === null ||
        memory.decayFloorSeq > effectiveDecayFloorSeqAfter;
  if (scope.decayFloorAnyAxis === true && wallAlive !== undefined && activityAlive !== undefined) {
    return !(wallAlive || activityAlive);
  }
  if (wallAlive !== undefined && activityAlive !== undefined) return !(wallAlive && activityAlive);
  if (wallAlive !== undefined) return !wallAlive;
  return !activityAlive;
}

/**
 * Issue #881 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md) 追記
 * （2026-09-26、クローン miku の判断）: `listLabels?` の `name` 昇順を**コードポイント順**
 * （Postgres の `COLLATE "C"` と同じ、バイト順）と定めた。`packages/testkit` の
 * `InMemoryMemoryStore`（`in-memory-memory-store.ts` の同名関数）と同じ実装。
 *
 * **文字列同士を素の `<`/`>` で比較しない。**JS の `<`/`>` は UTF-16 コード単位を比較する
 * ため、サロゲートペア（U+10000 以上、絵文字など）を含む名前では、サロゲート自体の値
 * （U+D800〜U+DFFF）が U+E000〜U+FFFF の BMP 文字より小さいコード単位として並んでしまい、
 * 実際のコードポイント順と食い違う（追記2、2026-09-26。詳細は `packages/testkit` の
 * 同名関数の doc コメントを見ること）。
 *
 * ⟹ 先頭から `String.prototype.codePointAt` で1文字（サロゲートペアなら2コード単位）ずつ
 * 読み、コードポイントの値そのものを比較する。UTF-8 のバイト順（Postgres の
 * `COLLATE "C"`）はコードポイント順と単調に対応するため、この実装は Postgres と一致する。
 */
function compareLabelName(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    // i/j はループ条件で length 未満と保証済みなので、その位置に有効なコード単位が必ずある。
    const aCodePoint = a.codePointAt(i)!;
    const bCodePoint = b.codePointAt(j)!;
    if (aCodePoint !== bCodePoint) {
      return aCodePoint < bCodePoint ? -1 : 1;
    }
    // サロゲートペア（コードポイントが BMP 外）なら2コード単位、それ以外は1コード単位進む。
    i += aCodePoint > 0xffff ? 2 : 1;
    j += bCodePoint > 0xffff ? 2 : 1;
  }
  // ここまで全コードポイントが一致——残りがある方（長い方）が後ろ。
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/**
 * ADR 0521: 操作の対象の id を小文字にそろえる（`@mnemora/postgres` は uuid 型の列で比べる・入口で
 * `normalizeUuidCase` を掛けるので、大文字の uuid を同じ記憶として受ける）。この Fake の id は小文字の
 * `mem-N` だけなので、小文字にそろえても別の id と混ざらない。
 */
function normId<T extends string>(id: T): T {
  return id.toLowerCase() as T;
}
function normOptId<T extends string>(id: T | null | undefined): T | null | undefined {
  return id === null || id === undefined ? id : normId(id);
}
function normPairSide<T extends { id: MemoryId; supersededById?: MemoryId }>(side: T): T {
  return {
    ...side,
    id: normId(side.id),
    ...(side.supersededById === undefined ? {} : { supersededById: normId(side.supersededById) }),
  };
}

export class FakeMemoryStore implements MemoryStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * ADR 0054: 判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから出す
   * （`InMemoryMemoryStore.createObservationIdempotent` と同じ形・同じ理由）。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Observation> {
    // ADR 0543: `kind`（`text` 列。識別子ではない）の孤立サロゲートは U+FFFD に置き換えて保存する。
    input = { ...input, kind: wf(input.kind) };
    assertObservationHasNoNul("FakeMemoryStore", input);
    // ADR 0493: `subjectId`・`externalId` の孤立サロゲートも Postgres・InMemory は断る（`MalformedIdentifierError`）。
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    // 9回目の棚卸し: testkit の fixture と `@mnemora/postgres`（`timestamptz` 列）と同じく、Invalid Date の日時を拒む。
    for (const [field, value] of [
      ["recordedAt", input.recordedAt],
      ["occurredAt", input.occurredAt],
      ["validFrom", input.validFrom],
      ["validUntil", input.validUntil],
    ] as const) {
      if (value != null && Number.isNaN(value.getTime())) {
        throw new Error(`FakeMemoryStore: ${field} must be a valid Date (got Invalid Date)`);
      }
    }
    const existing = input.externalId
      ? [...this.backing.observations.values()].find(
          (o) => o.tenantId === ctx.tenantId && o.externalId === input.externalId,
        )
      : undefined;
    return resolveIdempotentCreate(existing, () => {
      beforeInsert?.();
      const observation: Observation = {
        id: nextId("obs"),
        tenantId: ctx.tenantId,
        subjectId: input.subjectId ?? null,
        externalId: input.externalId ?? null,
        kind: input.kind,
        payload: input.payload,
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt ?? new Date(),
        // Issue #280: `occurredAt` と同じ経路。
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        // Issue #152（ADR 0312）: 同じ経路。runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
      };
      this.backing.observations.set(observation.id, observation);
      return observation;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    assertWellFormedCtx(ctx);
    return this.createObservationIdempotent(ctx, input).value;
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    assertWellFormedCtx(ctx);
    const observation = this.backing.observations.get(normId(id));
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return observation;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date; claimedBy?: string },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    // ADR 0493: 行を実際に書くときだけ、outbox の行が書けるか（`jobKinds`・`opts.now`・`opts.claimedBy`）を、何も書く前に見る。
    const { value: observation, created } = this.createObservationIdempotent(ctx, input, () =>
      assertFakeOutboxRowsWritable("createObservationWithOutbox", jobKinds, opts),
    );
    if (!created) {
      return { observation, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueJob(ctx, kind, { observationId: observation.id }, opts),
    );
    // Postgres は INSERT ... RETURNING で行の複製を返す。生の参照を返すと、後の claim が
    // 返した job の `attempts` を書き換え、CAS（ADR 0142）の食い違いが隠れる（ADR 0407）。
    return { observation, created: true, jobs: jobs.map((job) => ({ ...job })) };
  }

  private enqueueJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
    opts?: { now?: Date; claimedBy?: string },
  ): OutboxJobRecord {
    // ADR 0543: `outbox.kind`・`outbox.claimed_by` は `text` 列。孤立サロゲートは U+FFFD に置き換えて保存する。
    kind = wf(kind);
    const claimedBy = wf(opts?.claimedBy);
    const job: OutboxJobMutable = {
      id: nextId("job"),
      tenantId: ctx.tenantId,
      kind,
      payload,
      availableAt: new Date(),
      // ADR 0407: `claimedBy` を渡されたら「その名前で claim 済み」（`attempts: 1`）で作る。
      claimedAt: claimedBy === undefined ? null : (opts?.now ?? new Date()),
      claimedBy: claimedBy ?? null,
      attempts: claimedBy === undefined ? 0 : 1,
      completedAt: null,
      failedAt: null,
      lastError: null,
      createdAt: new Date(),
    };
    this.backing.outboxJobs.push(job);
    return job;
  }

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じる
   * （`InMemoryMemoryStore.createMemoryIdempotent` と同じ形・同じ理由）。
   *
   * Issue #768（調査時、`packages/testkit` の `describeMemoryStoreConformance` へ
   * この Fake を一時的に通して実測——その通し方自体は採らず、PR には載せていない。
   * 見つけた食い違いのうち Fake 側のバグだった7件を、下の doc と同じ形で
   * `fake-*.test.ts` の専用テストとして固定している）: ADR 0078 の値域検査
   * （{@link isStrengthInRange}）を、`InMemoryMemoryStore` と同じ位置（冪等衝突の判定
   * より前／何も書く前）に持つ。既存の `packages/core` テストで無効な `strength` を
   * 使うものは無い（実測: 全テストファイルを通して実行して確認）。
   *
   * ⚠ **ADR 0140 の `ContestedWithoutCompanionError` 相当のガードと、ADR 0125 の
   * `halfLifeHours` 値域検査は、意図して持たない。**
   *
   * - ADR 0140 決定2が明記するとおり、`FakeMemoryStore` はこのガードの対象外
   *   ——`packages/core` 自身の単体テスト（`recall-pipeline.test.ts` 等）が ADR 0136
   *   の読み取り側の防御（対向未解決の `contested` は単位を組まない）を検査するには、
   *   まさにこのガードが塞ごうとする壊れた状態（`contestedWithId` 無しの `contested`）
   *   を `FakeMemoryStore` 経由で構成できる必要がある。ガードを足すとそれらの
   *   回帰テストが構造的に書けなくなる（Issue #768 の調査で実測: 19件の既存テストが
   *   赤くなった。`recall-pipeline.test.ts` ×12 など。下の `halfLifeHours` 側の2件とは
   *   別枠——合わせて21件が Issue #768 のコメントに載っている）。詳細は ADR 0140
   *   「決定2」「開いている穴1」「これが覆るとしたら」。
   * - ADR 0125「引き受ける負債」節が同じ形で明記するとおり、`FakeMemoryStore` には
   *   `halfLifeHours` の値域検査も元から無い。`recall-pipeline.test.ts`
   *   （score_not_comparable の三分割、ADR 0153）が `halfLifeHours: 0` の「壊れた」
   *   Memory を意図的に作り、scoring 側の NaN 処理の防御を検査している——検査を足すと
   *   この2件の回帰テストが書けなくなる（Issue #768 の調査で実測）。
   */
  /** ADR 0439: 別の行への参照は `ctx` のテナントの記憶を指すこと（`null`・`undefined`・空文字は「参照しない」——この Fake の従来の扱い）。 */
  private assertOwnMemoryRef(ctx: Ctx, id: MemoryId | null | undefined): void {
    if (!id) return;
    const memory = this.backing.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
  }

  /**
   * ADR 0469（ADR 0456 の H4 の Fake 版）: 呼び出し側が渡した `NewMemoryEvent.memoryId` の記憶が `ctx` のテナントに在ることを、
   * イベントを積む前に確かめる。実在しない・別テナントは区別せず `memory not found for tenant`
   * （`PostgresMemoryStore.assertEventTargetInTenant`・testkit の `InMemoryMemoryStore` と同じ判定・同じ message の形）。
   * `null`・`undefined`（記憶を指さないイベント）は確かめない。**空文字は参照として扱い、断る**（Postgres の uuid の形でない id と同じ）。
   * `knownInTenant` は、この呼び出しが今まさに更新・作成した行の id で、それを指すイベントは問い合わせない。
   * 大文字小文字は区別しない（`@mnemora/postgres` は uuid を小文字にそろえて比べる。この Fake の id は小文字の `mem-N`）。
   */
  private assertEventTargetOwn(
    ctx: Ctx,
    memoryId: MemoryId | null | undefined,
    knownInTenant: readonly MemoryId[] = [],
  ): void {
    if (memoryId === null || memoryId === undefined) return;
    const id = memoryId.toLowerCase();
    if (knownInTenant.some((known) => known.toLowerCase() === id)) return;
    const memory = this.backing.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${memoryId}`);
    }
  }

  /** イベントを組み立てる前に {@link assertEventTargetOwn} を通す（イベントを先に組み立てる口の合流点）。 */
  private buildOwnedEvent(
    ctx: Ctx,
    event: NewMemoryEvent,
    knownInTenant: readonly MemoryId[],
  ): MemoryEvent {
    this.assertEventTargetOwn(ctx, event.memoryId, knownInTenant);
    return buildStoredEvent(ctx, event);
  }

  private createMemoryIdempotent(
    ctx: Ctx,
    input: NewMemory,
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Memory> {
    // 8回目の TSDoc の棚卸し: testkit の fixture（`InMemoryMemoryStore.createMemoryIdempotent`）と
    // `@mnemora/postgres` が拒む `provenance` の形のうち、2つをこの Fake も同じく拒む（冪等の衝突の判定より前。
    // fixture と同じ位置）——`provenance.kind` が列挙に無いとき、と `provenance` が `null` のとき（次の行が
    // fixture と同じく `TypeError` を投げる）。
    //
    // ⚠ **3つ目（`stated`・`inferred` なのに列の `sourceObservationId` が `null`）は、意図して拒まない。**
    // fixture と Postgres は拒むが、core の既存のテストのうち25件（`recall-pipeline`・`recall-basis-lost`・
    // `recall-association`・`recall-exclude-provenance-filter`・`runtime` の5ファイル）が、`sourceObservationId: null`
    // の `inferred`・`stated` の Memory をこの Fake に書いて前提にしている。拒むとそれらのデータを書き換えることに
    // なり、各テストが縛っているものが変わりうるので、揃えない（`fake-provenance-rejects.test.ts` が今の振る舞いを縛る）。
    // ADR 0543: `text` 列に入る欄の孤立サロゲートは、Postgres と同じく U+FFFD に置き換えて保存する。冪等の鍵
    // （`contentHash`・`extractorVersion`）も置き換えた後の値で比べる。`jsonb` 列の欄（`attributes`・`provenance`）は触らない。
    input = {
      ...input,
      content: wf(input.content),
      digest: wf(input.digest),
      contentHash: wf(input.contentHash),
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => wf(tag)) : input.tags,
      extractorVersion: wf(input.extractorVersion),
      ...(input.claimKey === undefined ? {} : { claimKey: wfClaimKey(input.claimKey) }),
    };
    const provenanceKind = input.provenance.kind;
    if (!ProvenanceKindSchema.safeParse(provenanceKind).success) {
      throw new Error(
        `FakeMemoryStore: memories.provenance_kind must be one of ${ProvenanceKindSchema.options.join(", ")} (got ${JSON.stringify(provenanceKind)})`,
      );
    }
    // ADR 0521: 参照する observation の id も大文字小文字を区別しない（`@mnemora/postgres` は uuid 型の列で比べる）。
    input = { ...input, sourceObservationId: normOptId(input.sourceObservationId) } as typeof input;
    const idemKey = this.backing.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    const existingId = input.sourceObservationId
      ? this.backing.extractionIndex.get(idemKey)
      : undefined;
    const existing = existingId !== undefined ? this.backing.memories.get(existingId) : undefined;

    return resolveIdempotentCreate(existing, () => {
      beforeInsert?.();
      // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.createMemory` と
      // 同じ理由・同じ検査）: `sourceObservationId`/`supersededById`/`contestedWithId` は
      // 非 null なら実在する行を指さなければならない。**「存在」だけを見る**——一対一等の
      // 整合まではここでは踏み込まない。
      // ADR 0439: 参照先は `ctx` のテナントの行であること（別テナントの行は、実在しない id と同じく拒む）。
      if (input.sourceObservationId) {
        const observation = this.backing.observations.get(input.sourceObservationId);
        if (!observation || observation.tenantId !== ctx.tenantId) {
          throw new Error(
            `FakeMemoryStore: observation not found for tenant: ${input.sourceObservationId}`,
          );
        }
      }
      this.assertOwnMemoryRef(ctx, input.supersededById);
      this.assertOwnMemoryRef(ctx, input.contestedWithId);
      // 値域（ADR 0078）: `InMemoryMemoryStore.createMemoryIdempotent` と同じ位置・
      // 同じ理由——ここで放置すると「本番（Postgres の CHECK 制約）では落ちる書き込みが
      // 手元では黙って成功する」。`halfLifeHours`（ADR 0125）を検査しない理由は、この
      // メソッドの doc コメント参照。
      if (!isStrengthInRange(input.strength)) {
        throw new Error(
          `FakeMemoryStore: strength out of range (0, ${MAX_STRENGTH}]: ${input.strength}`,
        );
      }
      // Issue #817（PR #815 と同根）: `memories.half_life_hours` は Postgres の `real`
      // （IEEE 754 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い。
      // float64 では有限だが float4 の範囲を超える値（例: `1e300`）を渡すと、`real` へ
      // 変換される際に `Infinity` へ丸まり CHECK 制約に抵触して Postgres は例外を投げる
      // （実測）。⚠ この Fake には `halfLifeHours` の値域全体の検査（ADR 0125、
      // `(0, ∞)`）は上の `createMemoryIdempotent` の doc コメントが明記するとおり
      // **意図して無い**——`recall-pipeline.test.ts` が `halfLifeHours: 0` の「壊れた」
      // Memory を意図的に作ってスコアリング側の NaN 処理を検査するため。ここで足すのは
      // その値域検査ではなく、Postgres の `real` 列という物理的なストレージ上限だけを見る
      // 狭い検査（`Math.fround` が `Infinity` に丸めるかどうか）——`0` や負数は
      // `Math.fround` を通しても有限のままなので、この検査は既存の「壊れた」テストを
      // 壊さない。
      //
      // ⚠ **上側については**、`strength` は同じ `real` 列だが、値域が `(0, MAX_STRENGTH]` であり float4 の
      // 範囲へ遠く届かない——上の `isStrengthInRange` の時点で `1e300` のような値は
      // 既に拒まれている（実測。float4 オーバーフローに到達する前に別の理由で例外になる）
      // ため、`strength` にはこの検査を足さない。
      if (!Number.isFinite(Math.fround(input.halfLifeHours))) {
        throw new Error(
          `FakeMemoryStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${input.halfLifeHours})`,
        );
      }
      // 下側（アンダーフロー）: `packages/testkit` の `InMemoryMemoryStore` と同じ検査
      // （そちらのコメント参照）。0 でない値が float4 で 0 に丸まるときだけ拒む——
      // `halfLifeHours: 0`（上の「壊れた」Memory）はここでは見ない。
      for (const [field, value] of [
        ["halfLifeHours", input.halfLifeHours],
        ["strength", input.strength],
      ] as const) {
        if (value !== 0 && Math.fround(value) === 0) {
          throw new Error(
            `FakeMemoryStore: ${field} does not fit in a Postgres "real" (float4) column (got ${value}; rounds to 0)`,
          );
        }
      }
      // Issue #807: `recordedAt`（必須）/`occurredAt`/`validFrom`/`validUntil`
      // （省略可能）はすべて Postgres の `timestamptz` 列に書き込まれる。Invalid Date
      // （`.getTime()` が `NaN`）を渡すと `PostgresMemoryStore.createMemory` はクエリ
      // 実行時に `invalid input syntax for type timestamp with time zone` で例外を投げる
      // （実測。`reinforce`—同じ Issue—と同じ根本原因）。省略可能な3つは値が渡された
      // ときだけ検査する（既定値 `null`/`undefined` は「無い」であって Invalid Date
      // ではない）。
      if (Number.isNaN(input.recordedAt.getTime())) {
        throw new Error(`FakeMemoryStore: recordedAt must be a valid Date (got Invalid Date)`);
      }
      // ADR 0493: `decayFloorAt`・`lastReinforcedAt` も `timestamptz` 列。Postgres は Invalid Date を拒む。
      // 型の外の `null` は今までどおり通す（Invalid Date だけを断る。`fake-aggregate-scope-exclude-provenance.test.ts` が null で作る）。
      if (input.decayFloorAt != null && Number.isNaN(input.decayFloorAt.getTime())) {
        throw new Error(`FakeMemoryStore: decayFloorAt must be a valid Date (got Invalid Date)`);
      }
      // ADR 0493: 列挙の列（`status`・`digest_source`・`embedding_status`）。`provenance_kind` は上で見ている。
      if (input.status !== undefined) assertFakeMemoryColumn("status", input.status);
      assertFakeMemoryColumn("digest_source", input.digestSource);
      assertFakeMemoryColumn("embedding_status", input.embeddingStatus);
      // ADR 0493: 活動時計の起点と床は `bigint` 列で `memories_decay_seq_non_negative` が負を拒む。`halfLifeRecalls` は float4 で (0, ∞)。
      // ⚠ `halfLifeHours` の範囲（`(0, ∞)`）は、この Fake が意図して見ない（上の doc コメント）。`halfLifeRecalls` は見る。
      for (const [field, value] of [
        ["decayBaseSeq", input.decayBaseSeq],
        ["decayFloorSeq", input.decayFloorSeq],
      ] as const) {
        if (value == null) continue;
        if (!Number.isInteger(value)) {
          throw new Error(`FakeMemoryStore: ${field} must be an integer (got ${value})`);
        }
        if (value < 0) {
          throw new Error(`FakeMemoryStore: ${field} must not be negative (got ${value})`);
        }
        if (value >= 2 ** 63) {
          throw new Error(`FakeMemoryStore: ${field} must fit in a Postgres bigint (got ${value})`);
        }
      }
      if (input.halfLifeRecalls != null) {
        const recalls = input.halfLifeRecalls;
        if (!isHalfLifeRecallsInRange(recalls)) {
          throw new Error(`FakeMemoryStore: halfLifeRecalls out of range (0, ∞): ${recalls}`);
        }
        if (!Number.isFinite(Math.fround(recalls)) || Math.fround(recalls) === 0) {
          throw new Error(
            `FakeMemoryStore: halfLifeRecalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
          );
        }
      }
      for (const [field, value] of [
        ["occurredAt", input.occurredAt],
        ["lastReinforcedAt", input.lastReinforcedAt],
        ["validFrom", input.validFrom],
        ["validUntil", input.validUntil],
      ] as const) {
        if (value != null && Number.isNaN(value.getTime())) {
          throw new Error(`FakeMemoryStore: ${field} must be a valid Date (got Invalid Date)`);
        }
      }
      // Issue #816（NUL 側。孤立サロゲート側はここでは扱わない）: Postgres の `text` 型は
      // NUL バイト（`\u0000`）を構造的に拒む（C 文字列表現に由来する制約）。
      // `PostgresMemoryStore.createMemory` は `content`/`subjectId`/`tags`（各要素）/
      // `digest` のいずれに NUL を含む文字列を渡しても `invalid byte sequence for
      // encoding "UTF8": 0x00` で例外を投げる（実測。4欄とも同じメッセージ）。
      // PR #923 の時点ではこの検査を `content` だけに絞っていた（同 PR のコメント）が、
      // 実測するとこの4欄は対称な入力面だったため、本 PR（Issue #816 の残り）で揃えた
      // （`packages/testkit` の `InMemoryMemoryStore.createMemory` と同じ範囲）。
      //
      // `ctx.tenantId` の NUL・孤立サロゲートは、ADR 0493 で各公開メソッドの冒頭の `assertWellFormedCtx(ctx)` が断る
      // （以前はここに「共通の入口が無いので扱わない」と書いていた。InMemory が先に揃い、Fake も各メソッドで明示した）。
      if (input.content.includes("\u0000")) {
        throw new Error(`FakeMemoryStore: content must not contain NUL characters (U+0000)`);
      }
      if (input.subjectId != null && input.subjectId.includes("\u0000")) {
        throw new Error(`FakeMemoryStore: subjectId must not contain NUL characters (U+0000)`);
      }
      // ADR 0493: `subjectId` の孤立サロゲート（InMemory・Postgres は `MalformedIdentifierError`）と、`extractorVersion` の NUL。
      assertWellFormedIdentifier(input.subjectId, "input.subjectId");
      if (input.extractorVersion != null && input.extractorVersion.includes("\u0000")) {
        throw new Error(
          `FakeMemoryStore: extractorVersion must not contain NUL characters (U+0000)`,
        );
      }
      if (input.tags.some((tag) => tag.includes("\u0000"))) {
        throw new Error(`FakeMemoryStore: tags must not contain NUL characters (U+0000)`);
      }
      if (input.digest.includes("\u0000")) {
        throw new Error(`FakeMemoryStore: digest must not contain NUL characters (U+0000)`);
      }
      // 穴 O-6-3（ADR 0424）: `content_hash` も `text` 列（`InMemoryMemoryStore` と同じ）。
      if (input.contentHash.includes("\u0000")) {
        throw new Error(`FakeMemoryStore: contentHash must not contain NUL characters (U+0000)`);
      }
      // `attributes`・`provenance` は `jsonb` 列。Postgres は NUL を `unsupported Unicode
      // escape sequence` で拒む（実測。`jsonContainsNul` の doc コメント参照）。
      if (jsonContainsNul(input.attributes ?? {})) {
        throw new Error(`FakeMemoryStore: attributes must not contain NUL characters (U+0000)`);
      }
      if (jsonContainsNul(input.provenance)) {
        throw new Error(`FakeMemoryStore: provenance must not contain NUL characters (U+0000)`);
      }
      // 孤立サロゲート（Issue #816、実測）: このメソッドは検査しない。`text` 列の欄の孤立サロゲートは、ADR 0543 から
      // `createMemoryIdempotent` の入口で U+FFFD に置き換えて保存する（`PostgresMemoryStore` と同じ。以前は入力を
      // そのまま保持していた）。`jsonb` 列の欄（`attributes`・`provenance`）は触らない（ADR 0543 の対象外）。
      const now = new Date();
      const memory: Memory = {
        id: nextId("mem"),
        tenantId: ctx.tenantId,
        subjectId: input.subjectId ?? null,
        sourceObservationId: input.sourceObservationId ?? null,
        extractorVersion: input.extractorVersion ?? null,
        content: input.content,
        contentHash: input.contentHash,
        digest: input.digest,
        digestSource: input.digestSource,
        provenance: input.provenance,
        status: input.status ?? "active",
        supersededById: normOptId(input.supersededById) ?? null,
        contestedWithId: normOptId(input.contestedWithId) ?? null,
        tags: input.tags,
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt,
        lastReinforcedAt: input.lastReinforcedAt ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        // Issue #371（ADR 0185/ADR 0315）: `InMemoryMemoryStore`（packages/testkit）と
        // 同じ理由・同じ形——`?? null` で転記しないと `undefined` のまま消える。
        claimKey: input.claimKey ?? null,
        strength: input.strength,
        halfLifeHours: input.halfLifeHours,
        decayFloorAt: input.decayFloorAt,
        // ADR 0165 決めたこと3: 活動時計の3つ組。以前はここで1つも転記しておらず、
        // `createMemory` で渡した `decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls` が
        // 常に `undefined` になって消えていた——`recall-decay-gate.test.ts` の
        // 活動時計の歯を書く過程で実測した(すべて `undefined` に化けるため
        // `activityAxisAlive` が「この軸に床が無い」と誤認して常に生存判定していた)。
        decayBaseSeq: input.decayBaseSeq ?? null,
        decayFloorSeq: input.decayFloorSeq ?? null,
        halfLifeRecalls: input.halfLifeRecalls ?? null,
        embeddingStatus: input.embeddingStatus,
        purgedAt: input.purgedAt ?? null,
        // Issue #152/#153（ADR 0312）: runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      this.backing.memories.set(memory.id, memory);
      if (input.sourceObservationId) {
        this.backing.extractionIndex.set(idemKey, memory.id);
      }
      // Issue #201 PR-B（ADR 0323）: `packages/testkit` の `InMemoryMemoryStore` と同じ
      // 契機——新しい行を実際に作ったときだけ `tags` から `proposed` ラベルを作る。
      this.upsertProposedLabels(ctx, memory.id, memory.tags);
      return memory;
    });
  }

  /**
   * `packages/testkit` の `InMemoryMemoryStore.labelKey` と同じ形——`tenantId` は `::` を含んで
   * よいので、区切り文字で繋がず `JSON.stringify` の配列で表す。
   */
  private labelKey(tenantId: string, name: string): string {
    return JSON.stringify([tenantId, name]);
  }

  /** `labelKey` と同じ形——`(tenantId, memoryId)` を `JSON.stringify` の配列で表す。 */
  private memoryLabelKey(tenantId: string, memoryId: string): string {
    return JSON.stringify([tenantId, memoryId]);
  }

  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `packages/testkit` の `InMemoryMemoryStore.upsertProposedLabels` と同じ意味論。
   * Issue #995/#1207 / [ADR 0375](../../../docs/decisions/0375-purge-scope-widened.md):
   * どの label 名に紐づいたかを `backing.memoryLabels` にも記録する（`purgeMemory` が使う）。
   */
  private upsertProposedLabels(ctx: Ctx, memoryId: MemoryId, tags: readonly string[]): void {
    const uniqueNames = Array.from(new Set(tags));
    if (uniqueNames.length === 0) {
      return;
    }
    const linked = new Set<string>();
    for (const name of uniqueNames) {
      const key = this.labelKey(ctx.tenantId, name);
      const existing = this.backing.labels.get(key);
      if (existing === undefined) {
        this.backing.labels.set(key, {
          name,
          status: "proposed",
          proposedCount: 1,
          registeredAt: null,
        });
        linked.add(name);
        continue;
      }
      if (existing.status === "proposed") {
        this.backing.labels.set(key, { ...existing, proposedCount: existing.proposedCount + 1 });
      }
      linked.add(name);
    }
    this.backing.memoryLabels.set(this.memoryLabelKey(ctx.tenantId, memoryId), linked);
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `listLabels?`（`InMemoryMemoryStore.listLabels` と同じ契約）。
   *
   * Issue #881 / ADR 0318 追記（2026-09-26、クローン miku の判断）: 並び順は
   * `compareLabelName`（このファイル上）——コードポイント順。`localeCompare` はこの
   * 契約とずれるため使わない。
   */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    assertWellFormedCtx(ctx);
    const results: LabelSummary[] = [];
    for (const [key, label] of this.backing.labels) {
      if ((JSON.parse(key) as [string, string])[0] === ctx.tenantId) {
        results.push(label);
      }
    }
    results.sort((a, b) => compareLabelName(a.name, b.name));
    return results;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `registerLabel?`（`InMemoryMemoryStore.registerLabel` と
   * 同じ契約）。
   */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    assertWellFormedCtx(ctx);
    // ADR 0543: `labels.name` は `text` 列。孤立サロゲートは U+FFFD に置き換えて保存する（`tags` の要素と同じ）。
    name = wf(name);
    const key = this.labelKey(ctx.tenantId, name);
    const existing = this.backing.labels.get(key);
    const registered: LabelSummary = {
      name,
      status: "registered",
      proposedCount: existing?.proposedCount ?? 0,
      registeredAt: existing?.registeredAt ?? new Date(),
    };
    this.backing.labels.set(key, registered);
    return registered;
  }

  /**
   * Issue #1207 / ADR 0383: `packages/testkit` の `InMemoryMemoryStore.eraseTenant` と
   * 同じ実装（`this.backing.*` を使う点だけが違う）。詳細な doc コメントはそちらを参照。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む。
    assertFakeEraseLimit(opts.limit);
    const dryRun = opts.dryRun === true;
    let remaining = opts.limit;
    let total = 0;
    let reachedLimit = false;

    const drainMap = <V>(map: Map<string, V>, tenantOf: (value: V) => string): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const [key, value] of map) {
        if (victims.length >= budget) break;
        if (tenantOf(value) === ctx.tenantId) victims.push(key);
      }
      if (!dryRun) for (const key of victims) map.delete(key);
      return victims.length;
    };
    const drainKeyedMap = <V>(map: Map<string, V>): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const key of map.keys()) {
        if (victims.length >= budget) break;
        const [tenantId] = JSON.parse(key) as [string, ...unknown[]];
        if (tenantId === ctx.tenantId) victims.push(key);
      }
      if (!dryRun) for (const key of victims) map.delete(key);
      return victims.length;
    };
    const drainSet = (set: Set<string>, belongsToTenant: (key: string) => boolean): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const key of set) {
        if (victims.length >= budget) break;
        if (belongsToTenant(key)) victims.push(key);
      }
      if (!dryRun) for (const key of victims) set.delete(key);
      return victims.length;
    };
    const drainArray = <V>(array: V[], tenantOf: (value: V) => string): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victimIndexes: number[] = [];
      for (let i = 0; i < array.length && victimIndexes.length < budget; i++) {
        if (tenantOf(array[i]!) === ctx.tenantId) victimIndexes.push(i);
      }
      if (!dryRun)
        for (let i = victimIndexes.length - 1; i >= 0; i--) array.splice(victimIndexes[i]!, 1);
      return victimIndexes.length;
    };

    const steps: Array<() => number> = [
      () => drainKeyedMap(this.backing.memoryLabels),
      () => drainSet(this.backing.usages, (key) => key.startsWith(`${ctx.tenantId}:`)),
      () => drainArray(this.backing.events, (event) => event.tenantId),
      // memory_relations（Issue #207/#933 PR2）
      () => drainArray(this.backing.relations, (relation) => relation.tenantId),
      () => {
        const deleted = drainMap(this.backing.memories, (memory) => memory.tenantId);
        if (!dryRun) {
          for (const key of [...this.backing.extractionIndex.keys()]) {
            const [tenantId] = JSON.parse(key) as [string, ...unknown[]];
            if (tenantId === ctx.tenantId) this.backing.extractionIndex.delete(key);
          }
        }
        return deleted;
      },
      () => drainMap(this.backing.observations, (observation) => observation.tenantId),
      () => drainMap(this.backing.recalls, (recall) => recall.tenantId),
      () => drainKeyedMap(this.backing.labels),
      () => {
        if (remaining <= 0) return 0;
        if (!this.backing.activitySeq.has(ctx.tenantId)) return 0;
        if (!dryRun) this.backing.activitySeq.delete(ctx.tenantId);
        return 1;
      },
      () => {
        if (remaining <= 0) return 0;
        if (!this.backing.subjectActivitySeq.has(ctx.tenantId)) return 0;
        if (!dryRun) this.backing.subjectActivitySeq.delete(ctx.tenantId);
        return 1;
      },
    ];

    for (const step of steps) {
      if (remaining <= 0) {
        reachedLimit = true;
        break;
      }
      const budgetBeforeStep = remaining;
      const deleted = step();
      total += deleted;
      remaining -= deleted;
      if (deleted === budgetBeforeStep && deleted > 0) {
        reachedLimit = true;
        break;
      }
    }

    return { kind: "executed", deleted: total, reachedLimit };
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    assertWellFormedCtx(ctx);
    return this.createMemoryIdempotent(ctx, input).value;
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    // ADR 0493: 行を実際に書くときだけ `jobKinds` の NUL を、何も書く前に見る（testkit の `assertOutboxRowsWritable` と同じ）。
    const { value: memory, created } = this.createMemoryIdempotent(ctx, input, () =>
      assertFakeOutboxRowsWritable("createMemoryWithOutbox", jobKinds, undefined),
    );
    if (!created) {
      return { memory, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) => this.enqueueJob(ctx, kind, { memoryId: memory.id }));
    return { memory, created: true, jobs };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    assertWellFormedCtx(ctx);
    const memory = this.backing.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // `PostgresMemoryStore.getMany` は `WHERE id = ANY(...)` という集合演算で引くため
    // （実測）、同じ id が `ids` に複数回含まれていても一致する行は主キーの性質上1回しか
    // 無い。ここで検査せず単純にループで push すると同じ Memory を重複して返してしまう
    // ——`InMemoryMemoryStore.getMany`（`packages/testkit`、PR #806/#812）と同じ形の
    // 不一致（`fake-store-postgres-parity.test.ts` が歯）。`seen` で2回目以降を
    // スキップし、Postgres の集合演算と同じ「一意な id の集合」に揃える。
    const seen = new Set<MemoryId>();
    const results: Memory[] = [];
    for (const rawId of ids) {
      const id = normId(rawId);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const memory = this.backing.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /** ADR 0028: `runtime.reextract` が既存 Memory を判定するための列挙（**SELECT のみ**）。 */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // ADR 0543: 検索語も、Postgres が引数を UTF-8 に変換するときに置き換わる。
    extractorVersion = wf(extractorVersion);
    const results: Memory[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== normId(observationId)) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(memory);
    }
    return results;
  }

  /** ADR 0380: 版を問わず同じ Observation 由来の Memory を列挙する（**SELECT のみ**）。 */
  async listBySourceObservationAllVersions(
    ctx: Ctx,
    observationId: ObservationId,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    const results: Memory[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== normId(observationId)) continue;
      results.push(memory);
    }
    return results;
  }

  /**
   * ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする
   * （postgres 実装・testkit の in-memory 実装と同じ意味論）。
   *
   * `beforeUpdateStatus`（テスト専用のフック）は CAS 判定の**直前**に呼ぶ——
   * `reextract` の TOCTOU（読んでから書くまでの間に別の書き込みが割り込む）を
   * 決定的に再現するための差し込み口。本番相当の実装には存在しない、このフェイク限りの機構。
   * ADR 0031 で追加した `updateStatusWithEvent` も、`reextract` が実際に呼ぶ経路として
   * 同じ位置（CAS 判定の直前）でこのフックを発火する——さもないと PR #28 が
   * このフックで決定的に再現している TOCTOU の歯が、`reextract` が `updateStatus` を
   * 呼ばなくなった時点で意味を失う。
   */
  beforeUpdateStatus?: (id: MemoryId) => void;

  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // ⚠ Issue #768: ADR 0140 の `status: 'contested'` ガードは、この Fake には意図して
    // 持たない（`createMemoryIdempotent` の doc コメント参照——ADR 0140 決定2）。
    id = normId(id);
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない。ADR 0439: `ctx` のテナントの Memory であること（検査の順は実装と同じ: 対象、参照、`expectedStatus`）。
    if (opts?.supersededById !== undefined) {
      this.assertOwnMemoryRef(ctx, opts.supersededById);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    assertFakeMemoryColumn("status", status);
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = normId(opts.supersededById);
    }
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0031: `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む。
   * `reextract` の supersede ループは、以前の「`updateStatus` を呼んでから
   * 別途 `eventStore.append` を呼ぶ」という2コミットの形をやめてこちらを呼ぶ
   * （`packages/core/src/runtime.ts`）——`beforeUpdateStatus` はここでも CAS 判定の
   * 直前に発火するため、PR #28 の TOCTOU の歯はそのまま生きる。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // ⚠ Issue #768: updateStatus と同じ理由——ADR 0140 のガードは意図して持たない。
    id = normId(id);
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    // 外部キー相当（ADR 0047）・ADR 0439: updateStatus と同じ理由・同じ検査・同じ順。
    if (opts.supersededById !== undefined) {
      this.assertOwnMemoryRef(ctx, opts.supersededById);
    }
    if (opts.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    assertFakeMemoryColumn("status", status);
    // 9回目の棚卸し: イベントを先に組み立てる（検査もここで走る）。以前は状態を書き換えた後に組み立てていたので、
    // イベントが書けない（Invalid Date の `at` など）と、状態だけが書き換わったまま投げていた——Postgres は
    // 1トランザクションで巻き戻り、fixture は状態を書き換える前に検査するので、どちらもそうはならない。
    const storedEvent = this.buildOwnedEvent(ctx, event, [id]);
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = normId(opts.supersededById);
    }
    memory.updatedAt = new Date();
    this.backing.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * Issue #134 / ADR 0100: `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の
   * supersede、複数可）を1回の呼び出しにまとめる——`packages/testkit` の
   * `InMemoryMemoryStore.supersedeWithNewMemories` と同じ形だが、ファイル冒頭のコメントの
   * 通り意図的に独立している（`backing` を共有する既存の形に揃えただけ）。
   *
   * `beforeUpdateStatus` は `supersede` の各要素についても CAS 判定の直前に発火する
   * ——`updateStatus`/`updateStatusWithEvent` と同じ位置。この口を経由しても
   * TOCTOU 再現のフックが死なないようにする（ADR 0031 決定8 と同じ理由）。
   *
   * 事前検証（`supersede[].id`/`supersededById` の存在）を `news`/`supersede` のどちらにも
   * 書き込む前にすべて済ませることで、in-memory の「ロールバック」を模す
   * （`InMemoryMemoryStore.supersedeWithNewMemories` と同じ作法）。
   */
  async supersedeWithNewMemories(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
    // ADR 0493: この Fake は `opts` を使わない（`abortIf*` 等は未実装）。`now` の Invalid Date だけは、行を書く前に断る。
    opts?: { now?: Date },
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }> {
    assertWellFormedCtx(ctx);
    if (news.some((n) => n.jobKinds.length > 0)) {
      assertFakeQueryDate("supersedeWithNewMemories", "opts.now", opts?.now);
    }
    // 1. 事前検証——まだ何も書いていないうちに投げる。⛔ 3種類の失敗を潰さない（ADR 0100）。
    supersede = supersede.map((t) => ({ ...t, id: normId(t.id) }));
    for (const target of supersede) {
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `FakeMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
      const memory = this.backing.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(`FakeMemoryStore: memory not found for tenant: ${target.id}`);
      }
      // 書けないイベント（Invalid Date の `at`、列挙に無い `kind` など）も、記憶を作る前・状態を書き換える前に投げる
      // ——以前は news を作り、先の対象を superseded にした後で投げていた。`meta.supersededById` は作った記憶の
      // id で埋めるので、ここでは組み立てずに検査だけを走らせる（`assertBuildableFakeEvent`）。
      assertBuildableFakeEvent(target.event);
    }
    // ADR 0469: CAS を通ってイベントを書く対象だけ、そのイベントが指す記憶が `ctx` のテナントの行かを、news を作る前に確かめる
    // （弾かれる対象はイベントを書かないので確かめない。`PostgresMemoryStore`・`InMemoryMemoryStore` と同じ）。
    const willSupersede = new Set<MemoryId>();
    for (const target of supersede) {
      const status = willSupersede.has(target.id)
        ? "superseded"
        : this.backing.memories.get(target.id)!.status;
      if (target.expectedStatus !== undefined && status !== target.expectedStatus) continue;
      this.assertEventTargetOwn(ctx, target.event.memoryId, [target.id]);
      willSupersede.add(target.id);
    }
    // ⚠ Issue #768: `InMemoryMemoryStore.supersedeWithNewMemories` は news 側にも
    // ADR 0140 の制約を課すが、この Fake は意図して課さない（`createMemoryIdempotent`
    // の doc コメント参照）。

    // 2. news を作る（`createMemoryWithOutbox` と同じ経路）。
    const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];
    for (const { input, jobKinds } of news) {
      const { value: memory, created: wasCreated } = this.createMemoryIdempotent(ctx, input);
      if (!wasCreated) {
        created.push({ memory, created: false, jobs: [] });
        continue;
      }
      const jobs = jobKinds.map((kind) => this.enqueueJob(ctx, kind, { memoryId: memory.id }));
      created.push({ memory, created: true, jobs });
    }

    // 3. supersede を1件ずつ CAS で処理する。弾かれても conflicted に積んで続行する。
    const superseded: MemoryEvent[] = [];
    const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    for (const target of supersede) {
      this.beforeUpdateStatus?.(target.id);
      const memory = this.backing.memories.get(target.id)!;
      if (target.expectedStatus !== undefined && memory.status !== target.expectedStatus) {
        conflicted.push({ id: target.id, observedStatus: memory.status });
        continue;
      }
      memory.status = "superseded";
      const anchorId = created[target.supersededByIndex]!.memory.id;
      memory.supersededById = anchorId;
      memory.updatedAt = new Date();
      // `meta.supersededById` は解決した id で埋める（interface の契約）。
      const storedEvent = buildStoredEvent(ctx, {
        ...target.event,
        meta: { ...target.event.meta, supersededById: anchorId },
      });
      this.backing.events.push(storedEvent);
      superseded.push(storedEvent);
    }

    return { created, superseded, conflicted };
  }

  /**
   * Issue #210 / ADR 0115: `InMemoryMemoryStore.purgeExpiredEventsSync`（`packages/testkit`）と
   * 同じ意味論。`backing.events` を直接操作し、`FakeEventStore` のメソッドは一切呼ばない
   * ——append-only の型に触れない、という契約を Fake 側でも保つ。`purgeExpiredEvents` と
   * `purgeExpiredEventsByRetention`（Issue #1232、ADR 0354）が共有する本体——**書き写さない**。
   * **同期関数である**——`await` を1つも挟まない（`purgeExpiredEventsByRetention` が
   * 「保持期間を読んでから消すまで」を同じ同期区間に閉じるための前提）。
   */
  private purgeExpiredEventsSync(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): PurgeExpiredEventsResult {
    // `PostgresMemoryStore.purgeExpiredEvents` は `opts.limit`（+1件）を生 SQL の
    // `LIMIT`（bigint パラメータ）にそのまま渡すため、`NaN`・`Infinity`・非整数と
    // `opts.limit <= -2` は例外になる（実測）。ただし `opts.limit === -1` の1点だけは
    // `LIMIT opts.limit + 1` が `LIMIT 0` になり例外を投げず `{ purged: 0,
    // reachedLimit: true }` を返す——`InMemoryMemoryStore.purgeExpiredEvents`
    // （`packages/testkit`、PR #804/#811）と同じ不一致であり、今の契約として残す
    // （Issue #876、`PurgeExpiredEventsOptions.limit` の doc 参照）。ここで検査せず
    // `candidates.slice(0, opts.limit)` へ渡すと `Array.prototype.slice` の意味論を踏んで
    // 誤った件数を削除してしまうため、負数はすべて一様に拒む
    // （`fake-store-postgres-parity.test.ts` が歯。`-1` ではなく `-2` で確認している）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeExpiredEvents: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeExpiredEvents: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(
        `purgeExpiredEvents: limit must fit in a Postgres bigint (got ${opts.limit})`,
      );
    }
    const dryRun = opts.dryRun ?? false;
    const candidates = this.backing.events
      .filter(
        (event) =>
          event.tenantId === ctx.tenantId &&
          event.kind !== "events_purged" &&
          event.at.getTime() < opts.olderThan.getTime(),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const reachedLimit = candidates.length > opts.limit;
    const victims = candidates.slice(0, opts.limit);
    const purged = victims.length;
    const oldestPurgedAt = purged > 0 ? victims[0]!.at : null;
    const newestPurgedAt = purged > 0 ? victims[purged - 1]!.at : null;

    if (dryRun || purged === 0) {
      return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
    }

    const victimIds = new Set(victims.map((event) => event.id));
    for (let i = this.backing.events.length - 1; i >= 0; i--) {
      if (victimIds.has(this.backing.events[i]!.id)) {
        this.backing.events.splice(i, 1);
      }
    }

    const storedEvent = buildStoredEvent(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      // ADR 0538: `@mnemora/postgres`（`jsonb`）と `InMemoryMemoryStore` は日時を ISO 8601 の文字列で持つ。この Fake は `Date` のまま持っていた
      // （`meta` を読み戻すと型が違った）ので、文字列にそろえる。
      meta: {
        purgedCount: purged,
        oldestPurgedAt: oldestPurgedAt?.toISOString() ?? null,
        newestPurgedAt: newestPurgedAt?.toISOString() ?? null,
        olderThan: opts.olderThan.toISOString(),
      },
    });
    this.backing.events.push(storedEvent);

    return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
  }

  /**
   * Issue #210 / ADR 0115: {@link FakeMemoryStore.purgeExpiredEventsSync} を呼ぶだけの
   * 薄い async ラッパー（`MemoryStore.purgeExpiredEvents?` の公開シグネチャを満たす）。
   */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    assertWellFormedCtx(ctx);
    return this.purgeExpiredEventsSync(ctx, opts);
  }

  /**
   * [ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `MemoryStore.purgeExpiredRecalls?` の in-memory 実装（`PostgresMemoryStore` と同じ契約）。
   * 対象の recall を先に確定し、その `recall_usages` を消してから recall を消す。
   * `await` を挟まない（1回の同期区間で終わる）。
   */
  async purgeExpiredRecalls(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult> {
    assertWellFormedCtx(ctx);
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeExpiredRecalls: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeExpiredRecalls: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(
        `purgeExpiredRecalls: limit must fit in a Postgres bigint (got ${opts.limit})`,
      );
    }
    const dryRun = opts.dryRun ?? false;
    const candidates = [...this.backing.recalls.entries()]
      .filter(
        ([, row]) =>
          row.tenantId === ctx.tenantId && row.createdAt.getTime() < opts.olderThan.getTime(),
      )
      .sort(
        ([idA, a], [idB, b]) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (idA < idB ? -1 : idA > idB ? 1 : 0),
      );
    const reachedLimit = candidates.length > opts.limit;
    const victims = candidates.slice(0, opts.limit);
    const purged = victims.length;
    const oldestPurgedAt = purged > 0 ? new Date(victims[0]![1].createdAt) : null;
    const newestPurgedAt = purged > 0 ? new Date(victims[purged - 1]![1].createdAt) : null;
    const usageKeys: string[] = [];
    for (const [id] of victims) {
      const prefix = `${ctx.tenantId}:${id}:`;
      for (const key of this.backing.usages) {
        if (key.startsWith(prefix)) usageKeys.push(key);
      }
    }
    if (!dryRun) {
      // 子（recall_usages）が先、親（recalls）が後。
      for (const key of usageKeys) this.backing.usages.delete(key);
      for (const [id] of victims) this.backing.recalls.delete(id);
    }
    return {
      purged,
      purgedUsages: usageKeys.length,
      reachedLimit,
      oldestPurgedAt,
      newestPurgedAt,
      dryRun,
    };
  }

  /**
   * Issue #1232 / [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * `MemoryStore.purgeExpiredEventsByRetention?` の Fake 実装。`backing.eventRetentionDays`
   * （`FakeTenantSettingsStore.setEventRetention` と共有）を読んでから
   * {@link FakeMemoryStore.purgeExpiredEventsSync} を呼ぶまで、**`await` を1つも挟まない**
   * ——`packages/testkit` の `InMemoryMemoryStore.purgeExpiredEventsByRetention` と同じ形・
   * 同じ理由。
   */
  async purgeExpiredEventsByRetention(
    ctx: Ctx,
    opts: PurgeExpiredEventsByRetentionOptions,
  ): Promise<PurgeExpiredEventsByRetentionOutcome> {
    assertWellFormedCtx(ctx);
    if (!this.backing.eventRetentionDays.has(ctx.tenantId)) {
      return { kind: "unset" };
    }
    const days = this.backing.eventRetentionDays.get(ctx.tenantId)!;
    if (days === null) {
      return { kind: "unlimited" };
    }
    const olderThan = computeEventRetentionCutoff(opts.now, days);
    const result = this.purgeExpiredEventsSync(ctx, {
      olderThan,
      limit: opts.limit,
      dryRun: opts.dryRun,
    });
    return { kind: "executed", result };
  }

  /**
   * ADR 0053: `ready` を `failed` へ巻き戻さない。
   * `InMemoryMemoryStore.setEmbeddingStatus`（`packages/testkit`）と同じ意味論・
   * 同じ理由——禁じる遷移の判定は共有の {@link isEmbeddingStatusRollback} に固定し、
   * 実装ごとに条件式を書き直さない。巻き戻しは**例外にせず** no-op のまま現在の行を返す
   * （`runtime.tick` の `catch` の中が唯一の `failed` の呼び出し口であり、そこで投げると
   * 元の埋め込みエラーが握り潰される。ADR 0048 の `reinforce` と同じ理由の形）。
   * `failed → ready` は妨げない（片側だけの規則）。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    assertWellFormedCtx(ctx);
    id = normId(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    assertFakeMemoryColumn("embedding_status", status);
    if (isEmbeddingStatusRollback(memory.embeddingStatus, status)) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return memory;
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0048（Postgres）/ ADR 0049（本 fake）: 減衰の起点を巻き戻さない。
   * `InMemoryMemoryStore.reinforce`（`packages/testkit`）と同じ意味論・同じ理由
   * ——狭義の `<`（同じ `at` は no-op）で `lastReinforcedAt`/`decayFloorAt` を
   * 同じ条件でまとめて動かす。古い `at` は例外にせず、no-op のまま現在の行を返す。
   */
  /** ADR 0394: `ReinforceOptions.addOwnSubjectSeq` を読める（`reinforce` の実装を参照）。 */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    id = normId(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    // `PostgresMemoryStore.reinforce` は `at` を `timestamptz` 列へそのまま書き込むため、
    // Invalid Date（`at.getTime()` が `NaN`）を渡すとクエリ実行時に
    // `invalid input syntax for type timestamp with time zone` で例外を投げる（実測。
    // Issue #807。`packages/testkit` の `InMemoryMemoryStore.reinforce` と同じ判定・
    // 同じ理由）。ここで検査しないと、下の no-op 判定（`>= at.getTime()`）は `NaN` を
    // 含む比較が常に `false` になるため素通りし、`lastReinforcedAt`/`decayFloorAt` が
    // Invalid Date のまま静かに書き込まれてしまう。クエリを投げる前に弾く Postgres 側に
    // 揃える。
    if (Number.isNaN(at.getTime())) {
      throw new Error(`reinforce: at must be a valid Date (got Invalid Date)`);
    }
    // 起点（lastReinforcedAt ?? recordedAt）より新しい at のときだけ書く（Issue #1093）。未強化の
    // 記憶では作成時刻が起点なので、それより前・ちょうどの at は、活動時計の欄も含めて何も書かない。
    // ADR 0493: `opts.nowSeq` は `bigint` の引数へ書く値。この Memory が `halfLifeRecalls` を持つときだけ見る
    // （持たなければ使われない）。no-op の判定より前（Postgres は no-op でも同じ UPDATE を発行する）。
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      assertFakeQueryBigint("reinforce", "nowSeq", opts.nowSeq);
    }
    if ((memory.lastReinforcedAt ?? memory.recordedAt).getTime() >= at.getTime()) {
      return memory;
    }
    // 書く値（`nowSeq` か `nowSeq + S_x`）が負なら `memories_decay_seq_non_negative` が拒む。何かを書き換える前に決めて見る。
    let plannedBaseSeq: number | undefined;
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      plannedBaseSeq =
        opts.addOwnSubjectSeq === true && memory.subjectId != null
          ? opts.nowSeq +
            (this.backing.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
          : opts.nowSeq;
      if (plannedBaseSeq < 0) {
        throw new Error(`reinforce: decayBaseSeq must not be negative (got ${plannedBaseSeq})`);
      }
    }
    memory.lastReinforcedAt = at;
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16
    // （Issue #768 で実測して足した）: `opts.nowSeq` が渡され、かつこの Memory が
    // `halfLifeRecalls` を持つときに限り、活動時計側の起点・床も同じ強化イベントとして
    // 進める。`InMemoryMemoryStore.reinforce`/`PostgresMemoryStore.reinforce` と同じ分岐
    // ——壁時計側の「等しい/古い at は no-op」の分岐（上）を通り抜けたあとでだけ動かす
    // ことで、Issue #730 の「同じ at の2回目は活動時計側も動かさない」を1バイトも
    // 変えずに保つ。
    if (plannedBaseSeq !== undefined && memory.halfLifeRecalls != null) {
      // ADR 0394: `addOwnSubjectSeq` が true なら、`nowSeq`（T）に Memory 自身の subject の S_x を足す（上で計算済み）。
      const baseSeq = plannedBaseSeq;
      memory.decayBaseSeq = baseSeq;
      memory.decayFloorSeq = defaultActivityDecayStrategy.floorAt({
        baseSeq,
        strength: memory.strength,
        halfLifeRecalls: memory.halfLifeRecalls,
      });
    }
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * [Issue #874](https://github.com/takecchi/mnemora/issues/874): `reinforce` を
   * `ids` の各要素について順に呼ぶだけの素直な実装。`InMemoryMemoryStore.reinforceMany`
   * （`packages/testkit`）と同じ理由——この fake はテスト用のプレースホルダであり、
   * 往復数を束ねる最適化そのものは対象としない。`runtime.ts` の `handleMemoryUsage` が
   * 「口が在るかどうかで分岐する」ことを検査する歯（`runtime.test.ts`）は、この実装が
   * 実際に呼ばれたかどうかを `vi.spyOn` で観測する。
   */
  async reinforceMany(
    ctx: Ctx,
    ids: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    const results: Memory[] = [];
    for (const id of ids) {
      results.push(await this.reinforce(ctx, id, at, opts));
    }
    return results;
  }

  /**
   * Issue #961: `recordUsage` と `reinforceMany` を1つの口で撃つ（`PostgresMemoryStore`
   * は1トランザクション）。in-memory にトランザクションは無いので、強化が投げたら
   * この呼び出しで挿入した使用の行を取り消して、何も起きなかったのと同じに見せる。
   * この Fake で強化が投げうるのは Invalid Date の `at` だけで（Issue #807）、`at` は
   * 全件に共通なので、1件目の強化で何も書かずに投げる——強化の部分的な書き込みは残らない。
   */
  async recordUsageAndReinforce(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    assertWellFormedCtx(ctx);
    recallId = normId(recallId);
    const result = await this.recordUsage(ctx, recallId, memoryIds);
    if (result.insertedMemoryIds.length === 0) {
      return result;
    }
    try {
      await this.reinforceMany(ctx, result.insertedMemoryIds, at, opts);
    } catch (err) {
      for (const memoryId of result.insertedMemoryIds) {
        this.backing.usages.delete(`${ctx.tenantId}:${recallId}:${memoryId}`);
      }
      throw err;
    }
    return result;
  }

  async recordUsage(
    ctx: Ctx,
    recallId: string,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    assertWellFormedCtx(ctx);
    // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.recordUsage` と
    // 同じ理由・同じ検査）: `recall_usages.recall_id → recalls(id)` /
    // `recall_usages.memory_id → memories(id)`。`memoryIds` が空配列なら Postgres 実装は
    // クエリを一切発行せず即座に空の結果を返す（`recallId` の実在は問われない）ため、
    // その早期リターンより後ろで検査する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    // ADR 0439: recall も memory も `ctx` のテナントの行であること。
    recallId = normId(recallId);
    const recall = this.backing.recalls.get(recallId);
    if (!recall || recall.tenantId !== ctx.tenantId) {
      throw new Error(`FakeMemoryStore: recall not found for tenant: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      this.assertOwnMemoryRef(ctx, memoryId);
    }

    const insertedMemoryIds: MemoryId[] = [];
    for (const rawMemoryId of memoryIds) {
      const memoryId = normId(rawMemoryId);
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.backing.usages.has(key)) {
        this.backing.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `InMemoryMemoryStore.aggregateScope` と同じ検査。条件の識別子・日時・通し番号は Postgres の型へ変換できなければならない。
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    assertFakeQueryDate("aggregateScope", "occurredAfter", scope.occurredAfter);
    assertFakeQueryDate("aggregateScope", "occurredBefore", scope.occurredBefore);
    assertFakeQueryDate("aggregateScope", "validAt", scope.validAt);
    assertFakeQueryDate("aggregateScope", "decayFloorAtAfter", scope.decayFloorAtAfter);
    assertFakeQueryInteger("aggregateScope", "decayFloorSeqAfter", scope.decayFloorSeqAfter);
    // ADR 0543: `labels`・`taxonomyGroupCandidates`（`text[]` の引数）の孤立サロゲートは U+FFFD に置き換わって比べられる。
    scope = {
      ...scope,
      ...(scope.labels === undefined ? {} : { labels: scope.labels.map((label) => wf(label)) }),
      ...(scope.taxonomyGroupCandidates === undefined
        ? {}
        : { taxonomyGroupCandidates: scope.taxonomyGroupCandidates.map((label) => wf(label)) }),
    };
    // `attributes`・`labels` の NUL は、集計も目次帯も引かない（`scopeAggregate: "skip"` で `digestBand` 無し）ときだけ Postgres は見ない。
    if (!(opts?.scopeAggregate === "skip" && opts.digestBand === undefined)) {
      if (scope.attributes !== undefined && jsonContainsNul(scope.attributes)) {
        throw new Error("aggregateScope: attributes must not contain NUL characters (U+0000)");
      }
      for (const label of scope.labels ?? []) {
        if (label.includes("\u0000")) {
          throw new Error("aggregateScope: labels must not contain NUL characters (U+0000)");
        }
      }
    }
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;
    let filteredExpired = 0;
    let filteredNotYetValid = 0;
    let filteredTaxonomy = 0;
    let filteredDecayed = 0;
    const excludedKinds =
      opts?.excludeProvenanceKinds !== undefined && opts.excludeProvenanceKinds.length > 0
        ? new Set<string>(opts.excludeProvenanceKinds)
        : undefined;
    let excludedProvenanceIndexed = 0;
    // 目次帯の候補（本 PR）: totalInScope に数える条件と**同じ条件**で in-scope の
    // Memory を集める。`digestBand` が要求されなかった場合はこの配列を使わない。
    const inScopeMemories: Memory[] = [];

    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      // Issue #608 項目③(b) / ADR 0286（Issue #768 で実測して足した）:
      // `InMemoryMemoryStore.aggregateScope`/`PostgresMemoryStore.aggregateScope` と
      // 同じ意味論——`includeSubjectless: true` のときだけ `subjectId === null`
      // （主題なし）も scope 内に含める。
      const subjectMatches =
        scope.subjectId === undefined ||
        memory.subjectId === scope.subjectId ||
        (scope.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) continue;
      // Issue #152/#153（ADR 0312）: `attributes` も `subjectId` と同じくスコープの外側の
      // 境界——落ちた分は `filtered*` のどの列にも数えず、`totalInScope` にも入れない
      // （`recall.ts` の `ScopeAggregate` doc「2026-09 追記」参照）。
      if (scope.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(scope.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
      }

      if (memory.status === "archived") {
        filteredArchived += 1;
        continue;
      }
      if (memory.status === "superseded") {
        filteredSuperseded += 1;
        continue;
      }
      if (memory.status === "forgotten") {
        filteredForgotten += 1;
        continue;
      }

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        filteredPeriod += 1;
        continue;
      }
      // Issue #280（Issue #202 第2弾）: validAt ゲート。`InMemoryMemoryStore`
      // （`packages/testkit`）と同じ意味論（独立した2条件として数える）。
      if (scope.validAt !== undefined) {
        const isNotYetValid = memory.validFrom != null && memory.validFrom > scope.validAt;
        const isExpired = memory.validUntil != null && memory.validUntil <= scope.validAt;
        if (isNotYetValid) {
          filteredNotYetValid += 1;
        }
        if (isExpired) {
          filteredExpired += 1;
        }
        if (isNotYetValid || isExpired) {
          continue;
        }
      }
      // Issue #201 PR-B（ADR 0323）: taxonomy ゲート。`attributes`（上）とは違い
      // `period`/`validity` と同じ側——`totalInScope` から除かれ、`filtered*` に数えられる。
      if (scope.labels !== undefined) {
        const labels = scope.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          filteredTaxonomy += 1;
          continue;
        }
      }

      totalInScope += 1;
      // ⭐ Issue #329 / ADR 0173: 忘却ゲートで落ちた件数。**`continue` しない**
      // ——`archived`/`period`/`expired` と違い、減衰しきった Memory は
      // `totalInScope`・群カウント・目次帯のいずれからも除かれない（スコープ内に在る）。
      // 述語は `PostgresMemoryStore.aggregateScope` の `isDecayed` と、
      // `recall-runtime.ts` の `survivesDecayGate` の否定と、同じものでなければならない。
      if (isDecayedForScope(memory, scope, this.backing.subjectActivitySeq.get(ctx.tenantId))) {
        filteredDecayed += 1;
      }
      const key = memory.subjectId ?? null;
      inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
      if (memory.embeddingStatus !== "ready") {
        notIndexed[memory.embeddingStatus] += 1;
      } else if (excludedKinds?.has(memory.provenance.kind) === true) {
        // ADR 0390: 除外 kind で索引済み（`notIndexed` の補集合）の行。
        excludedProvenanceIndexed += 1;
      }
      inScopeMemories.push(memory);
    }

    const groups: ScopeAggregate["groups"] = [...inScopeBySubject.entries()].map(
      ([key, count]) => ({
        axis: "subject" as const,
        key,
        count,
        countKind: "exact" as const,
      }),
    );

    // Issue #201 PR-B（ADR 0323「決定5」）: `packages/testkit` の `InMemoryMemoryStore` と
    // 同じ意味論。
    if (scope.taxonomyGroupCandidates !== undefined) {
      const candidates = scope.taxonomyGroupCandidates;
      const perLabelCount = new Map<string, number>();
      let residual = 0;
      for (const memory of inScopeMemories) {
        const matchingLabels = new Set(memory.tags.filter((tag) => candidates.includes(tag)));
        if (matchingLabels.size === 0) {
          residual += 1;
          continue;
        }
        for (const label of matchingLabels) {
          perLabelCount.set(label, (perLabelCount.get(label) ?? 0) + 1);
        }
      }
      for (const [key, count] of perLabelCount) {
        groups.push({ axis: "taxonomy" as const, key, count, countKind: "exact" as const });
      }
      if (residual > 0) {
        groups.push({
          axis: "taxonomy" as const,
          key: null,
          count: residual,
          countKind: "exact" as const,
        });
      }
    }

    let digests: ScopeAggregate["digests"] = [];
    let digestEligible: ScopeAggregate["digestEligible"] = { count: 0, countKind: "exact" };
    if (opts?.digestBand) {
      // `PostgresMemoryStore.aggregateScope` は `digestBand.limit` を生 SQL の `LIMIT`
      // （bigint パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外に
      // なる（実測）。ここで検査せず `eligibleMemories.slice(0, opts.digestBand.limit)`
      // へ渡すと `Array.prototype.slice` の意味論を踏む——
      // `InMemoryMemoryStore.aggregateScope`（`packages/testkit`、PR #804/#811）と
      // 同じ形の不一致（`fake-store-postgres-parity.test.ts` が歯）。
      if (!Number.isInteger(opts.digestBand.limit)) {
        throw new Error(
          `aggregateScope: digestBand.limit must be an integer (got ${opts.digestBand.limit})`,
        );
      }
      if (opts.digestBand.limit < 0) {
        throw new Error(
          `aggregateScope: digestBand.limit must not be negative (got ${opts.digestBand.limit})`,
        );
      }
      // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
      // "9223372036854776000" is out of range for type bigint`）。
      if (opts.digestBand.limit >= 2 ** 63) {
        throw new Error(
          `aggregateScope: digestBand.limit must fit in a Postgres bigint (got ${opts.digestBand.limit})`,
        );
      }
      const exclude = new Set(opts.digestBand.excludeMemoryIds.map(normId));
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順（本 PR）。
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      digestEligible = { count: eligibleMemories.length, countKind: "exact" };
      digests = eligibleMemories.slice(0, opts.digestBand.limit).map((m) => ({
        memoryId: m.id,
        digest: m.digest,
      }));
    }

    return {
      groups,
      totalInScope,
      countKind: "exact",
      // ADR 0390: 空配列・未指定は欄を足さない（no-op）。
      ...(excludedKinds !== undefined
        ? { excludedProvenanceIndexedCount: excludedProvenanceIndexed }
        : {}),
      notIndexed: {
        pending: { count: notIndexed.pending, countKind: "exact" },
        failed: { count: notIndexed.failed, countKind: "exact" },
        skipped: { count: notIndexed.skipped, countKind: "exact" },
      },
      filteredArchived: { count: filteredArchived, countKind: "exact" },
      filteredSuperseded: { count: filteredSuperseded, countKind: "exact" },
      filteredForgotten: { count: filteredForgotten, countKind: "exact" },
      filteredPeriod: { count: filteredPeriod, countKind: "exact" },
      filteredExpired: { count: filteredExpired, countKind: "exact" },
      filteredNotYetValid: { count: filteredNotYetValid, countKind: "exact" },
      filteredTaxonomy: { count: filteredTaxonomy, countKind: "exact" },
      filteredDecayed: { count: filteredDecayed, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    assertWellFormedCtx(ctx);
    // ADR 0506: InMemory と同じ順（識別子 → 書けない値）。`recalls.subject_id`・`tenant_subject_activity.subject_id` は `text`。
    assertWellFormedIdentifier(record.subjectId, "record.subjectId");
    if (typeof record.advanceActivityClock === "object" && record.advanceActivityClock !== null) {
      assertWellFormedIdentifier(
        record.advanceActivityClock.subjectId,
        "record.advanceActivityClock.subjectId",
      );
    }
    // ADR 0480: InMemory・Postgres と同じく Invalid Date の createdAt は書かずに拒む（活動時計も進めない）。
    if (record.createdAt != null && Number.isNaN(record.createdAt.getTime())) {
      throw new Error("createRecall: createdAt must be a valid Date (got Invalid Date)");
    }
    assertFakeRecallRecordStorable(record);
    const id = nextId("rcl");
    // ADR 0404: 実装（`InMemoryMemoryStore`・`PostgresMemoryStore`）と同じく、`record.createdAt` を渡せばそれを使う。
    // ADR 0480: 呼び出し側の入力と共有しない（InMemory は structuredClone、Postgres は jsonb で往復する）。
    this.backing.recalls.set(id, {
      ...structuredClone(record),
      tenantId: ctx.tenantId,
      createdAt: record.createdAt !== undefined ? new Date(record.createdAt) : new Date(),
    });
    // ADR 0165 決めたこと5: `recalls` への INSERT と「同一トランザクション」で
    // `activity_seq` を +1 する。フェイクには本物のトランザクションが無いので、
    // 同期的に隣り合わせて書くことで同じ性質（片方だけが書かれることはない）を再現する。
    if (record.advanceActivityClock === true) {
      const current = this.backing.activitySeq.get(ctx.tenantId) ?? 0;
      this.backing.activitySeq.set(ctx.tenantId, current + 1);
    } else if (
      // ADR 0353（Issue #338）: `T` ではなく `S_x`（subject 単位）を進める。
      typeof record.advanceActivityClock === "object" &&
      record.advanceActivityClock !== null &&
      record.advanceActivityClock.scope === "subject"
    ) {
      const subjectId = record.advanceActivityClock.subjectId;
      let bySubject = this.backing.subjectActivitySeq.get(ctx.tenantId);
      if (bySubject === undefined) {
        bySubject = new Map<string, number>();
        this.backing.subjectActivitySeq.set(ctx.tenantId, bySubject);
      }
      const current = bySubject.get(subjectId) ?? 0;
      bySubject.set(subjectId, current + 1);
    }
    return id;
  }

  /**
   * Issue #298 / ADR 0155: `createRecall` と対になる読む口。`InMemoryMemoryStore`
   * （`packages/testkit`）と同じ契約——見つからない、またはテナントが一致しなければ
   * `null`。このフェイクが保持する行は常に `createRecall` 経由の新規行なので
   * `breakdownCaptured: true` で固定する。
   */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    assertWellFormedCtx(ctx);
    id = normId(id);
    const row = this.backing.recalls.get(id);
    if (!row || row.tenantId !== ctx.tenantId) {
      return null;
    }
    return structuredClone({
      recallId: id,
      tenantId: row.tenantId,
      subjectId: row.subjectId ?? null,
      query: row.query,
      budget: row.budget ?? null,
      omitted: row.omitted,
      usage: row.usage,
      indexBand: row.indexBand,
      explain: row.explain,
      returnedMemories: { breakdownCaptured: true, memories: row.returnedMemories },
      createdAt: row.createdAt,
    });
  }

  /**
   * ADR 0079: 索引に載っていない Memory を `pending` へ戻し、`embed` の outbox 行を
   * 積み直す。**更新と積み直しを `await` を挟まない同期区間で行う**ことで、
   * Postgres 側の単一文（＝同一トランザクション）と同じく「片方だけ起きた中間状態」を
   * 外から観測させない（ADR 0054 と同じ形）。
   */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `writeOpts.now` は `available_at`・`created_at`（`timestamptz`）に入る。Invalid Date は Postgres・InMemory が断る。
    assertFakeQueryDate("requeueEmbedJobs", "writeOpts.now", writeOpts?.now);
    // `PostgresMemoryStore.requeueEmbedJobs` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数を渡すと Postgres
    // 自身が例外を投げる（実測: `LIMIT must not be negative` / `invalid input syntax for
    // type bigint: "NaN"` 等）。ここで検査せず `.slice(0, Math.max(0, opts.limit))` へ
    // 渡すと、`Infinity` は対象を全件、`1.5` は1件、積み直す書き込みをしてしまう
    // （`archiveDecayed` の Issue #880 と同じ形）。クエリを投げる前に弾く Postgres 側に
    // 揃える（同じ2段の順序: 非整数を先に、次に負数を見る）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`requeueEmbedJobs: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`requeueEmbedJobs: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`。`1e21` 以上は指数表記になり
    // `invalid input syntax for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`requeueEmbedJobs: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    const targetStatuses: readonly EmbeddingStatus[] = opts.statuses;
    const idFilter =
      opts.memoryIds === undefined ? null : new Set<string>(opts.memoryIds.map(normId));
    const targets = [...this.backing.memories.values()]
      .filter(
        (m) =>
          m.tenantId === ctx.tenantId &&
          (m.status === "active" || m.status === "contested") &&
          targetStatuses.includes(m.embeddingStatus) &&
          (idFilter === null || idFilter.has(m.id)),
      )
      .sort(
        (a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, opts.limit);

    const memoryIds: MemoryId[] = [];
    for (const memory of targets) {
      memory.embeddingStatus = "pending";
      memory.updatedAt = new Date();
      this.enqueueJob(ctx, "embed", { memoryId: memory.id });
      memoryIds.push(memory.id);
    }
    return { requeued: memoryIds.length, memoryIds };
  }

  /**
   * ADR 0114: `docs/memory-model.md` §11 行8の掃引。`requeueEmbedJobs` と同じ作法
   * ——`status = 'active'` かつ `decayFloorAt <= opts.now`（境界を含む）の Memory を
   * `decayFloorAt` 昇順で `opts.limit` 件まで選び、更新とイベント追記を `await` を
   * 挟まない同期区間で行う（postgres 実装の単一トランザクションを模す）。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `now`（`timestamptz`）の Invalid Date と、`nowSeq`（`bigint`）の整数でない値を、クエリの前に断る（`InMemoryMemoryStore` と同じ）。
    assertFakeQueryDate("archiveDecayed", "now", opts.now);
    assertFakeQueryInteger("archiveDecayed", "nowSeq", opts.nowSeq);
    // `PostgresMemoryStore.archiveDecayed` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数を渡すと Postgres
    // 自身が例外を投げる（実測。Issue #880。`packages/testkit` の
    // `InMemoryMemoryStore.archiveDecayed` と同じ判定・同じ理由）。ここで検査せず
    // `.slice(0, Math.max(0, opts.limit))` へ渡すと、`Infinity` は対象を無条件に全件
    // `archived` にしてしまう——書き込みの副作用を持つ口である分、他の limit ガード
    // （PR #811/#875 相当、`FakeVectorStore.search` 等）より実害が大きい。クエリを
    // 投げる前に弾く Postgres 側に揃える。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`archiveDecayed: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`archiveDecayed: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`archiveDecayed: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    const nowMs = opts.now.getTime();
    const clock = opts.clock ?? "wall";
    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15
    // （Issue #768 で実測して足した）: `opts.clock` の分岐を
    // `InMemoryMemoryStore.archiveDecayed`/`PostgresMemoryStore.archiveDecayed` と
    // 同じ形に揃える——境界の非対称（ゲートは狭義 `>`、掃引は境界を含む `<=`）を
    // 1バイトも変えずに写す。`'either'` は AND（両方の軸で沈んでいるものだけ掃く）。
    const passesWall = (m: Memory): boolean => m.decayFloorAt.getTime() <= nowMs;
    // ADR 0353（Issue #338）: `usesSubjectActivityCounters` が true のときだけ、
    // その Memory の subjectId に対応する `S_x` を足す（postgres 側
    // `activityFloorSeqDeadCondition` と同じ式）。
    const subjectActivitySeqByTenant = this.backing.subjectActivitySeq.get(ctx.tenantId);
    const passesActivity = (m: Memory): boolean => {
      if (opts.nowSeq === undefined) {
        throw new Error(
          `FakeMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
        );
      }
      const decayFloorSeq = m.decayFloorSeq ?? null;
      if (decayFloorSeq === null) return false;
      const effectiveNowSeq =
        opts.usesSubjectActivityCounters === true && m.subjectId != null
          ? opts.nowSeq + (subjectActivitySeqByTenant?.get(m.subjectId) ?? 0)
          : opts.nowSeq;
      return decayFloorSeq <= effectiveNowSeq;
    };
    const passesClock = (m: Memory): boolean => {
      if (clock === "wall") return passesWall(m);
      if (clock === "activity") return passesActivity(m);
      return passesWall(m) && passesActivity(m);
    };
    // ⭐ ADR 0165 決めたこと8: 並べる軸は掃く軸に合わせる（`clock: 'activity'` では
    // `decayFloorSeq` 昇順）。`InMemoryMemoryStore` と同じ形——返り値 `archived` の
    // 並び順の契約は変えない（下で `decayFloorAt` 昇順に並べ直す）。
    const byId = (a: Memory, b: Memory): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const selectionOrder = (a: Memory, b: Memory): number =>
      clock === "activity"
        ? (a.decayFloorSeq ?? 0) - (b.decayFloorSeq ?? 0) || byId(a, b)
        : a.decayFloorAt.getTime() - b.decayFloorAt.getTime() || byId(a, b);

    const targets = [...this.backing.memories.values()]
      .filter((m) => m.tenantId === ctx.tenantId && m.status === "active" && passesClock(m))
      .sort(selectionOrder)
      .slice(0, Math.max(0, opts.limit));

    const archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }> = [];
    for (const memory of targets) {
      const digestSnapshot = memory.digest;
      memory.status = "archived";
      memory.updatedAt = new Date();
      const storedEvent = buildStoredEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "archived",
        actor: { type: "system" },
        digestSnapshot,
        sizeBeforeBytes: null,
        meta: {},
      });
      this.backing.events.push(storedEvent);
      archived.push({ memoryId: memory.id, decayFloorAt: memory.decayFloorAt });
    }
    archived.sort(
      (a, b) =>
        a.decayFloorAt.getTime() - b.decayFloorAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    // ADR 0493: `limit: 0` は何も選ばないので「上限に届いた」とは言わない（`InMemoryMemoryStore`・Postgres は `false`）。
    return { archived, reachedLimit: opts.limit > 0 && archived.length === opts.limit };
  }

  /**
   * Issue #198 / ADR 0124 / [ADR 0375](../../../docs/decisions/0375-purge-scope-widened.md):
   * `forgotten` かつ未 purge（`purgedAt === null`）な Memory だけを対象にした CAS。
   * `beforeUpdateStatus`（テスト専用のフック）を CAS 判定の直前に発火する
   * ——`updateStatus`/`updateStatusWithEvent` と同じ位置・同じ理由（`purge` の並行の歯も
   * この既存のフックで決定的に再現する）。
   *
   * 🔴 ADR 0375 決定1〜3: `content`/`digest`/`purgedAt` に加えて `tags`/`attributes`/
   * `claimKey` を空にし、label の紐付けを外して `proposedCount` を減らし、このテナントの
   * `recalls` の `indexBand.digestBand` から該当 `memoryId` の `digest` を書き換える
   * ——`packages/testkit` の `InMemoryMemoryStore.purgeMemory` と同じ範囲。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    id = normId(id);
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (memory.status !== "forgotten" || (memory.purgedAt ?? null) !== null) {
      throw new MemoryPurgeConflictError(id, memory.status, memory.purgedAt ?? null);
    }
    // イベントを先に組み立てる（検査もここで走る）。書けないイベントなら、状態を書き換える前に投げる——
    // `updateStatusWithEvent`（#1368）と同じ形。Postgres は1トランザクションで巻き戻り、fixture は書き換える前に検査する。
    const storedEvent = this.buildOwnedEvent(ctx, event, [id]);
    // ADR 0543: 墓石の `content`・`digest` は `text` 列へ書く値。孤立サロゲートは U+FFFD に置き換えて保存する。
    memory.content = wf(tombstone.content);
    memory.digest = wf(tombstone.digest);
    memory.tags = [];
    memory.attributes = {};
    memory.claimKey = null;
    memory.purgedAt = new Date();
    memory.updatedAt = new Date();

    // ADR 0375 決定2: label の紐付けを外し、proposed な label の proposedCount を減らす。
    const linkKey = this.memoryLabelKey(ctx.tenantId, id);
    const linkedLabelNames = this.backing.memoryLabels.get(linkKey);
    if (linkedLabelNames !== undefined) {
      for (const name of linkedLabelNames) {
        const key = this.labelKey(ctx.tenantId, name);
        const existing = this.backing.labels.get(key);
        if (existing !== undefined && existing.status === "proposed") {
          this.backing.labels.set(key, {
            ...existing,
            proposedCount: Math.max(existing.proposedCount - 1, 0),
          });
        }
      }
      this.backing.memoryLabels.delete(linkKey);
    }

    // ADR 0375 決定3: このテナントの recalls.index_band の digestBand から、この
    // memoryId のエントリを見つけてトゥームストーンへ書き換える（`recalls.query` は
    // 触らない——決定4）。
    for (const row of this.backing.recalls.values()) {
      if (row.tenantId !== ctx.tenantId) continue;
      const digestBand = row.indexBand?.digestBand;
      if (!digestBand) continue;
      let changed = false;
      const nextDigestBand = digestBand.map((entry) => {
        if (entry.memoryId !== id) return entry;
        changed = true;
        return { memoryId: entry.memoryId, digest: tombstone.digest };
      });
      if (changed) {
        row.indexBand = { ...row.indexBand, digestBand: nextDigestBand };
      }
    }

    this.backing.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * Issue #197 / ADR 0134: 両側とも `status === 'active'` の CAS を課したうえで、
   * `status='contested'`・`contestedWithId` を相互に設定する。`InMemoryMemoryStore`
   * （testkit）/ `PostgresMemoryStore` と同じ「事前検証してから書く」作法——
   * まだ何も書いていないうちに、存在確認と CAS 判定を両方の対象について済ませる
   * ことで、in-memory の「ロールバック」を模す（`supersedeWithNewMemories` と同じ形）。
   *
   * `beforeUpdateStatus` は各対象の CAS 判定の**直前**に発火する——`updateStatus`/
   * `updateStatusWithEvent`/`supersedeWithNewMemories` と同じ位置。TOCTOU の歯が
   * この口でも決定的に再現できるようにする。
   */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    first = { ...first, id: normId(first.id) };
    second = { ...second, id: normId(second.id) };
    if (first.id === second.id) {
      throw new RangeError("FakeMemoryStore: first.id and second.id must differ");
    }

    // 1. 事前検証——存在確認。まだ何も書いていない。
    const firstMemory = await this.get(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = await this.get(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${second.id}`);
    }

    // 2. 事前検証——CAS（両側とも `active` であること）。まだ何も書いていない。
    this.beforeUpdateStatus?.(first.id);
    if (firstMemory.status !== "active") {
      throw new MemoryStatusConflictError(first.id, "active", firstMemory.status);
    }
    this.beforeUpdateStatus?.(second.id);
    if (secondMemory.status !== "active") {
      throw new MemoryStatusConflictError(second.id, "active", secondMemory.status);
    }

    // 3. イベントを2件とも先に組み立てる（検査もここで走る）。書けないイベントなら、どちらの状態も書き換える前に
    // 投げる——`updateStatusWithEvent`（#1368）と同じ形。
    const firstEvent = this.buildOwnedEvent(ctx, first.event, [first.id, second.id]);
    const secondEvent = this.buildOwnedEvent(ctx, second.event, [first.id, second.id]);

    // 4. ここから先は両方成功する（in-memory であり、途中失敗の余地が無い）。
    firstMemory.status = "contested";
    firstMemory.contestedWithId = second.id;
    firstMemory.updatedAt = new Date();
    secondMemory.status = "contested";
    secondMemory.contestedWithId = first.id;
    secondMemory.updatedAt = new Date();
    this.backing.events.push(firstEvent, secondEvent);

    return { first: firstMemory, second: secondMemory, events: [firstEvent, secondEvent] };
  }

  /**
   * Issue #197 / ADR 0150: `markContestedPair` の解決側。両側とも `status === 'contested'`
   * かつ相互参照が成立していることを CAS で課したうえで、`contestedWithId` を両側とも
   * `null` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する
   * ——`markContestedPair` と同じ「事前検証してから書く」作法（まだ何も書いていないうちに
   * 存在確認と CAS 判定を両方の対象について済ませ、in-memory の「ロールバック」を模す）。
   *
   * `beforeUpdateStatus` は各対象の CAS 判定の**直前**に発火する——`markContestedPair` と
   * 同じ位置。TOCTOU の歯がこの口でも決定的に再現できるようにする。
   */
  async resolveContestedPair(
    ctx: Ctx,
    first: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    },
    second: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    first = normPairSide(first);
    second = normPairSide(second);
    assertFakeMemoryColumn("status", first.status);
    assertFakeMemoryColumn("status", second.status);
    if (first.id === second.id) {
      throw new RangeError("FakeMemoryStore: first.id and second.id must differ");
    }

    // 1. 事前検証——存在確認。まだ何も書いていない。
    const firstMemory = await this.get(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = await this.get(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${second.id}`);
    }

    // 2. 事前検証——CAS（両側とも `contested` かつ相互参照が成立していること）。
    //    まだ何も書いていない。
    this.beforeUpdateStatus?.(first.id);
    if (firstMemory.status !== "contested" || firstMemory.contestedWithId !== second.id) {
      throw new MemoryStatusConflictError(first.id, "contested", firstMemory.status);
    }
    this.beforeUpdateStatus?.(second.id);
    if (secondMemory.status !== "contested" || secondMemory.contestedWithId !== first.id) {
      throw new MemoryStatusConflictError(second.id, "contested", secondMemory.status);
    }
    // ADR 0439: `supersededById` は `ctx` のテナントの Memory であること（何も書く前）。
    this.assertOwnMemoryRef(ctx, first.supersededById);
    this.assertOwnMemoryRef(ctx, second.supersededById);

    // 3. イベントを2件とも先に組み立てる（検査もここで走る）。書けないイベントなら、どちらの状態も書き換える前に
    // 投げる——`updateStatusWithEvent`（#1368）と同じ形。
    const firstEvent = this.buildOwnedEvent(ctx, first.event, [first.id, second.id]);
    const secondEvent = this.buildOwnedEvent(ctx, second.event, [first.id, second.id]);

    // 4. ここから先は両方成功する（in-memory であり、途中失敗の余地が無い）。
    firstMemory.status = first.status;
    firstMemory.contestedWithId = null;
    if (first.supersededById !== undefined) {
      firstMemory.supersededById = first.supersededById;
    }
    firstMemory.updatedAt = new Date();
    secondMemory.status = second.status;
    secondMemory.contestedWithId = null;
    if (second.supersededById !== undefined) {
      secondMemory.supersededById = second.supersededById;
    }
    secondMemory.updatedAt = new Date();
    this.backing.events.push(firstEvent, secondEvent);

    return { first: firstMemory, second: secondMemory, events: [firstEvent, secondEvent] };
  }

  /**
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.markContestedGroup?` の実装
   * （契約は interface 側の doc コメントにある）。`markContestedPair` と同じ
   * 「事前検証してから書く」作法。
   */
  async markContestedGroup(
    ctx: Ctx,
    members: ReadonlyArray<{ id: MemoryId; event: NewMemoryEvent }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }> {
    assertWellFormedCtx(ctx);
    members = members.map((m) => ({ ...m, id: normId(m.id) }));
    if (members.length < 3) {
      throw new RangeError("FakeMemoryStore: members must have at least 3 entries");
    }
    const ids = members.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("FakeMemoryStore: member ids must be unique");
    }

    // 1. 事前検証——存在確認。まだ何も書いていない。
    const memories: Memory[] = [];
    for (const m of members) {
      const memory = await this.get(ctx, m.id);
      if (!memory) {
        throw new Error(`FakeMemoryStore: memory not found for tenant: ${m.id}`);
      }
      memories.push(memory);
    }

    // 2. 事前検証——CAS。まだ何も書いていない。
    for (const memory of memories) {
      this.beforeUpdateStatus?.(memory.id);
      const eligible =
        memory.status === "active" ||
        (memory.status === "contested" &&
          (memory.contestedWithId === null ||
            memory.contestedWithId === undefined ||
            ids.includes(memory.contestedWithId)));
      if (!eligible) {
        throw new MemoryStatusConflictError(memory.id, "active", memory.status);
      }
    }

    // 3. イベントを全件先に組み立てる（検査もここで走る）。
    // ADR 0431: 呼び出し時点で既に contested かつ contestedWithId が無いメンバーは、書いても状態が
    // 変わらない（既存の群のメンバーを吸収する場合）。そのメンバーには `updated` を積まない。
    const events = members
      .filter((_, i) => !isUnchangedGroupMember(memories[i]!))
      .map((m) => this.buildOwnedEvent(ctx, m.event, ids));

    // 4. ここから先は全部成功する。
    for (const memory of memories) {
      memory.status = "contested";
      memory.contestedWithId = null;
      memory.updatedAt = new Date();
    }
    // ADR 0381 §1: 有効期間が重なる組だけに関係の行を張る（ADR 0324 決定4との整合）。
    const overlaps = (a: Memory, b: Memory): boolean =>
      (a.validFrom === null ||
        a.validFrom === undefined ||
        b.validUntil === null ||
        b.validUntil === undefined ||
        a.validFrom < b.validUntil) &&
      (b.validFrom === null ||
        b.validFrom === undefined ||
        a.validUntil === null ||
        a.validUntil === undefined ||
        b.validFrom < a.validUntil);
    const linkPair = (fromId: MemoryId, toId: MemoryId): void => {
      const exists = (a: MemoryId, b: MemoryId) =>
        this.backing.relations.some(
          (r) =>
            r.tenantId === ctx.tenantId &&
            r.fromMemoryId === a &&
            r.toMemoryId === b &&
            r.kind === "contradicts",
        );
      const now = new Date();
      if (!exists(fromId, toId)) {
        this.backing.relations.push({
          id: nextId("rel"),
          tenantId: ctx.tenantId,
          fromMemoryId: fromId,
          toMemoryId: toId,
          kind: "contradicts",
          createdAt: now,
        });
      }
      if (!exists(toId, fromId)) {
        this.backing.relations.push({
          id: nextId("rel"),
          tenantId: ctx.tenantId,
          fromMemoryId: toId,
          toMemoryId: fromId,
          kind: "contradicts",
          createdAt: now,
        });
      }
    };
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (overlaps(memories[i]!, memories[j]!)) {
          linkPair(memories[i]!.id, memories[j]!.id);
        }
      }
    }
    this.backing.events.push(...events);

    return { members: memories, events };
  }

  /**
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.resolveContestedGroup?` の実装
   * （契約は interface 側の doc コメントにある）。`resolveContestedPair` と対称——
   * 決着の種類に関わらず、このメンバー全員を結んでいた関係の行を消す
   * （`MemoryStore.resolveContestedGroup?` の契約）。
   */
  async resolveContestedGroup(
    ctx: Ctx,
    members: ReadonlyArray<{
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }> {
    assertWellFormedCtx(ctx);
    members = members.map(normPairSide);
    for (const m of members) assertFakeMemoryColumn("status", m.status);
    if (members.length < 3) {
      throw new RangeError("FakeMemoryStore: members must have at least 3 entries");
    }
    const ids = members.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("FakeMemoryStore: member ids must be unique");
    }

    const memories: Memory[] = [];
    for (const m of members) {
      const memory = await this.get(ctx, m.id);
      if (!memory) {
        throw new Error(`FakeMemoryStore: memory not found for tenant: ${m.id}`);
      }
      memories.push(memory);
    }
    for (const memory of memories) {
      this.beforeUpdateStatus?.(memory.id);
      if (memory.status !== "contested") {
        throw new MemoryStatusConflictError(memory.id, "contested", memory.status);
      }
    }

    // 2026-09-30 の直し（ADR 0381 追記、段階Bの穴埋め）: `members` が、関係の行で
    // つながった「今も contested な」群の全員と一致することを CAS で課す
    // （`PostgresMemoryStore.resolveContestedGroup` と同じ形）。
    {
      const idSet = new Set(ids);
      const visited = new Set<MemoryId>(ids);
      const queue = [...ids];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const r of this.backing.relations) {
          if (
            r.tenantId === ctx.tenantId &&
            r.fromMemoryId === current &&
            r.kind === "contradicts" &&
            !visited.has(r.toMemoryId)
          ) {
            visited.add(r.toMemoryId);
            queue.push(r.toMemoryId);
          }
        }
      }
      const missing: MemoryId[] = [];
      for (const id of visited) {
        if (idSet.has(id)) continue;
        const memory = await this.get(ctx, id);
        if (memory !== null && memory.status === "contested") {
          missing.push(id);
        }
      }
      if (missing.length > 0) {
        // 2026-09-30 のさらなる直し（ADR 0381 §7 解消）: MemoryStatusConflictError の
        // 再利用をやめ、専用のエラーを投げる。
        throw new ContestedGroupMembershipMismatchError(missing[0]!);
      }
    }
    // ADR 0439: `supersededById` は `ctx` のテナントの Memory であること（何も書く前）。
    for (const m of members) {
      this.assertOwnMemoryRef(ctx, m.supersededById);
    }

    const events = members.map((m) => this.buildOwnedEvent(ctx, m.event, ids));

    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const memory = memories[i]!;
      memory.status = m.status;
      memory.contestedWithId = null;
      if (m.supersededById !== undefined) {
        memory.supersededById = m.supersededById;
      }
      memory.updatedAt = new Date();
    }
    const idSet = new Set(ids);
    this.backing.relations = this.backing.relations.filter(
      (r) =>
        !(
          r.tenantId === ctx.tenantId &&
          idSet.has(r.fromMemoryId) &&
          idSet.has(r.toMemoryId) &&
          r.kind === "contradicts"
        ),
    );
    this.backing.events.push(...events);

    return { members: memories, events };
  }

  /**
   * Issue #825（ADR 0150 追記）: `resolveContestedPair` の解決側 CAS を満たせなくなった
   * 生存側1件だけを対象にした別の任意メソッド。`beforeUpdateStatus` は CAS 判定の直前に
   * 発火する——`updateStatusWithEvent`/`resolveContestedPair` と同じ位置（TOCTOU 再現の
   * フックが死なないようにする）。
   */
  async resolveOrphanedContested(
    ctx: Ctx,
    survivor: { id: MemoryId; contestedWithId: MemoryId; event: NewMemoryEvent },
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    survivor = {
      ...survivor,
      id: normId(survivor.id),
      contestedWithId: normId(survivor.contestedWithId),
    };
    const memory = await this.get(ctx, survivor.id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${survivor.id}`);
    }
    this.beforeUpdateStatus?.(survivor.id);
    if (memory.status !== "contested" || memory.contestedWithId !== survivor.contestedWithId) {
      throw new MemoryStatusConflictError(survivor.id, "contested", memory.status);
    }

    // イベントを先に組み立てる（検査もここで走る）。書けないイベントなら、状態を書き換える前に投げる——
    // `updateStatusWithEvent`（#1368）と同じ形。
    const storedEvent = this.buildOwnedEvent(ctx, survivor.event, [survivor.id]);
    memory.status = "active";
    memory.contestedWithId = null;
    memory.updatedAt = new Date();
    this.backing.events.push(storedEvent);

    return { memory, event: storedEvent };
  }

  /**
   * Issue #372（(B) 第2段）: `MemoryStore.findActiveByClaimKey?` の実装
   * （`packages/testkit` の `InMemoryMemoryStore.findActiveByClaimKey` と同じロジック
   * ——このファイルは意図的に独立している、冒頭のコメント参照）。
   */
  async findActiveByClaimKey(
    ctx: Ctx,
    query: {
      subjectId: string | null;
      claimKey: ClaimKey;
      excludeMemoryId: MemoryId;
      contentHash: string;
      validFrom: Date | null;
      validUntil: Date | null;
    },
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId"); // ADR 0506
    // ADR 0543: 検索値（`text` 列の引数）の孤立サロゲートも U+FFFD に置き換わって比べられる。
    query = { ...query, claimKey: wfClaimKey(query.claimKey) };
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    return [...this.backing.memories.values()].filter((m) => {
      if (m.tenantId !== ctx.tenantId) return false;
      if (m.id === normId(query.excludeMemoryId)) return false;
      if ((m.subjectId ?? null) !== query.subjectId) return false;
      if (!m.claimKey) return false;
      if (
        m.claimKey.subject !== query.claimKey.subject ||
        m.claimKey.predicate !== query.claimKey.predicate
      ) {
        return false;
      }
      if (m.status !== "active") return false;
      if (m.contentHash === query.contentHash) return false;
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      // 空の区間・逆転した区間（`from >= until`）は点を1つも含まないので、何とも重ならない
      // （ADR 0473。`packages/postgres` の実装と同じ）。
      const isEmptyInterval = (from: Date | null, until: Date | null): boolean =>
        from !== null && until !== null && from >= until;
      const overlaps =
        !isEmptyInterval(targetFrom, targetUntil) &&
        !isEmptyInterval(otherFrom, otherUntil) &&
        (targetFrom === null || otherUntil === null || targetFrom < otherUntil) &&
        (otherFrom === null || targetUntil === null || otherFrom < targetUntil);
      return overlaps;
    });
  }

  /**
   * Issue #933（案2、ADR 0378）: `MemoryStore.findContestedByClaimKey?` の実装
   * （`packages/testkit` の `InMemoryMemoryStore.findContestedByClaimKey` と同じロジック
   * ——このファイルは意図的に独立している、冒頭のコメント参照）。`findActiveByClaimKey`
   * と同じ絞り込みで、`status === "active"` の代わりに `status === "contested"` を見る。
   */
  async findContestedByClaimKey(
    ctx: Ctx,
    query: {
      subjectId: string | null;
      claimKey: ClaimKey;
      excludeMemoryId: MemoryId;
      contentHash: string;
      validFrom: Date | null;
      validUntil: Date | null;
    },
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId"); // ADR 0506
    // ADR 0543: 検索値（`text` 列の引数）の孤立サロゲートも U+FFFD に置き換わって比べられる。
    query = { ...query, claimKey: wfClaimKey(query.claimKey) };
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    return [...this.backing.memories.values()].filter((m) => {
      if (m.tenantId !== ctx.tenantId) return false;
      if (m.id === normId(query.excludeMemoryId)) return false;
      if ((m.subjectId ?? null) !== query.subjectId) return false;
      if (!m.claimKey) return false;
      if (
        m.claimKey.subject !== query.claimKey.subject ||
        m.claimKey.predicate !== query.claimKey.predicate
      ) {
        return false;
      }
      if (m.status !== "contested") return false;
      if (m.contentHash === query.contentHash) return false;
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      // 空の区間・逆転した区間（`from >= until`）は点を1つも含まないので、何とも重ならない
      // （ADR 0473。`packages/postgres` の実装と同じ）。
      const isEmptyInterval = (from: Date | null, until: Date | null): boolean =>
        from !== null && until !== null && from >= until;
      const overlaps =
        !isEmptyInterval(targetFrom, targetUntil) &&
        !isEmptyInterval(otherFrom, otherUntil) &&
        (targetFrom === null || otherUntil === null || targetFrom < otherUntil) &&
        (otherFrom === null || targetUntil === null || otherFrom < targetUntil);
      return overlaps;
    });
  }

  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` の実装
   * （`packages/testkit` の `InMemoryMemoryStore.listActiveClaimPredicates` と同じ
   * ロジック——このファイルは意図的に独立している、冒頭のコメント参照）。
   */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId"); // ADR 0506
    // `PostgresMemoryStore.listActiveClaimPredicates` は `query.limit` を生 SQL の `LIMIT`（bigint の
    // パラメータ）へそのまま渡すので、負数・`NaN`・`Infinity`・非整数・2^63 以上では Postgres が
    // 例外を投げる。検査せず `slice(0, limit)` へ渡すと違う件数を黙って返すので、他の `limit` を
    // 取る口（`requeueEmbedJobs` ほか）と同じ2段の順序で、クエリの前に弾く Postgres 側に揃える。
    if (!Number.isInteger(query.limit)) {
      throw new Error(`listActiveClaimPredicates: limit must be an integer (got ${query.limit})`);
    }
    if (query.limit < 0) {
      throw new Error(`listActiveClaimPredicates: limit must not be negative (got ${query.limit})`);
    }
    if (query.limit >= 2 ** 63) {
      throw new Error(
        `listActiveClaimPredicates: limit must fit in a Postgres bigint (got ${query.limit})`,
      );
    }
    const latestByPredicate = new Map<string, number>();
    for (const m of this.backing.memories.values()) {
      if (m.tenantId !== ctx.tenantId) continue;
      if ((m.subjectId ?? null) !== query.subjectId) continue;
      if (m.status !== "active") continue;
      if (!m.claimKey) continue;
      const predicate = m.claimKey.predicate;
      const createdAtMs = m.createdAt.getTime();
      const existing = latestByPredicate.get(predicate);
      if (existing === undefined || createdAtMs > existing) {
        latestByPredicate.set(predicate, createdAtMs);
      }
    }
    return (
      [...latestByPredicate.entries()]
        // 同着は predicate のコードポイント順（UTF-8 のバイト順と一致する。JS の `<` は UTF-16 コード単位順で食い違う）。
        .sort((a, b) => b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
        .slice(0, query.limit)
        .map(([predicate]) => predicate)
    );
  }

  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」。`archiveDecayed` と同じ
   * 「範囲走査 + 一括更新」の形——`await` を挟まない同期区間で選定・更新・イベント
   * 追記を行うことで、postgres 実装の単一トランザクションを模す
   * （`packages/testkit` の `InMemoryMemoryStore.restoreSupersededBy` と同じ形だが、
   * ファイル冒頭のコメントの通り意図的に独立している）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: 積集合フィルタ。
   */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string; actor?: EventActor; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ restored: Memory[] }> {
    assertWellFormedCtx(ctx);
    supersededById = normId(supersededById);
    const onlyMemoryIds = filter?.onlyMemoryIds?.map(normId);
    const targets = [...this.backing.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const actor = event.actor ?? { type: "system" };
    const meta = { reason: event.reason ?? "unsuperseded", supersededById };

    // 全対象のイベントを先に組み立てる（検査もここで走る）。書けないイベント（Invalid Date の `at` など）なら、
    // 1件も戻す前に投げる——以前は対象ごとに戻してから組み立てていたので、先の対象だけが `active` に戻ったまま
    // 投げていた。`updateStatusWithEvent`（#1368）と同じ形。対象が無ければ組み立てないので、今どおり空で返る。
    const storedEvents = targets.map((memory) =>
      buildStoredEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "unsuperseded",
        at: event.at,
        actor,
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta,
      }),
    );

    const restored: Memory[] = [];
    targets.forEach((memory, i) => {
      memory.status = "active";
      memory.supersededById = null;
      memory.updatedAt = new Date();
      this.backing.events.push(storedEvents[i]!);
      restored.push(memory);
    });
    return { restored };
  }

  /**
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口
   * （Issue #515、ADR 0237）。`packages/testkit` の `InMemoryMemoryStore.previewRestoreSupersededBy`
   * と同じ形——対象の選び方は `restoreSupersededBy` と同じ filter を使い、
   * `this.backing.events` から対象ごとに直近の `kind: 'superseded'` イベントを探して
   * `meta.reason` を運ぶ。書き込みは一切行わない。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy` と
   * 同じ積集合フィルタ。
   */
  async previewRestoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    assertWellFormedCtx(ctx);
    supersededById = normId(supersededById);
    const onlyMemoryIds = filter?.onlyMemoryIds?.map(normId);
    const targets = [...this.backing.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const candidates = targets.map((memory) => {
      let latest: MemoryEvent | undefined;
      for (const event of this.backing.events) {
        if (
          event.tenantId === ctx.tenantId &&
          event.memoryId === memory.id &&
          event.kind === "superseded" &&
          (latest === undefined || event.at.getTime() > latest.at.getTime())
        ) {
          latest = event;
        }
      }
      const reason = latest?.meta?.["reason"];
      return {
        memoryId: memory.id,
        supersededReason: typeof reason === "string" ? reason : null,
      };
    });

    return { candidates };
  }
}

/**
 * Issue #207/#933 PR2（ADR 0381）: `RelationStore` の Fake 実装。`FakeEventStore` と
 * 同じ形——`FakeBackingStore.relations` をそのまま共有する（`FakeMemoryStore.
 * markContestedGroup`/`resolveContestedGroup` が書いた行もここから読める）。
 */
export class FakeRelationStore implements RelationStore {
  constructor(private readonly backing: FakeBackingStore) {}

  async link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    // ADR 0488: InMemory・Postgres と同じく、範囲外の kind は両端の検査より前に断る。
    if (!Object.hasOwn({ contradicts: true } satisfies Record<RelationKind, true>, kind)) {
      throw new Error(`FakeRelationStore: unknown relation kind: ${String(kind)}`);
    }
    // ADR 0521: 大文字の id も同じ記憶として受け、小文字（この Fake の id の綴り）で持つ。
    fromId = normId(fromId);
    toId = normId(toId);
    // ADR 0398: 両端の記憶が ctx のテナントに在ることを確かめてから書く（本物の store と同じ）。
    for (const id of [fromId, toId]) {
      const memory = this.backing.memories.get(id);
      if (memory === undefined || memory.tenantId !== ctx.tenantId) {
        throw new Error(`FakeRelationStore: memory not found for tenant: ${id}`);
      }
    }
    const exists = this.backing.relations.some(
      (r) =>
        r.tenantId === ctx.tenantId &&
        r.fromMemoryId === fromId &&
        r.toMemoryId === toId &&
        r.kind === kind,
    );
    if (exists) return;
    this.backing.relations.push({
      id: nextId("rel"),
      tenantId: ctx.tenantId,
      fromMemoryId: fromId,
      toMemoryId: toId,
      kind,
      createdAt: new Date(),
    });
  }

  async unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    fromId = normId(fromId);
    toId = normId(toId);
    this.backing.relations = this.backing.relations.filter(
      (r) =>
        !(
          r.tenantId === ctx.tenantId &&
          r.fromMemoryId === fromId &&
          r.toMemoryId === toId &&
          r.kind === kind
        ),
    );
  }

  async listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]> {
    assertWellFormedCtx(ctx);
    memoryId = normId(memoryId);
    return this.backing.relations
      .filter(
        (r) =>
          r.tenantId === ctx.tenantId && r.fromMemoryId === memoryId && (!kind || r.kind === kind),
      )
      .map((r) => ({ memoryId: r.toMemoryId, kind: r.kind, createdAt: new Date(r.createdAt) })); // ADR 0488: 複製して返す
  }
}

export class FakeOutboxStore implements OutboxStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * 歯が outbox 行の**終端状態**（`claimedAt` / `failedAt` / `lastError`）を直接測るための読み口。
   * ADR 0082 の歯が「対応していない kind のジョブは黙って lease 切れを待つのではなく
   * `fail()` で終端に落ちる」「頼まれていない kind は claim すらされない」を測るのに使う——
   * `TickResult` だけでは outbox 行がどうなったかは見えない。
   */
  listJobs(ctx: Ctx): OutboxJobRecord[] {
    return this.backing.outboxJobs
      .filter((job) => job.tenantId === ctx.tenantId)
      .map((job) => ({ ...job }));
  }

  // リース意味論（ADR 0032）は `packages/testkit` の `InMemoryOutboxStore`/
  // `PostgresOutboxStore` と一致させてある——この fake だけ古い意味論のままだと
  // `runtime.test.ts` が「今日の姿」を検査しているつもりで、実は直った後の姿を
  // 検査してしまう食い違いが起きる。
  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `claimedBy` は `text` 列に入る。NUL は Postgres が拒み、`InMemoryOutboxStore` も同じ文面で拒む。
    if (typeof opts.claimedBy === "string" && opts.claimedBy.includes("\u0000")) {
      throw new Error("claimBatch: claimedBy must not contain NUL characters (U+0000)");
    }
    // `PostgresOutboxStore.claimBatch` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる
    // （実測）。ここで検査せず `eligible.slice(0, opts.limit)` へ渡すと
    // `Array.prototype.slice` の意味論を踏んでジョブを黙って claim してしまう——
    // `InMemoryOutboxStore.claimBatch`（`packages/testkit`、PR #804/#811）と同じ形の
    // 不一致（`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`claimBatch: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`claimBatch: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`claimBatch: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // `PostgresOutboxStore.claimBatch` は `now` と `new Date(now - leaseMs)` を `timestamptz`
    // のパラメータとして送るため、どちらかが Invalid Date になる入力（`now` が Invalid Date、
    // `leaseMs` が `NaN`・`±Infinity`・`Date` の範囲を超える値）では Postgres が例外を投げる
    // （実測: `invalid input syntax for type timestamp with time zone`）。ここで検査せず数の
    // まま比べると、未 claim のジョブを claim してしまう。クエリを投げる前に弾く Postgres 側に
    // 揃える。⚠ `Date` としては有効でも Postgres の範囲（紀元前4713年より前）を外れる値は
    // 揃えていない（Issue #1041 の論点）。`now` が Invalid Date なら `now - leaseMs` も
    // Invalid Date になるので、1つの検査で両方を見る。
    if (Number.isNaN(new Date(opts.now.getTime() - opts.leaseMs).getTime())) {
      throw new Error(
        `claimBatch: now - leaseMs must be a valid Date (now=${opts.now.getTime()}, leaseMs=${opts.leaseMs})`,
      );
    }
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    // ADR 0543: `claimed_by`（`text`）・`kinds`（`text[]` の引数）の孤立サロゲートは U+FFFD に置き換わる。
    const kindsFilter = opts.kinds?.map((kind) => wf(kind));
    const eligible = this.backing.outboxJobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (kindsFilter === undefined || kindsFilter.includes(job.kind)) &&
        job.completedAt === null &&
        job.failedAt === null &&
        job.availableAt <= opts.now &&
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      job.claimedAt = opts.now;
      job.claimedBy = wf(opts.claimedBy);
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  // CAS 意味論（ADR 0142, Issue #233）も `packages/testkit` の `InMemoryOutboxStore`/
  // `PostgresOutboxStore` と一致させてある。complete/fail は互いに排他でもある
  // （Issue #826）——相手側の終端列（`completedAt`/`failedAt`）が既に付いていれば、
  // 後から来た呼び出しは行を一切変えず例外も投げない（先に付いた終端が勝つ）。
  // 同種の再呼び出し（complete+complete、fail+fail）の冪等な挙動は変えていない。
  async complete(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
    opts?: { at?: Date },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `OutboxStore.complete` の TSDoc が約束する（`opts.at` が Invalid Date なら、行には触れずに断る）。
    // `InMemoryOutboxStore` と同じく、行を探す前に見る。
    assertFakeQueryDate("complete", "opts.at", opts?.at);
    const job = this.backing.outboxJobs.find(
      (j) => j.id === normId(jobId) && j.tenantId === ctx.tenantId,
    );
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（fail）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.failedAt ?? null) !== null) {
      return;
    }
    // Issue #1237: 実装（`InMemoryOutboxStore`・`PostgresOutboxStore`）と同じく、`opts.at` を渡せばそれを使う。
    job.completedAt = opts?.at ?? new Date();
  }

  async fail(
    ctx: Ctx,
    jobId: string,
    error: string,
    expectedAttempts: number,
    opts?: { at?: Date },
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    assertFakeQueryDate("fail", "opts.at", opts?.at);
    const job = this.backing.outboxJobs.find(
      (j) => j.id === normId(jobId) && j.tenantId === ctx.tenantId,
    );
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（complete）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.completedAt ?? null) !== null) {
      return;
    }
    job.failedAt = opts?.at ?? new Date();
    job.lastError = error;
  }

  /**
   * Issue #1207 / ADR 0383: `packages/testkit` の `InMemoryOutboxStore.eraseTenant` と
   * 同じ実装（`this.backing.outboxJobs` を使う点だけが違う）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む。
    assertFakeEraseLimit(opts.limit);
    const dryRun = opts.dryRun === true;
    const matchingIndexes: number[] = [];
    for (
      let i = 0;
      i < this.backing.outboxJobs.length && matchingIndexes.length < opts.limit;
      i++
    ) {
      if (this.backing.outboxJobs[i]!.tenantId === ctx.tenantId) {
        matchingIndexes.push(i);
      }
    }
    if (!dryRun) {
      for (let i = matchingIndexes.length - 1; i >= 0; i--) {
        this.backing.outboxJobs.splice(matchingIndexes[i]!, 1);
      }
    }
    return { deleted: matchingIndexes.length, reachedLimit: matchingIndexes.length === opts.limit };
  }

  /**
   * [ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `OutboxStore.purgeCompletedJobs?` の in-memory 実装（`PostgresOutboxStore` と同じ契約）。
   * `completedAt` が付いていて `< olderThan` の行だけを消す——claim 中・未処理・
   * `failedAt` の行は対象にならない。共有配列なので `splice` でその場から取り除く。
   */
  async purgeCompletedJobs(
    ctx: Ctx,
    opts: PurgeCompletedJobsOptions,
  ): Promise<PurgeCompletedJobsResult> {
    assertWellFormedCtx(ctx);
    assertFakeQueryDate("purgeCompletedJobs", "olderThan", opts.olderThan);
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeCompletedJobs: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeCompletedJobs: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(
        `purgeCompletedJobs: limit must fit in a Postgres bigint (got ${opts.limit})`,
      );
    }
    const dryRun = opts.dryRun ?? false;
    const candidates = this.backing.outboxJobs
      .filter(
        (job) =>
          job.tenantId === ctx.tenantId &&
          (job.completedAt ?? null) !== null &&
          job.completedAt!.getTime() < opts.olderThan.getTime(),
      )
      .sort(
        (a, b) =>
          a.completedAt!.getTime() - b.completedAt!.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const reachedLimit = candidates.length > opts.limit;
    const victims = candidates.slice(0, opts.limit);
    const purged = victims.length;
    const oldestPurgedAt = purged > 0 ? new Date(victims[0]!.completedAt!) : null;
    const newestPurgedAt = purged > 0 ? new Date(victims[purged - 1]!.completedAt!) : null;
    if (!dryRun && purged > 0) {
      const victimIds = new Set(victims.map((job) => job.id));
      for (let i = this.backing.outboxJobs.length - 1; i >= 0; i--) {
        if (victimIds.has(this.backing.outboxJobs[i]!.id)) this.backing.outboxJobs.splice(i, 1);
      }
    }
    return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
  }
}

/**
 * cosine 距離（pgvector の `<=>` 演算子と同じ定義: `1 - cosine_similarity`）。
 * `packages/postgres` の `PostgresVectorStore.search` が実際に使う演算子と同じ式にする
 * ——recall のテストが「本物の pgvector とスコアの意味が違う」という食い違いを生まないため。
 *
 * **Issue #867 / 案B: 長さが違う2本は比較不能として `NaN` を返す。**
 * `packages/testkit/src/__fixtures__/in-memory-vector-store.ts` の `cosineDistance` に
 * 全く同じ形で足した番人と同じもの（このファイルが `testkit` を import できない理由は
 * このファイル冒頭のコメント参照）。以前は `a.length` までしか回らず、`a` が `b` より
 * 短いと `b` の残りを無視し、`a` が `b` より長いと `b[i] ?? 0` で 0 埋めして計算を続けて
 * いた——ノルムが0にならないため ADR 0040 の `NaN` 経路に乗らず、意味の無い実数の
 * 類似度を普通のヒットとして返していた。
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // 上の doc コメント（Issue #867 / 案B）参照——長さが違う時点で比較不能。
    return NaN;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) {
    // ADR 0040: 契約は「ゼロベクトルが絡む候補は recall() の結果に出ない」——
    // どんな scoreThreshold でも `total >= scoreThreshold` を通らない値を返さなければならない。
    // `0` でも `1` でもだめ（どちらも scoreThreshold 次第で通りうる）。
    // `Infinity` もだめ——`similarity = 1 - Infinity = -Infinity` になり、
    // `scoreThreshold = -Infinity` のとき `-Infinity >= -Infinity` が真になって通ってしまう。
    // `NaN` は、どんな数との比較も false になる唯一の値である。
    // 🔴 この番人（`normA === 0 || normB === 0`）を「下の式が 0/0 で同じ NaN になるから」と
    // 消さないこと——消しても値は変わらない（等価変異）が、番人が保持しているのは値ではなく
    // 「0/1/Infinity ではなく NaN を選んだ」という決定そのもの。消すと、次に式を触った人が
    // その決定ごと落とす。
    return NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `FakeVectorStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。recall のテストが意味のある結果を得られるよう、
 * `upsert` されたベクトルに対して実際に cosine 距離で ANN を模する
 * （`FakeBackingStore.memories` を参照して `VectorFilter`（ADR 0034）を本物同様に適用する）。
 *
 * **`backing` を必須のコンストラクタ引数にしている（省略不可）。** `status` / `subjectId` /
 * `decayFloorAt` は Memory の属性であって、ベクトルの属性ではない
 * （`VectorFilter` — `packages/core/src/interfaces/vector-store.ts`、ADR 0034）。
 * `packages/testkit` の `InMemoryVectorStore` が `memoryStore` を必須にしたのと同じ理由——
 * **省略可能にしなかった理由（ADR 0034 の「採らなかった案」節）**: 省略できると
 * 「filter を実際に検査できる fake」と「検査できない（＝常に無視しても壊れない）fake」が
 * 同じ緑色の出力になる。このリポジトリは ADR 0011/0025/0027/0028 で同じ族の失敗
 * （名乗れる以上の精度を主張する）を繰り返しており、ここでも繰り返さない。唯一の生成箇所
 * （このファイルの `createFakeRuntimeStores`）は既に `backing` を渡している。
 */
export class FakeVectorStore implements VectorStore {
  entries = new Map<string, { tenantId: string; memoryId: MemoryId; vector: number[] }>();

  constructor(private readonly backing: FakeBackingStore) {}

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    // 区切り文字で繋がず、`JSON.stringify` の配列で表す。`provider`・`model` は `:` を含みうる
    // （`nomic-embed-text:latest` など）。繋いだ文字列の前方一致で空間を絞ると、空間 `{p, m, 3}` が
    // 空間 `{p, m:3, 3}` のベクトルを拾っていた（`joined-string-keys.postgres.test.ts`）。
    return JSON.stringify([space.provider, space.model, space.dimensions, tenantId, memoryId]);
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // `search` は同じ `backing.memories` を真実の源として引いており（クラス doc 参照）、
    // 書き込み側（upsert）でも同じ非対称を強制する——ADR 0034 が実装した「MemoryStore が
    // 真実の源」を、書き込み時点でも成り立たせる。
    // ADR 0521: 大文字の id も同じ記憶として受け、小文字（この Fake の id の綴り）で持つ。
    memoryId = normId(memoryId);
    // ADR 0436: `ctx.tenantId` の記憶であることも確かめる（別のテナントの記憶は、実在しない id と同じく拒む）。
    if (this.backing.memories.get(memoryId)?.tenantId !== ctx.tenantId) {
      throw new Error(`FakeVectorStore: memory not found for tenant: ${memoryId}`);
    }
    // 穴 O-6-2（ADR 0424）: float4 に収まらない成分は Postgres の upsert が拒む（`InMemoryVectorStore` と同じ）。
    for (const [i, x] of vector.entries()) {
      if (!Number.isFinite(Math.fround(x))) {
        throw new RangeError(
          `FakeVectorStore.upsert: vector component [${i}] does not fit in a float4 (pgvector) value (got ${x})`,
        );
      }
    }
    // ADR 0493: pgvector は成分を float4 で持つ（`InMemoryVectorStore` と同じ。Issue #1268）。1e-50 は 0 に丸まる。
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      vector: vector.map(Math.fround),
    });
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    assertWellFormedCtx(ctx);
    // ADR 0493: 絞りの識別子（`tenantId`・`subjectId`）の NUL と、絞りの日時の Invalid Date を、
    // `InMemoryVectorStore`・`PostgresVectorStore` と同じく断る。
    assertWellFormedFilter(opts.filter, "opts.filter");
    // ADR 0543: `filter.labels`（`text[]` の引数）の孤立サロゲートは U+FFFD に置き換わって比べられる（保存側の `tags` も置き換わっている）。
    if (opts.filter.labels !== undefined) {
      opts = { ...opts, filter: { ...opts.filter, labels: opts.filter.labels.map((l) => wf(l)) } };
    }
    assertFakeQueryDate("search", "filter.occurredAfter", opts.filter.occurredAfter);
    assertFakeQueryDate("search", "filter.occurredBefore", opts.filter.occurredBefore);
    assertFakeQueryDate("search", "filter.validAt", opts.filter.validAt);
    assertFakeQueryDate("search", "filter.decayFloorAtAfter", opts.filter.decayFloorAtAfter);
    assertFakeQueryInteger("search", "filter.decayFloorSeqAfter", opts.filter.decayFloorSeqAfter);
    // `PostgresVectorStore.search` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる
    // （実測）。ここで検査せず `hits.slice(0, opts.limit)` へ渡すと
    // `Array.prototype.slice` の意味論を踏んでほぼ全件を静かに返してしまう——
    // `InMemoryVectorStore.search`（`packages/testkit`、PR #804/#811）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`search: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // `InMemoryVectorStore`（packages/testkit）と同じ意味論に揃える（ADR 0065）:
    // 索引を模す prefix は space（provider/model/dimensions）だけで絞る。以前はここで
    // `space` を一度も参照しておらず（引数名も `_space` だった）、異なる space の vector を
    // 混同して返していた——`key()` が space を含む prefix を作っているのに、`search` だけが
    // それを見ていなかった。
    // ADR 0493: 問い合わせのベクトルも float4 に丸める（`InMemoryVectorStore` と同じ。1e39 は Infinity になり距離が NaN になる）。
    const float4Query = query.map(Math.fround);
    const hits: (VectorHit & { recordedAt: Date })[] = [];
    for (const [key, entry] of this.entries) {
      // 空間は `key()` の組の先頭3つを完全一致で比べる（前方一致にしない）。
      const [provider, model, dimensions] = JSON.parse(key) as [string, string, number];
      if (provider !== space.provider || model !== space.model || dimensions !== space.dimensions)
        continue;
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) continue;
      // status / subjectId / decayFloorAtAfter は Memory の属性であり、ベクトルの属性ではない
      // （ADR 0034）。`backing.memories` を真実の源として引く——`InMemoryVectorStore` の
      // `this.memoryStore.get(...)` に対応する一段。
      const memory = this.backing.memories.get(entry.memoryId);
      if (!memory) {
        // 真実の源に無い vector は返さない——Postgres の外部キー制約
        // （`memory_id → memories(id)`）に対応する扱い（ADR 0034 決定2、
        // `InMemoryVectorStore` と揃える）。このリポジトリ内で `vectorStore.upsert` を
        // 直接呼ぶテストは必ず `memoryStore.createMemory` で作った実在の memory.id を渡して
        // いるため（`recall-pipeline.test.ts`）、この既定によって既存の歯が落ちないことを
        // 確認済み。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // Issue #608 項目③(b) / ADR 0286（Issue #948 で追加）: `includeSubjectless: true` の
      // ときだけ、`subjectId` 一致に加えて主体なし（`subjectId === null`）の行も通す
      // ——`InMemoryVectorStore.search`（`packages/testkit`）・`PostgresVectorStore.search`
      // （`m.subject_id = ... OR m.subject_id IS NULL`）と同じ意味論。以前は厳密一致
      // （`memory.subjectId !== opts.filter.subjectId`）だけを見ており、
      // `includeSubjectless` を一度も参照していなかった。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値。`FakeLexicalStore.search` と同じ意味論。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
      }
      // Issue #201 PR-B（ADR 0323、Issue #948 で追加）: OR の集合絞り込み——渡した名前の
      // うち1つでも `tags` に含まれれば通す。`InMemoryVectorStore.search`
      // （`packages/testkit`）・`PostgresVectorStore.search`（`m.tags && ...::text[]`）と
      // 同じ意味論。以前は一度も参照しておらず、`labels` を渡しても絞り込まれなかった。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      // ADR 0165 決めたこと1・12・14: 忘却ゲートの2軸。`decayFloorAnyAxis: true` かつ
      // 両方（`decayFloorAtAfter`・`decayFloorSeqAfter`）が与えられているときに限り OR で
      // 結ぶ（`interfaces/vector-store.ts` の `decayFloorAnyAxis` doc の契約そのもの）。
      // 以前はここで `decayFloorAtAfter` だけを常時 AND で見ており、`decayFloorSeqAfter`/
      // `decayFloorAnyAxis` を一度も参照していなかった——'either' のテナントで
      // 壁時計が死んでいるが活動時計は生きている候補が、ANN の push-down 段で
      // 誤って落ちる（実測: `recall-decay-gate.test.ts` の「'either' はOR: 活動時計は
      // 生きているが壁時計は沈んでいても通る」歯が最初に赤くなった）。
      const wallAxisAfter = opts.filter.decayFloorAtAfter;
      const seqAxisAfter = opts.filter.decayFloorSeqAfter;
      const wallAlive =
        wallAxisAfter === undefined ? undefined : memory.decayFloorAt > wallAxisAfter;
      // ADR 0353（Issue #338）: `decayFloorSeqUsesSubjectCounters` が true のときだけ、
      // この行の subjectId に対応する `S_x` を足す（postgres 側
      // `activityFloorSeqAliveCondition` と同じ式）。
      const effectiveSeqAxisAfter =
        seqAxisAfter === undefined
          ? undefined
          : opts.filter.decayFloorSeqUsesSubjectCounters === true && memory.subjectId != null
            ? seqAxisAfter +
              (this.backing.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
            : seqAxisAfter;
      const seqAlive =
        effectiveSeqAxisAfter === undefined
          ? undefined
          : memory.decayFloorSeq === null || memory.decayFloorSeq === undefined
            ? true
            : memory.decayFloorSeq > effectiveSeqAxisAfter;
      if (
        opts.filter.decayFloorAnyAxis === true &&
        wallAlive !== undefined &&
        seqAlive !== undefined
      ) {
        if (!wallAlive && !seqAlive) continue;
      } else {
        if (wallAlive === false) continue;
        if (seqAlive === false) continue;
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op
      // （`VectorFilter.excludeProvenanceKinds` の doc 参照。`InMemoryVectorStore` と
      // 同じ意味論）。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0059: period（両端とも包含、`>=`/`<=`）。比較対象は `occurredAt ?? recordedAt`
      // （ADR 0039 の実効時刻）——`InMemoryVectorStore`（`packages/testkit`）と同じ意味論。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`InMemoryVectorStore`
      // （`packages/testkit`）と同じ意味論。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }
      hits.push({
        memoryId: entry.memoryId,
        distance: cosineDistance(float4Query, entry.vector),
        recordedAt: memory.recordedAt,
      });
    }
    // `PostgresVectorStore.search`（ADR 0170、Issue #339）と同じ3段 tie-break:
    // 距離 → `recordedAt` DESC → `memoryId` 昇順。`InMemoryVectorStore`（`packages/testkit`）
    // と同じ理由・同じ修正——以前は距離だけのソートで、同点の中身が挿入順（通常の呼び出し順では
    // `recordedAt` が古いほうが先）に落ちており、Postgres の「新しい方が先」と逆向きだった
    // （`packages/core/src/__tests__/fake-vector-store-tiebreak.test.ts` が歯）。
    hits.sort((a, b) => {
      // 距離 `NaN`（ゼロベクトル、ADR 0040）は Postgres の `float8` と同じく、どの有限値よりも
      // 大きく、`NaN` どうしは同点として扱う（Issue #983）。`a.distance - b.distance` だけだと
      // `NaN` で比較関数が一貫せず、ゼロベクトルの候補の位置が挿入順しだいで揺れる。
      const aNaN = Number.isNaN(a.distance);
      const bNaN = Number.isNaN(b.distance);
      if (aNaN !== bNaN) return aNaN ? 1 : -1;
      if (!aNaN && a.distance !== b.distance) return a.distance - b.distance;
      const recordedAtDiff = b.recordedAt.getTime() - a.recordedAt.getTime();
      if (recordedAtDiff !== 0) return recordedAtDiff;
      return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
    });
    return hits.slice(0, opts.limit).map(({ memoryId, distance }) => ({ memoryId, distance }));
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    this.entries.delete(this.key(space, ctx.tenantId, normId(memoryId)));
  }

  /**
   * Issue #1425 / ADR 0382: `ctx.tenantId` に属する `memoryIds` の行を、この store が
   * 持つ**全 space**から消す。`packages/testkit` の `InMemoryVectorStore.deleteAcrossSpaces`
   * と同じ意味論——`entries` の値が持つ `tenantId`/`memoryId` の一致だけを見て、
   * space（key の先頭3要素）は問わない。
   */
  async deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    if (memoryIds.length === 0) {
      return;
    }
    const idSet = new Set<MemoryId>(memoryIds.map(normId));
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === ctx.tenantId && idSet.has(entry.memoryId)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Issue #200 / ADR 0151: 連想枠の歯が使う。`InMemoryVectorStore`
   * （`packages/testkit`）の同名メソッドと同じ意味論——存在しない memoryId・
   * 他テナントの memoryId は静かに結果から落ちる（tenant 境界は key の一致で掛かる）。
   */
  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<{ memoryId: MemoryId; vector: number[] }[]> {
    assertWellFormedCtx(ctx);
    // `PostgresVectorStore.getVectors` は `memory_id = ANY(...)` という集合演算で引くため
    // （実測）、同じ id を複数回渡しても一致する行は主キーの性質上1回しか無い。ここで
    // 検査せず `memoryIds` をそのまま for-of すると重複して返してしまう——
    // `InMemoryVectorStore.getVectors`（`packages/testkit`、PR #812）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。`seen` で2回目以降をスキップする。
    const seen = new Set<MemoryId>();
    const results: { memoryId: MemoryId; vector: number[] }[] = [];
    for (const rawMemoryId of memoryIds) {
      const memoryId = normId(rawMemoryId);
      if (seen.has(memoryId)) {
        continue;
      }
      seen.add(memoryId);
      const entry = this.entries.get(this.key(space, ctx.tenantId, memoryId));
      if (entry !== undefined) {
        results.push({ memoryId, vector: entry.vector });
      }
    }
    return results;
  }

  /**
   * Issue #1207 / ADR 0383: `packages/testkit` の `InMemoryVectorStore.eraseTenant` と
   * 同じ実装。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む。
    assertFakeEraseLimit(opts.limit);
    const dryRun = opts.dryRun === true;
    const matchingKeys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (matchingKeys.length >= opts.limit) break;
      if (entry.tenantId === ctx.tenantId) matchingKeys.push(key);
    }
    if (!dryRun) {
      for (const key of matchingKeys) this.entries.delete(key);
    }
    return { deleted: matchingKeys.length, reachedLimit: matchingKeys.length === opts.limit };
  }
}

/**
 * Issue #377 / Issue #1412 の続き: `searchMany`（任意メソッド）を持つ `VectorStore` を模す薄いラッパー。
 * `FakeVectorStore` へ全部委譲し、`searchMany` は契約（`VectorStore.searchMany?` の doc）どおり
 * 「`new Map(queries.map((q) => [q.key, search(ctx, space, q.vector, opts)]))` と同じ」に実装する
 * ——同じ key は後勝ち、Map の並びは最初に現れた位置。`searchCalls`/`searchManyCalls` は、
 * `recall-runtime.ts` の段3.5が束ねる経路と search へ戻る経路のどちらを通ったかを見るための記録。
 * `FakeVectorStore` 自体には足さない——足すと他の全テストの連想枠が束ねる経路に切り替わる。
 */
export function withSearchMany(store: FakeVectorStore): VectorStore & {
  searchCalls: number;
  searchManyCalls: { keys: string[]; opts: { limit: number; filter: VectorFilter } }[];
} {
  const wrapper = {
    searchCalls: 0,
    searchManyCalls: [] as { keys: string[]; opts: { limit: number; filter: VectorFilter } }[],
    upsert: (ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]) =>
      store.upsert(ctx, space, memoryId, vector),
    search: (
      ctx: Ctx,
      space: EmbeddingSpaceId,
      query: number[],
      opts: { limit: number; filter: VectorFilter },
    ) => {
      wrapper.searchCalls += 1;
      return store.search(ctx, space, query, opts);
    },
    delete: (ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId) =>
      store.delete(ctx, space, memoryId),
    deleteAcrossSpaces: (ctx: Ctx, memoryIds: readonly MemoryId[]) =>
      store.deleteAcrossSpaces(ctx, memoryIds),
    getVectors: (ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]) =>
      store.getVectors(ctx, space, memoryIds),
    searchMany: async (
      ctx: Ctx,
      space: EmbeddingSpaceId,
      queries: { key: string; vector: number[] }[],
      opts: { limit: number; filter: VectorFilter },
    ) => {
      wrapper.searchManyCalls.push({ keys: queries.map((q) => q.key), opts });
      const result = new Map<string, VectorHit[]>();
      for (const q of queries) result.set(q.key, await store.search(ctx, space, q.vector, opts));
      return result;
    },
  };
  return wrapper;
}

/**
 * Issue #200 / ADR 0151: `getVectors` を実装していない `VectorStore` を模す薄いラッパー。
 * `FakeVectorStore` の `upsert`/`search`/`delete` へそのまま委譲するが、`getVectors` を
 * プロパティとして持たない——`deps.vectorStore.getVectors === undefined` を検査する歯
 * （`stage_skipped { reason: "vector_store_lacks_get_vectors" }`）専用。
 */
export function withoutGetVectors(store: FakeVectorStore): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => store.upsert(ctx, space, memoryId, vector),
    search: (ctx, space, query, opts) => store.search(ctx, space, query, opts),
    delete: (ctx, space, memoryId) => store.delete(ctx, space, memoryId),
    deleteAcrossSpaces: (ctx, memoryIds) => store.deleteAcrossSpaces(ctx, memoryIds),
  };
}

/**
 * Issue #316 / ADR 0167: `VectorStore.getVectors` の doc（「返す順序は memoryIds の
 * 順序と一致している必要はない」）を、字面だけでなく実際に踏む adapter を模す。
 *
 * `FakeVectorStore.getVectors` は `memoryIds` をそのまま for-of するため、常に
 * **入力順を保って**返す——`PostgresVectorStore.getVectors`（`ORDER BY` を持たず、
 * 実測では主キー Index Scan がランダムな UUID 昇順で返す）とは違う。この違いが、
 * `recall-runtime.ts` 側が「契約上どの順で来てもよい」ことを実装で守れているかを
 * 検査から隠していた——この wrapper は、`getVectors` の結果を**逆順**にして返すことで、
 * 呼び出し側が返り値の順序に依存していないかを暴く。
 */
export function withReversedGetVectorsOrder(store: FakeVectorStore): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => store.upsert(ctx, space, memoryId, vector),
    search: (ctx, space, query, opts) => store.search(ctx, space, query, opts),
    delete: (ctx, space, memoryId) => store.delete(ctx, space, memoryId),
    deleteAcrossSpaces: (ctx, memoryIds) => store.deleteAcrossSpaces(ctx, memoryIds),
    getVectors: async (ctx, space, memoryIds) => {
      const entries = await store.getVectors(ctx, space, memoryIds);
      return [...entries].reverse();
    },
  };
}

/**
 * `FakeLexicalStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。`packages/testkit` の `InMemoryLexicalStore` とは
 * **意図的に独立している**——本 PR の時点で `InMemoryLexicalStore` はまだ書かれている最中
 * （Issue #106 の歯だけを先に置く作業。他の作業者が同時に `packages/testkit` を触っている）
 * ため、それを import しない。
 *
 * **契約は `interfaces/lexical-store.ts` の `LexicalStore` doc に従う**（ADR 0092）:
 * - `query` の語彙の**いずれか1つでも**含む候補を返す（OR 意味論）。1つも含まない候補は
 *   返さない——全件を無条件で返す実装は、この契約と `recall-channels.test.ts` 歯①の
 *   偽陽性点検（無関係な記憶が混ざっても返らないこと）で落ちる。
 * - `coverage`（一致した語彙数 ÷ クエリ語彙の総数）を返す。これがそのまま
 *   `ScoreBreakdown.lexicalMatch` に入る（`recall-runtime.ts`）。
 * - `filter` の各フィールドを実際に適用する（`FakeVectorStore.search` と同じ多層防御の作法）。
 * - 返り値は `coverage` の降順、同値なら `rank` の降順。`rank` はここでは
 *   「一致したトークンの出現回数の総和」という決定的で単調な値を使う——本物の
 *   `ts_rank_cd` を模す必要は無い。`LexicalHit.rank` の doc の通り、この値は
 *   `ScoreBreakdown` には一切入らない。
 *
 * **一致判定（Issue #951、PostgresLexicalStore に揃えた点・揃えていない点）**:
 *
 * `search` の一致判定は `InMemoryLexicalStore` と同じ語（token）の一致である（ADR 0513。以前は
 * `content.includes(語)` の部分文字列一致で、query `a` が content `alpha` に当たった。ADR 0509 の割れ 1）。
 * クエリは空白区切りの語を 1 単位（coverage の分母）とし、語の中の token（英数字境界で割る）が content の token の列に
 * 隣接して現れたときに、その語が一致したと数える（Postgres の `websearch_to_tsquery('"..."')` のフレーズ）。
 * **同じだと確認したこと**:
 * - 大文字・小文字を区別しない（`PostgresLexicalStore`/`to_tsvector('simple', …)` と同じ
 *   向き。以前はここに大文字小文字の区別があり、`PROJ-1234`/`proj-1234` を別語として
 *   扱っていた）。
 * - 本文側は、ASCII の連なりの前後に空白を入れてから小文字化する
 *   （`mnemora_lexical_normalize` と同じ順序。**順序が大事**——先に小文字化すると、
 *   小文字化で ASCII 化する非 ASCII 文字（ケルビン記号 U+212A → `k` 等）が隣の ASCII
 *   文字と癒着する。Issue #951 の実測: 本文 `"100" + U+212A` は `"100"` と `"k"` に
 *   割れ、クエリ `"100k"` の部分文字列一致にはならない——本物の Postgres でも0件）。
 * - クエリ側は、非 ASCII の連なりを空白に落としてから語に分割する
 *   （`mnemora_lexical_query_terms` と同じ向き。非 ASCII だけのクエリは語彙が0個になり
 *   0件を返す——本物の Postgres でも同じく0件）。
 *
 * **揃えていない・確認していないこと**（`InMemoryLexicalStore` と共通の限界。同ファイルの
 * doc 参照）: postgres の text search parser は `-12`・`+12` を符号付きの 1 token にし、`a.b`・メールアドレスを
 * 1 token にし、ハイフンで結んだ語を結合形と部品の両方の token にする。ここは英数字境界で割るだけなので、
 * content `proj 12` がクエリ `PROJ-12` に当たる・クエリ `12` が content `PROJ-12` に当たる（どちらも postgres は当たらない）。
 * 語幹処理・`word`/`numword`/`hword` 等の細かいトークン化規則、
 * ギリシャ語の語末シグマのような locale 依存の小文字化規則は再現していない。
 *
 * `calls` / `shouldThrow` は `FakeEmbeddingProvider.shouldFail` と同じ形の診断・注入口——
 * 「一度も呼ばれていないこと」（既定チャンネルが語彙 store に触れない）と
 * 「配線されているが落ちる adapter」の両方を、歯から直接組み立てられるようにするため。
 */

/**
 * クエリ全体の文字数・異なる語数・語ごとの文字数の上限（Issue #878、2026-09-26、
 * クローン miku の判断）。
 *
 * `packages/postgres` の `LEXICAL_QUERY_MAX_TOTAL_CHARS`/`LEXICAL_QUERY_MAX_DISTINCT_WORDS`/
 * `LEXICAL_QUERY_MAX_WORD_CHARS`（`packages/postgres/src/lexical-query-cap.ts`）、
 * `packages/testkit` の `InMemoryLexicalStore` が持つ同名の定数
 * （`packages/testkit/src/__fixtures__/in-memory-lexical-store.ts`）と**同じ値**
 * （3箇所とも手で揃える——`FakeLexicalStore` は `@mnemora/postgres`/`@mnemora/testkit`
 * の外に居るため、import で共有できない。値がずれていないことは `packages/postgres`
 * 側の歯 `lexical-query-cap-values-match.test.ts` が、3ファイルのソースを読んで
 * 突き合わせる）。
 *
 * `search` の語の数え方は `InMemoryLexicalStore` と同じ（ADR 0513: 空白区切りの語を 1 単位とし、語の中の
 * token は隣接を要る）。
 *
 * このファイルは `tsconfig.build.json` の `exclude`（`src/**\/__tests__/**`）に含まれ、
 * `@mnemora/core` の公開ビルド（`dist/`）には一切含まれない——ここでの export は
 * 同じパッケージ内の他のテストファイルが値を書き写さずに参照するためだけのものであり、
 * `pnpm api:check` には影響しない。
 */
export const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 32;
export const LEXICAL_QUERY_MAX_WORD_CHARS = 64;
export const LEXICAL_QUERY_MAX_TOTAL_CHARS = 600;

/**
 * `query` が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、先頭からその文字数に
 * 切り詰める。超えなければ `query` をそのまま返す。他のどの上限（語数・1語の文字数）
 * よりも先に適用する（`packages/postgres` の `capLexicalQueryTotalChars` と同じ
 * 位置づけ）。
 */
function capFakeLexicalQueryTotalChars(query: string): string {
  return query.length > LEXICAL_QUERY_MAX_TOTAL_CHARS
    ? query.slice(0, LEXICAL_QUERY_MAX_TOTAL_CHARS)
    : query;
}

/**
 * `rawTerms`（空白区切りの生の語の配列）から、1語が
 * {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える場合は先頭からその文字数に切り詰め、
 * そのうえで異なる語を先頭からの出現順に {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} 個
 * まで残した `Set` を返す。どちらの上限にも触れない限り、全ての語を含む `Set` を
 * そのまま返す（1件も切り捨てない）。**呼び出し側が、分割する前の生の `query` に
 * {@link capFakeLexicalQueryTotalChars} をあらかじめ通しておくこと**（`search` 参照）。
 */
/**
 * Issue #951: `mnemora_lexical_normalize`（`regexp_replace($1, '([[:ascii:]]+)', ' \1 ', 'g')`、
 * `packages/postgres/migrations/0008_memories_lexical_index.sql`）と同じ向き——`content` の
 * ASCII の連なりの前後に空白を入れる。**呼び出し順が大事——小文字化より前に呼ぶこと。**
 * 先に小文字化すると、小文字化で ASCII 化する非 ASCII 文字（ケルビン記号 U+212A → `k` 等）
 * が隣の ASCII 文字と癒着し、本来割れるはずの境界が消える（`FakeLexicalStore` の doc 参照）。
 */
function insertAsciiBoundaries(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/([\x00-\x7f]+)/g, " $1 ");
}

/**
 * Issue #951: `mnemora_lexical_query_terms`（`regexp_replace($1, '[^[:ascii:]]+', ' ', 'g')`、
 * `packages/postgres/migrations/0008_memories_lexical_index.sql`）と同じ向き——クエリ側の
 * 非 ASCII の連なりを空白1つに落とす。本文側（`insertAsciiBoundaries`）とは逆の変換であり、
 * 混同しないこと（`FakeLexicalStore` の doc 参照）。
 */
function dropNonAsciiRuns(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x00-\x7f]+/g, " ");
}

/**
 * ADR 0513: 本文を token の列にする（`InMemoryLexicalStore` の `tokenize` と同じ。ASCII の連なりの前後に
 * 空白を入れ、小文字化し、Unicode の英数字境界で割る）。`includes` の部分文字列一致ではなく、
 * Postgres（tsvector）と同じ「語（token）の一致」を見るために使う。
 */
function fakeLexicalTokenize(text: string): string[] {
  return insertAsciiBoundaries(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * ADR 0513: クエリを空白区切りの語に割り、語ごとの token の列（フレーズ）の配列にする
 * （`InMemoryLexicalStore` の `queryPhrases` と同じ。doc はそちら）。語の上限は語に当たる
 * （1 語 {@link LEXICAL_QUERY_MAX_WORD_CHARS} 文字、大文字小文字を区別しない異なる語 {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} 個）。
 * token が取れない語は捨て、同じ token 列は 1 つにまとめる（Postgres の空の tsquery の除外と `DISTINCT`）。
 * 呼び出し側が `dropNonAsciiRuns(capFakeLexicalQueryTotalChars(query))` を渡すこと。
 */
function fakeLexicalQueryPhrases(asciiOnlyQuery: string): string[][] {
  const rawWords = asciiOnlyQuery.split(/\s+/).filter((w) => w.length > 0);
  const seenLowercased = new Set<string>();
  const words: string[] = [];
  for (const raw of rawWords) {
    const word =
      raw.length > LEXICAL_QUERY_MAX_WORD_CHARS ? raw.slice(0, LEXICAL_QUERY_MAX_WORD_CHARS) : raw;
    const key = word.toLowerCase();
    if (!seenLowercased.has(key)) {
      seenLowercased.add(key);
      words.push(word);
    }
  }
  const seenPhrases = new Set<string>();
  const phrases: string[][] = [];
  for (const word of words.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS)) {
    const phrase = fakeLexicalTokenize(word);
    if (phrase.length === 0) continue;
    const key = phrase.join(" ");
    if (!seenPhrases.has(key)) {
      seenPhrases.add(key);
      phrases.push(phrase);
    }
  }
  return phrases;
}

/** `phrase` が `tokens` の中に隣接してこの順で現れる回数（`<->` のフレーズ一致）。 */
function countFakeLexicalPhrase(tokens: string[], phrase: string[]): number {
  let count = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((p, j) => tokens[i + j] === p)) count += 1;
  }
  return count;
}

export class FakeLexicalStore implements LexicalStore {
  /** `search` が呼ばれるたびに積む診断ログ。「一度も呼ばれていないこと」を歯が直接検査できる。 */
  calls: { ctx: Ctx; query: string; opts: { limit: number; filter: LexicalFilter } }[] = [];
  /** true にすると `search` は例外を投げる（配線されているが壊れている adapter を模す）。 */
  shouldThrow = false;

  constructor(private readonly backing: FakeBackingStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    assertWellFormedCtx(ctx);
    this.calls.push({ ctx, query, opts });
    if (this.shouldThrow) {
      throw new Error("FakeLexicalStore: simulated search failure");
    }
    // 穴 O-6-1（ADR 0424）: 検索語の NUL は Postgres の `text` に渡せない（`InMemoryLexicalStore` と同じ）。
    if (query.includes("\u0000")) {
      throw new Error("FakeLexicalStore.search: query must not contain NUL characters (U+0000)");
    }
    // ADR 0493: 絞りの識別子の NUL・日時の Invalid Date・`attributes` の NUL を、`InMemoryLexicalStore` と同じく断る。
    assertWellFormedFilter(opts.filter, "opts.filter");
    // ADR 0543: `filter.labels`（`text[]` の引数）の孤立サロゲートは U+FFFD に置き換わって比べられる（保存側の `tags` も置き換わっている）。
    if (opts.filter.labels !== undefined) {
      opts = { ...opts, filter: { ...opts.filter, labels: opts.filter.labels.map((l) => wf(l)) } };
    }
    assertFakeQueryDate("search", "filter.occurredAfter", opts.filter.occurredAfter);
    assertFakeQueryDate("search", "filter.occurredBefore", opts.filter.occurredBefore);
    assertFakeQueryDate("search", "filter.validAt", opts.filter.validAt);
    if (opts.filter.attributes !== undefined && jsonContainsNul(opts.filter.attributes)) {
      throw new Error("search: filter.attributes must not contain NUL characters (U+0000)");
    }
    // `PostgresLexicalStore.search`/`PostgresTrigramLexicalStore.search` は `opts.limit` を
    // 生 SQL の `LIMIT`（bigint パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・
    // 非整数は例外になる（実測、両実装とも同じ）。ここで検査せず
    // `hits.slice(0, opts.limit)` へ渡すと `Array.prototype.slice` の意味論を踏んで
    // ほぼ全件を静かに返してしまう——`InMemoryLexicalStore.search`（`packages/testkit`、
    // PR #804/#811）と同じ形の不一致（`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`search: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // Issue #878: クエリ全体の文字数・異なる語数・1語の文字数に上限を置く
    // （capFakeLexicalQueryTotalChars/capFakeLexicalQueryTerms の doc 参照）。
    // 全体の文字数を最初に適用する。
    // Issue #951: `mnemora_lexical_query_terms` と同じ向きで、非 ASCII の連なりを
    // 空白に落としてから分割する。`PostgresLexicalStore`/`to_tsvector('simple', …)` と
    // 同じく大文字小文字を区別しないため、ここで小文字化する（`FakeLexicalStore` の
    // doc 参照）。
    const phrases = fakeLexicalQueryPhrases(dropNonAsciiRuns(capFakeLexicalQueryTotalChars(query)));
    const hits: (LexicalHit & { recordedAt: Date })[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== opts.filter.tenantId || memory.tenantId !== ctx.tenantId) continue;
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // Issue #608 項目③(b) / ADR 0286（Issue #948 で追加）: `includeSubjectless: true` の
      // ときだけ、`subjectId` 一致に加えて主体なし（`subjectId === null`）の行も通す
      // ——`FakeVectorStore.search` と同じ意味論（doc はそちらを参照）。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値。`FakeVectorStore.search` と同じ意味論。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
      }
      // Issue #201 PR-B（ADR 0323、Issue #948 で追加）: OR の集合絞り込み。
      // `FakeVectorStore.search` と同じ意味論（doc はそちらを参照）。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`FakeVectorStore` と同じ意味論。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }
      // 🔴 契約（ADR 0092）: クエリの語彙が0個なら何も返さない。1個以上一致すれば返す
      // （OR 意味論）——AND（すべて含む候補しか返さない）ではない。
      if (phrases.length === 0) continue;
      // ADR 0513: `includes` の部分文字列一致ではなく、Postgres（tsvector）と同じ語（token）の一致。
      // `mnemora_lexical_normalize` と同じ順序（ASCII の連なりの前後に空白を入れてから小文字化）で割った
      // token の列に、クエリの語（空白区切り）の token 列が隣接して現れるかを見る。
      const contentTokens = fakeLexicalTokenize(memory.content);
      const counts = phrases.map((p) => countFakeLexicalPhrase(contentTokens, p));
      const matchedCount = counts.filter((n) => n > 0).length;
      if (matchedCount === 0) continue;

      const coverage = matchedCount / phrases.length;
      const rank = counts.reduce((sum, n) => sum + n, 0);
      hits.push({ memoryId: memory.id, coverage, rank, recordedAt: memory.recordedAt });
    }
    // `PostgresLexicalStore.search`（`interfaces/lexical-store.ts` の `LexicalStore.search`
    // doc、Issue #345 / ADR 0175）と同じ4段 tie-break: coverage → rank → recordedAt DESC →
    // memoryId 昇順。以前は coverage/rank/memoryId の3段止まりで recordedAt を見ておらず、
    // Postgres の「新しい方が先」と食い違っていた
    // （`fake-store-postgres-parity.test.ts` が歯。`InMemoryLexicalStore`
    // （`packages/testkit`）と同じ形の不一致・同じ修正）。
    hits.sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.rank - a.rank ||
        b.recordedAt.getTime() - a.recordedAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return hits
      .slice(0, opts.limit)
      .map(({ memoryId, coverage, rank }) => ({ memoryId, coverage, rank }));
  }
}

export class FakeEventStore implements EventStore {
  /**
   * ADR 0031: `backing.events` を共有する（`FakeMemoryStore.updateStatusWithEvent` が
   * 積んだイベントもここから読めるようにするため）。以前は独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`FakeOutboxStore` が `backing.outboxJobs` を
   * 共有するのと同じ形に揃えた。`stores.eventStore.events` という既存の参照の仕方
   * （`runtime.test.ts` 等）を壊さないよう、`events` は `backing.events` を指す getter。
   */
  constructor(private readonly backing: FakeBackingStore) {}

  get events(): MemoryEvent[] {
    return this.backing.events;
  }

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    assertWellFormedCtx(ctx);
    // 外部キー相当（ADR 0047）: `memory_events.memory_id → memories(id)`（nullable。
    // `kind = 'events_purged'` の場合のみ NULL が正当）。**NULL は拒まない**——kind を
    // 問わず、`memoryId` が非 null のときだけ実在を要求する。
    // ADR 0436: `ctx.tenantId` の記憶であることも確かめる（別のテナントの記憶は、実在しない id と同じく拒む）。
    if (
      event.memoryId !== null &&
      // ADR 0475: 大文字小文字は区別しない（`PostgresEventStore.append` は uuid を小文字にそろえて比べる）。message は渡された id のまま。
      this.backing.memories.get(event.memoryId.toLowerCase())?.tenantId !== ctx.tenantId
    ) {
      throw new Error(`FakeEventStore: memory not found for tenant: ${event.memoryId}`);
    }
    const stored = buildStoredEvent(ctx, event);
    this.backing.events.push(stored);
    return stored;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    assertWellFormedCtx(ctx);
    return this.backing.events.find((e) => e.id === id && e.tenantId === ctx.tenantId) ?? null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    assertWellFormedCtx(ctx);
    // `PostgresEventStore.list` は `filter.limit` を生 SQL の `LIMIT`（bigint パラメータ）
    // にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる（実測）。ここで
    // 検査せず `sorted.slice(0, filter.limit)` へ渡すと `Array.prototype.slice` の
    // 意味論を踏んでほぼ全件を静かに返してしまう——`InMemoryEventStore.list`
    // （`packages/testkit`、PR #804/#811）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。
    if (filter.limit !== undefined && !Number.isInteger(filter.limit)) {
      throw new Error(`list: limit must be an integer (got ${filter.limit})`);
    }
    if (filter.limit !== undefined && filter.limit < 0) {
      throw new Error(`list: limit must not be negative (got ${filter.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (filter.limit !== undefined && filter.limit >= 2 ** 63) {
      throw new Error(`list: limit must fit in a Postgres bigint (got ${filter.limit})`);
    }
    assertFakeQueryDate("list", "since", filter.since);
    assertFakeQueryDate("list", "until", filter.until);
    const matched = this.backing.events.filter((e) => {
      if (e.tenantId !== ctx.tenantId) return false;
      if (filter.memoryId !== undefined && e.memoryId !== normId(filter.memoryId)) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.since !== undefined && e.at < filter.since) return false;
      if (filter.until !== undefined && e.at > filter.until) return false;
      return true;
    });
    // EventStore.list の契約（../interfaces/event-store.ts）どおり `at` 昇順に並べ替えてから
    // `limit` を適用する。`filter()` は新しい配列を返すので、その配列を sort() すれば
    // `this.backing.events`（ADR 0031: FakeMemoryStore.updateStatusWithEvent と共有、
    // `store.events` getter 経由で runtime.test.ts が直接読む）を in-place で破壊しない
    // （`packages/testkit` の `InMemoryEventStore.list` と同じ形・同じ理由）。
    const sorted = matched.sort((a, b) => a.at.getTime() - b.at.getTime());
    return filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted;
  }
}

/**
 * Postgres の `real`（float4）の列に書いた number が、読み戻されるときの値。Postgres は float4 を「float4 として一意に決まる
 * 最短の10進表記」で文字列にし、ドライバが float64 として読む。呼ぶ前に、`Math.fround` が有限で 0 でないことを確かめてあること。
 * `packages/testkit` の `toFloat4Readback` と同じ式（core は testkit に依存しないので、ここに持つ）。
 */
function float4Readback(value: number): number {
  const rounded = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(rounded.toPrecision(digits));
    if (Math.fround(candidate) === rounded) {
      return candidate;
    }
  }
  return rounded;
}

// `getEventRetention`/`setEventRetention` は `TenantSettingsStore` interface が必須にした
// ため（ADR 0050）、型を満たすためだけに足した最小実装。⚠ 当初は「これら2メソッドを呼ぶ
// 既存テストは無い」と書いていたが、その後 `event-retention-purge.test.ts`（ADR 0115）が
// 呼ぶようになった。`packages/testkit` の `InMemoryTenantSettingsStore`（適合スイートの対象）
// とは異なり、`FakeTenantSettingsStore` は適合スイートの対象外（ADR 0047 が明記した
// 「core 専用の Fake は testkit の適合テストが届かない」構造と同じ）。テナントごとに
// 持つことだけは `fake-tenant-settings-event-retention-per-tenant.test.ts` が検査する。
//
// [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと13:
// `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/`getActivitySeq` を実装する。
// **interface 上はすべて省略可能（`?`）だが、活動時計の歯を書くにはこの Fake 側で
// 実装が要る**——省略した adapter がどう振る舞うかは `readDecayClock` 等の
// フォールバック自身の歯（`tenant-settings-store.test.ts` 等）が別に持つ。
export class FakeTenantSettingsStore implements TenantSettingsStore {
  // ADR 0007 / ADR 0050: テナントごとに持つ（以前は1つだけ持ち、`ctx` を読まずに共有していた。
  // 歯は `fake-tenant-settings-event-retention-per-tenant.test.ts`）。
  //
  // Issue #1232 / ADR 0354（2026-09-29 追記）: 保持期間そのものの値は、`backing` が渡されていれば
  // `backing.eventRetentionDays`（`FakeMemoryStore.purgeExpiredEventsByRetention` と共有する Map）に
  // 持つ——`activitySeq`/`subjectActivitySeq` と同じ「同一プロセス内の参照共有」の形。`backing` が
  // 渡されなければ、このインスタンス専用の `ownEventRetentionDays` を使う（`getActivitySeq` が
  // `backing` 無しで常に `0` を返すのと同じ規律——共有が無くても単体では動く）。
  private readonly ownEventRetentionDays = new Map<string, number | null>();
  private decayClockByTenant = new Map<string, DecayClock>();
  private halfLifeRecallsByTenant = new Map<string, number>();
  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `tenant_settings.taxonomy_mode` 相当。`decayClockByTenant` と同じ形——
   * `FakeMemoryStore` の `labels`（`FakeBackingStore` 側）とは違い、これを読むのは
   * `TenantSettingsStore` だけなので backing の共有は要らない。
   */
  private taxonomyModeByTenant = new Map<string, TaxonomyMode>();

  constructor(
    private readonly halfLifeHours = 720,
    /**
     * ADR 0165 決めたこと13 末尾の訂正どおり、`activity_seq` を進めるのは
     * `MemoryStore.createRecall`（別 adapter）である。フェイクの世界でその契約
     * （書く側と読む側が同じ値を見る）を再現するために、`FakeMemoryStore` と同じ
     * `FakeBackingStore` を共有する。省略すると `getActivitySeq` は常に `0` を返す
     * ——`tenant_activity` に一度も書かれていないテナントと同じ状態。
     */
    private readonly backing?: FakeBackingStore,
  ) {}

  /** {@link FakeTenantSettingsStore.backing} が渡されていればそれを、無ければ自前の Map を返す。 */
  private get eventRetentionDays(): Map<string, number | null> {
    return this.backing?.eventRetentionDays ?? this.ownEventRetentionDays;
  }

  async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
    assertWellFormedCtx(_ctx);
    return this.halfLifeHours;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    assertWellFormedCtx(ctx);
    if (!this.eventRetentionDays.has(ctx.tenantId)) {
      return { kind: "unset" };
    }
    const days = this.eventRetentionDays.get(ctx.tenantId)!;
    if (days === null) {
      return { kind: "unlimited" };
    }
    return { kind: "days", days };
  }

  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    assertWellFormedCtx(ctx);
    // ADR 0479: InMemoryTenantSettingsStore・Postgres と同じ検査（kind は Issue #1168、days の上限は int4 列）。
    assertValidEventRetentionKind(retention.kind);
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
      if (retention.days > 2 ** 31 - 1) {
        throw new Error(
          `setEventRetention: days does not fit in a Postgres "integer" (int4) column (got ${retention.days})`,
        );
      }
    }
    this.eventRetentionDays.set(ctx.tenantId, retention.kind === "days" ? retention.days : null);
  }

  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    assertWellFormedCtx(ctx);
    return this.decayClockByTenant.get(ctx.tenantId) ?? DEFAULT_DECAY_CLOCK;
  }

  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidDecayClock(clock);
    this.decayClockByTenant.set(ctx.tenantId, clock);
  }

  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    return this.halfLifeRecallsByTenant.get(ctx.tenantId) ?? DEFAULT_HALF_LIFE_RECALLS;
  }

  /**
   * ⚠ **この Fake は `TenantSettingsStore.setDefaultHalfLifeRecalls`（[ADR 0197]
   * (../../../docs/decisions/0197-set-default-half-life-recalls.md) が足した、`?` 付きの
   * 本番の書き込み口）を実装していない。**このメソッドは、interface のメソッドとは
   * 別名の、テスト専用の口である——`getDefaultHalfLifeHours` がコンストラクタ引数で
   * 差し替えられるのと同じ役割を、テナントごとに持てるようにしたもの。名前が違うのは
   * 偶然ではなく、`packages/testkit` の `InMemoryTenantSettingsStore` が同じ理由
   * （本番メソッドとの名前衝突）で同名のテスト専用フックを削除したのと対になる決定
   * ——このファイルは適合スイートの対象外（上のコメント参照）なので衝突は起きないが、
   * 読む側の混乱を避けるため命名だけ揃えた（ADR 0197「決めたこと」参照）。
   */
  setDefaultHalfLifeRecallsForTest(tenantId: string, value: number): void {
    this.halfLifeRecallsByTenant.set(tenantId, value);
  }

  /**
   * miku 了承済み（マネージャー経由）: `TenantSettingsStore.setDefaultHalfLifeRecalls`
   * （[ADR 0197](../../../docs/decisions/0197-set-default-half-life-recalls.md) の本番の
   * 書き込み口、interface 上は `?` 付きの任意メソッド）を `packages/postgres`・
   * `packages/testkit` の `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` と
   * 同じ意味論で実装する。値域は `assertValidHalfLifeRecalls`（core 共有）で検査する。
   *
   * `tenant_settings.default_half_life_recalls` は Postgres の `real`（IEEE 754
   * 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い
   * （`migrations/0015_decay_activity_clock.sql` の CHECK 制約）。`assertValidHalfLifeRecalls`
   * の値域 `(0, ∞)` は JS の float64 では有限でも、float4 の範囲を超える値
   * （例: `1e300`）は Postgres 側で `real` への変換時に `Infinity` へ丸まり、CHECK
   * 制約違反の例外になる（実測。`in-memory-fixtures-half-life-recalls-float4-overflow.test.ts`
   * と同じ形・同じ `Math.fround` の境界判定）。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidHalfLifeRecalls(recalls);
    const rounded = Math.fround(recalls);
    if (!Number.isFinite(rounded) || rounded === 0) {
      throw new Error(
        `setDefaultHalfLifeRecalls: recalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
      );
    }
    // ADR 0500（ADR 0479 の引き受けた負債）: 列は float4 なので、読み戻す値は float4 に丸めたものの最短表記
    // （`Math.fround(720.1)` ではなく `720.1`。`16777217` は `16777216`）。
    this.halfLifeRecallsByTenant.set(ctx.tenantId, float4Readback(recalls));
  }

  async getActivitySeq(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    if (this.backing === undefined) return 0;
    return this.backing.activitySeq.get(ctx.tenantId) ?? 0;
  }

  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `backing.subjectActivitySeq` に、このテナントの行が1本でもあるか。
   */
  async hasSubjectActivityCounters(ctx: Ctx): Promise<boolean> {
    assertWellFormedCtx(ctx);
    if (this.backing === undefined) return false;
    const bySubject = this.backing.subjectActivitySeq.get(ctx.tenantId);
    return bySubject !== undefined && bySubject.size > 0;
  }

  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `backing.subjectActivitySeq` から、渡した `subjectIds` ぶんを
   * まとめて読む。行が無い `subjectId` はキーを省略する。
   */
  async getSubjectActivitySeqs(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>> {
    assertWellFormedCtx(ctx);
    // ADR 0506: InMemory と同じく、`subjectIds` の各要素も読む前に断る。
    subjectIds.forEach((id, i) => assertWellFormedIdentifier(id, `subjectIds[${i}]`));
    const out = Object.create(null) as Record<string, number>;
    if (this.backing === undefined) return out;
    const bySubject = this.backing.subjectActivitySeq.get(ctx.tenantId);
    if (bySubject === undefined) return out;
    for (const id of subjectIds) {
      const value = bySubject.get(id);
      if (value !== undefined) {
        out[id] = value;
      }
    }
    return out;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `getTaxonomyMode?`（`InMemoryTenantSettingsStore` と
   * 同じ契約）。未設定のテナントは `DEFAULT_TAXONOMY_MODE`（`'open'`）。
   */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    assertWellFormedCtx(ctx);
    return this.taxonomyModeByTenant.get(ctx.tenantId) ?? DEFAULT_TAXONOMY_MODE;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `setTaxonomyMode?`（`InMemoryTenantSettingsStore` と
   * 同じ契約）。
   */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidTaxonomyMode(mode);
    this.taxonomyModeByTenant.set(ctx.tenantId, mode);
  }

  /**
   * Issue #1207 / ADR 0383: `packages/testkit` の `InMemoryTenantSettingsStore.eraseTenant`
   * と同じ契約。この Fake は `InMemoryTenantSettingsStore` と違い、テナントの設定を
   * 1つの「行」（Map）にまとめていない——`eventRetentionDays`・`decayClockByTenant`・
   * `halfLifeRecallsByTenant`・`taxonomyModeByTenant` の4つの Map に分かれているため、
   * どれか1つでもこのテナントのキーを持っていれば「行が存在した」とみなす。
   * `getDefaultHalfLifeHours` が返す `halfLifeHours`（コンストラクタ引数、テナント別では
   * ない固定値）はこのメソッドの対象外——テナントごとの状態ではないため。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    const existed =
      this.eventRetentionDays.has(ctx.tenantId) ||
      this.decayClockByTenant.has(ctx.tenantId) ||
      this.halfLifeRecallsByTenant.has(ctx.tenantId) ||
      this.taxonomyModeByTenant.has(ctx.tenantId);
    if (opts.dryRun !== true) {
      this.eventRetentionDays.delete(ctx.tenantId);
      this.decayClockByTenant.delete(ctx.tenantId);
      this.halfLifeRecallsByTenant.delete(ctx.tenantId);
      this.taxonomyModeByTenant.delete(ctx.tenantId);
    }
    return { deleted: existed ? 1 : 0, reachedLimit: false };
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = { provider: "fake", model: "fake-model", dimensions: 2 };
  shouldFail = false;

  /**
   * ADR 0142 の「tick はリース競合が起きても他のジョブの処理を続ける」歯のための、
   * 決定的な差し込みフック（`FakeMemoryStore.beforeUpdateStatus`、ADR 0030と同じ形）。
   * `embed()` が値を返す直前に呼ばれる——`processEmbedJob` が
   * `deps.outboxStore.complete(...)` を呼ぶより前の、まさにその隙間を指す。
   * ここで（テストコードから）別ワーカーの再 claim を直接起こすことで、
   * 「処理には成功したが complete しようとした時点でリースを失っていた」を
   * 確率的な並行に頼らず毎回同じ形で再現できる。
   */
  beforeEmbedReturn?: () => Promise<void> | void;

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (this.shouldFail) {
      throw new Error("simulated embedding provider failure");
    }
    if (this.beforeEmbedReturn) {
      await this.beforeEmbedReturn();
    }
    // 決定的: 文字列長から機械的にベクトルを作る。
    return texts.map((text) => [text.length, [...text].filter((c) => c === "a").length]);
  }
}

export function createFakeRuntimeStores(): {
  memoryStore: FakeMemoryStore;
  outboxStore: FakeOutboxStore;
  vectorStore: FakeVectorStore;
  /**
   * 語彙チャンネル（ADR 0084、Issue #106）。**常に生成する**が、`RuntimeDeps.lexicalStore` へ
   * 配線するかどうかは呼び出し側（各テストの `createRuntime` 呼び出し）の裁量——
   * 配線しない歯（`recall-channels.test.ts` 歯④）は、この値を単に渡さないだけでよい。
   */
  lexicalStore: FakeLexicalStore;
  eventStore: FakeEventStore;
  tenantSettingsStore: FakeTenantSettingsStore;
  embeddingProvider: FakeEmbeddingProvider;
  /**
   * Issue #207/#933 PR2（ADR 0381）。`lexicalStore` と同じく**常に生成する**が、
   * `RuntimeDeps.relationStore` へ配線するかどうかは呼び出し側の裁量——配線しない歯は
   * この値を渡さないだけでよい（既定 off・`RelationStore` 無し経路を縛る歯が使う）。
   */
  relationStore: FakeRelationStore;
} {
  const backing = new FakeBackingStore();
  return {
    memoryStore: new FakeMemoryStore(backing),
    outboxStore: new FakeOutboxStore(backing),
    vectorStore: new FakeVectorStore(backing),
    lexicalStore: new FakeLexicalStore(backing),
    eventStore: new FakeEventStore(backing),
    // `backing` を共有することで、`createRecall({advanceActivityClock: true})` が進めた
    // `activity_seq` を `getActivitySeq` が同じ値として読み戻せる（上のクラス doc 参照）。
    tenantSettingsStore: new FakeTenantSettingsStore(720, backing),
    embeddingProvider: new FakeEmbeddingProvider(),
    relationStore: new FakeRelationStore(backing),
  };
}

// ---------------------------------------------------------------------------
// recall() の戻り値の契約の検査（TSDoc の7巡目 B1・B2）
// ---------------------------------------------------------------------------

/**
 * `recall()` の戻り値が、出力の側の約束を守っているかを確かめ、破れていた点を文字列で返す（空なら守っている）。
 * `./setup-recall-output-contract.ts` が、core のすべてのテストの `createRuntime` の `recall` をこれで包む。
 *
 * - **B1**: `RecallResultSchema` を通る。`outputValidation` が在るなら `ok: true` である（既定の `"report"` で
 *   検証している。`"off"` のときも、ここで同じ schema を当てる）。
 * - **B2**: schema が強制していない TSDoc の約束:
 *   - `below_threshold.nearMisses` は上位5件まで・`score` の降順（`BelowThresholdOmission.nearMisses`）
 *   - `ann_truncated.safetyRatio` は `certainty: "loss_possible"` のときだけ在り、必ず 1 未満（`AnnTruncatedOmission.safetyRatio`）
 *   - `ann_unreached.severity` は runtime が必ず入れる（`AnnUnreachedOmission.severity`）
 *   - `filtered.scopeRelation` は `FILTERED_CONDITION_SCOPE_RELATION[condition]`（`FilteredOmission.scopeRelation`）
 *   - `unit_assembly_dropped.countKind` は `"lower_bound"`（`UnitAssemblyDroppedOmission`）
 *   - 件数を持つ Omission の `count` は 0 ではない（0件なら積まない）
 */
export function checkRecallResultContract(result: RecallResult): string[] {
  const problems: string[] = [];
  const parsed = RecallResultSchema.safeParse(result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      problems.push(`schema: ${issue.path.join(".")}: ${issue.message}`);
  }
  if (result.outputValidation !== undefined && !result.outputValidation.ok) {
    problems.push(
      `outputValidation.ok: false (${result.outputValidation.issues.map((i) => i.path).join(", ")})`,
    );
  }
  for (const o of result.omitted) {
    if (o.kind === "below_threshold" && o.nearMisses !== undefined) {
      if (o.nearMisses.length > 5)
        problems.push(`below_threshold.nearMisses が ${o.nearMisses.length} 件（上位5件まで）`);
      for (let i = 1; i < o.nearMisses.length; i += 1) {
        if (!(o.nearMisses[i - 1]!.score >= o.nearMisses[i]!.score))
          problems.push("below_threshold.nearMisses が score の降順でない");
      }
    }
    if (o.kind === "ann_truncated") {
      if (o.certainty === "loss_possible") {
        if (!(typeof o.safetyRatio === "number" && o.safetyRatio < 1))
          problems.push(
            `ann_truncated(loss_possible).safetyRatio = ${String(o.safetyRatio)}（1 未満であるはず）`,
          );
      } else if (o.safetyRatio !== undefined) {
        problems.push(`ann_truncated(${o.certainty}) が safetyRatio を持つ`);
      }
    }
    if (o.kind === "ann_unreached" && o.severity === undefined)
      problems.push("ann_unreached.severity が無い");
    if (
      o.kind === "filtered" &&
      o.scopeRelation !== FILTERED_CONDITION_SCOPE_RELATION[o.condition]
    ) {
      problems.push(`filtered(${o.condition}).scopeRelation = ${o.scopeRelation}`);
    }
    if (o.kind === "unit_assembly_dropped" && o.countKind !== "lower_bound")
      problems.push(`unit_assembly_dropped.countKind = ${o.countKind}`);
    if ("count" in o && o.count === 0) problems.push(`${o.kind} の count が 0`);
  }
  return problems;
}

/**
 * `RecalledMemory.score`/`RecallRecordMemory.score` は `ScoreBreakdown |
 * AffinityUnmeasuredScore` の判別可能な union（Issue #548 方向2、
 * [ADR 0352](../../../../docs/decisions/0352-association-score-without-total.md)）。
 * `total`/`similarity`/`lexicalMatch` を読む歯は、affinity を測っている（`"ann"`/`"lexical"`
 * 経由で、`affinityMeasured` が `false` でない）ことをテストの入力自体から知っているが、
 * 型はそれを知らない——ここで assert し、`ScoreBreakdown` 側へ絞り込む。
 * `affinityMeasured === false` なら、その歯の前提（affinity を測る経路のはず）が崩れている
 * ということなので、握り潰さず投げる。
 */
export function assertAffinityMeasured(score: RecalledScore): asserts score is ScoreBreakdown {
  if (score.affinityMeasured === false) {
    throw new Error(
      "assertAffinityMeasured: score.affinityMeasured is false (AffinityUnmeasuredScore) — " +
        "this test expected a measured (ann/lexical) score with total/similarity/lexicalMatch",
    );
  }
}
