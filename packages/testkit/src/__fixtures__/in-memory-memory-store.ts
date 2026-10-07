import {
  computeEventRetentionCutoff,
  ContestedGroupMembershipMismatchError,
  ContestedWithoutCompanionError,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
  isContestedWithoutCompanion,
  isEmbeddingStatusRollback,
  isHalfLifeHoursInRange,
  isHalfLifeRecallsInRange,
  isStrengthInRange,
  MAX_STRENGTH,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  resolveIdempotentCreate,
  SourceMemoryStatusChangedError,
} from "@mnemora/core";
import type { IdempotentCreateResult, NotIndexedReason } from "@mnemora/core";
import type {
  AggregateScopeOptions,
  ArchiveDecayedOptions,
  ArchiveDecayedResult,
  ClaimKey,
  Ctx,
  EmbeddingStatus,
  EraseTenantStoreOptions,
  EraseTenantStoreResult,
  EventActor,
  LabelSummary,
  Memory,
  MemoryEvent,
  MemoryId,
  MemoryStatus,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  NewRecallRecord,
  Observation,
  ObservationId,
  OutboxJobKind,
  OutboxJobRecord,
  PurgeExpiredEventsByRetentionOptions,
  PurgeExpiredEventsByRetentionOutcome,
  PurgeExpiredEventsOptions,
  PurgeExpiredRecallsOptions,
  PurgeExpiredRecallsResult,
  PurgeExpiredEventsResult,
  RecallId,
  RecallRecord,
  RecallScope,
  ReinforceOptions,
  RelationKind,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
  ScopeAggregate,
} from "@mnemora/core";
import {
  assertWellFormedCtx,
  assertWellFormedIdentifier,
  assertWellFormedNewMemory,
} from "@mnemora/core";
import { buildStoredMemoryEvent } from "./in-memory-event-store.js";
import {
  replaceLoneSurrogates,
  replaceLoneSurrogatesInClaimKey,
  replaceLoneSurrogatesInNewMemory,
  replaceLoneSurrogatesInNewObservation,
} from "./well-formed-text.js";
import {
  assertQueryDate,
  assertQueryTimestamptz,
  assertWrittenTimestamptzFloor,
  assertQueryJsonWithoutNul,
  assertQueryTextWithoutNul,
  assertQueryBigint,
  seqSumOverflowsBigint,
  jsonContainsNul,
  stringHasNul,
} from "./query-check.js";
import { toFloat4Readback } from "./float4.js";
import {
  assertCloneableMemoryEvent,
  assertStorableMemoryEvent,
  asJsonSerializedSizeBeforeBytes,
} from "./memory-event-check.js";
import { assertStorableMemoryColumn } from "./memory-enum-check.js";
import { nextId } from "./id.js";

function casMismatch(
  memory: { status: MemoryStatus; purgedAt?: Date | null | undefined },
  expectedStatus: MemoryStatus,
): boolean {
  return memory.status !== expectedStatus || (memory.purgedAt ?? null) !== null;
}

function assertResolvedStatus(method: string, field: string, status: unknown): void {
  if (status !== "active" && status !== "superseded") {
    throw new RangeError(`${method}: ${field}.status must be "active" or "superseded"`);
  }
}

function assertSupersededByShape(
  method: string,
  field: string,
  selfId: string,
  status: string,
  supersededById: string | undefined,
  opts: { forbidWhenNotSuperseded: boolean },
): void {
  if (status === "superseded") {
    if (supersededById === undefined) {
      throw new RangeError(
        `${method}: ${field}.supersededById is required when status is "superseded"`,
      );
    }
    if (normId(supersededById) === normId(selfId)) {
      throw new RangeError(`${method}: ${field}.supersededById must not be the memory itself`);
    }
  } else if (opts.forbidWhenNotSuperseded && supersededById !== undefined) {
    throw new RangeError(
      `${method}: ${field}.supersededById must not be set unless status is "superseded"`,
    );
  }
}

