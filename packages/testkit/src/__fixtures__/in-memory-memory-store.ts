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

/** `expectedStatus` を渡された status 更新の CAS が破れるか。purge 済みの行（`purgedAt` が非 null）は、どの `expectedStatus` にも一致しない（`PostgresMemoryStore` と同じ。`Runtime.purge` の「不可逆」の約束）。 */
function casMismatch(
  memory: { status: MemoryStatus; purgedAt?: Date | null | undefined },
  expectedStatus: MemoryStatus,
): boolean {
  return memory.status !== expectedStatus || (memory.purgedAt ?? null) !== null;
}

/** `resolveContestedPair`・`resolveContestedGroup` の `status` が型の外の値なら、書く前に `RangeError` で断る（`PostgresMemoryStore` と同じ文面。値は message に入れない）。 */
function assertResolvedStatus(method: string, field: string, status: unknown): void {
  if (status !== "active" && status !== "superseded") {
    throw new RangeError(`${method}: ${field}.status must be "active" or "superseded"`);
  }
}

/**
 * `status: "superseded"` の更新は、置き換えた側（`supersededById`）を必ず伴い、自分自身でないこと。
 * `resolveContested*` の `"active"` に `supersededById` を付けることも断る。書く前に `RangeError` で断る（`PostgresMemoryStore` と同じ文面）。
 */
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
    // Postgres は両側の uuid を畳んで比べる。呼び出し側は id だけ畳むので、ここで両側を畳む。
    if (normId(supersededById) === normId(selfId)) {
      throw new RangeError(`${method}: ${field}.supersededById must not be the memory itself`);
    }
  } else if (opts.forbidWhenNotSuperseded && supersededById !== undefined) {
    throw new RangeError(
      `${method}: ${field}.supersededById must not be set unless status is "superseded"`,
    );
  }
}

/** `supersededById` の鎖が、同じ呼び出しで `superseded` になるメンバーの中で輪になっていないこと。輪なら `RangeError`。 */
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

/** `MemoryStore` の口が返す値を、返す時点の複製にする。内部の実体を返すと、呼び手が受け取った値が後の操作で変わり、書き換えると store の中身まで変わる（Postgres は毎回新しいオブジェクトを返す）。 */
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

/** `createRecall` で、Postgres が `recalls` の行を書けずに拒む入力（NUL、JSON にならない値、Invalid Date）を先に検査する。何も書かず、活動時計も進めない。 */
function assertRecallRecordStorable(record: NewRecallRecord): void {
  // `created_at` は `timestamptz`。省略は壁時計を使うので検査しない。
  if (record.createdAt != null && Number.isNaN(record.createdAt.getTime())) {
    throw new Error("createRecall: createdAt must be a valid Date (got Invalid Date)");
  }
  // 下限より前は、Postgres が書けずに拒む。
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

/**
 * outbox の行を実際に書くときに Postgres が拒む入力（`jobKinds` の NUL、`now` の Invalid Date、`claimedBy` の NUL）を、何も書く前に検査する。
 * 行を書かないとき（`jobKinds` が空・冪等の既存の行）は拒まない（Postgres は outbox へ INSERT せず、値を見ない）。新しい行を作る分岐の中（`beforeInsert`）で呼ぶ。
 */
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

/**
 * Observation の `payload` に、Postgres の `JSON.stringify` の規則のうち、`structuredClone` が断る値（関数・`Symbol`）と `toJSON` だけを先に当てる。
 * 残りの値（`NaN`・`-0`・`Date` など）は `ObserveEventInput.data` の TSDoc の表どおり保持する。入力は書き換えない。
 */
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

/** Observation を書く口で、Postgres が NUL を拒む欄を先に検査する。`externalId` の衝突を見る前に拒むので、冪等の判定より前に見る。 */
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

/** Observation を書く口で、Postgres が `timestamptz` への変換で拒む Invalid Date を先に検査する。省略は検査しない。`externalId` の衝突を見る前に拒むので、冪等の判定より前に見る。 */
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
    // 下限より前は、冪等の既存の行が在っても拒む。
    assertWrittenTimestamptzFloor(owner, field, value);
  }
}

/**
 * `MemoryStore` のインメモリ・プレースホルダ実装。本番用途ではない: 索引・永続化・トランザクションは模さない。
 * `outboxJobs`・`events` は公開してあり、`InMemoryOutboxStore`・`InMemoryEventStore` に同じ配列を渡すと、
 * ここが積んだジョブ・イベントを `OutboxStore`・`EventStore` 側から扱える。
 */
/**
 * `aggregateScope` が `filteredDecayed` を数えるための述語。`recall-runtime.ts` の `survivesDecayGate` の否定であり、
 * `PostgresMemoryStore.aggregateScope` の `isDecayed`（SQL）と同じものでなければならない（一致は適合テストが検算する）。
 *
 * - 壁時計の軸が生きている: `decayFloorAt > decayFloorAtAfter`（狭義）
 * - 活動時計の軸が生きている: `decayFloorSeq` が無い（床が無い）か `decayFloorSeq > decayFloorSeqAfter`
 * - `decayFloorAnyAxis`: 2軸の OR。軸が1本も渡されていない（ゲート無効）: 常に `false`
 */