function assertNoSupersededCycle(
  method: string,
  members: ReadonlyArray<{ id: string; status: string; supersededById?: string | undefined }>,
): void {
  const next = new Map<string, string>();
  for (const m of members) {
    if (m.status === "superseded" && m.supersededById !== undefined) {
      next.set(m.id, m.supersededById);
    }
  }
  for (const start of next.keys()) {
    let cur = next.get(start);
    for (let hops = 0; cur !== undefined && hops <= next.size; hops += 1) {
      if (cur === start) {
        throw new RangeError(`${method}: supersededById must not form a cycle among the members`);
      }
      cur = next.get(cur);
    }
  }
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** `memory_relations` の1行相当。`InMemoryMemoryStore.relations`（書く）と `InMemoryRelationStore`（読む）が共有する内部形。 */
export interface StoredRelation {
  id: string;
  tenantId: string;
  fromMemoryId: MemoryId;
  toMemoryId: MemoryId;
  kind: RelationKind;
  createdAt: Date;
}

function assertRecallRecordStorable(record: NewRecallRecord): void {
  if (record.createdAt != null && Number.isNaN(record.createdAt.getTime())) {
    throw new Error("createRecall: createdAt must be a valid Date (got Invalid Date)");
  }
  assertWrittenTimestamptzFloor("createRecall", "createdAt", record.createdAt);
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

function assertOutboxRowsWritable(
  method: string,
  jobKinds: ReadonlyArray<OutboxJobKind>,
  now: Date | undefined,
  claimedBy?: string | undefined,
): void {
  if (jobKinds.length === 0) {
    return;
  }
  assertQueryTimestamptz(method, "opts.now", now);
  if (jobKinds.some((kind) => stringHasNul(kind))) {
    throw new Error(`${method}: jobKinds must not contain NUL characters (U+0000)`);
  }
  if (stringHasNul(claimedBy)) {
    throw new Error(`${method}: claimedBy must not contain NUL characters (U+0000)`);
  }
}

function toStorablePayload(value: unknown, key = ""): unknown {
  let current = value;
  if (
    current !== null &&
    typeof current === "object" &&
    !(current instanceof Date) &&
    typeof (current as { toJSON?: unknown }).toJSON === "function"
  ) {
    current = (current as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (current === null || typeof current !== "object" || current instanceof Date) {
    return current;
  }
  if (Array.isArray(current)) {
    return current.map((element, index) => {
      const next = toStorablePayload(element, String(index));
      return typeof next === "function" || typeof next === "symbol" ? null : next;
    });
  }
  if (
    Object.getPrototypeOf(current) !== Object.prototype &&
    Object.getPrototypeOf(current) !== null
  ) {
    return current;
  }
  const result: Record<string, unknown> = {};
  for (const [name, element] of Object.entries(current)) {
    const next = toStorablePayload(element, name);
    if (typeof next !== "function" && typeof next !== "symbol") {
      result[name] = next;
    }
  }
  return result;
}

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

function assertObservationDatesValid(owner: string, input: NewObservation): void {
  for (const [field, value] of [
    ["occurredAt", input.occurredAt],
    ["recordedAt", input.recordedAt],
    ["validFrom", input.validFrom],
    ["validUntil", input.validUntil],
  ] as const) {
    if (value != null && Number.isNaN(value.getTime())) {
      throw new Error(`${owner}: ${field} must be a valid Date (got Invalid Date)`);
    }
    assertWrittenTimestamptzFloor(owner, field, value);
  }
}

function isDecayedForScope(
  memory: Pick<Memory, "decayFloorAt" | "decayFloorSeq" | "subjectId">,
  scope: RecallScope,
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
  if (
    decayFloorSeqAfter !== undefined &&
    scope.decayFloorSeqUsesSubjectCounters === true &&
    memory.subjectId != null &&
    memory.decayFloorSeq != null &&
    (wallAlive === undefined || (scope.decayFloorAnyAxis === true ? !wallAlive : wallAlive)) &&
    seqSumOverflowsBigint(
      decayFloorSeqAfter,
      subjectActivitySeqByTenant?.get(memory.subjectId) ?? 0,
    )
  ) {
    throw new Error(
      `aggregateScope: decayFloorSeqAfter + own subject seq must fit in a Postgres bigint (got ${decayFloorSeqAfter} + ${subjectActivitySeqByTenant?.get(memory.subjectId) ?? 0})`,
    );
  }
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

/** 素の `<`/`>` は UTF-16 コード単位順で、サロゲートペアが U+E000〜U+FFFF より前に並び、`COLLATE "C"` のコードポイント順と食い違う。 */
function compareLabelName(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aCodePoint = a.codePointAt(i)!;
    const bCodePoint = b.codePointAt(j)!;
    if (aCodePoint !== bCodePoint) {
      return aCodePoint < bCodePoint ? -1 : 1;
    }
    i += aCodePoint > 0xffff ? 2 : 1;
    j += bCodePoint > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function assertStorableNewMemory(input: NewMemory): void {
  if (!isStrengthInRange(input.strength)) {
    throw new Error(
      `InMemoryMemoryStore: strength out of range (0, ${MAX_STRENGTH}]: ${input.strength}`,
    );
  }
  if (!isHalfLifeHoursInRange(input.halfLifeHours)) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours out of range (0, ∞): ${input.halfLifeHours}`,
    );
  }
  if (!Number.isFinite(Math.fround(input.halfLifeHours))) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${input.halfLifeHours})`,
    );
  }
  for (const [field, value] of [
    ["halfLifeHours", input.halfLifeHours],
    ["strength", input.strength],
  ] as const) {
    if (value !== 0 && Math.fround(value) === 0) {
      throw new Error(
        `InMemoryMemoryStore: ${field} does not fit in a Postgres "real" (float4) column (got ${value}; rounds to 0)`,
      );
    }
  }
  if (
    (input.provenance.kind === "stated" || input.provenance.kind === "inferred") &&
    input.sourceObservationId == null
  ) {
    throw new Error(
      `InMemoryMemoryStore: provenance.kind "${input.provenance.kind}" requires sourceObservationId`,
    );
  }
  for (const [field, value] of [
    ["decayBaseSeq", input.decayBaseSeq],
    ["decayFloorSeq", input.decayFloorSeq],
  ] as const) {
    if (value == null) continue;
    if (!Number.isInteger(value)) {
      throw new Error(`InMemoryMemoryStore: ${field} must be an integer (got ${value})`);
    }
    if (value < 0) {
      throw new Error(`InMemoryMemoryStore: ${field} must not be negative (got ${value})`);
    }
    if (value >= 2 ** 63) {
      throw new Error(`InMemoryMemoryStore: ${field} must fit in a Postgres bigint (got ${value})`);
    }
  }
  if (input.halfLifeRecalls != null) {
    const recalls = input.halfLifeRecalls;
    if (!isHalfLifeRecallsInRange(recalls)) {
      throw new Error(`InMemoryMemoryStore: halfLifeRecalls out of range (0, ∞): ${recalls}`);
    }
    if (!Number.isFinite(Math.fround(recalls))) {
      throw new Error(
        `InMemoryMemoryStore: halfLifeRecalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
      );
    }
    if (Math.fround(recalls) === 0) {
      throw new Error(
        `InMemoryMemoryStore: halfLifeRecalls does not fit in a Postgres "real" (float4) column (got ${recalls}; rounds to 0)`,
      );
    }
  }
  if (Number.isNaN(input.recordedAt.getTime())) {
    throw new Error(`InMemoryMemoryStore: recordedAt must be a valid Date (got Invalid Date)`);
  }
  if (!(input.decayFloorAt instanceof Date)) {
    throw new TypeError(
      `InMemoryMemoryStore: decayFloorAt must be a Date (got ${input.decayFloorAt === null ? "null" : typeof input.decayFloorAt})`,
    );
  }
  if (Number.isNaN(input.decayFloorAt.getTime())) {
    throw new Error(`InMemoryMemoryStore: decayFloorAt must be a valid Date (got Invalid Date)`);
  }
  for (const [field, value] of [
    ["occurredAt", input.occurredAt],
    ["lastReinforcedAt", input.lastReinforcedAt],
    ["validFrom", input.validFrom],
    ["validUntil", input.validUntil],
  ] as const) {
    if (value != null && Number.isNaN(value.getTime())) {
      throw new Error(`InMemoryMemoryStore: ${field} must be a valid Date (got Invalid Date)`);
    }
  }
  for (const [field, value] of [
    ["recordedAt", input.recordedAt],
    ["decayFloorAt", input.decayFloorAt],
    ["occurredAt", input.occurredAt],
    ["lastReinforcedAt", input.lastReinforcedAt],
    ["validFrom", input.validFrom],
    ["validUntil", input.validUntil],
  ] as const) {
    assertWrittenTimestamptzFloor("InMemoryMemoryStore", field, value);
  }
  if (input.content.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: content must not contain NUL characters (U+0000)`);
  }
  if (input.subjectId != null && input.subjectId.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: subjectId must not contain NUL characters (U+0000)`);
  }
  if (input.tags.some((tag) => tag.includes("\u0000"))) {
    throw new Error(`InMemoryMemoryStore: tags must not contain NUL characters (U+0000)`);
  }
  if (input.digest.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: digest must not contain NUL characters (U+0000)`);
  }
  if (input.contentHash.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: contentHash must not contain NUL characters (U+0000)`);
  }
  if (stringHasNul(input.extractorVersion)) {
    throw new Error(
      `InMemoryMemoryStore: extractorVersion must not contain NUL characters (U+0000)`,
    );
  }
  if (stringHasNul(input.claimKey?.subject)) {
    throw new Error(
      `InMemoryMemoryStore: claimKey.subject must not contain NUL characters (U+0000)`,
    );
  }
  if (stringHasNul(input.claimKey?.predicate)) {
    throw new Error(
      `InMemoryMemoryStore: claimKey.predicate must not contain NUL characters (U+0000)`,
    );
  }
  if (jsonContainsNul(input.attributes ?? {})) {
    throw new Error(`InMemoryMemoryStore: attributes must not contain NUL characters (U+0000)`);
  }
  if (jsonContainsNul(input.provenance)) {
    throw new Error(`InMemoryMemoryStore: provenance must not contain NUL characters (U+0000)`);
  }
  if (input.status !== undefined) assertStorableMemoryColumn("status", input.status);
  assertStorableMemoryColumn("digest_source", input.digestSource);
  assertStorableMemoryColumn("embedding_status", input.embeddingStatus);
  assertStorableMemoryColumn("provenance_kind", input.provenance.kind);
  assertWellFormedNewMemory("InMemoryMemoryStore", input);
}

/** `MemoryStore` のインメモリ実装。本番用途ではない: 索引・永続化・トランザクションは模さない。Postgres が拒む値はこの fixture も拒み、拒むときは何も書かない。 */
function normId<T extends string>(id: T): T {
  return id.toLowerCase() as T;
}
function normOptId<T extends string>(id: T | null | undefined): T | null | undefined {
  return id === null || id === undefined ? id : normId(id);
}

function normPairSide<T extends { id: MemoryId; supersededById?: MemoryId | undefined }>(
  side: T,
): T {
  return {
    ...side,
    id: normId(side.id),
    ...(side.supersededById === undefined ? {} : { supersededById: normId(side.supersededById) }),
  };
}

function tenantOfUsageKey(key: string): string {
  const last = key.lastIndexOf(":");
  return key.slice(0, key.lastIndexOf(":", last - 1));
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly observations = new Map<string, Observation>();
  private readonly memories = new Map<string, Memory>();
  private readonly extractionIndex = new Map<string, MemoryId>();
  private readonly usages = new Set<string>();
  readonly recalls = new Map<string, NewRecallRecord & { tenantId: string; createdAt: Date }>();
  /** `InMemoryEventStore` と共有する memory_events 相当の配列。 */
  readonly events: MemoryEvent[] = [];
  /** `InMemoryOutboxStore` と共有する outbox ジョブの配列。 */
  readonly outboxJobs: OutboxJobRecord[] = [];
  /** `InMemoryTenantSettingsStore` と同じ Map を渡すと、書く側と読む側が同じ値を見る。 */
  readonly activitySeq = new Map<string, number>();

  /** `InMemoryTenantSettingsStore` と共有する。 */
  readonly subjectActivitySeq = new Map<string, Map<string, number>>();

  /** `InMemoryTenantSettingsStore` と共有する。キー無しは `unset`、`null` は `unlimited`。 */
  readonly eventRetentionDays = new Map<string, number | null>();

  private readonly labels = new Map<string, LabelSummary>();

  private readonly memoryLabels = new Map<string, Set<string>>();

  /** `InMemoryRelationStore` と共有する。 */
  readonly relations: StoredRelation[] = [];

  private readonly memoriesDeletedListeners: Array<
    (tenantId: string, memoryIds: readonly MemoryId[]) => void
  > = [];

  /** `memories` の行が消えたとき（`dryRun` では呼ばない）に `listener` を呼ぶ。`InMemoryVectorStore` が埋め込みを一緒に消すために使う。 */
  onMemoriesDeleted(listener: (tenantId: string, memoryIds: readonly MemoryId[]) => void): void {
    this.memoriesDeletedListeners.push(listener);
  }

  /** 区切り文字で繋がず配列で表す: `tenantId` が `::` を含みうるので、繋ぐと別の組が同じキーに潰れる。 */
  private labelKey(tenantId: string, name: string): string {
    return JSON.stringify([tenantId, name]);
  }

  private memoryLabelKey(tenantId: string, memoryId: string): string {
    return JSON.stringify([tenantId, memoryId]);
  }

  private upsertProposedLabels(ctx: Ctx, memoryId: MemoryId, tags: readonly string[]): void {
    const uniqueNames = Array.from(new Set(tags));
    if (uniqueNames.length === 0) {
      return;
    }
    const linked = new Set<string>();
    for (const name of uniqueNames) {
      const key = this.labelKey(ctx.tenantId, name);
      const existing = this.labels.get(key);
      if (existing === undefined) {
        this.labels.set(key, { name, status: "proposed", proposedCount: 1, registeredAt: null });
        linked.add(name);
        continue;
      }
      if (existing.status === "proposed") {
        this.labels.set(key, { ...existing, proposedCount: existing.proposedCount + 1 });
      }
      linked.add(name);
    }
    this.memoryLabels.set(this.memoryLabelKey(ctx.tenantId, memoryId), linked);
  }

  /** `await` を挟まない: 挟むと判定と挿入の間に他の呼び出しが入る。 */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Observation> {
    input = replaceLoneSurrogatesInNewObservation(input);
    assertObservationHasNoNul("InMemoryMemoryStore", input);
    assertObservationDatesValid("InMemoryMemoryStore", input);
    const existing =
      input.externalId != null
        ? [...this.observations.values()].find(
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
        payload: toStorablePayload(input.payload),
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt ?? new Date(),
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        attributes: input.attributes ?? {},
      };
      const stored = snapshot(observation);
      this.observations.set(stored.id, stored);
      return stored;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    return snapshot(this.createObservationIdempotent(ctx, input).value);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    assertWellFormedCtx(ctx);
    const observation = this.observations.get(normId(id));
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return snapshot(observation);
  }

  private enqueueOutboxJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
    now: Date = new Date(),
    claimedBy?: string,
  ): OutboxJobRecord {
    kind = replaceLoneSurrogates(kind);
    claimedBy = replaceLoneSurrogates(claimedBy);
    const job: OutboxJobRecord = {
      id: nextId("job"),
      tenantId: ctx.tenantId,
      kind,
      payload,
      availableAt: now,
      claimedAt: claimedBy === undefined ? null : now,
      claimedBy: claimedBy ?? null,
      attempts: claimedBy === undefined ? 0 : 1,
      completedAt: null,
      failedAt: null,
      lastError: null,
      createdAt: now,
    };
    this.outboxJobs.push(job);
    return job;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date | undefined; claimedBy?: string | undefined },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    const outboxNow = opts?.now ?? new Date();
    const { value: observation, created } = this.createObservationIdempotent(ctx, input, () =>
      assertOutboxRowsWritable("createObservationWithOutbox", jobKinds, opts?.now, opts?.claimedBy),
    );
    if (!created) {
      return { observation: snapshot(observation), created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueOutboxJob(
        ctx,
        kind,
        { observationId: observation.id },
        outboxNow,
        opts?.claimedBy,
      ),
    );
    return snapshot({ observation, created: true, jobs });
  }

  private assertOwnMemoryRef(ctx: Ctx, id: MemoryId | null | undefined): void {
    if (id === null || id === undefined) return;
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${normId(id)}`);
    }
  }

  private assertEventTargetOwn(
    ctx: Ctx,
    memoryId: MemoryId | null | undefined,
    knownInTenant: readonly MemoryId[] = [],
  ): void {
    if (memoryId === null || memoryId === undefined) return;
    const id = memoryId.toLowerCase();
    if (knownInTenant.some((known) => known.toLowerCase() === id)) return;
    const memory = this.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${memoryId}`);
    }
  }

  private assertOwnObservationRef(ctx: Ctx, id: string | null | undefined): void {
    if (id === null || id === undefined) return;
    const observation = this.observations.get(normId(id));
    if (!observation || observation.tenantId !== ctx.tenantId) {
      throw new Error(`InMemoryMemoryStore: observation not found for tenant: ${id}`);
    }
  }

  private createMemoryIdempotent(
    ctx: Ctx,
    input: NewMemory,
    method:
      | "createMemory"
      | "createMemoryWithOutbox"
      | "createMemoriesWithOutboxAndEvents" = "createMemory",
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Memory> {
    input = replaceLoneSurrogatesInNewMemory(input);
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError(method, null);
    }
    assertStorableNewMemory(input);
    input = { ...input, sourceObservationId: normOptId(input.sourceObservationId) } as typeof input;
    this.assertOwnObservationRef(ctx, input.sourceObservationId);
    this.assertOwnMemoryRef(ctx, input.supersededById);
    this.assertOwnMemoryRef(ctx, input.contestedWithId);
    const idemKey = this.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    const existingId =
      input.sourceObservationId != null ? this.extractionIndex.get(idemKey) : undefined;
    const existing = existingId !== undefined ? this.memories.get(existingId) : undefined;

    return resolveIdempotentCreate(existing, () => {
      beforeInsert?.();

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
        // `?? null` で転記しないと `undefined` のまま消える。
        claimKey: input.claimKey ?? null,
        strength: toFloat4Readback(input.strength),
        halfLifeHours: toFloat4Readback(input.halfLifeHours),
        decayFloorAt: input.decayFloorAt,
        decayBaseSeq: input.decayBaseSeq ?? null,
        decayFloorSeq: input.decayFloorSeq ?? null,
        halfLifeRecalls:
          input.halfLifeRecalls == null ? null : toFloat4Readback(input.halfLifeRecalls),
        embeddingStatus: input.embeddingStatus,
        // `purgedAt` は保存しない: 書き手は `purgeMemory` だけで、渡された値は無視する。
        purgedAt: null,
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const stored = structuredClone(memory);
      this.memories.set(stored.id, stored);
      if (input.sourceObservationId != null) {
        this.extractionIndex.set(idemKey, stored.id);
      }
      this.upsertProposedLabels(ctx, stored.id, stored.tags);
      return stored;
    });
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    return snapshot(this.createMemoryIdempotent(ctx, input).value);
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date | undefined; abortIfSuperseded?: ReadonlyArray<MemoryId> | undefined },
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "createMemoryWithOutbox");
    const { value: memory, created } = this.createMemoryIdempotent(
      ctx,
      input,
      "createMemoryWithOutbox",
      () => assertOutboxRowsWritable("createMemoryWithOutbox", jobKinds, opts?.now),
    );
    if (!created) {
      return { memory: snapshot(memory), created: false, jobs: [] };
    }
    const outboxNow = opts?.now ?? new Date();
    const jobs = jobKinds.map((kind) =>
      this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }, outboxNow),
    );
    return { memory: snapshot(memory), created: true, jobs: snapshot(jobs) };
  }

  private assertNoneSuperseded(
    ctx: Ctx,
    ids: ReadonlyArray<MemoryId> | undefined,
    method:
      "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents" | "supersedeWithNewMemories",
  ): void {
    if (ids === undefined || ids.length === 0) {
      return;
    }
    const changed: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    const seen = new Set<MemoryId>();
    for (const raw of ids) {
      const id = normId(raw);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const memory = this.memories.get(id);
      if (
        memory !== undefined &&
        memory.tenantId === ctx.tenantId &&
        memory.status === "superseded"
      ) {
        changed.push({ id, observedStatus: memory.status });
      }
    }
    changed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (changed.length > 0) {
      throw new SourceMemoryStatusChangedError(method, changed);
    }
  }

  private captureWriteState(): () => void {
    const memoryIdsBefore = new Set(this.memories.keys());
    const outboxLengthBefore = this.outboxJobs.length;
    const labelsBefore = new Map(this.labels);
    // `memoryLabels` も巻き戻す: 写し忘れると、途中失敗した書き込みの label 紐付けだけが残る。
    const memoryLabelsBefore = new Map(
      [...this.memoryLabels].map(([key, names]) => [key, new Set(names)] as const),
    );
    const extractionIndexBefore = new Map(this.extractionIndex);
    return () => {
      for (const id of [...this.memories.keys()]) {
        if (!memoryIdsBefore.has(id)) {
          this.memories.delete(id);
        }
      }
      this.outboxJobs.splice(outboxLengthBefore);
      this.labels.clear();
      for (const [key, value] of labelsBefore) this.labels.set(key, value);
      this.memoryLabels.clear();
      for (const [key, value] of memoryLabelsBefore) this.memoryLabels.set(key, value);
      this.extractionIndex.clear();
      for (const [key, value] of extractionIndexBefore) this.extractionIndex.set(key, value);
    };
  }

  /**
   * 抽出の全候補を1つの同期区間で書く。保存できない候補は `dropped` に積み、全候補が落ちたら最初の例外を投げる。
   * ⚠ `opts.abortIfForgotten` は実装しない（無視する）。⚠ イベントは `events` に積まれるので、`InMemoryEventStore` から読むには同じ配列を共有する。
   */
  async createMemoriesWithOutboxAndEvents(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    buildCreatedEvent: (
      memory: Memory,
      dropped: ReadonlyArray<{ index: number; error: unknown }>,
    ) => NewMemoryEvent,
    opts?: {
      now?: Date | undefined;
      abortIfForgotten?: ReadonlyArray<MemoryId> | undefined;
      abortIfSuperseded?: ReadonlyArray<MemoryId> | undefined;
    },
  ): Promise<{
    written: Array<{ index: number; memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    dropped: Array<{ index: number; error: unknown }>;
  }> {
    assertWellFormedCtx(ctx);
    news.forEach((entry, i) =>
      assertWellFormedIdentifier(entry.input.subjectId, `news[${i}].input.subjectId`),
    );
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "createMemoriesWithOutboxAndEvents");
    const outboxNow = opts?.now ?? new Date();
    const restoreAll = this.captureWriteState();
    const eventsLengthBefore = this.events.length;
    const written: Array<{
      index: number;
      memory: Memory;
      created: boolean;
      jobs: OutboxJobRecord[];
    }> = [];
    const dropped: Array<{ index: number; error: unknown }> = [];
    try {
      for (const [index, { input, jobKinds }] of news.entries()) {
        const restoreOne = this.captureWriteState();
        try {
          const { value: memory, created } = this.createMemoryIdempotent(
            ctx,
            input,
            "createMemoriesWithOutboxAndEvents",
            () =>
              assertOutboxRowsWritable("createMemoriesWithOutboxAndEvents", jobKinds, opts?.now),
          );
          const jobs = created
            ? jobKinds.map((kind) =>
                this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }, outboxNow),
              )
            : [];
          written.push({ index, memory, created, jobs });
        } catch (error) {
          restoreOne();
          dropped.push({ index, error });
        }
      }
      if (written.length === 0 && dropped.length > 0) {
        throw dropped[0]!.error;
      }
      for (const { memory, created } of written) {
        if (!created) {
          continue;
        }
        const createdEvent = buildCreatedEvent(snapshot(memory), dropped);
        this.assertEventTargetOwn(ctx, createdEvent.memoryId, [memory.id]);
        this.events.push(buildStoredMemoryEvent(ctx, createdEvent));
      }
    } catch (error) {
      restoreAll();
      this.events.splice(eventsLengthBefore);
      throw error;
    }
    return {
      written: written.map((entry) => snapshot(entry)),
      dropped,
    };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    assertWellFormedCtx(ctx);
    const memory = this.rawGet(ctx, id);
    return memory === null ? null : snapshot(memory);
  }

  private rawGet(ctx: Ctx, id: MemoryId): Memory | null {
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // 同じ id の重複は1件に畳む: Postgres は `= ANY(...)` の集合演算で引く。
    const seen = new Set<MemoryId>();
    const results: Memory[] = [];
    for (const rawId of ids) {
      const id = normId(rawId);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const memory = this.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(snapshot(memory));
      }
    }
    return results;
  }

  /** `InMemoryLexicalStore` 用の反復子。複製せず内部の行を返すので、読むだけにすること。 */
  listByTenant(ctx: Ctx): Memory[] {
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    extractorVersion = replaceLoneSurrogates(extractorVersion);
    assertQueryTextWithoutNul(
      "listBySourceObservation",
      "extractorVersion",
      extractorVersion ?? "",
    );
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== normId(observationId)) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(snapshot(memory));
    }
    return results;
  }

  async listBySourceObservationAllVersions(
    ctx: Ctx,
    observationId: ObservationId,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== normId(observationId)) continue;
      results.push(snapshot(memory));
    }
    return results;
  }

  /** `expectedStatus` があるときだけ CAS。`"contested"` への遷移は {@link ContestedWithoutCompanionError}、食い違えば {@link MemoryStatusConflictError}（どちらも何も書かない）。 */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
  ): Promise<Memory> {
    assertWellFormedCtx(ctx);
    const requestedId = id;
    id = normId(id);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    assertSupersededByShape("updateStatus", "opts", id, status, opts?.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    this.assertOwnMemoryRef(ctx, opts?.supersededById);
    if (opts?.expectedStatus !== undefined && casMismatch(memory, opts.expectedStatus)) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    assertStorableMemoryColumn("status", status);
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = normId(opts.supersededById);
    }
    memory.updatedAt = new Date();
    return snapshot(memory);
  }

  /** `updateStatus` と同じ CAS のあと、通ったときだけイベントも積む。投げる例外も同じ。 */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    const requestedId = id;
    id = normId(id);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    assertSupersededByShape("updateStatusWithEvent", "opts", id, status, opts.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    this.assertOwnMemoryRef(ctx, opts.supersededById);
    if (opts.expectedStatus !== undefined && casMismatch(memory, opts.expectedStatus)) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    assertStorableMemoryColumn("status", status);
    assertStorableMemoryEvent(event);
    assertCloneableMemoryEvent(event);
    this.assertEventTargetOwn(ctx, event.memoryId, [id]);
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = normId(opts.supersededById);
    }
    memory.updatedAt = new Date();
    const storedEvent = buildStoredMemoryEvent(ctx, event);
    this.events.push(storedEvent);
    return snapshot({ memory, event: storedEvent });
  }

  /**
   * CAS に弾かれた `supersede` 対象は例外にせず `conflicted` に積んで続行する（対象が無い場合を除く）。
   * ⚠ in-memory にトランザクションは無いので、書く前に検査を済ませて投げることでロールバックを模す。
   * ⚠ `supersededById` が同じ呼び出しの `news` で作る Memory を指す形はサポートしない。
   * `contestedWithId` の無い `status: "contested"` の新規行は {@link ContestedWithoutCompanionError}。`opts.abortIfForgotten` は実装しない（無視する）。
   */
  async supersedeWithNewMemories(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus | undefined;
      event: NewMemoryEvent;
    }>,
    opts?: {
      now?: Date | undefined;
      abortIfForgotten?: ReadonlyArray<MemoryId> | undefined;
      abortIfSuperseded?: ReadonlyArray<MemoryId> | undefined;
      abortIfAllConflicted?: boolean | undefined;
      buildCreatedEvent?: ((memory: Memory, index: number) => NewMemoryEvent) | undefined;
    },
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
    createdEventsWritten?: true;
  }> {
    assertWellFormedCtx(ctx);
    const requestedTargetIds = supersede.map((t) => t.id);
    supersede = supersede.map((t) => ({ ...t, id: normId(t.id) }));
    news.forEach((entry, i) =>
      assertWellFormedIdentifier(entry.input.subjectId, `news[${i}].input.subjectId`),
    );
    const outboxNow = opts?.now ?? new Date();
    const buildCreatedEvent = opts?.buildCreatedEvent;
    for (const target of supersede) {
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `InMemoryMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
    }
    // `assertWellFormedNewMemory` だけを先に呼ばない: `digest: null` などで、ほかの口と例外の種類が割れる。
    for (const { input } of news) {
      const replaced = replaceLoneSurrogatesInNewMemory(input);
      if (isContestedWithoutCompanion(replaced.status, replaced.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
      assertStorableNewMemory(replaced);
    }
    for (const [i, target] of supersede.entries()) {
      assertStorableMemoryEvent(target.event, { skipAtFloor: true });
      const memory = this.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(
          `InMemoryMemoryStore: memory not found for tenant: ${requestedTargetIds[i]}`,
        );
      }
    }
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
    }
    const wouldConflict: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    const willSupersede = new Set<MemoryId>();
    for (const target of supersede) {
      const row = this.memories.get(target.id)!;
      const status = willSupersede.has(target.id) ? "superseded" : row.status;
      if (
        target.expectedStatus !== undefined &&
        (status !== target.expectedStatus || (row.purgedAt ?? null) !== null)
      ) {
        wouldConflict.push({ id: target.id, observedStatus: status });
        continue;
      }
      assertCloneableMemoryEvent(target.event);
      assertWrittenTimestamptzFloor("memory_events", "at", target.event.at);
      this.assertEventTargetOwn(ctx, target.event.memoryId, [target.id]);
      willSupersede.add(target.id);
    }
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "supersedeWithNewMemories");
    if (
      opts?.abortIfAllConflicted === true &&
      supersede.length > 0 &&
      wouldConflict.length === supersede.length
    ) {
      throw new SourceMemoryStatusChangedError("supersedeWithNewMemories", wouldConflict);
    }

    const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];
    const restoreWriteState = this.captureWriteState();
    const eventsLengthBefore = this.events.length;
    try {
      for (const { input, jobKinds } of news) {
        const { value: memory, created: wasCreated } = this.createMemoryIdempotent(
          ctx,
          input,
          "createMemory",
          () => assertOutboxRowsWritable("supersedeWithNewMemories", jobKinds, opts?.now),
        );
        if (!wasCreated) {
          created.push({ memory, created: false, jobs: [] });
          continue;
        }
        const jobs = jobKinds.map((kind) =>
          this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }, outboxNow),
        );
        created.push({ memory, created: true, jobs });
      }
      if (buildCreatedEvent !== undefined) {
        for (const [index, entry] of created.entries()) {
          if (entry.created) {
            const createdEvent = buildCreatedEvent(snapshot(entry.memory), index);
            this.assertEventTargetOwn(ctx, createdEvent.memoryId, [entry.memory.id]);
            this.events.push(buildStoredMemoryEvent(ctx, createdEvent));
          }
        }
      }
    } catch (err) {
      restoreWriteState();
      this.events.splice(eventsLengthBefore);
      throw err;
    }

    const superseded: MemoryEvent[] = [];
    const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    for (const target of supersede) {
      const memory = this.memories.get(target.id)!;
      if (target.expectedStatus !== undefined && casMismatch(memory, target.expectedStatus)) {
        conflicted.push({ id: target.id, observedStatus: memory.status });
        continue;
      }
      memory.status = "superseded";
      const anchorId = created[target.supersededByIndex]!.memory.id;
      memory.supersededById = anchorId;
      memory.updatedAt = new Date();
      const storedEvent = buildStoredMemoryEvent(ctx, {
        ...target.event,
        meta: { ...target.event.meta, supersededById: anchorId },
      });
      this.events.push(storedEvent);
      superseded.push(storedEvent);
    }

    const result = snapshot({ created, superseded, conflicted });
    return buildCreatedEvent === undefined ? result : { ...result, createdEventsWritten: true };
  }

  /** 同期関数: `await` を挟まない（`purgeExpiredEventsByRetention` が読みから削除までを同じ同期区間に閉じる前提）。 */
  private purgeExpiredEventsSync(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): PurgeExpiredEventsResult {
    assertQueryDate("purgeExpiredEvents", "olderThan", opts.olderThan);
    // 負数は拒む: `slice` の負数は末尾から数える除外になり、期限切れイベントのほぼ全件を静かに消す。
    const dryRun = opts.dryRun ?? false;
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeExpiredEvents: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeExpiredEvents: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(
        `purgeExpiredEvents: limit must fit in a Postgres bigint (got ${opts.limit})`,
      );
    }
    const candidates = this.events
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
      return snapshot({ purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun });
    }

    const victimIds = new Set(victims.map((event) => event.id));
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (victimIds.has(this.events[i]!.id)) {
        this.events.splice(i, 1);
      }
    }

    const storedEvent = buildStoredMemoryEvent(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      meta: {
        purgedCount: purged,
        oldestPurgedAt: oldestPurgedAt?.toISOString() ?? null,
        newestPurgedAt: newestPurgedAt?.toISOString() ?? null,
        olderThan: opts.olderThan.toISOString(),
      },
    });
    this.events.push(storedEvent);

    return snapshot({ purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun });
  }

  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    assertWellFormedCtx(ctx);
    return this.purgeExpiredEventsSync(ctx, opts);
  }

  async purgeExpiredRecalls(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult> {
    assertWellFormedCtx(ctx);
    assertQueryDate("purgeExpiredRecalls", "olderThan", opts.olderThan);
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
    const candidates = [...this.recalls.entries()]
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
      for (const key of this.usages) {
        if (key.startsWith(prefix)) usageKeys.push(key);
      }
    }
    if (!dryRun) {
      for (const key of usageKeys) this.usages.delete(key);
      for (const [id] of victims) this.recalls.delete(id);
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

  async purgeExpiredEventsByRetention(
    ctx: Ctx,
    opts: PurgeExpiredEventsByRetentionOptions,
  ): Promise<PurgeExpiredEventsByRetentionOutcome> {
    assertWellFormedCtx(ctx);
    if (!this.eventRetentionDays.has(ctx.tenantId)) {
      return { kind: "unset" };
    }
    const days = this.eventRetentionDays.get(ctx.tenantId)!;
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
   * `ready` を `failed` へ巻き戻さず、例外にもしない（no-op で現在の行を返す）。`runtime.tick` の `catch` の中で投げると元の埋め込みエラーが握り潰される。
   * 判定は共有の {@link isEmbeddingStatusRollback} に固定する。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    assertWellFormedCtx(ctx);
    const requestedId = id;
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    assertStorableMemoryColumn("embedding_status", status);
    if (isEmbeddingStatusRollback(memory.embeddingStatus, status)) {
      return snapshot(memory);
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return snapshot(memory);
  }

  /** 起点 `lastReinforcedAt ?? recordedAt` より新しい `at` だけを書き、古い・同じ `at` は例外にせず no-op で現在の行を返す。`opts.nowSeq` は `halfLifeRecalls` を持つ Memory に限り活動時計側も進める。 */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    const requestedId = id;
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    if (Number.isNaN(at.getTime())) {
      throw new Error(`reinforce: at must be a valid Date (got Invalid Date)`);
    }
    assertWrittenTimestamptzFloor("reinforce", "at", at);
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      assertQueryBigint("reinforce", "nowSeq", opts.nowSeq);
    }
    if ((memory.lastReinforcedAt ?? memory.recordedAt).getTime() >= at.getTime()) {
      return snapshot(memory);
    }
    let activityBaseSeq: number | undefined;
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      activityBaseSeq =
        opts.addOwnSubjectSeq === true && memory.subjectId != null
          ? opts.nowSeq + (this.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
          : opts.nowSeq;
      if (activityBaseSeq < 0) {
        throw new Error(`reinforce: decayBaseSeq must not be negative (got ${activityBaseSeq})`);
      }
      if (opts.addOwnSubjectSeq === true && memory.subjectId != null) {
        const ownSeq = this.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0;
        const baseSeq = BigInt(String(opts.nowSeq)) + BigInt(ownSeq);
        const offset = defaultActivityDecayStrategy.floorAt({
          baseSeq: 0,
          strength: memory.strength,
          halfLifeRecalls: memory.halfLifeRecalls,
        });
        if (baseSeq + BigInt(offset) >= 2n ** 63n) {
          throw new Error(
            `reinforce: decayBaseSeq + own subject seq must fit in a Postgres bigint (got nowSeq ${opts.nowSeq} + ${ownSeq})`,
          );
        }
      }
    }
    memory.lastReinforcedAt = new Date(at);
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    if (activityBaseSeq !== undefined && memory.halfLifeRecalls != null) {
      memory.decayBaseSeq = activityBaseSeq;
      memory.decayFloorSeq = defaultActivityDecayStrategy.floorAt({
        baseSeq: activityBaseSeq,
        strength: memory.strength,
        halfLifeRecalls: memory.halfLifeRecalls,
      });
    }
    memory.updatedAt = new Date();
    return snapshot(memory);
  }

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

  /** 強化が投げたら、この呼び出しで挿入した使用の行を取り消す。 */
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
        this.usages.delete(`${ctx.tenantId}:${recallId}:${memoryId}`);
      }
      throw err;
    }
    return result;
  }

  async recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    assertWellFormedCtx(ctx);
    // ⚠ `memoryIds` が空なら Postgres は recall の実在を問わないので、この早期リターンより後ろで検査する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    recallId = normId(recallId);
    const recall = this.recalls.get(recallId);
    if (!recall || recall.tenantId !== ctx.tenantId) {
      throw new Error(`InMemoryMemoryStore: recall not found for tenant: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      this.assertOwnMemoryRef(ctx, memoryId);
    }

    const insertedMemoryIds: MemoryId[] = [];
    for (const rawMemoryId of memoryIds) {
      const memoryId = normId(rawMemoryId);
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.usages.has(key)) {
        this.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  /** 契約は「groups の総和が totalInScope と一致すること」。`opts.digestBand` は `FakeMemoryStore.aggregateScope` と同じ意味論。 */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    assertQueryDate("aggregateScope", "occurredAfter", scope.occurredAfter);
    assertQueryDate("aggregateScope", "occurredBefore", scope.occurredBefore);
    assertQueryDate("aggregateScope", "validAt", scope.validAt);
    assertQueryDate("aggregateScope", "decayFloorAtAfter", scope.decayFloorAtAfter);
    assertQueryBigint("aggregateScope", "decayFloorSeqAfter", scope.decayFloorSeqAfter);
    scope = {
      ...scope,
      ...(scope.labels === undefined
        ? {}
        : { labels: scope.labels.map((label) => replaceLoneSurrogates(label)) }),
      ...(scope.taxonomyGroupCandidates === undefined
        ? {}
        : {
            taxonomyGroupCandidates: scope.taxonomyGroupCandidates.map((label) =>
              replaceLoneSurrogates(label),
            ),
          }),
    };
    if (!(opts?.scopeAggregate === "skip" && opts.digestBand === undefined)) {
      assertQueryJsonWithoutNul("aggregateScope", "attributes", scope.attributes);
      for (const label of scope.labels ?? []) {
        assertQueryTextWithoutNul("aggregateScope", "labels", label);
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
    const inScopeMemories: Memory[] = [];
    // `"skip"` では、値だけ受け取って計算する実装は禁止（`AggregateScopeOptions.scopeAggregate`）。
    const skipCounting = opts?.scopeAggregate === "skip";

    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) {
        continue;
      }
      const subjectMatches =
        scope.subjectId === undefined ||
        memory.subjectId === scope.subjectId ||
        (scope.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      if (scope.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const attributesMatch = Object.entries(scope.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!attributesMatch) {
          continue;
        }
      }

      if (memory.status === "archived") {
        if (!skipCounting) filteredArchived += 1;
        continue;
      }
      if (memory.status === "superseded") {
        if (!skipCounting) filteredSuperseded += 1;
        continue;
      }
      if (memory.status === "forgotten") {
        if (!skipCounting) filteredForgotten += 1;
        continue;
      }

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        if (!skipCounting) filteredPeriod += 1;
        continue;
      }
      // `continue` で打ち切らない: Postgres の独立集計と食い違う。
      if (scope.validAt !== undefined) {
        const isNotYetValid = memory.validFrom != null && memory.validFrom > scope.validAt;
        const isExpired = memory.validUntil != null && memory.validUntil <= scope.validAt;
        if (isNotYetValid && !skipCounting) {
          filteredNotYetValid += 1;
        }
        if (isExpired && !skipCounting) {
          filteredExpired += 1;
        }
        if (isNotYetValid || isExpired) {
          continue;
        }
      }
      if (scope.labels !== undefined) {
        const labels = scope.labels;
        const hasQualifyingLabel = memory.tags.some((tag) => labels.includes(tag));
        if (!hasQualifyingLabel) {
          if (!skipCounting) filteredTaxonomy += 1;
          continue;
        }
      }

      if (!skipCounting) {
        totalInScope += 1;
      }
      // `continue` しない: 減衰しきった Memory も `totalInScope`・群カウント・目次帯から除かない。
      if (
        !skipCounting &&
        isDecayedForScope(memory, scope, this.subjectActivitySeq.get(ctx.tenantId))
      ) {
        filteredDecayed += 1;
      }
      if (!skipCounting) {
        const key = memory.subjectId ?? null;
        inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
        if (memory.embeddingStatus !== "ready") {
          notIndexed[memory.embeddingStatus] += 1;
        } else if (excludedKinds?.has(memory.provenance.kind) === true) {
          excludedProvenanceIndexed += 1;
        }
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

    if (scope.taxonomyGroupCandidates !== undefined && !skipCounting) {
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
      // 負・非整数の `limit` は先に断る: `slice` の負数はほぼ全件を返し、`NaN`/`Infinity` は黙って丸まる。
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
      if (opts.digestBand.limit >= 2 ** 63) {
        throw new Error(
          `aggregateScope: digestBand.limit must fit in a Postgres bigint (got ${opts.digestBand.limit})`,
        );
      }
      const exclude = new Set(opts.digestBand.excludeMemoryIds.map(normId));
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      digestEligible = skipCounting
        ? { count: 0, countKind: "unknown" }
        : { count: eligibleMemories.length, countKind: "exact" };
      digests = eligibleMemories.slice(0, opts.digestBand.limit).map((m) => ({
        memoryId: m.id,
        digest: m.digest,
      }));
    }

    const countKind = skipCounting ? ("unknown" as const) : ("exact" as const);
    const zeroCount = { count: 0, countKind } as const;
    return {
      groups,
      totalInScope,
      countKind,
      ...(!skipCounting && excludedKinds !== undefined
        ? { excludedProvenanceIndexedCount: excludedProvenanceIndexed }
        : {}),
      notIndexed: skipCounting
        ? { pending: zeroCount, failed: zeroCount, skipped: zeroCount }
        : {
            pending: { count: notIndexed.pending, countKind: "exact" },
            failed: { count: notIndexed.failed, countKind: "exact" },
            skipped: { count: notIndexed.skipped, countKind: "exact" },
          },
      filteredArchived: skipCounting ? zeroCount : { count: filteredArchived, countKind: "exact" },
      filteredSuperseded: skipCounting
        ? zeroCount
        : { count: filteredSuperseded, countKind: "exact" },
      filteredForgotten: skipCounting
        ? zeroCount
        : { count: filteredForgotten, countKind: "exact" },
      filteredPeriod: skipCounting ? zeroCount : { count: filteredPeriod, countKind: "exact" },
      filteredExpired: skipCounting ? zeroCount : { count: filteredExpired, countKind: "exact" },
      filteredNotYetValid: skipCounting
        ? zeroCount
        : { count: filteredNotYetValid, countKind: "exact" },
      filteredTaxonomy: skipCounting ? zeroCount : { count: filteredTaxonomy, countKind: "exact" },
      filteredDecayed: skipCounting ? zeroCount : { count: filteredDecayed, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  /** `advanceActivityClock === true` のときだけ、行を書くのと同じ同期区間で `activitySeq` を進める。 */
  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(record.subjectId, "record.subjectId");
    if (typeof record.advanceActivityClock === "object" && record.advanceActivityClock !== null) {
      assertWellFormedIdentifier(
        record.advanceActivityClock.subjectId,
        "record.advanceActivityClock.subjectId",
      );
    }
    assertRecallRecordStorable(record);
    const id = nextId("rcl");
    this.recalls.set(id, {
      ...snapshot(record),
      tenantId: ctx.tenantId,
      createdAt: record.createdAt === undefined ? new Date() : snapshot(record.createdAt),
    });
    if (record.advanceActivityClock === true) {
      const current = this.activitySeq.get(ctx.tenantId) ?? 0;
      this.activitySeq.set(ctx.tenantId, current + 1);
    } else if (
      typeof record.advanceActivityClock === "object" &&
      record.advanceActivityClock !== null &&
      record.advanceActivityClock.scope === "subject"
    ) {
      const subjectId = record.advanceActivityClock.subjectId;
      let bySubject = this.subjectActivitySeq.get(ctx.tenantId);
      if (bySubject === undefined) {
        bySubject = new Map<string, number>();
        this.subjectActivitySeq.set(ctx.tenantId, bySubject);
      }
      const current = bySubject.get(subjectId) ?? 0;
      bySubject.set(subjectId, current + 1);
    }
    return id;
  }

  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    assertWellFormedCtx(ctx);
    id = normId(id);
    const row = this.recalls.get(id);
    if (!row || row.tenantId !== ctx.tenantId) {
      return null;
    }
    return snapshot({
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

  /** ⚠ `for` の中に `await` を入れない（更新だけ起きて INSERT が起きない中間状態が観測される）。 */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    // 負・非整数の `limit` は先に断る: 通すと `Infinity` が全件、`1.5` が1件の積み直しを書く。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`requeueEmbedJobs: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`requeueEmbedJobs: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(`requeueEmbedJobs: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    if (opts.memoryIds === undefined || opts.memoryIds.length > 0) {
      assertQueryTimestamptz("requeueEmbedJobs", "writeOpts.now", writeOpts?.now);
    }
    const targetStatuses: readonly EmbeddingStatus[] = opts.statuses;
    const idFilter =
      opts.memoryIds === undefined ? null : new Set<string>(opts.memoryIds.map(normId));
    const targets = [...this.memories.values()]
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

    const outboxNow = writeOpts?.now ?? new Date();
    const memoryIds: MemoryId[] = [];
    for (const memory of targets) {
      memory.embeddingStatus = "pending";
      memory.updatedAt = new Date();
      this.enqueueOutboxJob(ctx, "embed", { memoryId: memory.id }, outboxNow);
      memoryIds.push(memory.id);
    }
    return { requeued: memoryIds.length, memoryIds };
  }

  /** `status = 'active'` の Memory を `decayFloorAt` 昇順で `limit` 件まで `archived` にする。境界の非対称（ゲートは狭義 `>`、掃引は `<=`）と、`'either'` が AND（ゲートの OR と逆）である点は Postgres と同じ。 */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    assertWellFormedCtx(ctx);
    assertQueryTimestamptz("archiveDecayed", "now", opts.now);
    if ((opts.clock ?? "wall") !== "wall") {
      assertQueryBigint("archiveDecayed", "nowSeq", opts.nowSeq);
    }
    // 負・非整数の `limit` は先に断る: 通すと `NaN` が0件、`Infinity` が全件になり、書き込みを伴うので実害が大きい。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`archiveDecayed: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`archiveDecayed: limit must not be negative (got ${opts.limit})`);
    }
    if (opts.limit >= 2 ** 63) {
      throw new Error(`archiveDecayed: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    const nowMs = opts.now.getTime();
    const clock = opts.clock ?? "wall";
    const passesWall = (m: Memory): boolean => m.decayFloorAt.getTime() <= nowMs;
    const subjectActivitySeqByTenant = this.subjectActivitySeq.get(ctx.tenantId);
    const passesActivity = (m: Memory): boolean => {
      if (opts.nowSeq === undefined) {
        throw new Error(
          `InMemoryMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
        );
      }
      const decayFloorSeq = m.decayFloorSeq ?? null;
      if (decayFloorSeq === null) return false;
      const effectiveNowSeq =
        opts.usesSubjectActivityCounters === true && m.subjectId != null
          ? opts.nowSeq + (subjectActivitySeqByTenant?.get(m.subjectId) ?? 0)
          : opts.nowSeq;
      if (
        opts.usesSubjectActivityCounters === true &&
        m.subjectId != null &&
        seqSumOverflowsBigint(opts.nowSeq, subjectActivitySeqByTenant?.get(m.subjectId) ?? 0)
      ) {
        throw new Error(
          `archiveDecayed: nowSeq + own subject seq must fit in a Postgres bigint (got ${opts.nowSeq} + ${subjectActivitySeqByTenant?.get(m.subjectId) ?? 0})`,
        );
      }
      return decayFloorSeq <= effectiveNowSeq;
    };
    const passesClock = (m: Memory): boolean => {
      if (clock === "wall") return passesWall(m);
      if (clock === "activity") return passesActivity(m);
      return passesWall(m) && passesActivity(m);
    };

    const byId = (a: Memory, b: Memory): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const selectionOrder = (a: Memory, b: Memory): number =>
      clock === "activity"
        ? (a.decayFloorSeq ?? 0) - (b.decayFloorSeq ?? 0) || byId(a, b)
        : a.decayFloorAt.getTime() - b.decayFloorAt.getTime() || byId(a, b);

    const targets = [...this.memories.values()]
      .filter((m) => m.tenantId === ctx.tenantId && m.status === "active" && passesClock(m))
      .sort(selectionOrder)
      .slice(0, Math.max(0, opts.limit));

    const archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }> = [];
    for (const memory of targets) {
      const digestSnapshot = memory.digest;
      memory.status = "archived";
      memory.updatedAt = new Date();
      const storedEvent = buildStoredMemoryEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "archived",
        at: opts.now,
        actor: { type: "system" },
        digestSnapshot,
        sizeBeforeBytes: null,
        meta: {},
      });
      this.events.push(storedEvent);
      archived.push({ memoryId: memory.id, decayFloorAt: new Date(memory.decayFloorAt) });
    }
    archived.sort(
      (a, b) =>
        a.decayFloorAt.getTime() - b.decayFloorAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return { archived, reachedLimit: opts.limit > 0 && archived.length === opts.limit };
  }

  /** `forgotten` かつ未 purge の Memory だけを対象にした CAS。条件を満たさなければ {@link MemoryPurgeConflictError}（何も書かない）。`status` は動かさない。 */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    if (stringHasNul(tombstone.content)) {
      throw new Error(
        `InMemoryMemoryStore: tombstone.content must not contain NUL characters (U+0000)`,
      );
    }
    if (stringHasNul(tombstone.digest)) {
      throw new Error(
        `InMemoryMemoryStore: tombstone.digest must not contain NUL characters (U+0000)`,
      );
    }
    assertWrittenTimestamptzFloor("memory_events", "at", event.at);
    tombstone = {
      content: replaceLoneSurrogates(tombstone.content),
      digest: replaceLoneSurrogates(tombstone.digest),
    };
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (memory.status !== "forgotten" || (memory.purgedAt ?? null) !== null) {
      throw new MemoryPurgeConflictError(id, memory.status, memory.purgedAt ?? null);
    }
    assertStorableMemoryEvent(event);
    assertCloneableMemoryEvent(event);
    this.assertEventTargetOwn(ctx, event.memoryId, [id]);
    const at = event.at === undefined ? new Date() : snapshot(event.at);
    memory.content = tombstone.content;
    memory.digest = tombstone.digest;
    memory.tags = [];
    memory.attributes = {};
    memory.claimKey = null;
    memory.purgedAt = at;
    memory.updatedAt = new Date();

    const linkKey = this.memoryLabelKey(ctx.tenantId, id);
    const linkedLabelNames = this.memoryLabels.get(linkKey);
    if (linkedLabelNames !== undefined) {
      for (const name of linkedLabelNames) {
        const key = this.labelKey(ctx.tenantId, name);
        const existing = this.labels.get(key);
        if (existing !== undefined && existing.status === "proposed") {
          this.labels.set(key, {
            ...existing,
            proposedCount: Math.max(existing.proposedCount - 1, 0),
          });
        }
      }
      this.memoryLabels.delete(linkKey);
    }

    for (const row of this.recalls.values()) {
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

    const storedEvent = buildStoredMemoryEvent(ctx, { ...event, at });
    this.events.push(storedEvent);
    return snapshot({ memory, event: storedEvent });
  }

  /** `forgotten` かつ purge 済みの行だけを対象に残骸を伏せる。残骸の無い行は書き換えない（`updatedAt` も動かさない）。 */
  async scrubPurged(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    for (const rawId of memoryIds) {
      const id = normId(rawId);
      const memory = this.rawGet(ctx, id);
      if (!memory || memory.status !== "forgotten" || (memory.purgedAt ?? null) === null) {
        continue;
      }
      if (
        memory.tags.length > 0 ||
        Object.keys(memory.attributes ?? {}).length > 0 ||
        (memory.claimKey ?? null) !== null
      ) {
        memory.tags = [];
        memory.attributes = {};
        memory.claimKey = null;
        memory.updatedAt = new Date();
      }
      const linkKey = this.memoryLabelKey(ctx.tenantId, id);
      const linkedLabelNames = this.memoryLabels.get(linkKey);
      if (linkedLabelNames !== undefined) {
        for (const name of linkedLabelNames) {
          const key = this.labelKey(ctx.tenantId, name);
          const existing = this.labels.get(key);
          if (existing !== undefined && existing.status === "proposed") {
            this.labels.set(key, {
              ...existing,
              proposedCount: Math.max(existing.proposedCount - 1, 0),
            });
          }
        }
        this.memoryLabels.delete(linkKey);
      }
      for (const row of this.recalls.values()) {
        if (row.tenantId !== ctx.tenantId) continue;
        const digestBand = row.indexBand?.digestBand;
        if (!digestBand) continue;
        let changed = false;
        const nextDigestBand = digestBand.map((entry) => {
          if (entry.memoryId !== id) return entry;
          if (entry.digest === memory.digest && !("truncated" in entry)) return entry;
          changed = true;
          return { memoryId: entry.memoryId, digest: memory.digest };
        });
        if (changed) {
          row.indexBand = { ...row.indexBand, digestBand: nextDigestBand };
        }
      }
    }
  }

  /** 両側が `active` であることを CAS で課し、片方でも失敗したら何も書かず {@link MemoryStatusConflictError}。 */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    first = { ...first, id: normId(first.id) };
    second = { ...second, id: normId(second.id) };
    if (first.id === second.id) {
      throw new RangeError("InMemoryMemoryStore: first.id and second.id must differ");
    }

    const firstMemory = this.rawGet(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = this.rawGet(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${second.id}`);
    }
    if (firstMemory.status !== "active") {
      throw new MemoryStatusConflictError(first.id, "active", firstMemory.status);
    }
    if (secondMemory.status !== "active") {
      throw new MemoryStatusConflictError(second.id, "active", secondMemory.status);
    }

    assertStorableMemoryEvent(first.event);
    assertStorableMemoryEvent(second.event);
    assertCloneableMemoryEvent(first.event);
    assertCloneableMemoryEvent(second.event);
    this.assertEventTargetOwn(ctx, first.event.memoryId, [first.id, second.id]);
    this.assertEventTargetOwn(ctx, second.event.memoryId, [first.id, second.id]);
    firstMemory.status = "contested";
    firstMemory.contestedWithId = second.id;
    firstMemory.updatedAt = new Date();
    secondMemory.status = "contested";
    secondMemory.contestedWithId = first.id;
    secondMemory.updatedAt = new Date();

    const firstEvent = buildStoredMemoryEvent(ctx, first.event);
    const secondEvent = buildStoredMemoryEvent(ctx, second.event);
    this.events.push(firstEvent, secondEvent);

    return snapshot({
      first: firstMemory,
      second: secondMemory,
      events: [firstEvent, secondEvent],
    });
  }

  /** 両側が `contested` で相互参照が成立していることを CAS で課す。失敗は {@link MemoryStatusConflictError}（何も書かない）。 */
  async resolveContestedPair(
    ctx: Ctx,
    first: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId | undefined;
      event: NewMemoryEvent;
    },
    second: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId | undefined;
      event: NewMemoryEvent;
    },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    first = normPairSide(first);
    second = normPairSide(second);
    if (first.id === second.id) {
      throw new RangeError("InMemoryMemoryStore: first.id and second.id must differ");
    }
    assertResolvedStatus("resolveContestedPair", "first", first.status);
    assertResolvedStatus("resolveContestedPair", "second", second.status);
    assertSupersededByShape(
      "resolveContestedPair",
      "first",
      first.id,
      first.status,
      first.supersededById,
      {
        forbidWhenNotSuperseded: true,
      },
    );
    assertSupersededByShape(
      "resolveContestedPair",
      "second",
      second.id,
      second.status,
      second.supersededById,
      {
        forbidWhenNotSuperseded: true,
      },
    );
    assertNoSupersededCycle("resolveContestedPair", [first, second]);

    const firstMemory = this.rawGet(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = this.rawGet(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${second.id}`);
    }
    if (firstMemory.status !== "contested" || firstMemory.contestedWithId !== second.id) {
      throw new MemoryStatusConflictError(first.id, "contested", firstMemory.status);
    }
    if (secondMemory.status !== "contested" || secondMemory.contestedWithId !== first.id) {
      throw new MemoryStatusConflictError(second.id, "contested", secondMemory.status);
    }
    this.assertOwnMemoryRef(ctx, first.supersededById);
    this.assertOwnMemoryRef(ctx, second.supersededById);
    for (const [field, side] of [
      ["first", first],
      ["second", second],
    ] as const) {
      const ref = side.supersededById;
      if (ref === undefined || ref === first.id || ref === second.id) continue;
      if (this.rawGet(ctx, ref)?.status === "forgotten") {
        throw new RangeError(
          `resolveContestedPair: ${field}.supersededById must not be a forgotten memory outside the pair`,
        );
      }
    }

    assertStorableMemoryColumn("status", first.status);
    assertStorableMemoryColumn("status", second.status);
    assertStorableMemoryEvent(first.event);
    assertStorableMemoryEvent(second.event);
    assertCloneableMemoryEvent(first.event);
    assertCloneableMemoryEvent(second.event);
    this.assertEventTargetOwn(ctx, first.event.memoryId, [first.id, second.id]);
    this.assertEventTargetOwn(ctx, second.event.memoryId, [first.id, second.id]);
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

    const firstEvent = buildStoredMemoryEvent(ctx, first.event);
    const secondEvent = buildStoredMemoryEvent(ctx, second.event);
    this.events.push(firstEvent, secondEvent);

    return snapshot({
      first: firstMemory,
      second: secondMemory,
      events: [firstEvent, secondEvent],
    });
  }

  /** `markContestedPair` と同じく、1件でも失敗したら何も書かずに throw する。 */
  async markContestedGroup(
    ctx: Ctx,
    members: ReadonlyArray<{ id: MemoryId; event: NewMemoryEvent }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }> {
    assertWellFormedCtx(ctx);
    members = members.map((m) => ({ ...m, id: normId(m.id) }));
    if (members.length < 3) {
      throw new RangeError("markContestedGroup: members must have at least 3 entries");
    }
    const ids = members.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("markContestedGroup: member ids must be unique");
    }

    const memories = members.map((m) => {
      const memory = this.rawGet(ctx, m.id);
      if (!memory) {
        throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${m.id}`);
      }
      return memory;
    });
    for (const memory of memories) {
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
    for (const m of members) {
      assertStorableMemoryEvent(asJsonSerializedSizeBeforeBytes(m.event));
      assertCloneableMemoryEvent(m.event);
    }

    const unchanged = memories.map(
      (memory) => memory.status === "contested" && (memory.contestedWithId ?? null) === null,
    );
    members.forEach((m, i) => {
      if (!unchanged[i]) this.assertEventTargetOwn(ctx, m.event.memoryId, ids);
    });
    for (const memory of memories) {
      memory.status = "contested";
      memory.contestedWithId = null;
      memory.updatedAt = new Date();
    }

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
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i]!;
        const b = memories[j]!;
        if (!overlaps(a, b)) continue;
        this.linkRelationPair(ctx.tenantId, a.id, b.id, "contradicts");
      }
    }

    const events = members
      .filter((_, i) => !unchanged[i])
      .map((m) => {
        const event = buildStoredMemoryEvent(ctx, asJsonSerializedSizeBeforeBytes(m.event));
        this.events.push(event);
        return event;
      });

    return snapshot({ members: memories, events });
  }

  private linkRelationPair(
    tenantId: string,
    fromId: MemoryId,
    toId: MemoryId,
    kind: RelationKind,
  ): void {
    const exists = (a: MemoryId, b: MemoryId) =>
      this.relations.some(
        (r) =>
          r.tenantId === tenantId && r.fromMemoryId === a && r.toMemoryId === b && r.kind === kind,
      );
    const now = new Date();
    if (!exists(fromId, toId)) {
      this.relations.push({
        id: nextId("rel"),
        tenantId,
        fromMemoryId: fromId,
        toMemoryId: toId,
        kind,
        createdAt: now,
      });
    }
    if (!exists(toId, fromId)) {
      this.relations.push({
        id: nextId("rel"),
        tenantId,
        fromMemoryId: toId,
        toMemoryId: fromId,
        kind,
        createdAt: now,
      });
    }
  }

  /** 決着の種類に関わらず、このメンバー全員を結んでいた関係の行を消す。 */
  async resolveContestedGroup(
    ctx: Ctx,
    members: ReadonlyArray<{
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId | undefined;
      event: NewMemoryEvent;
    }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }> {
    assertWellFormedCtx(ctx);
    members = members.map(normPairSide);
    if (members.length < 3) {
      throw new RangeError("resolveContestedGroup: members must have at least 3 entries");
    }
    const ids = members.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("resolveContestedGroup: member ids must be unique");
    }
    members.forEach((m, i) =>
      assertResolvedStatus("resolveContestedGroup", `members[${i}]`, m.status),
    );
    members.forEach((m, i) =>
      assertSupersededByShape(
        "resolveContestedGroup",
        `members[${i}]`,
        m.id,
        m.status,
        m.supersededById,
        {
          forbidWhenNotSuperseded: true,
        },
      ),
    );
    assertNoSupersededCycle("resolveContestedGroup", members);

    const memories = members.map((m) => {
      const memory = this.rawGet(ctx, m.id);
      if (!memory) {
        throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${m.id}`);
      }
      return memory;
    });
    for (const memory of memories) {
      if (memory.status !== "contested") {
        throw new MemoryStatusConflictError(memory.id, "contested", memory.status);
      }
    }

    {
      const idSet = new Set(ids);
      const visited = new Set<MemoryId>(ids);
      const queue = [...ids];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const r of this.relations) {
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
      const missing = [...visited].filter((id) => {
        if (idSet.has(id)) return false;
        const memory = this.rawGet(ctx, id);
        return memory !== null && memory.status === "contested";
      });
      if (missing.length > 0) {
        throw new ContestedGroupMembershipMismatchError(missing[0]!);
      }
    }
    for (const m of members) {
      this.assertOwnMemoryRef(ctx, m.supersededById);
    }
    {
      const memberIds = new Set<string>(ids);
      members.forEach((m, i) => {
        if (m.supersededById === undefined || memberIds.has(m.supersededById)) return;
        if (this.rawGet(ctx, m.supersededById)?.status === "forgotten") {
          throw new RangeError(
            `resolveContestedGroup: members[${i}].supersededById must not be a forgotten memory outside the group`,
          );
        }
      });
    }

    for (const m of members) {
      assertStorableMemoryColumn("status", m.status);
      assertStorableMemoryEvent(asJsonSerializedSizeBeforeBytes(m.event));
      assertCloneableMemoryEvent(m.event);
    }
    for (const m of members) {
      this.assertEventTargetOwn(ctx, m.event.memoryId, ids);
    }

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
    for (let i = this.relations.length - 1; i >= 0; i--) {
      const r = this.relations[i]!;
      if (
        r.tenantId === ctx.tenantId &&
        idSet.has(r.fromMemoryId) &&
        idSet.has(r.toMemoryId) &&
        r.kind === "contradicts"
      ) {
        this.relations.splice(i, 1);
      }
    }

    const events = members.map((m) => {
      const event = buildStoredMemoryEvent(ctx, asJsonSerializedSizeBeforeBytes(m.event));
      this.events.push(event);
      return event;
    });

    return snapshot({ members: memories, events });
  }

  /** 生存側1件だけを対象にし、対向の行には触れない。CAS の失敗は {@link MemoryStatusConflictError}。 */
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
    const memory = this.rawGet(ctx, survivor.id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${survivor.id}`);
    }
    if (memory.status !== "contested" || memory.contestedWithId !== survivor.contestedWithId) {
      throw new MemoryStatusConflictError(survivor.id, "contested", memory.status);
    }

    assertStorableMemoryEvent(survivor.event);
    assertCloneableMemoryEvent(survivor.event);
    this.assertEventTargetOwn(ctx, survivor.event.memoryId, [survivor.id]);
    memory.status = "active";
    memory.contestedWithId = null;
    memory.updatedAt = new Date();

    const storedEvent = buildStoredMemoryEvent(ctx, survivor.event);
    this.events.push(storedEvent);

    return snapshot({ memory, event: storedEvent });
  }

  /** 有効期間の重なる `status === "active"` の行を探す。`subjectId` は `null` 同士も一致する。LLM は呼ばない。 */
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
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    query = { ...query, claimKey: replaceLoneSurrogatesInClaimKey(query.claimKey) };
    assertQueryDate("findActiveByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findActiveByClaimKey", "validUntil", query.validUntil);
    assertQueryTextWithoutNul("findActiveByClaimKey", "claimKey.subject", query.claimKey.subject);
    assertQueryTextWithoutNul(
      "findActiveByClaimKey",
      "claimKey.predicate",
      query.claimKey.predicate,
    );
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    const matches = [...this.memories.values()].filter((m) => {
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
      if (m.contentHash === replaceLoneSurrogates(query.contentHash)) return false;
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      const isEmptyInterval = (from: Date | null, until: Date | null): boolean =>
        from !== null && until !== null && from >= until;
      const overlaps =
        !isEmptyInterval(targetFrom, targetUntil) &&
        !isEmptyInterval(otherFrom, otherUntil) &&
        (targetFrom === null || otherUntil === null || targetFrom < otherUntil) &&
        (otherFrom === null || targetUntil === null || otherFrom < targetUntil);
      return overlaps;
    });
    return snapshot(matches);
  }

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
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    query = { ...query, claimKey: replaceLoneSurrogatesInClaimKey(query.claimKey) };
    assertQueryDate("findContestedByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findContestedByClaimKey", "validUntil", query.validUntil);
    assertQueryTextWithoutNul(
      "findContestedByClaimKey",
      "claimKey.subject",
      query.claimKey.subject,
    );
    assertQueryTextWithoutNul(
      "findContestedByClaimKey",
      "claimKey.predicate",
      query.claimKey.predicate,
    );
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    const matches = [...this.memories.values()].filter((m) => {
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
      if (m.contentHash === replaceLoneSurrogates(query.contentHash)) return false;
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      const isEmptyInterval = (from: Date | null, until: Date | null): boolean =>
        from !== null && until !== null && from >= until;
      const overlaps =
        !isEmptyInterval(targetFrom, targetUntil) &&
        !isEmptyInterval(otherFrom, otherUntil) &&
        (targetFrom === null || otherUntil === null || targetFrom < otherUntil) &&
        (otherFrom === null || targetUntil === null || otherFrom < targetUntil);
      return overlaps;
    });
    return snapshot(matches);
  }

  /** `status === "active"` の行を predicate ごとにまとめ、最も新しい `createdAt` の降順で `limit` 件まで返す。 */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
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
    for (const m of this.memories.values()) {
      if (m.tenantId !== ctx.tenantId) continue;
      if ((m.subjectId ?? null) !== query.subjectId) continue;
      if (m.status !== "active") continue;
      if (!m.claimKey || m.claimKey.subject == null || m.claimKey.predicate == null) continue;
      const predicate = m.claimKey.predicate;
      const createdAtMs = m.createdAt.getTime();
      const existing = latestByPredicate.get(predicate);
      if (existing === undefined || createdAtMs > existing) {
        latestByPredicate.set(predicate, createdAtMs);
      }
    }
    return (
      [...latestByPredicate.entries()]
        // 同着は predicate のコードポイント順（JS の `<` は UTF-16 コード単位順で食い違う）。
        .sort((a, b) => b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
        .slice(0, query.limit)
        .map(([predicate]) => predicate)
    );
  }

  /** `superseded → active`。`filter?.onlyMemoryIds` は選定条件に積集合として足す。 */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string | undefined; actor?: EventActor | undefined; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ restored: Memory[] }> {
    assertWellFormedCtx(ctx);
    supersededById = normId(supersededById);
    const onlyMemoryIds = filter?.onlyMemoryIds?.map(normId);
    const targets = [...this.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const actor = event.actor ?? { type: "system" };
    const meta = { reason: event.reason ?? "unsuperseded", supersededById };
    // 1件目を書き換える前に確かめる: ループ内で初めて投げると、先の行だけが戻ってイベントの無い状態が残る。
    if (targets.length > 0) {
      const template: NewMemoryEvent = {
        tenantId: ctx.tenantId,
        memoryId: supersededById,
        kind: "unsuperseded",
        at: event.at,
        actor,
        digestSnapshot: null,
        sizeBeforeBytes: null,
        meta,
      };
      assertStorableMemoryEvent(template);
      assertCloneableMemoryEvent(template);
    } else {
      assertWrittenTimestamptzFloor("memory_events", "at", event.at);
    }

    const restored: Memory[] = [];
    for (const memory of targets) {
      memory.status = "active";
      memory.supersededById = null;
      memory.updatedAt = new Date();
      const storedEvent = buildStoredMemoryEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "unsuperseded",
        at: event.at,
        actor,
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta,
      });
      this.events.push(storedEvent);
      restored.push(memory);
    }
    return snapshot({ restored });
  }

  /** 書き込みを行わず、対象ごとの直近の `superseded` イベントの `meta.reason` を返す（無ければ `null`）。 */
  async previewRestoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    assertWellFormedCtx(ctx);
    supersededById = normId(supersededById);
    const onlyMemoryIds = filter?.onlyMemoryIds?.map(normId);
    const targets = [...this.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const candidates = targets.map((memory) => {
      let latest: MemoryEvent | undefined;
      for (const event of this.events) {
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

  /** `name` はコードポイント順（Postgres の `COLLATE "C"`）で、`localeCompare` ではない。 */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    assertWellFormedCtx(ctx);
    const results: LabelSummary[] = [];
    for (const [key, label] of this.labels) {
      if ((JSON.parse(key) as [string, string])[0] === ctx.tenantId) {
        results.push(label);
      }
    }
    results.sort((a, b) => compareLabelName(a.name, b.name));
    return snapshot(results);
  }

  /** `registerLabel?`。`name` に NUL（U+0000）を含むと投げる（Postgres は `labels.name`（`text` 列）が NUL を拒む）。 */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    assertWellFormedCtx(ctx);
    if (name.includes("\u0000")) {
      throw new Error(`InMemoryMemoryStore: label name must not contain NUL characters (U+0000)`);
    }
    name = replaceLoneSurrogates(name);
    const key = this.labelKey(ctx.tenantId, name);
    const existing = this.labels.get(key);
    const registered: LabelSummary = {
      name,
      status: "registered",
      proposedCount: existing?.proposedCount ?? 0,
      registeredAt: existing?.registeredAt ?? new Date(),
    };
    this.labels.set(key, registered);
    return snapshot(registered);
  }

  /** 外部キー制約を持たないので `blocked_by_foreign_reference` は返さない。`reachedLimit` は保守的な近似（ちょうど budget 分削除できたら、残りを確認せず `true`）。 */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult> {
    assertWellFormedCtx(ctx);
    assertQueryBigint("eraseTenant", "limit", opts.limit);
    const limit = opts.limit;
    const dryRun = opts.dryRun === true;
    let remaining = limit;
    let total = 0;
    let reachedLimit = false;

    const drainMap = <V>(map: Map<string, V>, tenantOf: (value: V) => string): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const [key, value] of map) {
        if (victims.length >= budget) break;
        if (tenantOf(value) === ctx.tenantId) {
          victims.push(key);
        }
      }
      if (!dryRun) {
        for (const key of victims) {
          map.delete(key);
        }
      }
      return victims.length;
    };
    const drainKeyedMap = <V>(map: Map<string, V>): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const key of map.keys()) {
        if (victims.length >= budget) break;
        const [tenantId] = JSON.parse(key) as [string, ...unknown[]];
        if (tenantId === ctx.tenantId) {
          victims.push(key);
        }
      }
      if (!dryRun) {
        for (const key of victims) {
          map.delete(key);
        }
      }
      return victims.length;
    };
    const drainSet = (set: Set<string>, belongsToTenant: (key: string) => boolean): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victims: string[] = [];
      for (const key of set) {
        if (victims.length >= budget) break;
        if (belongsToTenant(key)) {
          victims.push(key);
        }
      }
      if (!dryRun) {
        for (const key of victims) {
          set.delete(key);
        }
      }
      return victims.length;
    };
    const drainArray = <V>(array: V[], tenantOf: (value: V) => string): number => {
      if (remaining <= 0) return 0;
      const budget = remaining;
      const victimIndexes: number[] = [];
      for (let i = 0; i < array.length && victimIndexes.length < budget; i++) {
        if (tenantOf(array[i]!) === ctx.tenantId) {
          victimIndexes.push(i);
        }
      }
      if (!dryRun) {
        for (let i = victimIndexes.length - 1; i >= 0; i--) {
          array.splice(victimIndexes[i]!, 1);
        }
      }
      return victimIndexes.length;
    };

    const steps: Array<() => number> = [
      () => drainKeyedMap(this.memoryLabels),
      () => drainSet(this.usages, (key) => tenantOfUsageKey(key) === ctx.tenantId),
      () => drainArray(this.events, (event) => event.tenantId),
      () => drainArray(this.relations, (relation) => relation.tenantId),
      () => {
        const tenantMemoryIds = [...this.memories.values()]
          .filter((memory) => memory.tenantId === ctx.tenantId)
          .map((memory) => memory.id);
        const deleted = drainMap(this.memories, (memory) => memory.tenantId);
        if (!dryRun) {
          const deletedIds = tenantMemoryIds.filter((id) => !this.memories.has(id));
          if (deletedIds.length > 0) {
            for (const listener of this.memoriesDeletedListeners) {
              listener(ctx.tenantId, deletedIds);
            }
          }
          for (const key of [...this.extractionIndex.keys()]) {
            const [tenantId] = JSON.parse(key) as [string, ...unknown[]];
            if (tenantId === ctx.tenantId) {
              this.extractionIndex.delete(key);
            }
          }
        }
        return deleted;
      },
      () => drainMap(this.observations, (observation) => observation.tenantId),
      () => drainMap(this.recalls, (recall) => recall.tenantId),
      () => drainKeyedMap(this.labels),
      () => {
        if (remaining <= 0) return 0;
        if (!this.activitySeq.has(ctx.tenantId)) return 0;
        if (!dryRun) this.activitySeq.delete(ctx.tenantId);
        return 1;
      },
      () => {
        const bySubject = this.subjectActivitySeq.get(ctx.tenantId);
        if (bySubject === undefined) return 0;
        const deleted = drainMap(bySubject, () => ctx.tenantId);
        if (!dryRun && bySubject.size === 0) this.subjectActivitySeq.delete(ctx.tenantId);
        return deleted;
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

  private extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    // 区切り文字で繋がない: 各値が `:` を含みうるので、繋ぐと別の組と同じキーになる。
    return JSON.stringify([tenantId, sourceObservationId, extractorVersion, contentHash]);
  }
}