function isDecayedForScope(
  memory: Pick<Memory, "decayFloorAt" | "decayFloorSeq" | "subjectId">,
  scope: RecallScope,
  // このテナントの subject 単位カウンタ。`scope.decayFloorSeqUsesSubjectCounters` が true のときだけ参照する。
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
  // `decayFloorSeqAfter + S_x` が `bigint` を溢れるとき、Postgres は文ごと失敗する。ただし式が評価される行があるときだけ（`decay_floor_seq` が非 NULL で subject を持つ行）。
  // 2軸のときは壁時計が先に評価される。
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

/**
 * `listLabels?` の `name` 昇順を、コードポイント順（Postgres の `COLLATE "C"` と同じバイト順）で比べる。
 * 素の `<`/`>` を使わない: UTF-16 コード単位の比較だと、サロゲートペア（絵文字など）が U+E000〜U+FFFF の BMP 文字より前に並び、コードポイント順と食い違う。
 */
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

/** `memories` の1行として書ける値かを確かめる（Postgres が拒む入力を、同じ入力で拒む）。冪等の衝突の判定より前に呼ぶ。 */
function assertStorableNewMemory(input: NewMemory): void {
  // 値域は Postgres の CHECK 制約と同じ検査を置く: 放置すると、本番では落ちる書き込みが手元では黙って成功する。
  if (!isStrengthInRange(input.strength)) {
    throw new Error(
      `InMemoryMemoryStore: strength out of range (0, ${MAX_STRENGTH}]: ${input.strength}`,
    );
  }
  // `decay`/`freshness` は `halfLifeHours` で割るので、`0`・負・`NaN`・`Infinity` は通してはならない。
  if (!isHalfLifeHoursInRange(input.halfLifeHours)) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours out of range (0, ∞): ${input.halfLifeHours}`,
    );
  }
  // `half_life_hours` は `real`（float4）列。`isHalfLifeHoursInRange` は float64 の `(0, ∞)` しか見ないので、float4 で `Infinity` に丸まる値を別に断る。
  // `strength` にはこの検査を足さない: 同じ `real` 列だが、`isStrengthInRange` が先に拒む。
  if (!Number.isFinite(Math.fround(input.halfLifeHours))) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${input.halfLifeHours})`,
    );
  }
  // 下側: 0 でない値が float4 で 0 に丸まるときも Postgres は拒む（境界は `Math.fround(x)` が 0 になるか）。
  // `strength` は値域の中の値でもここに当たる。`0` そのものは値域の検査の担当。
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
  // `recordedAt`・`occurredAt`・`validFrom`・`validUntil`・`decayFloorAt`・`lastReinforcedAt` は `timestamptz` 列。省略可能な欄は値が渡されたときだけ検査する。
  // 由来が `stated`/`inferred` なら元の観測が要る（`memories_check`）。
  if (
    (input.provenance.kind === "stated" || input.provenance.kind === "inferred") &&
    input.sourceObservationId == null
  ) {
    throw new Error(
      `InMemoryMemoryStore: provenance.kind "${input.provenance.kind}" requires sourceObservationId`,
    );
  }
  // 活動時計の起点と床は `bigint` 列で、負を拒む。省略は検査しない。
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
  // 活動時計の半減期は `(0, ∞)` で、`real`（float4）列に収まる必要がある。省略は検査しない。
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
  // `decay_floor_at` は NOT NULL で、Postgres は `null`・`undefined`・キーなしを拒む（冪等の既存の行が在っても）。型の誤りなので `TypeError`（例外の顔は Postgres と揃えない）。
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
  // 上の欄は、下限より前を Postgres が書けずに拒む（冪等の既存の行が在っても拒む）。
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
  // `text` 列は NUL を拒む。`tenantId` はここに含めない: `ctx.tenantId` は他のメソッドが個別に読む横断的な値で、ここだけ検査しても一貫しない。孤立サロゲートはここでは扱わない。
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
  // `content_hash` も `text` 列。
  if (input.contentHash.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: contentHash must not contain NUL characters (U+0000)`);
  }
  // `extractor_version`・`claim_key_subject`・`claim_key_predicate` も `text` 列（冪等の既存の行が在っても拒む）。
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
  // `attributes`・`provenance` は `jsonb` 列。
  if (jsonContainsNul(input.attributes ?? {})) {
    throw new Error(`InMemoryMemoryStore: attributes must not contain NUL characters (U+0000)`);
  }
  if (jsonContainsNul(input.provenance)) {
    throw new Error(`InMemoryMemoryStore: provenance must not contain NUL characters (U+0000)`);
  }
  // 列挙の列（型の列挙に無い値）は Postgres の CHECK 制約で拒む。`status` は省略すると `active` になるので、省略は検査しない。
  if (input.status !== undefined) assertStorableMemoryColumn("status", input.status);
  assertStorableMemoryColumn("digest_source", input.digestSource);
  assertStorableMemoryColumn("embedding_status", input.embeddingStatus);
  assertStorableMemoryColumn("provenance_kind", input.provenance.kind);
  assertWellFormedNewMemory("InMemoryMemoryStore", input);
}

/**
 * `MemoryStore` のインメモリ実装（`@mnemora/testkit/fixtures`）。契約は `@mnemora/core` の `MemoryStore` の各メソッドの doc が正。
 * Postgres が拒む値（列挙に無い値・NUL・値域の外の数など）はこの fixture も拒み、拒むときは何も書かない。
 */
/** 操作の対象の id を小文字にそろえる（Postgres は uuid 型の列で比べるので、大文字の uuid を同じ記憶として受ける。この fixture の id は小文字の `mem-N` だけ）。 */
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

/** `recall_usages` の鍵 `${tenantId}:${recallId}:${memoryId}` から tenantId を取り出す。tenantId は `:` を含みうるので、前から切らず後ろの2つの `:` を外す。 */
function tenantOfUsageKey(key: string): string {
  const last = key.lastIndexOf(":");
  return key.slice(0, key.lastIndexOf(":", last - 1));
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly observations = new Map<string, Observation>();
  private readonly memories = new Map<string, Memory>();
  /** `(tenant_id, source_observation_id, extractor_version, content_hash)` の冪等キー。 */
  private readonly extractionIndex = new Map<string, MemoryId>();
  /** `(tenant_id, recall_id, memory_id)` の使用報告の冪等キー。 */
  private readonly usages = new Set<string>();
  /** `recalls` 相当のインメモリ表。`getRecall` が返す形と1対1にするため `createdAt` を持つ。 */
  readonly recalls = new Map<string, NewRecallRecord & { tenantId: string; createdAt: Date }>();
  /** `InMemoryEventStore` と共有する memory_events 相当の配列。 */
  readonly events: MemoryEvent[] = [];
  /** `InMemoryOutboxStore` と共有する outbox ジョブの配列。 */
  readonly outboxJobs: OutboxJobRecord[] = [];
  /** `tenant_activity` 相当のテナントごとの活動カウンタ。`InMemoryTenantSettingsStore` に同じ Map を渡すと、`createRecall`（書く側）と `getActivitySeq`（読む側）が同じ値を見る。 */
  readonly activitySeq = new Map<string, number>();

  /** `tenant_subject_activity` 相当（`tenantId` → `subjectId` → `S_x`）。`InMemoryTenantSettingsStore` と共有する。 */
  readonly subjectActivitySeq = new Map<string, Map<string, number>>();

  /**
   * `tenant_settings.event_retention_days` 相当。`InMemoryTenantSettingsStore` と共有する。
   * キーが無いテナントは `{ kind: "unset" }`、値が `null` なら `{ kind: "unlimited" }`、数値なら `{ kind: "days" }`。
   */
  readonly eventRetentionDays = new Map<string, number | null>();

  /** `labels` 相当のインメモリ表。key は {@link labelKey}。 */
  private readonly labels = new Map<string, LabelSummary>();

  /** `memory_labels` 相当（`(tenantId, memoryId)` → 紐づく label 名の集合）。`purgeMemory` が紐付けを外し、その分だけ `proposedCount` を減らすために要る。 */
  private readonly memoryLabels = new Map<string, Set<string>>();

  /** `memory_relations` 相当。`InMemoryRelationStore` と共有する。 */
  readonly relations: StoredRelation[] = [];

  /** `memories` の行を消したときに呼ぶ listener（`memory_embeddings_<space>.memory_id` の `ON DELETE CASCADE` に当たる動き）。 */
  private readonly memoriesDeletedListeners: Array<
    (tenantId: string, memoryIds: readonly MemoryId[]) => void
  > = [];

  /** `memories` の行が消えたとき（`eraseTenant`。`dryRun` では呼ばない）に `listener` を呼ぶ。`InMemoryVectorStore` が埋め込みを一緒に消すために使う。 */
  onMemoriesDeleted(listener: (tenantId: string, memoryIds: readonly MemoryId[]) => void): void {
    this.memoriesDeletedListeners.push(listener);
  }

  /** `(tenantId, name)` を区切り文字で繋がず、`JSON.stringify` の配列で表す: `tenantId` は `::` を含みうるので、繋ぐとテナント `a::b` の `x` とテナント `a` の `b::x` が同じキーに潰れる。 */
  private labelKey(tenantId: string, name: string): string {
    return JSON.stringify([tenantId, name]);
  }

  /** `labelKey` と同じ理由で、`(tenantId, memoryId)` を `JSON.stringify` の配列で表す。 */
  private memoryLabelKey(tenantId: string, memoryId: string): string {
    return JSON.stringify([tenantId, memoryId]);
  }

  /** 新しく作った Memory の `tags` から `proposed` ラベルを作り、`proposedCount` を数える（`PostgresMemoryStore.upsertProposedLabels` と同じ）。「新しい行を実際に作った」分岐からだけ呼ぶ。 */
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
      // `status === 'registered'` は件数を進めない。
      linked.add(name);
    }
    // この Memory がどの label 名に紐づいたかを覚える（`purgeMemory` が使う）。
    this.memoryLabels.set(this.memoryLabelKey(ctx.tenantId, memoryId), linked);
  }

  /** 「既存を引く」と「挿入する」を1つの同期区間に閉じる。`await` を挟まない: 挟むと判定と挿入の間に他の呼び出しが入り、`created` が別の書き込みの影響を受ける。 */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
    // 新しい行を実際に作るとき（冪等の既存の行が無いとき）にだけ、書く前に呼ばれる。
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Observation> {
    // `kind`（`text` 列）の孤立サロゲートは、Postgres と同じく U+FFFD に置き換えて保存する。
    input = replaceLoneSurrogatesInNewObservation(input);
    assertObservationHasNoNul("InMemoryMemoryStore", input);
    assertObservationDatesValid("InMemoryMemoryStore", input);
    // Postgres の一意制約は `external_id IS NOT NULL` の行に効く: 空文字も鍵（`null`/`undefined` だけが鍵無し）。
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
      // 呼び手の入力と切り離して保存する。
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
    // 渡されたら、その名前で claim 済み（`attempts: 1`）で作る。
    claimedBy?: string,
  ): OutboxJobRecord {
    // `text` 列なので、孤立サロゲートは U+FFFD に置き換える。
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
    // 省略時は1回だけ壁時計を読み、積む outbox 行すべてに同じ値を使う（`@mnemora/postgres` と同じ）。
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

  /** 別の行への参照は `ctx` のテナントの行を指さなければならない。実在しない id と別テナントの id は区別しない（`… not found for tenant: <id>`）。`null`・`undefined` は「参照しない」。空文字は参照として扱い、拒む。 */
  private assertOwnMemoryRef(ctx: Ctx, id: MemoryId | null | undefined): void {
    if (id === null || id === undefined) return;
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      // 参照先が無いときの message は、Postgres と同じく小文字にそろえた id を載せる。
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${normId(id)}`);
    }
  }

  /**
   * `NewMemoryEvent.memoryId` の記憶が `ctx` のテナントに在ることを、イベントを積む前に確かめる。実在しない・別テナントは区別しない。
   * `null`・`undefined` は確かめない。`knownInTenant` は、この呼び出しが更新・作成した行の id で、それを指すイベントは問い合わせない。
   * 書く前に呼ぶ（断ったら何も書かれない）。
   */
  private assertEventTargetOwn(
    ctx: Ctx,
    memoryId: MemoryId | null | undefined,
    knownInTenant: readonly MemoryId[] = [],
  ): void {
    if (memoryId === null || memoryId === undefined) return;
    // 大文字小文字は区別しない（Postgres は uuid を小文字にそろえて比べる）。断るときの message は渡された id のまま。
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

  /** 冪等キーの判定と挿入を1つの同期区間に閉じる（`createObservationIdempotent` と同じ理由）。 */
  private createMemoryIdempotent(
    ctx: Ctx,
    input: NewMemory,
    method:
      | "createMemory"
      | "createMemoryWithOutbox"
      | "createMemoriesWithOutboxAndEvents" = "createMemory",
    // 新しい行を実際に作るとき（冪等の既存の行が無いとき）にだけ、書く前に呼ばれる。
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Memory> {
    // `text` 列に入る欄の孤立サロゲートは、Postgres と同じく U+FFFD に置き換えて保存する。冪等の鍵（`contentHash`・`extractorVersion`）も置き換えた後の値で比べる。
    input = replaceLoneSurrogatesInNewMemory(input);
    // `createMemory`/`createMemoryWithOutbox` 共通の入口。Postgres と同じく何も書く前に落とす（冪等衝突の判定より前）。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError(method, null);
    }
    // 書ける値かの検査は、冪等の衝突の判定より前に置く: Postgres の `INSERT ... ON CONFLICT DO NOTHING` は、衝突を見る前に値を検査するので、同じ鍵の既存の行が在っても拒む。
    assertStorableNewMemory(input);
    // 参照先は `ctx` のテナントの行であること。検査の順は `PostgresMemoryStore` と同じ（observation、superseded-by、contested-with）で、冪等の衝突の判定より前に置く。
    // 参照する observation の id も大文字小文字を区別しない。
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
      // 外部キー相当: 参照先は、非 null なら実在する行を指さなければならない（放置すると、本番では起きない書き込みが手元では黙って成功する）。
      // 「存在」だけを見る（`contested_with_id` が双方向かどうかは見ない）。空文字も参照として扱う（`null`/`undefined` だけが「参照しない」）。

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
        // `undefined`/`null` はどちらも「鍵なし」。`?? null` で転記しないと `undefined` のまま消える。
        claimKey: input.claimKey ?? null,
        // Postgres の `real`（float4）列なので、Postgres が読み戻す値で持つ。
        strength: toFloat4Readback(input.strength),
        halfLifeHours: toFloat4Readback(input.halfLifeHours),
        decayFloorAt: input.decayFloorAt,
        // 省略可能なので `?? null` で転記しないと `undefined` のまま消える。
        decayBaseSeq: input.decayBaseSeq ?? null,
        decayFloorSeq: input.decayFloorSeq ?? null,
        halfLifeRecalls:
          input.halfLifeRecalls == null ? null : toFloat4Readback(input.halfLifeRecalls),
        embeddingStatus: input.embeddingStatus,
        // `purgedAt` は保存しない: `purgeMemory` が唯一の書き手で、Postgres は `purged_at` を INSERT に含めない。渡された値は断らず無視する。
        purgedAt: null,
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      // 呼び手の入力と切り離す（呼び手が後で書き換えても、保存した値は変わらない）。
      const stored = structuredClone(memory);
      this.memories.set(stored.id, stored);
      if (input.sourceObservationId != null) {
        this.extractionIndex.set(idemKey, stored.id);
      }
      // 3つの経路（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`）はすべてここを通るので、この分岐で1回呼べば覆える。
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
    // 何も書く前に見直す（`abortIfForgotten` は実装しないが、こちらは実装する）。
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

  /** `opts.abortIfSuperseded` の実装。渡された id のうち1件でも `superseded` なら {@link SourceMemoryStatusChangedError} を投げる。何も書く前に呼ぶ。 */
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
    // 綴り違いの同じ id（`[x, X]`）は1行として数え、`changed` は id の昇順にする（Postgres は `ORDER BY id ASC` で選ぶ）。
    const seen = new Set<MemoryId>();
    for (const raw of ids) {
      // `changed[].id` は小文字（Postgres は行の uuid を読み戻す）。
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

  /**
   * 今の書き込みの状態（Memory・冪等キー・outbox・ラベル）を写し取り、呼ぶとそこへ戻す関数を返す（Postgres の SAVEPOINT の代わり）。
   * 戻すのはこの4つだけで、`events`（共有配列）は呼び出し側が長さで切り戻す。
   */
  private captureWriteState(): () => void {
    const memoryIdsBefore = new Set(this.memories.keys());
    const outboxLengthBefore = this.outboxJobs.length;
    const labelsBefore = new Map(this.labels);
    // `memoryLabels` も `labels` と同じロールバック対象: 写し忘れると、途中失敗した書き込みの label 紐付けだけが残る。
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
   * 抽出の全候補の Memory と `created` イベントを、1つの同期区間（トランザクションの代わり）で書く。
   * - 保存できない候補は、その候補の書き込みだけを戻して `dropped` に積む。全候補が落ちたら最初の例外を投げる（何も書かない）。
   * - 成否が確定したあと、`created: true` の候補ぶんの `created` イベントを `events` 配列へ積む。ここで投げたら全部戻して投げる。
   * - ⚠ `opts.abortIfForgotten` は実装しない: 渡しても無視され、例外は投げられない。
   * - ⚠ イベントは `InMemoryMemoryStore.events` に積まれる。`InMemoryEventStore` から読むには `memoryStore.events` を渡して共有すること。
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
        // イベントが指す記憶が、今作った行でなければ `ctx` のテナントの行か（外れたら全体を戻す）。
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

  /** 内部に持っている Memory の実体を返す（複製しない）。書き込みの口が、取った実体をその場で書き換えるために使う。`MemoryStore` の口は複製（`snapshot`）を返す。 */
  private rawGet(ctx: Ctx, id: MemoryId): Memory | null {
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // 同じ id を複数回渡しても1回しか返さない: Postgres は `WHERE id = ANY(...)` の集合演算で引くので、重複した Memory を返すと食い違う。
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

  /**
   * `InMemoryLexicalStore` がテナント内の全 Memory を舐めるための反復子。`LexicalStore` は `upsert`/`delete` を持たず、この store の `memories` そのものが索引になる。
   * `Map` の行そのものを返す（複製しない）: 呼び出し側は読むだけで、検索の速さのために複製を省く。`get`/`getMany` は複製を返す。
   */
  listByTenant(ctx: Ctx): Memory[] {
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /** `reextract` が、既存 Memory のうち今回作られなかったものを判定するための列挙（SELECT のみ）。`extractorVersion: null` は `extractor_version IS NULL` を意味する。 */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // 検索語も、Postgres が引数を UTF-8 に変換するときに置き換わる。
    extractorVersion = replaceLoneSurrogates(extractorVersion);
    // `extractor_version` は `text` 列で、検索語の NUL は Postgres がクエリの時点で拒む。ただし `observationId` が uuid の形でないとき、Postgres はクエリを発行せずに `[]` を返して NUL を見ない（この fixture の id は uuid の形ではないので、その入力だけは揃えていない）。
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

  /** `reextract` が「版を跨いで退けた記憶」を判定するための列挙（SELECT のみ）。`extractorVersion`・`status` のどちらでも絞らない。 */
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

  /**
   * `opts.expectedStatus` があるときだけ compare-and-swap にする。
   * 投げるもの: `"contested"` への遷移は常に {@link ContestedWithoutCompanionError}、`expectedStatus` と食い違えば {@link MemoryStatusConflictError}（どちらも何も書かない）。
   */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
  ): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // この口には contestedWithId を渡す引数が無いので、`contested` への書き込みは常に単独になる。Postgres と同じ位置（対象の存在確認より前）で落とす。
    // 対象が無いときの message は、Postgres と同じく渡された綴りのまま載せる。
    const requestedId = id;
    id = normId(id);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    // `superseded` は置き換えた側を伴い、自分自身ではない（書く前・対象の存在確認より前に断る）。
    assertSupersededByShape("updateStatus", "opts", id, status, opts?.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    // 外部キー相当: `supersededById` は `ctx` のテナントの Memory を指す。検査の順は `PostgresMemoryStore` と同じ（対象の行、`supersededById`、`expectedStatus`）。
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

  /**
   * `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む（CAS に弾かれたら status もイベントも変わらない）。
   * 投げるもの: `"contested"` への遷移は常に {@link ContestedWithoutCompanionError}、`expectedStatus` と食い違えば {@link MemoryStatusConflictError}。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // `updateStatus` と同じ理由・同じ位置。対象が無いときの message は渡された綴りのまま。
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
    // イベントが指す記憶は `ctx` のテナントの行（Postgres は UPDATE の後、同じトランザクションの中で確かめる）。
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
   * `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の supersede、複数可）を1回の呼び出しにまとめる。
   * `news` は {@link createMemoryWithOutbox} と同じ冪等経路、`supersede` は {@link updateStatusWithEvent} と同じ CAS 意味論（`status` は常に `"superseded"`）。
   * CAS に弾かれた対象は例外にせず `conflicted` に積んで続行する（対象がそもそも存在しない場合を除く）。
   *
   * ⚠ in-memory にトランザクションは無いので、何も書く前に検査をすべて済ませて投げることで、ロールバックを模す。
   * `news` の2件目以降で投げたときは、先に作った Memory・冪等キー・outbox・ラベルを取り消してから投げる。
   * ⚠ `supersededById` が同じ呼び出しの `news` で作られる Memory を指す形はサポートしない（存在を先に検査するので「無い」と判定される）。
   *
   * 新しい行に `status: "contested"` で `contestedWithId` が無いものがあれば、何も書かずに {@link ContestedWithoutCompanionError} を投げる。
   * `opts.buildCreatedEvent` が渡されたら、`created: true` の `news` の Memory ごとに `created` イベントを `events` へ積み（`supersede` の書き込みより前）、
   * 戻り値に `createdEventsWritten: true` を付ける。ここで投げたら `news` 側を全部戻す。`opts.abortIfForgotten` は実装しない（無視する）。
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
    // 対象が無いときの message は、Postgres と同じく渡された綴りのまま載せる。
    const requestedTargetIds = supersede.map((t) => t.id);
    supersede = supersede.map((t) => ({ ...t, id: normId(t.id) }));
    news.forEach((entry, i) =>
      assertWellFormedIdentifier(entry.input.subjectId, `news[${i}].input.subjectId`),
    );
    const outboxNow = opts?.now ?? new Date();
    const buildCreatedEvent = opts?.buildCreatedEvent;
    // `@mnemora/postgres` と同じ順（RangeError → news の検査 → 対象の存在）。壊れた news と存在しない対象が同時にあれば、壊れた値の例外が先に出る。
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
    // news の入口の検査は、`createMemoryIdempotent` の入口と同じ並びで、対象の存在の検査より前に当てる。
    // `assertWellFormedNewMemory` だけを先に呼ばないこと: `digest: null` などで、ほかの口と例外の種類が割れる。
    for (const { input } of news) {
      const replaced = replaceLoneSurrogatesInNewMemory(input);
      if (isContestedWithoutCompanion(replaced.status, replaced.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
      assertStorableNewMemory(replaced);
    }
    // 事前検証: まだ何も書いていないうちに投げる。3種類の失敗を1つに潰さない。
    for (const [i, target] of supersede.entries()) {
      // 下限より前の `at` はここでは見ない: CAS に弾かれる対象はイベントを書かず、Postgres は `at` を見ない。CAS を通る対象だけ、下の 1d で見る。
      assertStorableMemoryEvent(target.event, { skipAtFloor: true });
      // 1b. 対象の行がそもそも無い。
      const memory = this.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(
          `InMemoryMemoryStore: memory not found for tenant: ${requestedTargetIds[i]}`,
        );
      }
    }
    // 1c. news の各要素にも `createMemory` と同じ制約を課す。
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
    }
    // 1d. 下の 3. で CAS を通ってイベントを書く対象だけ、そのイベントが structuredClone で写せるかを確かめる（写せないと、status を書き換えた後に投げる）。
    // CAS に弾かれる対象は確かめない（投げる入力を増やさない）。同じ id が2回並ぶと2回目は弾かれるので、それも写す。
    // 下の 3. で CAS に弾かれる対象（`abortIfAllConflicted` の判定に使う）。
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
      // CAS を通ってイベントを書く対象だけ、`at` が下限より前でないかを確かめる（上の 1. は見ない）。
      assertWrittenTimestamptzFloor("memory_events", "at", target.event.at);
      // CAS を通ってイベントを書く対象だけ、そのイベントが指す記憶が `ctx` のテナントの行かを確かめる（`PostgresMemoryStore` と同じ）。
      this.assertEventTargetOwn(ctx, target.event.memoryId, [target.id]);
      willSupersede.add(target.id);
    }
    // 何も書く前（news の作成より前）に見直す。
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "supersedeWithNewMemories");
    if (
      opts?.abortIfAllConflicted === true &&
      supersede.length > 0 &&
      wouldConflict.length === supersede.length
    ) {
      throw new SourceMemoryStatusChangedError("supersedeWithNewMemories", wouldConflict);
    }

    // 2. news を作る（`createMemoryWithOutbox` と同じ経路）。
    //    2件目以降で投げたときは、先に作った Memory・冪等キー・outbox・ラベルを取り消す（Postgres は1トランザクションで巻き戻る）。
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
      // `created` イベントも、`supersede` に触れる前に積む（積めなければ news の書き込みごと戻す）。
      if (buildCreatedEvent !== undefined) {
        for (const [index, entry] of created.entries()) {
          if (entry.created) {
            const createdEvent = buildCreatedEvent(snapshot(entry.memory), index);
            // 今作った行でなければ `ctx` のテナントの行か。
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

    // 3. supersede を1件ずつ CAS で処理する。弾かれても conflicted に積んで続行する（本メソッド自体は commit する）。
    const superseded: MemoryEvent[] = [];
    const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    for (const target of supersede) {
      // 1. で存在を確認済み。news の作成は既存 Memory の status を変えないので、ここで読む status は 1. の時点から変わっていない。
      const memory = this.memories.get(target.id)!;
      if (target.expectedStatus !== undefined && casMismatch(memory, target.expectedStatus)) {
        conflicted.push({ id: target.id, observedStatus: memory.status });
        continue;
      }
      memory.status = "superseded";
      // `created` は `news` と同じ順序。1. で範囲を検査済みなので、この索引は必ず在る。
      const anchorId = created[target.supersededByIndex]!.memory.id;
      memory.supersededById = anchorId;
      memory.updatedAt = new Date();
      // `meta.supersededById` は解決した id で埋める。
      const storedEvent = buildStoredMemoryEvent(ctx, {
        ...target.event,
        meta: { ...target.event.meta, supersededById: anchorId },
      });
      this.events.push(storedEvent);
      superseded.push(storedEvent);
    }

    const result = snapshot({ created, superseded, conflicted });
    // 積んだことを名乗る（渡していない呼び出しでは付けない）。
    return buildCreatedEvent === undefined ? result : { ...result, createdEventsWritten: true };
  }

  /**
   * 期限切れの行を `events` 配列から消す本体。`purgeExpiredEvents` と `purgeExpiredEventsByRetention` が共有する。
   * 同期関数: `await` を挟まない（`purgeExpiredEventsByRetention` が「保持期間を読んでから消すまで」を同じ同期区間に閉じるための前提）。
   * `InMemoryEventStore` のメソッドは呼ばず、`events` 配列を直接操作する（`PostgresMemoryStore` も `PostgresEventStore` を経由しない）。
   * `kind = 'events_purged'` の行は対象から除外する（無限後退を避ける）。`dryRun` のときは `this.events` を変更しない。
   */
  private purgeExpiredEventsSync(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): PurgeExpiredEventsResult {
    assertQueryDate("purgeExpiredEvents", "olderThan", opts.olderThan);
    // 負数は一様に拒む: `slice` の負数は「末尾から数えた除外」になり、期限切れイベントのほぼ全件を静かに削除してしまう（delete の副作用を持つので実害が大きい）。
    // `limit: -1` だけは Postgres が例外にならず `{ purged: 0, reachedLimit: true }` を返し、一致しない。`LIMIT + 1` の窓を模してまで特別扱いする値打ちは無く、
    // 負数は「受け付けない値」で、結果が実装ごとに違ってよい（`PurgeExpiredEventsOptions.limit`）。整数でない値も別の例外で先に断る。
    const dryRun = opts.dryRun ?? false;
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeExpiredEvents: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeExpiredEvents: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
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

    // 削除。`victims` は `this.events` から探し出した同じ参照なので id で除く。
    const victimIds = new Set(victims.map((event) => event.id));
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (victimIds.has(this.events[i]!.id)) {
        this.events.splice(i, 1);
      }
    }

    // 削除と同じ同期区間で `events_purged` を積む（`await` を挟まないので、原子性を模せる）。
    const storedEvent = buildStoredMemoryEvent(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      // 日時は ISO 8601 の文字列で持つ（Postgres は meta を JSON で保存するので、読み戻すと文字列になる）。戻り値のほうは `Date` のまま。
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

  /** {@link InMemoryMemoryStore.purgeExpiredEventsSync} を呼ぶだけの async ラッパー。 */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    assertWellFormedCtx(ctx);
    return this.purgeExpiredEventsSync(ctx, opts);
  }

  /** `MemoryStore.purgeExpiredRecalls?` の in-memory 実装。対象の recall を先に確定し、その `recall_usages` を消してから recall を消す。1回の同期区間で終わる。 */
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

  /**
   * `MemoryStore.purgeExpiredEventsByRetention?` の in-memory 実装。保持期間を読んでから {@link InMemoryMemoryStore.purgeExpiredEventsSync} を呼ぶまで
   * `await` を挟まず、1つの同期区間にする（他の呼び出しが「読んだ」と「消す」の間に割り込めない）。
   */
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
   * `ready` を `failed` へ巻き戻さない（`PostgresMemoryStore.setEmbeddingStatus` の `AND embedding_status <> 'ready'` と同じ意味論）。
   * 禁じる遷移の判定は共有の {@link isEmbeddingStatusRollback} に固定する: 実装ごとに条件式を書き直すと、禁じる遷移が実装間でずれる。
   * 巻き戻しを例外にはしない: 唯一の `failed` の呼び出し口は `runtime.tick` の `catch` の中で、投げると元の埋め込みエラーが握り潰される。
   * no-op のまま現在の行を返す。`failed → ready` は妨げない。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // 対象が無いときの message は、Postgres と同じく渡された綴りのまま。
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

  /**
   * 減衰の起点を巻き戻さない（`PostgresMemoryStore.reinforce` の `COALESCE(last_reinforced_at, recorded_at) < ${at}` と同じ意味論）。
   * 起点 `lastReinforcedAt ?? recordedAt` より新しい `at` だけを書き（狭義の `<`。同じ `at` は no-op）、`lastReinforcedAt` と `decayFloorAt` を同じ条件で動かす。
   * 古い `at` は例外にせず、no-op のまま現在の行を返す。
   * `opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときに限り、活動時計側の起点・床（`decayBaseSeq`/`decayFloorSeq`）も同じ条件で進める。
   * `ReinforceOptions.addOwnSubjectSeq` を読める。
   */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // 対象が無いときの message は、Postgres と同じく渡された綴りのまま。
    const requestedId = id;
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    // Invalid Date の `at` は、Postgres がクエリ実行時に拒む。ここで検査しないと、下の no-op 判定の比較が `NaN` で常に `false` になって素通りし、`lastReinforcedAt`/`decayFloorAt` が Invalid Date のまま書かれて減衰計算が `NaN` を返し続ける。
    if (Number.isNaN(at.getTime())) {
      throw new Error(`reinforce: at must be a valid Date (got Invalid Date)`);
    }
    // 下限より前の `at` は、何も書かない呼び出し（下の no-op）でも Postgres が拒む。no-op の判定より前に見る。
    assertWrittenTimestamptzFloor("reinforce", "at", at);
    // `opts.nowSeq` は `bigint` 列へ書く値で、Postgres は整数でない・範囲外をクエリの時点で拒む。ただしこの Memory が `halfLifeRecalls` を持つときだけ（持たなければ `nowSeq` は使われない）。
    // no-op の呼び出しでも Postgres は同じ UPDATE 文を発行するので、no-op の判定より前に見る。負は、行を実際に書くときの CHECK 制約なので下で見る。
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      assertQueryBigint("reinforce", "nowSeq", opts.nowSeq);
    }
    // 起点（lastReinforcedAt ?? recordedAt）より新しい at のときだけ書く。それより前・ちょうどの at は、活動時計の欄も含めて何も書かない。
    if ((memory.lastReinforcedAt ?? memory.recordedAt).getTime() >= at.getTime()) {
      return snapshot(memory);
    }
    // 活動時計側に書く起点。何かを書き換える前に決めて検査する: 投げたときに、壁時計側の列だけが書き換わった状態を残さない。
    let activityBaseSeq: number | undefined;
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      // `addOwnSubjectSeq` が true なら、`nowSeq` に Memory 自身の subject の S_x を足す。
      activityBaseSeq =
        opts.addOwnSubjectSeq === true && memory.subjectId != null
          ? opts.nowSeq + (this.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
          : opts.nowSeq;
      // 書く値が負なら Postgres は CHECK 制約で拒む（何も書かない呼び出しでは効かない）。`addOwnSubjectSeq` のときは `nowSeq + S_x` が書く値なので、`nowSeq` が負でも `S_x` で 0 以上になれば通る。
      if (activityBaseSeq < 0) {
        throw new Error(`reinforce: decayBaseSeq must not be negative (got ${activityBaseSeq})`);
      }
      // `addOwnSubjectSeq` のとき、`nowSeq + S_x` と床のどちらかが 2^63 以上なら、Postgres は UPDATE ごと失敗する。ドライバが `nowSeq` を文字にした値で足すので、float64 ではなく BigInt で足す。
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

  /** `reinforce` を `ids` の各要素について順に呼ぶだけの素直な実装。往復を束ねる最適化は対象としない。 */
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

  /** `recordUsage` と `reinforceMany` を1つの口で撃つ。強化が投げたら、この呼び出しで挿入した使用の行を取り消す（in-memory にトランザクションは無い）。強化が投げうるのは `at` が Invalid Date のときだけで、全件共通なので1件目で何も書かずに投げる。 */
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
    // 外部キー相当: Postgres は全件を1文で書くので、1件でも違反すれば文全体が失敗する。ここも全件の存在を先に確かめてから挿入し、全体原子性を再現する。
    // ⚠ `memoryIds` が空配列なら Postgres はクエリを発行せず空の結果を返す（`recallId` の実在は問われない）ので、この早期リターンより後ろで検査する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    // recall も memory も `ctx` のテナントの行であること（`PostgresMemoryStore` と同じ順・同じ message）。
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

  /**
   * 単一集約（`ScopeAggregate`）。契約は「groups の総和が totalInScope と一致すること」で、同じ1回のループで両方を積み上げて保証する。
   * `opts.digestBand`: in-scope の Memory から `excludeMemoryIds` を除き、`(occurredAt ?? recordedAt)` の降順（同値なら `id` の降順）で `limit` 件まで返す
   * （`FakeMemoryStore.aggregateScope` と同じ意味論）。`digestEligible.count` は `limit` を掛ける前（除外後）の総数。
   */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    // 読みの口の日時は下限（4714-11-24 BC）より前でも断らず、そのまま比べる（Postgres は下限へ寄せるが答えは同じ）。Invalid Date だけ断る。
    assertQueryDate("aggregateScope", "occurredAfter", scope.occurredAfter);
    assertQueryDate("aggregateScope", "occurredBefore", scope.occurredBefore);
    assertQueryDate("aggregateScope", "validAt", scope.validAt);
    assertQueryDate("aggregateScope", "decayFloorAtAfter", scope.decayFloorAtAfter);
    // `decayFloorSeqAfter` は `bigint` の引数（範囲外なら、行が無くても Postgres はクエリの時点で拒む）。
    assertQueryBigint("aggregateScope", "decayFloorSeqAfter", scope.decayFloorSeqAfter);
    // `attributes`・`labels` の NUL は、Postgres がクエリの時点で拒む。ただし `scopeAggregate: "skip"` で `digestBand` も無いときは、Postgres はクエリを1本も発行しないので見ない。
    // `labels`・`taxonomyGroupCandidates` の孤立サロゲートは Postgres が U+FFFD に置き換える。保存側（`tags`）が置き換わっているので、引数側も同じにしないと一致しない。
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
    // 目次帯の候補: totalInScope に数える条件と同じ条件で集める。
    const inScopeMemories: Memory[] = [];
    // `"skip"` のときも、スコープ判定は今までどおり行い（`inScopeMemories` に要る）、件数の集計だけを止める。値だけ受け取って計算は今までどおり行う実装は禁止（`AggregateScopeOptions.scopeAggregate`）。
    const skipCounting = opts?.scopeAggregate === "skip";

    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) {
        continue;
      }
      // `includeSubjectless: true` のときだけ `subject_id IS NULL`（主題なし）も scope 内に含める。
      const subjectMatches =
        scope.subjectId === undefined ||
        memory.subjectId === scope.subjectId ||
        (scope.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // `attributes` はスコープの外側の境界: 落ちた分は `filtered*` のどの列にも数えず、`totalInScope` にも入れない。
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
      // validAt ゲート。両端 null は「いつでも真」。独立した2条件として数える（`validFrom > validUntil` の壊れたデータでも両方のカウンタに計上する）。`continue` で打ち切ると Postgres の独立集計と食い違う。
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
      // taxonomy ゲート。`attributes` と違い `period`/`validity` と同じ側: `totalInScope` から除かれ、`filtered*` に数えられる。
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
      // 忘却ゲートで落ちた件数。`continue` しない: 減衰しきった Memory も `totalInScope`・群カウント・目次帯から除かれない（述語は `isDecayedForScope`）。
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
      // digestBand の候補集めは "skip" でも続ける（目次帯は集計とは独立した経路）。
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

    // `scope.taxonomyGroupCandidates` が渡されたときだけ `axis: 'taxonomy'` の群を足す。カウント0のラベル・残差は載せない。
    // "skip" のときは taxonomy 群カウントも計算しない（`groups` は空のまま）。
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
      // 整数でない・負の `limit` は先に断る: `slice` の負数はスコープ内のほぼ全件の digest を静かに返し、`NaN`/`Infinity` は黙って別の値に丸められる。
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
      // `LIMIT` の bigint に収まらない値も Postgres は拒む。
      if (opts.digestBand.limit >= 2 ** 63) {
        throw new Error(
          `aggregateScope: digestBand.limit must fit in a Postgres bigint (got ${opts.digestBand.limit})`,
        );
      }
      const exclude = new Set(opts.digestBand.excludeMemoryIds.map(normId));
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順。
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      // "skip" では `totalInScope` を数えていないので、`eligibleMemories.length` も信じられない: `unknown`/`0` にする。`digests` 自体は `inScopeMemories` から正しく求まる。
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

  /** `record.advanceActivityClock === true` のとき `this.activitySeq` を `+1` する。行を作るのと同じ同期区間で行い、`createRecall` の「同一トランザクション」を模す。`false`/未指定なら一切触らない。 */
  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(record.subjectId, "record.subjectId");
    // 書き込む先の subject のカウンタも、書く前に断る。
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
      // 呼び手の Date を共有しない。
      createdAt: record.createdAt === undefined ? new Date() : snapshot(record.createdAt),
    });
    if (record.advanceActivityClock === true) {
      const current = this.activitySeq.get(ctx.tenantId) ?? 0;
      this.activitySeq.set(ctx.tenantId, current + 1);
    } else if (
      // `T` ではなく `S_x`（subject 単位）を進める。
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

  /** `createRecall` が書いた行を `recallId` から読み戻す。テナントが一致しない、または見つからなければ `null`。 */
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
      // この実装が保持する行は常に `createRecall` 経由で新規に書かれたものなので、`breakdownCaptured: true` で固定してよい。
      returnedMemories: { breakdownCaptured: true, memories: row.returnedMemories },
      createdAt: row.createdAt,
    });
  }

  /**
   * 索引に載っていない Memory を選んで `pending` へ戻し、`embed` の outbox 行を積み直す。
   * 更新と INSERT を同じ同期区間で行って「同一トランザクション」を模す。⚠ `for` の中に `await` を入れないこと（「更新だけ起きて INSERT が起きない」中間状態が観測される）。
   * `statuses` を `readonly EmbeddingStatus[]` へ受け直すのは、`NotIndexedReason` が `EmbeddingStatus` の部分集合であることを型で確かめるため。
   */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    // 整数でない・負の `limit` は先に断る: Postgres が負数を断るのは `LIMIT` が評価されるときだけ（対象の行が無く統計が古いと `never executed` で `{ requeued: 0 }` を返す）が、
    // この fixture は常に断る。検査せず `.slice(0, Math.max(0, opts.limit))` へ渡すと、`Infinity` は全件、`1.5` は1件の積み直しを書いてしまう。非整数を先に、次に負数を見る。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`requeueEmbedJobs: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`requeueEmbedJobs: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`requeueEmbedJobs: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // `writeOpts.now` は `timestamptz` の引数で、Postgres は対象の行が0件でも Invalid Date を拒む。ただし `memoryIds` が空配列のときは、クエリを発行せず `{ requeued: 0 }` を返すので見ない。
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

  /**
   * 掃引。`status = 'active'` の Memory を `opts.clock`（省略時 `'wall'`）で選び、`decayFloorAt` 昇順で `opts.limit` 件まで、`status='archived'` への更新と `kind='archived'` のイベント追記を1つの同期区間で行う。
   * `opts.clock` の分岐は `buildArchiveDecayedTargetSelect` と同じ形で、境界の非対称（ゲートは狭義 `>`、掃引は境界を含む `<=`）をそのまま写す。
   * `'either'` は AND（両方の軸で沈んでいるものだけ掃く。ゲートの OR とは逆向き）。`digestSnapshot` には更新前の `digest` を入れる。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    assertWellFormedCtx(ctx);
    assertQueryTimestamptz("archiveDecayed", "now", opts.now);
    // `nowSeq` は `bigint` の引数で、整数でない値も範囲外も、行が無くても Postgres は拒む。ただし `wall` は `nowSeq` を SQL に入れないので見ない。
    if ((opts.clock ?? "wall") !== "wall") {
      assertQueryBigint("archiveDecayed", "nowSeq", opts.nowSeq);
    }
    // 整数でない・負の `limit` は先に断る: Postgres が負数を断るのは `LIMIT` が評価されるときだけ（対象の行が無く統計が古いと `{ archived: [] }` を返す）が、この fixture は常に断る。
    // 検査せず `.slice(0, Math.max(0, opts.limit))` へ渡すと、`NaN` は0件、`Infinity` は全件になる。書き込みの副作用（`archived` への更新とイベント）を持つので、他の口より実害が大きい。非整数を先に、次に負数を見る。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`archiveDecayed: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`archiveDecayed: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`archiveDecayed: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    const nowMs = opts.now.getTime();
    const clock = opts.clock ?? "wall";
    const passesWall = (m: Memory): boolean => m.decayFloorAt.getTime() <= nowMs;
    // `usesSubjectActivityCounters` が true のときだけ、その Memory の subjectId に対応する `S_x` を足す。
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
      // `nowSeq + S_x` が `bigint` を溢れる行で式が評価されたなら、Postgres は失敗する（`decay_floor_seq` が非 NULL の行。subject なしの行は `S_x` を引かない）。
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

    // 並べる軸は、掃く軸に合わせる: `clock: 'activity'` では `decayFloorSeq` 昇順で選ぶ（`buildArchiveDecayedTargetSelect` と同じ規律）。
    // 返り値 `archived` の並び順の契約は変えず、下で `decayFloorAt` 昇順に並べ直す。変わるのは `limit` が効くときにどの行を選ぶかだけ。`'either'` は壁時計のまま。
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
    // 返る並びは、選び方が clock で変わっても常に `decayFloorAt` 昇順（`ORDER BY decay_floor_at ASC, id ASC` と同じ）。
    archived.sort(
      (a, b) =>
        a.decayFloorAt.getTime() - b.decayFloorAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return { archived, reachedLimit: opts.limit > 0 && archived.length === opts.limit };
  }

  /**
   * `forgotten` かつ未 purge（`purgedAt === null`）の Memory だけを対象にした CAS。`content`/`digest` をトゥームストーンで上書きし `purgedAt` を設定して、`kind: 'purged'` のイベントを積む。
   * `status` は動かさない。条件を満たさなければ {@link MemoryPurgeConflictError} を投げる（まだ何も書いていないうちに判定する）。
   * `tags`/`attributes`/`claimKey` を空にし、label の紐付けを外して `proposedCount` を減らし、このテナントの `recalls` の `indexBand.digestBand` から該当 `memoryId` の `digest` を書き換える（`packages/postgres` の `purgeMemory` と同じ範囲）。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // 墓石の `content`・`digest` は `text` 列へ書く値で、Postgres は対象の行が無くても・CAS に弾かれる状態でも、同じ UPDATE 文の引数として NUL を拒む。行を引く前に見る。
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
    // `purged_at`・`memory_events.at` に入る `event.at` が下限より前なら、Postgres は CAS に弾かれる状態の行でも拒む。行を引く前に見る。
    assertWrittenTimestamptzFloor("memory_events", "at", event.at);
    // 墓石は `text` 列へ書く値なので、孤立サロゲートは U+FFFD に置き換えて保存する。
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
    // イベントが指す記憶は `ctx` のテナントの行（墓石を書く前に確かめる）。
    this.assertEventTargetOwn(ctx, event.memoryId, [id]);
    // `purgedAt` と `memory_events.at` を同じ値にする: 省略時も壁時計を2回読んで別の値にならないよう、一度だけ決める。呼び手の `event.at` と共有しない。
    const at = event.at === undefined ? new Date() : snapshot(event.at);
    memory.content = tombstone.content;
    memory.digest = tombstone.digest;
    memory.tags = [];
    memory.attributes = {};
    memory.claimKey = null;
    memory.purgedAt = at;
    memory.updatedAt = new Date();

    // label の紐付けを外し、proposed な label の proposedCount を減らす。
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

    // このテナントの `recalls.index_band` の digestBand から、この memoryId のエントリをトゥームストーンへ書き換える。`recalls.query` は `memoryId` で特定できないので触らない。
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

  /**
   * `packages/postgres` の `scrubPurged` と同じ契約。`forgotten` かつ `purgedAt` が非 `null` の行だけを対象に、`tags`・`attributes`・`claimKey` を空にし、label の紐付けを外して `proposedCount` を外した本数だけ減らす。
   * 残骸の無い行は書き換えない（`updatedAt` も動かさない）。`recalls.indexBand.digestBand` の、この行のエントリの digest も行の `digest` へ伏せる。同期区間で完結するので、同時呼び出しでも二重には数えない。
   */
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
      // このテナントの `recalls.indexBand.digestBand` の、この行のエントリを、行の digest（トゥームストーン）へ伏せる（truncated は落とす。同じ digest のエントリは書き換えない）。
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

  /**
   * 両側とも `status === 'active'` の CAS を課したうえで、`status='contested'`・`contestedWithId` を相互に設定する。
   * in-memory にトランザクションは無いので、存在確認・CAS 判定の両方を先に済ませ、どちらか一方でも失敗したら何も書き換えずに throw して、ロールバックを模す。
   * CAS の失敗（どちらかが `"active"` でない）は {@link MemoryStatusConflictError}。
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
    // 2つのイベントが指す記憶は、`ctx` のテナントの行（この呼び出しで更新する2行を含む）。
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

  /**
   * `markContestedPair` の解決側。両側とも `status === 'contested'` かつ相互参照が成立していることを CAS で課したうえで、`contestedWithId` を両側とも `null` に戻し、指定された `status`（`'active'`/`'superseded'`）へ更新する。
   * `markContestedPair` と同じく、何も書き換える前に判定する。CAS の失敗（どちらかが `"contested"` でない・相互参照が成り立っていない）は {@link MemoryStatusConflictError}。
   */
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
    // 型の外の status は、書く前に断る（`PostgresMemoryStore` と同じ位置・同じ文面）。
    assertResolvedStatus("resolveContestedPair", "first", first.status);
    assertResolvedStatus("resolveContestedPair", "second", second.status);
    // 置き換えた側を伴わない superseded・自己置換・active への supersededById・互いを指す循環は、書く前に断る。
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
    // 対の外の `forgotten` な記憶を置き換えた側にしない。対の相手を指すのは断らない。
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

  /** `MemoryStore.markContestedGroup?` の実装。`markContestedPair` と同じく、全員の存在確認・CAS 判定を先に済ませ、1件でも失敗したら何も書き換えずに throw する。 */
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

    // 呼び出し時点で既に contested かつ contestedWithId が無いメンバー（既存の群のメンバーを吸収する場合）は、書いても状態が変わらないので `updated` を積まない。
    const unchanged = memories.map(
      (memory) => memory.status === "contested" && (memory.contestedWithId ?? null) === null,
    );
    // イベントを積むメンバーだけ、そのイベントが指す記憶が `ctx` のテナントの行かを確かめる（`PostgresMemoryStore` と同じ）。書き換える前に。
    members.forEach((m, i) => {
      if (!unchanged[i]) this.assertEventTargetOwn(ctx, m.event.memoryId, ids);
    });
    for (const memory of memories) {
      memory.status = "contested";
      memory.contestedWithId = null;
      memory.updatedAt = new Date();
    }

    // 有効期間が重なる組だけに関係の行を張る。
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

  /** `markContestedGroup`/`resolveContestedGroup` が使う内部ヘルパー。双方向2行を冪等に足す。 */
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

  /** `MemoryStore.resolveContestedGroup?` の実装。決着の種類に関わらず、このメンバー全員を結んでいた関係の行を消す（`resolveContestedPair` と同じ扱い）。 */
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

    // `members` が、関係の行でつながった「今も contested な」群の全員と一致することを CAS で課す（`PostgresMemoryStore.resolveContestedGroup` と同じ）。forget 等で抜けたメンバーは `contested` でなくなっているので、この到達集合には入らない。
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

  /** `resolveContestedPair` の解決側 CAS を満たせなくなった生存側1件だけを対象にした任意メソッド。対向の行には一切触れない。CAS の失敗（`"contested"` でない・対向が渡された値と違う）は {@link MemoryStatusConflictError}。 */
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

  /** `MemoryStore.findActiveByClaimKey?` の実装。`subjectId` は `null` 同士も一致・`claimKey` は正規化済み文字列のまま等値比較・`status === "active"`・`contentHash` が違う、に加え、有効期間の重なりを判定する。LLM は呼ばない。 */
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
    // 検索値の孤立サロゲートも、Postgres では U+FFFD に置き換わって比べられる。
    query = { ...query, claimKey: replaceLoneSurrogatesInClaimKey(query.claimKey) };
    // 読みの口の日時は下限より前でも断らず、そのまま比べる（Postgres は下限へ寄せるが答えは同じ）。Invalid Date だけ断る。空の区間かどうかも、寄せずに元の値で決める。
    assertQueryDate("findActiveByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findActiveByClaimKey", "validUntil", query.validUntil);
    // 検索値の NUL は、Postgres がクエリの時点で拒む。
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
      // 保存側の `contentHash` は置き換え済み。Postgres は引数も U+FFFD にしてから比べるので、揃える。
      if (m.contentHash === replaceLoneSurrogates(query.contentHash)) return false;
      // 半開区間 [validFrom, validUntil) の重なり判定。`null` は -∞/+∞ として扱う。
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      // 空の区間・逆転した区間（`from >= until`）は点を1つも含まないので、何とも重ならない。
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

  /** `MemoryStore.findContestedByClaimKey?` の実装。`findActiveByClaimKey` と同じ絞り込みで、`status === "contested"` を見る。 */
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
    // 日時の扱いは `findActiveByClaimKey` と同じ。
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

  /** `MemoryStore.listActiveClaimPredicates?` の実装。`subjectId` は `null` 同士も一致・`status === "active"`・`claimKey` を持つ行のみ、のうえで predicate ごとに最も新しい `createdAt` を代表値にして降順ソートし、`limit` 件まで返す。 */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    // 整数でない・負の `limit` は先に断る: 検査せず `slice(0, limit)` へ渡すと、Postgres と違う件数を黙って返す。
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
      // 主語か述語の片方が欠けた claim key は数えない（`undefined` を一覧に混ぜない）。
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
        // 同着は predicate のコードポイント順（UTF-8 のバイト順と一致する。JS の `<` は UTF-16 コード単位順で食い違う）。
        .sort((a, b) => b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
        .slice(0, query.limit)
        .map(([predicate]) => predicate)
    );
  }

  /**
   * `superseded → active`。選定・更新・イベント追記を `await` を挟まない同期区間で行い、Postgres の単一トランザクションを模す。
   * `filter?.onlyMemoryIds` を指定すると、選定条件に `onlyMemoryIds.includes(m.id)` を積集合として足す（`AND id = ANY(...)` と同じ）。
   */
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
    // 1件目を書き換える前に、書くイベントが書けるかを確かめる（`at` の Invalid Date・`actor` の structuredClone できない値）。ループの中で初めて投げると、先の行だけが戻ってイベントの無い半端な状態が残る（Postgres は1文で巻き戻る）。
    // 対象が無いときは確かめない（投げる入力を増やさない）。
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
      // 下限より前の `at` は、対象が1件も無くても Postgres が拒む。
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

  /**
   * `restoreSupersededBy` を実際に呼ぶ前に見るための読み取り専用の口。対象の選び方は `restoreSupersededBy` と同じ `filter`（`onlyMemoryIds` を含む）を使う。
   * `this.events` から、対象ごとに直近の `kind: 'superseded'` イベントを探して `meta.reason` を運ぶ（見つからなければ `null`）。書き込みは一切行わない。
   */
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

  /** `listLabels?`。`name` の並び順は、`localeCompare`（ロケール依存の自然順）ではなく、コードポイント順（Postgres の `COLLATE "C"` と同じバイト順）。 */
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
    // `text` 列なので、孤立サロゲートは U+FFFD に置き換えて保存する。
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

  /**
   * このテナントに属する行を、`memory_labels`・`recall_usages`・`memory_events` → `memories`（+ 冪等キー）→ `observations` → `recalls` → `labels` → `tenant_activity`・`tenant_subject_activity` の順で消す（`PostgresMemoryStore.eraseTenant` と同じ並び）。
   * 外部キー制約を持たないので、`blocked_by_foreign_reference` は返さない。消した `memories` の埋め込みは `InMemoryVectorStore` が一緒に消す（件数には数えない）。
   * `reachedLimit` は `PostgresMemoryStore.eraseTenant` と同じ「保守的な近似」（ちょうど budget 分だけ削除できたら、残りを確認せず `true`）。
   */
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
    // `labels`/`memoryLabels` は key 自体が `JSON.stringify([tenantId, ...])` で、value に `tenantId` を持たないので、key から読む。
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
      // 前方一致ではなく、鍵から取り出した tenantId の完全一致（`acme` を消しても `acme:eu` は残す）。
      () => drainSet(this.usages, (key) => tenantOfUsageKey(key) === ctx.tenantId),
      () => drainArray(this.events, (event) => event.tenantId),
      () => drainArray(this.relations, (relation) => relation.tenantId),
      // `extractionIndex` の掃除と、消した memories の埋め込み（listener 経由）は、budget にも `deleted` にも数えない（見えない内部索引・`ON DELETE CASCADE` に当たる）。
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
      // `(tenant_id, subject_id)` が主キー: 内側の `Map<subjectId, seq>` の1エントリを1行として数える。
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
        // budget をちょうど使い切ったら、保守的に「まだ残っているかもしれない」とみなす。
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
    // 区切り文字で繋がず、`JSON.stringify` の配列で表す: `tenantId`・`extractorVersion`・`contentHash` は `:` を含みうるので、繋ぐと別の組と同じキーになる。
    return JSON.stringify([tenantId, sourceObservationId, extractorVersion, contentHash]);
  }
}
