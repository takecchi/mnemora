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

/**
 * ADR 0499（ADR 0447 の材料）: `expectedStatus` を渡された status 更新の CAS が破れるか。**purge 済みの行（`purgedAt` が
 * 非 null。`status` は `forgotten` のまま）は、どの `expectedStatus` にも一致しない**（`PostgresMemoryStore` の
 * `expectedStatusCondition` と同じ。`Runtime.purge` の「不可逆」の約束）。
 */
function casMismatch(
  memory: { status: MemoryStatus; purgedAt?: Date | null | undefined },
  expectedStatus: MemoryStatus,
): boolean {
  return memory.status !== expectedStatus || (memory.purgedAt ?? null) !== null;
}

/**
 * ADR 0499（ADR 0450 の材料）: `resolveContestedPair`・`resolveContestedGroup` の `status` は型が `"active" | "superseded"`。
 * 型の外の値は、書く前に `RangeError` で断る（`PostgresMemoryStore` と同じ文面。値は message に入れない）。
 */
function assertResolvedStatus(method: string, field: string, status: unknown): void {
  if (status !== "active" && status !== "superseded") {
    throw new RangeError(`${method}: ${field}.status must be "active" or "superseded"`);
  }
}

/**
 * ADR 0503（ADR 0447 材料3〜5・ADR 0450 材料1・2）: `status: "superseded"` の更新は、置き換えた側（`supersededById`）を
 * 必ず伴い、それは自分自身でないこと。`resolveContested*` の `"active"` に `supersededById` を付けることも断る
 * （active なのに `superseded_by_id` が残る行になる）。書く前に `RangeError` で断る（値は message に入れない）。
 * `PostgresMemoryStore` と同じ文面。
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
    // Postgres は `normalizeUuidCase` で両側を畳んで比べる。呼び出し側は id だけ畳むので、ここで両側を畳む。
    if (normId(supersededById) === normId(selfId)) {
      throw new RangeError(`${method}: ${field}.supersededById must not be the memory itself`);
    }
  } else if (opts.forbidWhenNotSuperseded && supersededById !== undefined) {
    throw new RangeError(
      `${method}: ${field}.supersededById must not be set unless status is "superseded"`,
    );
  }
}

/**
 * ADR 0503: `supersededById` の鎖が、同じ呼び出しで `superseded` になるメンバーの中で輪になっていないこと
 * （2者版の「互いを指す」、群版の A→B→A など）。輪になっていれば `RangeError`。
 */
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

/**
 * Issue #1108: `MemoryStore` の口が返す値（Memory と、それを含む返り値のオブジェクト）を、
 * **返す時点の複製**にする。以前は内部に持っている Memory の実体そのものを返していたため、
 * 呼び手が一度受け取った値が後の別の操作で遡って変わり、呼び手が受け取った値を書き換えると
 * store の中身まで変わった。Postgres は毎回行を読み直した新しいオブジェクトを返すので、
 * それに揃える（fixture は Postgres の振る舞いを写すためのもの）。
 * 歯は `__tests__/in-memory-return-snapshots.test.ts`（返す口の一覧を1本ずつ見る）。
 */
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Issue #207/#933 PR2（ADR 0381）: `memory_relations` の1行相当。
 * `InMemoryMemoryStore.relations`（`markContestedGroup`/`resolveContestedGroup` が
 * 書く）と `InMemoryRelationStore`（`in-memory-relation-store.ts`、読み取る）が
 * 共有する内部形。
 */
export interface StoredRelation {
  id: string;
  tenantId: string;
  fromMemoryId: MemoryId;
  toMemoryId: MemoryId;
  kind: RelationKind;
  createdAt: Date;
}

/**
 * `createRecall` で、Postgres が `recalls` の行を書けずに拒む入力を先に検査する（何も書かず、
 * 活動時計も進めない）。`subjectId` は `text` 列（NUL を拒む）。`query`・`omitted`・`usage`・
 * `indexBand`・`explain`・`returnedMemories` は `NOT NULL` の `jsonb` 列、`budget` は `jsonb` 列で、
 * `packages/postgres` は `JSON.stringify` した値を送る——NUL を含めば拒み（`unsupported Unicode escape
 * sequence`）、JSON にならない値（`undefined` など）は `NOT NULL` の列で拒む。
 */
function assertRecallRecordStorable(record: NewRecallRecord): void {
  // `created_at` は `timestamptz`——Invalid Date は Postgres が書けずに拒む（ADR 0480）。省略は壁時計を使うので検査しない。
  if (record.createdAt != null && Number.isNaN(record.createdAt.getTime())) {
    throw new Error("createRecall: createdAt must be a valid Date (got Invalid Date)");
  }
  // ADR 0640: 下限より前は、Postgres が `22008` で書けずに拒む。
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
 * outbox の行を**実際に書く**ときに Postgres が拒む入力（ADR 0434）を、何も書く前に検査する。
 * `jobKinds` の要素は `outbox.kind`（`text` 列）に入るので NUL を拒み、`now` は `available_at`・`created_at`
 * （`timestamptz`）に入るので Invalid Date を拒む（`22021`・`22007`）。`claimedBy`（`createObservationWithOutbox` の
 * `opts`。`outbox.claimed_by` は `text` 列）も NUL を拒む（ADR 0493）。**行を書かないときは拒まない**——
 * `jobKinds` が空・冪等の既存の行が在って新しい行を作らないとき、Postgres は outbox へ INSERT せず、
 * どちらも値を見ない（実測）。呼び出し側は、新しい行を実際に作る分岐の中（`beforeInsert`）で呼ぶ。
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
  // ADR 0493: `claimedBy`（`createObservationWithOutbox` の `opts`）は `outbox.claimed_by`（`text` 列）に入るので NUL を拒む。
  if (stringHasNul(claimedBy)) {
    throw new Error(`${method}: claimedBy must not contain NUL characters (U+0000)`);
  }
}

/**
 * ADR 0486: Observation の `payload` を、Postgres が `JSON.stringify` して `jsonb` に入れるときの規則のうち、
 * `structuredClone` が断る値（関数・`Symbol`）と `toJSON` だけを先に当てる。残りの値（`NaN`・`-0`・`Date`・値が
 * `undefined` の欄など）は、`ObserveEventInput.data` の TSDoc の表どおり、fixture はそのまま保持する。
 * - `toJSON` を持つ値（`Date` を除く。`Date` は表どおり `Date` のまま保つ）→ `toJSON(欄の名前)` の戻り値に置き換える
 *   （戻り値にも同じ規則を当てる。`data` 自体が持てば、object でない値になる）。
 * - 関数・`Symbol` → 欄の値なら欄ごと消す、配列の要素なら `null`（`JSON.stringify` と同じ）。
 * 入力は書き換えない（新しい値を返す）。循環参照・`BigInt` は、先に `jsonContainsNul` が `JSON.stringify` で断る。
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
    return current; // Map・Set・型付き配列・クラスのインスタンスなどは、これまでどおり structuredClone に任せる。
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
 * Observation を書く口で、Postgres が `timestamptz` への変換で拒む Invalid Date（`.getTime()` が `NaN`）を先に
 * 検査する（`invalid input syntax for type timestamp with time zone`、`22007`。Issue #807 の Memory 側と同じ根）。
 * 省略（`undefined`/`null`）は「無い」であって Invalid Date ではないので検査しない。上の NUL の検査と同じく、
 * Postgres は `externalId` の衝突を見る前に拒むので、冪等の判定より前に見る。
 */
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
    // ADR 0640: 下限より前は、Postgres が `22008` で書けずに拒む（冪等の既存の行が在っても、衝突を見る前に拒む。実測）。
    assertWrittenTimestamptzFloor(owner, field, value);
  }
}

/**
 * `MemoryStore` のインメモリ・プレースホルダ実装。
 *
 * **本番用途ではない。** `packages/testkit` の適合テストが実際に実行できることを示す
 * ためだけの最小実装であり、`packages/postgres`（段階2）が実装すべき振る舞いの
 * 完全な参照ではない。特に索引・永続化・トランザクションは一切模していない。
 *
 * roadmap.md 段階3で `outboxJobs` を公開した。`InMemoryOutboxStore`
 * （`./in-memory-outbox-store.js`）にこの配列をそのまま渡すことで、`createObservationWithOutbox` /
 * `createMemoryWithOutbox` が積んだジョブを `OutboxStore` 側から claim/complete/fail できる
 * （`packages/postgres` が同一 DB・同一トランザクションで両方を実装するのと対応する、
 * ADR 0005・0003）。
 *
 * ADR 0031 で `events` を同じ理由で公開した。`InMemoryEventStore`
 * （`./in-memory-event-store.js`）のコンストラクタにこの配列をそのまま渡すことで、
 * `updateStatusWithEvent` が積んだイベントを `EventStore` 側からも `get`/`list` できる。
 */
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
  // ADR 0353（Issue #338）: このテナントの subject 単位カウンタ（`tenantId` を
  // 引いた後の `Map<subjectId, S_x>`）。`scope.decayFloorSeqUsesSubjectCounters` が
  // true のときだけ参照する。
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
  // ADR 0505: `decayFloorSeqAfter + S_x` が `bigint` を溢れるとき、Postgres は `22003` で文ごと失敗する。失敗するのは、
  // その式が評価されるときだけ（実測）: `decay_floor_seq` が非 NULL（`IS NULL OR …` の短絡）で、subject を持つ行
  // （`S_x` を引く）。2軸のときは壁時計が左なので、既定（`NOT wall OR NOT activity`）は壁時計が生きているとき、
  // `decayFloorAnyAxis`（`NOT wall AND NOT activity`）は壁時計が生きていないときだけ、活動時計の式まで行く。
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
 * Issue #881 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md) 追記
 * （2026-09-26、クローン miku の判断）: `listLabels?` の `name` 昇順を**コードポイント順**
 * （Postgres の `COLLATE "C"` と同じ、バイト順）と定めた。この比較関数はそれを実装する。
 *
 * **文字列同士を素の `<`/`>` で比較しない。**JS の `<`/`>` は UTF-16 コード単位を比較する
 * ため、サロゲートペア（U+10000 以上、絵文字など）を含む名前では、サロゲート自体の値
 * （U+D800〜U+DFFF）が U+E000〜U+FFFF の BMP 文字より小さいコード単位として並んでしまい、
 * 実際のコードポイント順と食い違う（追記2、2026-09-26。`"！"` U+FF01 と `"😀"` U+1F600 の
 * ペアで実際に踏んだ——素の `<` だと `"😀"` が先に来るが、コードポイント順は `"！"` が先）。
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
 * `memories` の1行として書ける値かを確かめる（Postgres が拒む入力を、同じ入力で拒む）。`createMemory` 系の
 * 共通の入口（`createMemoryIdempotent`）が、冪等の衝突の判定より前に呼ぶ。モジュールの外へは出さない
 * （`.d.ts` に出ないので、公開の型の面は変わらない）。
 */
function assertStorableNewMemory(input: NewMemory): void {
  // 値域（ADR 0078）: `packages/postgres` は `memories_strength_range` の CHECK 制約で
  // これを強制する。外部キー相当の検査（`createMemoryIdempotent` の中）と同じ理由（ADR 0047）——ここで放置すると
  // 「本番では落ちる書き込みが手元では黙って成功する」。
  if (!isStrengthInRange(input.strength)) {
    throw new Error(
      `InMemoryMemoryStore: strength out of range (0, ${MAX_STRENGTH}]: ${input.strength}`,
    );
  }
  // 値域（ADR 0125）: `packages/postgres` は `memories_half_life_range` の CHECK 制約で
  // これを強制する。`decay`/`freshness` は `elapsedHours / halfLifeHours` として
  // この値で割るため、`0`・負・`NaN`・`Infinity` は決して通してはならない
  // （Issue #231。`isHalfLifeHoursInRange` の doc に実測を記録した）。
  if (!isHalfLifeHoursInRange(input.halfLifeHours)) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours out of range (0, ∞): ${input.halfLifeHours}`,
    );
  }
  // Issue #817（PR #815 と同根）: `memories.half_life_hours` は Postgres の `real`
  // （IEEE 754 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い
  // （`migrations/0012_half_life_hours_range.sql` の CHECK 制約）。上の
  // `isHalfLifeHoursInRange` は float64 の `(0, ∞)` しか見ないため、float64 では有限
  // だが float4 の範囲を超える値（例: `1e300`）を通してしまう——`real` へ変換される際に
  // `Infinity` へ丸まり CHECK 制約に抵触して Postgres は例外を投げる（実測）。
  // `Math.fround` は JS の number を float4 と同じビット幅へ丸める標準関数であり、
  // その丸めで `Infinity` になるかどうかは Postgres の `real` 変換が overflow するか
  // どうかとビット単位で一致する（`setDefaultHalfLifeRecalls`、PR #815 と同じ判定）。
  //
  // ⚠ **上側については**、`strength` は同じ `real` 列だが、値域が `(0, MAX_STRENGTH]`（`MAX_STRENGTH` は
  // 上の `isStrengthInRange` が使う定数、`packages/core/src/memory.ts`）であり
  // float4 の範囲へ遠く届かない——`isStrengthInRange` の時点で `1e300` のような値は
  // 既に拒まれている（実測。float4 オーバーフローに到達する前に別の理由で例外になる）
  // ため、`strength` にはこの検査を足さない。
  if (!Number.isFinite(Math.fround(input.halfLifeHours))) {
    throw new Error(
      `InMemoryMemoryStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${input.halfLifeHours})`,
    );
  }
  // 下側（アンダーフロー）: Postgres の `real` は、0 でない値が float4 で 0 に丸まるときも
  // `"…" is out of range for type real` で拒む（実測: `halfLifeHours: 1e-300`・`strength: 1e-46`
  // は拒み、`strength: 1e-45`＝float4 の非正規数に収まる値は受け付ける）。境界は
  // 「`Math.fround(x)` が 0 になるか」とビット単位で一致する（上の上側の検査と同じ形）。
  // `strength` も同じ `real` 列なので、値域 `(0, MAX_STRENGTH]` の中の値でもここに当たる
  // ——上側（`1e300`）が値域の検査で先に拒まれるのとは違い、下側は値域の中に在る。
  // `0` そのものは「0 に丸まった」のではないので、ここでは見ない（値域の検査の担当）。
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
  // Issue #807: `recordedAt`（必須）/`occurredAt`/`validFrom`/`validUntil`
  // （省略可能）はすべて Postgres の `timestamptz` 列に書き込まれる。Invalid Date
  // （`.getTime()` が `NaN`）を渡すと `PostgresMemoryStore.createMemory` はクエリ実行時に
  // `invalid input syntax for type timestamp with time zone` で例外を投げる（実測。
  // `reinforce`—同じ Issue—と同じ根本原因）。省略可能な3つは値が渡されたときだけ
  // 検査する（既定値 `null`/`undefined` は「無い」であって Invalid Date ではない）。
  // ADR 0493: `decayFloorAt`（必須）・`lastReinforcedAt`（省略可能）も同じ `timestamptz` 列で、同じく検査する（下）。
  // #1183 の外側の CHECK 制約（Postgres の `memories_check`）: 由来が `stated`/`inferred` なら、その元の観測が要る。
  if (
    (input.provenance.kind === "stated" || input.provenance.kind === "inferred") &&
    input.sourceObservationId == null
  ) {
    throw new Error(
      `InMemoryMemoryStore: provenance.kind "${input.provenance.kind}" requires sourceObservationId`,
    );
  }
  // 活動時計の起点と床（ADR 0165）: Postgres は `bigint` 列で、`memories_decay_seq_non_negative` が負を拒む。
  // 省略（`null`/`undefined`）は「この軸には床が無い」であり、検査しない。
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
  // 活動時計の半減期: 値域は `halfLifeHours` と同じ `(0, ∞)`（`memories_half_life_recalls_range`、ADR 0125）で、
  // `real`（float4）列に収まる必要がある（上の `halfLifeHours` と同じ判定）。省略は検査しない。
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
  // ADR 0493: `decayFloorAt`（必須）・`lastReinforcedAt`（省略可）も `timestamptz` 列。Postgres は Invalid Date を拒む。
  // Issue #1759: `decay_floor_at` は NOT NULL で、Postgres は `null`・`undefined`・キーなしを `23502` で拒む（冪等の既存の行が
  // 在っても。実測）。fixture も書く前に断る。例外の顔は揃えない（ADR 0640 の前例。型の誤りなので `TypeError`、ADR 0525）。
  // 以前は型の外の `null` を通していた（ADR 0493）。
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
  // ADR 0640: 上の6欄は、下限（4714-11-24 BC 00:00:00 UTC）より前を Postgres が `22008` で書けずに拒む（実測。冪等の既存の行が在っても拒む）。
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
  // Issue #816（NUL 側。孤立サロゲート側はここでは扱わない）: Postgres の `text` 型は
  // NUL バイト（`\u0000`）を構造的に拒む（C 文字列表現に由来する制約）。
  // `PostgresMemoryStore.createMemory` は `content`/`subjectId`/`tags`（各要素）/
  // `digest` のいずれに NUL を含む文字列を渡しても `invalid byte sequence for
  // encoding "UTF8": 0x00` で例外を投げる（実測。4欄とも同じメッセージ）。
  // PR #923 の時点ではこの検査を `content` だけに絞っていた（同 PR のコメント）が、
  // 実測するとこの4欄は対称な入力面だったため、本 PR（Issue #816 の残り）で揃えた。
  //
  // ⚠ `tenantId` はここに含めない——`ctx.tenantId` は `createMemory` 以外の
  // ほぼ全メソッドが個別に直接読む横断的な値であり、`InMemoryMemoryStore`/
  // `FakeMemoryStore` のどちらも `ctx` を受ける共通の入口を持たない。ここで検査を
  // 足しても `get`/`reinforce` 等の他メソッドでは素通りのままで一貫せず、全メソッドへ
  // 検査を広げる横展開は本 PR の範囲を超えるため扱わない（実測: `tenantId` に NUL を
  // 含めても Postgres は同じ理由で例外を投げる。Issue #816 本文と同じ）。
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
  // 穴 O-6-3（ADR 0424）: `content_hash` も `text` 列——Postgres は NUL を拒む。以前ここだけ検査が無く、
  // インメモリは NUL 入りの contentHash を保存していた。
  if (input.contentHash.includes("\u0000")) {
    throw new Error(`InMemoryMemoryStore: contentHash must not contain NUL characters (U+0000)`);
  }
  // `extractor_version`・`claim_key_subject`・`claim_key_predicate` も `text` 列で、Postgres は NUL を拒む
  // （ADR 0434、実測。`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・
  // `createMemoriesWithOutboxAndEvents` のどれでも、冪等の既存の行が在っても拒む）。
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
  // `attributes`・`provenance` は `jsonb` 列。Postgres は NUL を `unsupported Unicode
  // escape sequence` で拒む（実測。`jsonContainsNul` の doc コメント参照）。
  if (jsonContainsNul(input.attributes ?? {})) {
    throw new Error(`InMemoryMemoryStore: attributes must not contain NUL characters (U+0000)`);
  }
  if (jsonContainsNul(input.provenance)) {
    throw new Error(`InMemoryMemoryStore: provenance must not contain NUL characters (U+0000)`);
  }
  // 列挙の列（型の列挙に無い値）: Postgres は CHECK 制約で拒む（`memory-enum-check.ts`）。
  // `status` は省略すると `active` になるので、省略は検査しない。
  if (input.status !== undefined) assertStorableMemoryColumn("status", input.status);
  assertStorableMemoryColumn("digest_source", input.digestSource);
  assertStorableMemoryColumn("embedding_status", input.embeddingStatus);
  assertStorableMemoryColumn("provenance_kind", input.provenance.kind);
  // ADR 0630: 書いたら読み戻したときに `MemorySchema` を通らなくなる値（`digest`・`contentHash`・`extractorVersion` の空文字、
  // `claimKey`・`attributes`・`provenance` の中身の欠け・値域外）も断る。上の検査（NUL・列挙）の後に置く——それらが先に断る入力の
  // 文面を変えない。`@mnemora/postgres`・core の Fake と同じ検査（`assertWellFormedNewMemory`）。
  assertWellFormedNewMemory("InMemoryMemoryStore", input);
  // 孤立サロゲート（Issue #816、実測）: この関数は検査しない。`text` 列の欄の孤立サロゲートは、ADR 0543 から
  // `createMemoryIdempotent` の入口で U+FFFD に置き換えて保存する（`PostgresMemoryStore` と同じ。以前は入力をそのまま保持していた）。
  // `jsonb` 列の欄（`attributes`・`provenance`）は、今も置き換えも拒みもしない（Postgres は拒む。ADR 0543 の対象外）。
}

/**
 * `MemoryStore` のインメモリ実装（`@mnemora/testkit/fixtures`）。適合スイートと単体テストの入力に使う。
 * 契約は `@mnemora/core` の `MemoryStore` の各メソッドの doc が正で、Postgres が拒む値はこの fixture も拒む
 * （列挙に無い値・NUL・値域の外の数など）。拒むときは何も書かない。
 *
 * status を書く口が投げる名前の付いたエラー（`MemoryStatusConflictError`・`ContestedWithoutCompanionError`）は、
 * 各メソッドの doc に書いてある。
 */
/**
 * ADR 0521: 操作の対象の id を小文字にそろえる（`@mnemora/postgres` は uuid 型の列で比べる・入口で
 * `normalizeUuidCase` を掛けるので、大文字の uuid を同じ記憶として受ける）。この fixture の id は小文字の
 * `mem-N` だけなので、小文字にそろえても別の id と混ざらない。
 */
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

/**
 * ADR 0604: `recall_usages` の鍵 `${tenantId}:${recallId}:${memoryId}` から tenantId を取り出す。
 * tenantId は `:` を含んでよい不透明な文字列なので、前から切らずに後ろの2つの `:` を外す
 * （`recallId`・`memoryId` は uuid で `:` を含まない）。Postgres は `tenant_id` の列で比べる。
 */
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
  /**
   * roadmap.md 段階4/5: recall 段6（記録）が書き込む `recalls` 相当のインメモリ表。
   * Issue #298 / ADR 0155: `createdAt` を足した——`getRecall`（`RecallRecord`）が
   * 返す形と1対1にするため。この in-memory 実装が保持する行は常に
   * `createRecall` 経由で新規に書かれたものであり、マイグレーション以前の
   * 「内訳を持たない」行という状態は存在しない（`breakdownCaptured` は
   * `getRecall` で常に `true` に組み立てる）。
   */
  readonly recalls = new Map<string, NewRecallRecord & { tenantId: string; createdAt: Date }>();
  /** `InMemoryEventStore` と共有する memory_events 相当の配列（ADR 0031、同一プロセス内の参照共有）。 */
  readonly events: MemoryEvent[] = [];
  /** `InMemoryOutboxStore` と共有する outbox ジョブの配列（同一プロセス内の参照共有）。 */
  readonly outboxJobs: OutboxJobRecord[] = [];
  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5
   * （Issue #305）: `tenant_activity` 相当のテナントごとの活動カウンタ。
   * `InMemoryTenantSettingsStore` にこの Map をそのまま渡すことで、`createRecall`
   * （書く側）と `getActivitySeq`（読む側）が同じ値を見る——`outboxJobs`/`events` と
   * 同じ「同一プロセス内の参照共有」の形（`packages/core/src/__tests__/runtime-fakes.ts`
   * の `FakeBackingStore.activitySeq` と同じ設計）。
   */
  readonly activitySeq = new Map<string, number>();

  /**
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `tenant_subject_activity` 相当。`tenantId` → `subjectId` → `S_x`
   * の2段の `Map`。`InMemoryTenantSettingsStore` にそのまま渡すことで、`createRecall`
   * （書く側）と `getSubjectActivitySeqs`/`hasSubjectActivityCounters`（読む側）が
   * 同じ値を見る——`activitySeq`（上）と同じ「同一プロセス内の参照共有」の形。
   */
  readonly subjectActivitySeq = new Map<string, Map<string, number>>();

  /**
   * Issue #1232 / [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * `tenant_settings.event_retention_days` 相当。`purgeExpiredEventsByRetention` が読む。
   * `InMemoryTenantSettingsStore` にこの Map をそのまま渡すことで、`setEventRetention`
   * （書く側）と `purgeExpiredEventsByRetention`（読む側）が同じ値を見る——`activitySeq`（上）と
   * 同じ「同一プロセス内の参照共有」の形。キーが無い（`Map.has` が `false`）テナントは
   * `{ kind: "unset" }`、値が `null` なら `{ kind: "unlimited" }`、数値なら `{ kind: "days" }`。
   */
  readonly eventRetentionDays = new Map<string, number | null>();

  /**
   * Issue #201 / ADR 0318: `labels` 相当のインメモリ表。key は {@link labelKey}。
   * `PostgresMemoryStore.upsertProposedLabels`/`listLabels`/`registerLabel` と同じ意味論
   * （`docs/memory-model.md` §8）を、`Map` の上でそのまま再現する。
   */
  private readonly labels = new Map<string, LabelSummary>();

  /**
   * Issue #995/#1207 / [ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md):
   * `memory_labels` 相当——`(tenantId, memoryId)` からその Memory が紐づく label 名の
   * 集合へ。`labels`（上）は `proposedCount` 等の集計だけを持ち、どの memory がどの
   * label を持つかを個別には追跡していなかった——`purgeMemory` が「この Memory の
   * label の紐付けを外し、その分だけ `proposedCount` を減らす」ためにこの PR で新設した。
   */
  private readonly memoryLabels = new Map<string, Set<string>>();

  /**
   * Issue #207/#933 PR2（ADR 0381）: `memory_relations` 相当——`InMemoryRelationStore`
   * と共有する（`events`/`outboxJobs` と同じ「同一プロセス内の参照共有」の形）。
   * `markContestedGroup`/`resolveContestedGroup`（このファイル）が書き、
   * `InMemoryRelationStore.listRelated` が読む。
   */
  readonly relations: StoredRelation[] = [];

  /**
   * [ADR 0426](../../../../docs/decisions/0426-in-memory-erase-tenant-postgres-alignment.md):
   * `memories` の行を消したときに呼ぶ listener。`memory_embeddings_<space>.memory_id` の
   * `ON DELETE CASCADE`（`packages/postgres/src/vector-space.ts`）に当たる動きを、
   * `InMemoryVectorStore` がコンストラクタで {@link onMemoriesDeleted} を通して登録する。
   */
  private readonly memoriesDeletedListeners: Array<
    (tenantId: string, memoryIds: readonly MemoryId[]) => void
  > = [];

  /**
   * [ADR 0426](../../../../docs/decisions/0426-in-memory-erase-tenant-postgres-alignment.md):
   * `memories` の行が消えたとき（`eraseTenant`。`dryRun` では呼ばない）に `listener` を呼ぶ。
   * `InMemoryVectorStore` が埋め込みを一緒に消すために使う（Postgres の CASCADE）。
   */
  onMemoriesDeleted(listener: (tenantId: string, memoryIds: readonly MemoryId[]) => void): void {
    this.memoriesDeletedListeners.push(listener);
  }

  /**
   * `(tenantId, name)` を区切り文字で繋がず、`JSON.stringify` の配列で表す。`tenantId` は不透明な
   * 文字列で `::` を含んでよい（`Ctx` の doc）。以前の `${tenantId}::${name}` は、テナント `a::b` の
   * `x` とテナント `a` の `b::x` を同じキーに潰していた（`labels-tenant-key.postgres.test.ts`）。
   */
  private labelKey(tenantId: string, name: string): string {
    return JSON.stringify([tenantId, name]);
  }

  /** `labelKey` と同じ理由・同じ形——`(tenantId, memoryId)` を `JSON.stringify` の配列で表す。 */
  private memoryLabelKey(tenantId: string, memoryId: string): string {
    return JSON.stringify([tenantId, memoryId]);
  }

  /**
   * Issue #201 / ADR 0318: `PostgresMemoryStore.upsertProposedLabels` と同じ契約——
   * 新しく作った Memory の `tags`（重複は `Set` で潰す）から `proposed` ラベルを作り・
   * `proposedCount` を数える。`status === 'registered'` のラベルは件数を進めない。
   * `createMemoryIdempotent` の「新しい行を実際に作った」分岐からだけ呼ぶ
   * （冪等衝突では呼ばない——postgres 実装と同じ判断）。
   */
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
      // status === 'registered' の場合は件数を進めない（postgres 実装と同じ）。
      linked.add(name);
    }
    // Issue #995/#1207 / ADR 0375: この Memory がどの label 名に紐づいたかを覚える——
    // `purgeMemory` がこの紐付けを外し、`proposedCount` を減らすために使う。
    this.memoryLabels.set(this.memoryLabelKey(ctx.tenantId, memoryId), linked);
  }

  /**
   * ADR 0054: 「既存を引く」と「挿入する」を1つの同期区間に閉じ、`created` をその判定
   * そのものから出す。**`await` を挟まない**——挟むと判定と挿入の間に他の呼び出しの
   * 同期区間が入り、`created` が別の書き込みの影響を受ける。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
    // 新しい行を実際に作るとき（冪等の既存の行が無いとき）にだけ、書く前に呼ばれる（ADR 0434）。
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Observation> {
    // ADR 0543: `kind`（`text` 列。識別子ではない）の孤立サロゲートは、Postgres と同じく U+FFFD に置き換えて保存する。
    input = replaceLoneSurrogatesInNewObservation(input);
    assertObservationHasNoNul("InMemoryMemoryStore", input);
    assertObservationDatesValid("InMemoryMemoryStore", input);
    // Postgres の一意制約は `external_id IS NOT NULL` の行に効く——空文字も鍵である（`null`/`undefined` だけが鍵無し）。
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
        // Issue #280: `occurredAt` と同じ経路。
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        // Issue #152（ADR 0312）: 同じ経路。runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
      };
      // Issue #1108: 呼び手の入力（payload・attributes・Date）と切り離して保存する。
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
    // Issue #1237: 既定は壁時計——呼び出し側が時刻を明示的に渡さない限り、今日と同じ挙動のまま。
    now: Date = new Date(),
    // ADR 0407: 渡されたら「その名前で claim 済み」（`attempts: 1`）で作る。
    claimedBy?: string,
  ): OutboxJobRecord {
    // ADR 0543: `outbox.kind`・`outbox.claimed_by` は `text` 列。孤立サロゲートは U+FFFD に置き換えて保存する。
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
    // Issue #1237: 省略時は1回だけ壁時計を読み、この呼び出しで積む outbox 行すべてに
    // 同じ値を使う（`@mnemora/postgres` と同じ規律）。
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

  /**
   * ADR 0439: 別の行への参照は、`ctx` のテナントの行を指さなければならない。実在しない id と別テナントの id は区別しない
   * （`PostgresMemoryStore` と同じ。message も `… not found for tenant: <id>` にそろえる）。`null`・`undefined` は「参照しない」
   * （空文字は参照として扱い、どのテナントの行でもないので拒む）。
   */
  private assertOwnMemoryRef(ctx: Ctx, id: MemoryId | null | undefined): void {
    if (id === undefined) return;
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      // Issue #1759: 参照先が無いときの message は、Postgres と同じく小文字にそろえた id を載せる（ADR 0521 の訂正）。
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${normId(id)}`);
    }
  }

  /**
   * ADR 0466（ADR 0456 の H4 の InMemory 版）: 呼び出し側が渡した `NewMemoryEvent.memoryId` の記憶が `ctx` のテナントに
   * 在ることを、イベントを積む前に確かめる。実在しない・別テナントは区別せず `memory not found for tenant`
   * （`PostgresMemoryStore` の `assertEventTargetInTenant` と同じ判定・同じ message の形）。`null`・`undefined`
   * （記憶を指さないイベント）は確かめない。`knownInTenant` は、この呼び出しが今まさに更新・作成した行の id
   * （`ctx` のテナントの行と分かっている）で、それを指すイベントは問い合わせない。
   * **書く前に呼ぶ**（断ったら、status の更新も news もイベントも、何も書かれない）。
   */
  private assertEventTargetOwn(
    ctx: Ctx,
    memoryId: MemoryId | null | undefined,
    knownInTenant: readonly MemoryId[] = [],
  ): void {
    if (memoryId === null || memoryId === undefined) return;
    // ADR 0469: 大文字小文字は区別しない（`@mnemora/postgres` は uuid を小文字にそろえて比べる。この fixture の id は小文字の `mem-N`）。
    // 断るときの message は、渡された id のまま。操作の対象の id（`updateStatusWithEvent(ctx, id, …)` の `id` など）は変えない。
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

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから
   * 出す（`createObservationIdempotent` と同じ理由）。
   */
  private createMemoryIdempotent(
    ctx: Ctx,
    input: NewMemory,
    method:
      | "createMemory"
      | "createMemoryWithOutbox"
      | "createMemoriesWithOutboxAndEvents" = "createMemory",
    // 新しい行を実際に作るとき（冪等の既存の行が無いとき）にだけ、書く前に呼ばれる（ADR 0434）。
    beforeInsert?: () => void,
  ): IdempotentCreateResult<Memory> {
    // ADR 0543: `text` 列に入る欄の孤立サロゲートは、Postgres と同じく U+FFFD に置き換えて保存する。冪等の鍵
    // （`contentHash`・`extractorVersion`）も置き換えた後の値で比べる（Postgres は置き換わった値で一意制約に当たる）。
    input = replaceLoneSurrogatesInNewMemory(input);
    // ADR 0140: createMemory/createMemoryWithOutbox 共通の入口。PostgresMemoryStore の
    // createMemory と同じ位置（何も書く前）で落とす——冪等衝突の判定より前に見る。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError(method, null);
    }
    // 書ける値かの検査は、冪等の衝突の判定より前に置く。Postgres の `INSERT ... ON CONFLICT DO NOTHING`
    // は、衝突を見る前に行の値を型に変換し CHECK 制約を当てるので、同じ鍵の既存の行が在っても拒む（実測）。
    // 外部キー相当の検査は、ADR 0439 以降、次の参照先の検査（テナントも見る）に移した。
    assertStorableNewMemory(input);
    // ADR 0439: 参照先は `ctx` のテナントの行であること（別テナントの行を指す行は書けない）。検査の順は
    // `PostgresMemoryStore` と同じ（observation、superseded-by、contested-with）。`PostgresMemoryStore` は検査と書き込みを
    // 1つの文にするので、冪等の衝突で既存の行を返す呼び出しでも検査は当たる——ここも衝突の判定より前に置く。
    // ADR 0521: 参照する observation の id も大文字小文字を区別しない（`@mnemora/postgres` は uuid 型の列で比べる）。
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
      // 外部キー相当（0001_init.sql）: `memories.source_observation_id` /
      // `superseded_by_id` / `contested_with_id` は、非 null なら実在する行を指さなければ
      // ならない。`packages/postgres` は実際の外部キー制約でこれを強制するが、この
      // in-memory 実装は `Map` の生成物にすぎず、参照整合性を放置すると「本番では起きない
      // 書き込みが手元では黙って成功する」（ADR 0047）。**「存在」だけを見る——一対一等の
      // 整合までは踏み込まない（`contested_with_id` が双方向かどうかはここでは見ない）。**
      // 空文字も参照として扱う（`null`/`undefined` だけが「参照しない」）——Postgres は空文字を uuid として読めずに拒む。

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
        // Issue #371（ADR 0185/ADR 0315）: `undefined`/`null` はどちらも「鍵なし」
        // （`Memory.claimKey` の doc コメント参照）——`?? null` で転記しないと `undefined`
        // のまま消える。上の `decayBaseSeq` と同じ漏れを作らない。
        claimKey: input.claimKey ?? null,
        // `strength`・`halfLifeHours`・`halfLifeRecalls` は Postgres の `real`（float4）列——Postgres が読み戻す値で
        // 持つ（`toFloat4Readback` の doc 参照）。
        strength: toFloat4Readback(input.strength),
        halfLifeHours: toFloat4Readback(input.halfLifeHours),
        decayFloorAt: input.decayFloorAt,
        // ADR 0165（Issue #305）: 活動時計の3つ組。省略可能なフィールドなので `?? null` で
        // 転記しないと `undefined` のまま消える——これが前任の作業者が実際に踏んだ漏れ1
        // （core commit 5e37afb の doc 参照）。ここで同じ漏れを作らない。
        decayBaseSeq: input.decayBaseSeq ?? null,
        decayFloorSeq: input.decayFloorSeq ?? null,
        halfLifeRecalls:
          input.halfLifeRecalls == null ? null : toFloat4Readback(input.halfLifeRecalls),
        embeddingStatus: input.embeddingStatus,
        // ADR 0434: `input.purgedAt` は保存しない。`MemoryStore.purgeMemory` の doc が言う「`purgedAt` を書く経路は
        // この口以外に無い」とおり、`PostgresMemoryStore.createMemory` は `purged_at` を INSERT に含めず、
        // 渡しても `null` で読み戻る（実測）。渡された値は断らず、無視する（型は変えない）。
        purgedAt: null,
        // Issue #152/#153（ADR 0312）: runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      // Issue #1108: 呼び手の入力（tags・provenance・claimKey・attributes・日時）と切り離す——
      // 呼び手が後で入力を書き換えても、保存した値は変わらない（Postgres は行に書き写す）。
      const stored = structuredClone(memory);
      this.memories.set(stored.id, stored);
      if (input.sourceObservationId != null) {
        this.extractionIndex.set(idemKey, stored.id);
      }
      // Issue #201 / ADR 0318: `createMemory`/`createMemoryWithOutbox`/
      // `supersedeWithNewMemories` はすべてこの `createMemoryIdempotent` を通る
      // （このファイル冒頭の doc コメント参照）——「新しい行を実際に作った」この分岐
      // だけで1回呼べば3経路すべてを覆える。
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
    // ADR 0420: 何も書く前に見直す（`abortIfForgotten` は実装しないが、こちらは実装する）。
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
    // Issue #1237: `createObservationWithOutbox` と同じ理由——省略時は1回だけ壁時計を読む。
    const outboxNow = opts?.now ?? new Date();
    const jobs = jobKinds.map((kind) =>
      this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }, outboxNow),
    );
    return { memory: snapshot(memory), created: true, jobs: snapshot(jobs) };
  }

  /**
   * ADR 0420: `opts.abortIfSuperseded` の実装。渡された id のうち1件でも `superseded`（この tenant の行）なら
   * {@link SourceMemoryStatusChangedError} を投げる。**何も書く前に**呼ぶこと（同期区間なので窓は無い）。
   */
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
    // ADR 0568: 綴り違いの同じ id（`[x, X]`）は1行として数え、`changed` は id の昇順にする
    // （`@mnemora/postgres` は `id = ANY(...) ORDER BY id ASC` で行を選ぶので、1行につき1件・昇順）。
    const seen = new Set<MemoryId>();
    for (const raw of ids) {
      // ADR 0556: 大文字小文字は区別しない。`changed[].id` は小文字（`@mnemora/postgres` は行の uuid を読み戻すので小文字）。
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
   * 今の書き込みの状態（Memory・冪等キー・outbox・ラベル）を写し取り、呼ぶと**そこへ戻す**関数を返す。
   * Postgres の SAVEPOINT／トランザクションの巻き戻しの代わり——この store は `await` を挟まない同期区間で
   * 書くので、写してから戻すまでの間に他の書き込みは入らない。`supersedeWithNewMemories` と
   * `createMemoriesWithOutboxAndEvents` が共有する。
   *
   * ⚠ 戻すのは上の4つだけ。`events`（共有配列）は呼び出し側が長さで切り戻す。
   */
  private captureWriteState(): () => void {
    const memoryIdsBefore = new Set(this.memories.keys());
    const outboxLengthBefore = this.outboxJobs.length;
    const labelsBefore = new Map(this.labels);
    // ADR 0375: `memoryLabels` も `labels` と同じロールバック対象——新設した構造をここで写し忘れると、
    // 途中失敗した書き込みの label 紐付けだけが残ってしまう。
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
   * [ADR 0410](../../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)（穴 D-3）:
   * 抽出の全候補の Memory と `created` イベントを、1つの同期区間（＝トランザクションの代わり）で書く。
   *
   * - 候補ごとに写し取り（`captureWriteState`）、保存できない候補（`createMemoryIdempotent` が投げる）は
   *   その候補の書き込みだけを戻して `dropped` に積む（Postgres の SAVEPOINT に当たる）。
   * - 全候補が落ちたら最初の例外を投げる（何も書かない）。
   * - 全候補の成否が確定したあと、`created: true` の候補ぶんの `created` イベントを共有の `events` 配列へ積む。
   *   ここで投げたら（イベントが書けない値・`events.push` が投げる）、Memory・outbox・ラベル・積みかけの
   *   イベントも全部戻して、そのまま投げる。
   * - ⚠ `opts.abortIfForgotten`（ADR 0416）は**実装しない**——渡しても無視され、例外は投げられない
   *   （`createMemoryWithOutbox`・`supersedeWithNewMemories` と同じ。適合テストは `supportsAbortIfForgotten: false`
   *   でそれを積極的に assert する）。
   * - ⚠ イベントは `InMemoryMemoryStore.events` に積まれる。`InMemoryEventStore` から読むには、第2引数に
   *   `memoryStore.events` を渡して配列を共有すること（`InMemoryEventStore` のクラス doc）。共有しない組み立ての
   *   `InMemoryEventStore` に対しては、この口を使った抽出の `created` は `EventStore.list` に出ない。
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
    // ADR 0420: 何も書く前に見直す。
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "createMemoriesWithOutboxAndEvents");
    // Issue #1237: 省略時は1回だけ壁時計を読み、積む outbox 行すべてに使う。
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
        // ADR 0466: イベントが指す記憶が、今作った行でなければ `ctx` のテナントの行か（外れたら全体を戻す）。
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

  /**
   * Issue #1108: 内部に持っている Memory の**実体**を返す（複製しない）。この store の書き込みの
   * 口が、取った実体をその場で書き換えるために使う。`MemoryStore` の口（`get` など）は
   * 実体ではなく返す時点の複製を返す（`snapshot`）——Postgres が毎回行を読み直した新しい
   * オブジェクトを返すのと同じにするため。
   */
  private rawGet(ctx: Ctx, id: MemoryId): Memory | null {
    const memory = this.memories.get(normId(id));
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // `PostgresMemoryStore.getMany` は `WHERE id = ANY(...)` という集合演算で引く
    // （実測）。同じ id が `ids` に複数回含まれていても、一致する行は主キーの性質上
    // 1回しか無いため、返る件数は**一意な id の数**にしかならない。ここで検査せず
    // 単純にループで push すると、同じ id の Memory オブジェクトを重複して返して
    // しまう（実測: Postgres は `getMany([x,x,y])` に対し2件、素朴なループ実装は
    // 3件を返す）。呼び出し済みの id は2回目以降スキップし、Postgres の集合演算と
    // 同じ「一意な id の集合」に揃える。
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
   * ADR 0084 / Issue #106: `InMemoryLexicalStore`（`in-memory-lexical-store.ts`）がテナント内の
   * 全 Memory を舐めて `content` の語彙一致を見るための反復子。
   *
   * `LexicalStore` は `upsert`/`delete` を持たない（`interfaces/lexical-store.ts` のクラス doc）
   * ——postgres 実装は `memories.content` の上に式索引を張るので、索引は本体の書き込みに
   * 自動で追随する。`InMemoryVectorStore` が `entries`（自前の Map）を舐めて `this.memoryStore.get`
   * で属性だけを引くのに対し、`InMemoryLexicalStore` には自前の Map が無い——**この store の
   * `memories` そのものが索引**であり、その非対称をここで反復子として表す。
   *
   * 返すのは `Map` の行そのもの（複製しない）。呼び出し側
   * （`InMemoryLexicalStore.search`）はここから読むだけで書き換えないことを前提にしている。
   * ⚠ Issue #1108 以降、`get`/`getMany` は返す時点の複製を返す。この口は `MemoryStore` の口では
   * なく、同じ fixture 群が読むだけで使う口なので、検索の速さのために複製しないまま残す。
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

  /**
   * ADR 0028: `reextract` が既存 Memory のうち今回作られなかったものを判定するための列挙
   * （**SELECT のみ**）。`extractorVersion: null` は `extractor_version IS NULL`
   * （postgres 実装の `IS NOT DISTINCT FROM` と同じ規約）を意味する。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // ADR 0543: 検索語も、Postgres が引数を UTF-8 に変換するときに置き換わる。
    extractorVersion = replaceLoneSurrogates(extractorVersion);
    // ADR 0434: `extractor_version` は `text` 列。検索語の NUL は Postgres ではクエリの時点で拒まれる。
    // （`observationId` が uuid の形でないとき、Postgres はクエリを発行せずに `[]` を返して NUL を見ない。この
    // fixture の id は uuid の形ではないので、その入力だけは揃えていない。）
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

  /**
   * ADR 0380: `reextract` が「版を跨いで退けた記憶」を判定するための列挙（**SELECT のみ**）。
   * `listBySourceObservation` と違い `extractorVersion`・`status` のどちらでも絞らない。
   */
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
   * ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする（postgres 実装と同じ意味論）。
   *
   * 投げるもの: `"contested"` への遷移は常に {@link ContestedWithoutCompanionError}、`expectedStatus` と食い違えば
   * {@link MemoryStatusConflictError}（どちらも何も書かない）。
   */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
  ): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // ADR 0140: この口には contestedWithId を渡す引数が無いため、status: 'contested' への
    // 書き込みは常に単独になる。PostgresMemoryStore と同じ位置（対象の存在確認より前）で
    // 落とす。
    // Issue #1759: 対象が無いときの message は、Postgres と同じく渡された綴りのまま載せる（ADR 0521 の訂正）。
    const requestedId = id;
    id = normId(id);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    // ADR 0503: `superseded` は置き換えた側を伴い、自分自身ではない（書く前・対象の存在確認より前に断る）。
    assertSupersededByShape("updateStatus", "opts", id, status, opts?.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない（`memories.superseded_by_id → memories(id)`）。ADR 0439: `ctx` のテナントの Memory であること。
    // 検査の順は `PostgresMemoryStore` と同じ（対象の行、`supersededById`、`expectedStatus`）。
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
   * ADR 0031: `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む
   * （postgres 実装の `db.transaction()` に対応する意味論——CAS に弾かれたら status も
   * イベントも一切変わらない）。
   *
   * 投げるもの: `"contested"` への遷移は常に {@link ContestedWithoutCompanionError}、`expectedStatus` と食い違えば
   * {@link MemoryStatusConflictError}。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // ADR 0140: updateStatus と同じ理由・同じ位置。
    // Issue #1759: updateStatus と同じく、対象が無いときの message は渡された綴りのまま。
    const requestedId = id;
    id = normId(id);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    // ADR 0503: updateStatus と同じ。
    assertSupersededByShape("updateStatusWithEvent", "opts", id, status, opts.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    // 外部キー相当（ADR 0047）・ADR 0439: updateStatus と同じ理由・同じ検査・同じ順。
    this.assertOwnMemoryRef(ctx, opts.supersededById);
    if (opts.expectedStatus !== undefined && casMismatch(memory, opts.expectedStatus)) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    assertStorableMemoryColumn("status", status);
    assertStorableMemoryEvent(event);
    assertCloneableMemoryEvent(event);
    // ADR 0466: イベントが指す記憶は `ctx` のテナントの行（`PostgresMemoryStore` は UPDATE の後、同じトランザクションの中で確かめる）。
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
   * Issue #134 / ADR 0100: `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の
   * supersede、複数可）を1回の呼び出しにまとめる——docs/memory-model.md §11 行5 が要求する
   * 「旧行の status 更新と新 Memory の作成を1トランザクションで完結させる」を満たすため。
   *
   * `news` の各要素は {@link createMemoryWithOutbox} と同じ冪等経路。`supersede` の各要素は
   * {@link updateStatusWithEvent} と同じ CAS 意味論（`status` は常に `"superseded"`）。
   * CAS に弾かれた対象は例外にせず `conflicted` に積んで続行する——本メソッド自体は
   * 常に成功して返る（対象がそもそも存在しない場合を除く）。
   *
   * ⚠ **in-memory にトランザクションは無い。**「まだ何も書いていない」ことでロールバックを
   * 模す——`supersede[].id`/`supersededById` の存在検査を、`news`/`supersede` のどちらにも
   * まだ1バイトも書き込む前に、**すべて先に済ませる**（`await` を挟まない同期区間、
   * `updateStatusWithEvent`/`createObservationIdempotent` と同じ作法）。この検査のどれか1つ
   * でも「無い」なら、この時点で throw する——`news` は1件も Map に入っていない。
   * `news` の各要素が書ける値か・外部キー相当の検査は `createMemoryIdempotent` の中にあり、2件目
   * 以降で投げうる。そのときは、この呼び出しで先に作った Memory・冪等キー・outbox・ラベルを
   * 取り消してから投げる（2026-09-27、それまでは1件目が残っていた）。
   *
   * ⚠ **この事前検査の副作用**: `supersededById` が「同じ呼び出しの `news` で作られる
   * （まだ採番されていない）Memory」を指すケースは、この in-memory 実装ではサポートしない
   * ——`news` を作る前に存在を検査するため、まだ存在しない id は常に「無い」と判定される。
   * `packages/postgres` は外部キー制約がトランザクション内の直前の INSERT を見えるため
   * この形をサポートしうるが、**現在どの呼び出し元もこの形を必要としていない**
   * （ADR 0100 参照）。
   *
   * ⚠ **返す `memory`/`event` は Map の行そのもの（複製しない）。**`listByTenant` の doc
   * コメントと同じ注意——呼び出し側がこれを書き換えると store 自身の内部状態も書き換わる。
   * 適合テストで「（CAS に弾かれて）変わっていないこと」を assert するときは、
   * 呼び出しの前にプリミティブ値へ写し取ってから比べること——写し取らずに同じ参照を
   * 2回見ると、変異を入れても歯が赤くならない（死んだ歯になる）。
   *
   * 新しい行に `status: "contested"` で `contestedWithId` が無いものがあれば、何も書かずに
   * {@link ContestedWithoutCompanionError} を投げる。
   *
   * ADR 0416（穴 D-3 の続き）: `opts.buildCreatedEvent` が渡されたら、`created: true` の `news` の Memory ごとに
   * `created` イベントを共有の `events` 配列へ積み（**`supersede` の書き込みより前**。ここで投げたら `news` の
   * Memory・outbox・ラベルとイベントを全部戻す。`supersede` にはまだ触れていない）、戻り値に
   * `createdEventsWritten: true` を付けて名乗る。`opts.abortIfForgotten` は実装しない（従来どおり無視）。
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
    // Issue #1759: 対象が無いときの message は、Postgres と同じく渡された綴りのまま載せる（下の 1b）。
    const requestedTargetIds = supersede.map((t) => t.id);
    supersede = supersede.map((t) => ({ ...t, id: normId(t.id) }));
    news.forEach((entry, i) =>
      assertWellFormedIdentifier(entry.input.subjectId, `news[${i}].input.subjectId`),
    );
    // Issue #1237: 省略時は1回だけ壁時計を読み、news に積む outbox 行すべてに使う。
    const outboxNow = opts?.now ?? new Date();
    const buildCreatedEvent = opts?.buildCreatedEvent;
    // 0. `@mnemora/postgres` と同じ順（RangeError → news の検査 → 対象の存在）。壊れた news と存在しない対象が
    //    同時にあれば、壊れた値の例外が先に出る。
    // 0a. 呼び手が壊れた索引を渡した（RangeError。conflicted にも not found にも混ぜない）。
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
    // 0b. news の各要素の入口の検査を、対象の存在の検査より前に、`createMemoryIdempotent` の入口と同じ並び
    //     （孤立サロゲートの置き換え → ADR 0140 の contested → `assertStorableNewMemory`。ADR 0630 の検査はその末尾）で
    //     当てる。`@mnemora/postgres` も contested・値の検査・ADR 0630 の検査を、対象の存在より前に当てる。
    //     ⚠ `assertWellFormedNewMemory` だけを先に呼ばないこと——`digest: null` などで、ほかの口（`TypeError`）と
    //     例外の種類が割れる。`createMemoryIdempotent` も同じ検査をもう一度当てるが、結果は変わらない。
    for (const { input } of news) {
      const replaced = replaceLoneSurrogatesInNewMemory(input);
      if (isContestedWithoutCompanion(replaced.status, replaced.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
      assertStorableNewMemory(replaced);
    }
    // 1. 事前検証——まだ何も書いていないうちに投げる（news の作成も含め、何も起きな
    //    かったのと同じに見せる）。⛔ 3種類の失敗を1つに潰さない（ADR 0100）。
    for (const [i, target] of supersede.entries()) {
      // ADR 0640: 下限より前の `at` はここでは見ない——CAS に弾かれる対象はイベントを書かず、Postgres は `at` を見ない（実測）。
      // CAS を通る対象だけ、下の 1d で見る。
      assertStorableMemoryEvent(target.event, { skipAtFloor: true });
      // 1b. 対象の行がそもそも無い。
      const memory = this.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(
          `InMemoryMemoryStore: memory not found for tenant: ${requestedTargetIds[i]}`,
        );
      }
    }
    // 1c. ADR 0140: news の各要素にも createMemory と同じ制約を課す。
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
    }
    // 1d. 下の 3. で CAS を通ってイベントを書く対象だけ、そのイベントが structuredClone で写せるかを
    //     確かめる（写せないと 3. の `buildStoredMemoryEvent` で、status を書き換えた後に投げる）。
    //     CAS に弾かれる対象はイベントを書かないので確かめない——投げる入力を増やさない。
    //     同じ id が2回並ぶと2回目は弾かれる（1回目が superseded にする）ので、それも写す。
    // ADR 0420: 下の 3. で CAS に弾かれる対象（`abortIfAllConflicted` の判定に使う）。
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
      // ADR 0640: CAS を通ってイベントを書く対象だけ、`at` が下限より前でないかを確かめる（上の 1. は見ない）。
      assertWrittenTimestamptzFloor("memory_events", "at", target.event.at);
      // ADR 0466: CAS を通ってイベントを書く対象だけ、そのイベントが指す記憶が `ctx` のテナントの行かを確かめる
      // （弾かれる対象はイベントを書かないので確かめない。`PostgresMemoryStore` と同じ）。
      this.assertEventTargetOwn(ctx, target.event.memoryId, [target.id]);
      willSupersede.add(target.id);
    }
    // ADR 0420: 見直し。何も書く前（news の作成より前）に投げる。
    this.assertNoneSuperseded(ctx, opts?.abortIfSuperseded, "supersedeWithNewMemories");
    if (
      opts?.abortIfAllConflicted === true &&
      supersede.length > 0 &&
      wouldConflict.length === supersede.length
    ) {
      throw new SourceMemoryStatusChangedError("supersedeWithNewMemories", wouldConflict);
    }

    // 2. news を作る（`createMemoryWithOutbox` と同じ経路）。
    //    ⚠ 書ける値か・外部キー相当の検査は `createMemoryIdempotent` の中にあり、2件目以降で投げうる
    //    ——そのときは、この呼び出しで先に作った Memory・冪等キー・outbox・ラベルを取り消して、
    //    何も起きなかったのと同じに見せる（Postgres は1トランザクションで巻き戻る）。
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
      // ADR 0416: `created` イベントも、`supersede` に触れる前に積む（積めなければ news の書き込みごと戻す）。
      if (buildCreatedEvent !== undefined) {
        for (const [index, entry] of created.entries()) {
          if (entry.created) {
            const createdEvent = buildCreatedEvent(snapshot(entry.memory), index);
            // ADR 0466: 今作った行でなければ `ctx` のテナントの行か（外れたら news の書き込みごと戻す）。
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

    // 3. supersede を1件ずつ CAS で処理する。弾かれても conflicted に積んで続行する
    //    （本メソッド自体は commit する——ADR 0031「採らなかった案」を覆さない）。
    const superseded: MemoryEvent[] = [];
    const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    for (const target of supersede) {
      // 1. で存在を確認済み。news の作成（2.）は既存 Memory の status を変えないため、
      // ここで読む status は 1. の検証時点から変わっていない（同期区間、await 無し）。
      const memory = this.memories.get(target.id)!;
      if (target.expectedStatus !== undefined && casMismatch(memory, target.expectedStatus)) {
        conflicted.push({ id: target.id, observedStatus: memory.status });
        continue;
      }
      memory.status = "superseded";
      // `created` は `news` と同じ順序（下の 2. がそのまま push している）。1. で範囲を
      // 検査済みなので、この索引は必ず在る。
      const anchorId = created[target.supersededByIndex]!.memory.id;
      memory.supersededById = anchorId;
      memory.updatedAt = new Date();
      // `meta.supersededById` は解決した id で埋める（interface の契約）。
      const storedEvent = buildStoredMemoryEvent(ctx, {
        ...target.event,
        meta: { ...target.event.meta, supersededById: anchorId },
      });
      this.events.push(storedEvent);
      superseded.push(storedEvent);
    }

    const result = snapshot({ created, superseded, conflicted });
    // ADR 0416: 積んだことを名乗る（渡していない呼び出しでは付けない）。
    return buildCreatedEvent === undefined ? result : { ...result, createdEventsWritten: true };
  }

  /**
   * Issue #210 / ADR 0115: `events` 配列（`InMemoryEventStore` と共有、ADR 0031）から
   * 期限切れの行を消す本体。`purgeExpiredEvents` と `purgeExpiredEventsByRetention`
   * （Issue #1232、ADR 0354）が共有する——**書き写さない**。**同期関数である**——
   * `await` を1つも挟まない（`purgeExpiredEventsByRetention` が「保持期間を読んでから
   * 消すまで」を同じ同期区間に閉じるための前提。クラス冒頭の doc コメント参照）。
   *
   * `EventStore`（`InMemoryEventStore`）のメソッドは一切呼ばない——append-only の型に触れず、
   * `events` 配列を直接操作する（`PostgresMemoryStore.purgeExpiredEventsBody` が
   * `PostgresEventStore` を経由せず `memory_events` へ直接 SQL を発行するのと同じ形）。
   *
   * `kind = 'events_purged'` の行は対象から除外する（無限後退を避ける、interface doc
   * 参照）。`at` 昇順に並べ替えてから `opts.limit` 件（+1件、`reachedLimit` 判定用）を
   * 見る。`dryRun` のときは `this.events` を一切変更しない。
   */
  private purgeExpiredEventsSync(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): PurgeExpiredEventsResult {
    // 条件の日時は Postgres の timestamptz へ変換できなければならない（query-check.ts）。
    assertQueryDate("purgeExpiredEvents", "olderThan", opts.olderThan);
    // `PostgresMemoryStore.purgeExpiredEvents`（`buildPurgeExpiredEventsTargetSelect`）は
    // SQL の `LIMIT ${opts.limit + 1}` を使うため、`opts.limit` が負数だと
    // 生 SQL の `LIMIT` へ負数（またはそれ以下）が渡る。`opts.limit === -1` のときだけ
    // `LIMIT 0` になり例外を投げずに `purged: 0` で返るが（実測済み）、`opts.limit <= -2`
    // では Postgres が `LIMIT must not be negative` で例外を投げる（実測済み）。
    // ここで検査せず `candidates.slice(0, opts.limit)` へ渡すと、
    // `Array.prototype.slice` の負数引数は「末尾から数えた除外」という別の意味になり、
    // 対象テナントの期限切れイベントの**ほぼ全件を静かに削除**してしまう
    // （このメソッドは delete の副作用を持つ——`search`/`list` 系より実害が大きい）。
    // `opts.limit === -1` の1点だけは Postgres と完全には一致しない（Postgres は
    // 例外を投げず `{ purged: 0, reachedLimit: true }`）が、**どちらの入力でも
    // 「誤って削除しない」ことは保証される**——`LIMIT + 1` の窓を模してまで `-1` だけを
    // 特別扱いする値打ちが無いと判断し、負数はすべて一様に拒む。
    // ⟹ この不一致は解消すべき欠陥ではなく、今の契約である——負数は「受け付けない値」で
    // あり、結果が実装ごとに違うことを許す（Issue #876、`PurgeExpiredEventsOptions.limit`
    // の doc 参照）。
    // ⚠ 負数だけでは足りない——`opts.limit + 1` も bigint 型の SQL パラメータへ渡るため、
    // `NaN`/`Infinity`/非整数を渡すと Postgres は
    // `invalid input syntax for type bigint: "NaN"` の形で例外を投げる（実測済み。
    // `opts.limit + 1` の形のままでも同じ例外になることを確認済み——
    // in-memory-vector-store.ts の同種の注記参照）。
    // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
    // 「負数は例外」の回帰テストの文言を変えずに済ませる。
    const dryRun = opts.dryRun ?? false;
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

    // 削除と同一の同期区間で `events_purged` を積む（`await` を挟まないため、
    // 他の呼び出しがこの間に割り込む余地が無い——本物のトランザクションではないが、
    // in-memory 実装として原子性を模す唯一の手段。クラス冒頭の doc コメント参照）。
    const storedEvent = buildStoredMemoryEvent(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      // 日時は ISO 8601 の文字列で持つ——`PostgresMemoryStore` は meta を JSON で保存するので、
      // 読み戻すと文字列になる。fixture はそれを写す（戻り値のほうは `Date` のまま）。
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

  /**
   * Issue #210 / ADR 0115: {@link InMemoryMemoryStore.purgeExpiredEventsSync} を呼ぶだけの
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
   * [ADR 0404](../../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `MemoryStore.purgeExpiredRecalls?` の in-memory 実装（`PostgresMemoryStore` と同じ契約）。
   * 対象の recall を先に確定し、その `recall_usages` を消してから recall を消す。
   * `await` を挟まない（1回の同期区間で終わる）。
   */
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
      // 子（recall_usages）が先、親（recalls）が後。
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
   * Issue #1232 / [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * `MemoryStore.purgeExpiredEventsByRetention?` の in-memory 実装。保持期間
   * （`this.eventRetentionDays`、コンストラクタで渡された `InMemoryTenantSettingsStore` と
   * 共有する Map）を読んでから {@link InMemoryMemoryStore.purgeExpiredEventsSync} を呼ぶまで、
   * **`await` を1つも挟まない**——同期関数を呼ぶだけなので、この呼び出し全体が1つの
   * 同期区間になり、他の呼び出しが「読んだ」と「消す」の間に割り込む余地が無い
   * （本物のトランザクションではないが、in-memory 実装として原子性を模す唯一の手段。
   * `purgeExpiredEventsSync` の doc コメントと同じ理由）。
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
   * ADR 0053: `ready` を `failed` へ巻き戻さない。
   *
   * `PostgresMemoryStore.setEmbeddingStatus`（`packages/postgres/src/memory-store.ts`）の
   * `WHERE ... AND embedding_status <> 'ready'`（`status` が `'failed'` のときだけ付く
   * 条件片）と同じ意味論。**禁じる遷移そのものの判定は共有の
   * {@link isEmbeddingStatusRollback} に固定する**——実装ごとに条件式を書き直すと、
   * どの遷移を禁じるかが実装間でずれる余地を作る（Postgres 側だけは比較を SQL の1文の
   * `WHERE` に置く必要があるためこの関数を呼べず、比較の形が2箇所に書かれる。
   * ADR 0053「引き受けた負債」）。
   *
   * 巻き戻しを**例外にはしない**——唯一の `failed` の呼び出し口は `runtime.tick` の
   * `catch` の中であり、そこで投げると元の埋め込みエラーが握り潰されて別の例外に
   * すり替わる。呼び出し側の次の一手も無いので、no-op のまま現在の（更新されなかった）
   * 行を返す（ADR 0048 の `reinforce` と同じ理由の形）。
   * `failed → ready` は妨げない（片側だけの規則）。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // Issue #1759: 対象が無いときの message は、Postgres と同じく渡された綴りのまま。
    const requestedId = id;
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    assertStorableMemoryColumn("embedding_status", status);
    if (isEmbeddingStatusRollback(memory.embeddingStatus, status)) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return snapshot(memory);
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return snapshot(memory);
  }

  /**
   * ADR 0048（Postgres）/ ADR 0049（本実装）: 減衰の起点を巻き戻さない。
   *
   * `PostgresMemoryStore.reinforce`（`packages/postgres/src/memory-store.ts`）の
   * `WHERE ... AND COALESCE(last_reinforced_at, recorded_at) < ${at}` と
   * 同じ意味論（起点 `lastReinforcedAt ?? recordedAt` より新しい `at` だけを書く。Issue #1093）——**狭義の `<`**（同じ `at` は no-op）で、`lastReinforcedAt` と
   * `decayFloorAt` を同じ条件でまとめて動かす。古い `at` を**例外にはしない**——
   * 呼び出し側（`runtime.observe` の使用報告ループ）の次の一手が無いため、
   * no-op のまま現在の（更新されなかった）行を返す。
   *
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   * `opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときに限り、
   * 活動時計側の起点・床（`decayBaseSeq`/`decayFloorSeq`）も同じ条件で一緒に進める
   * （`PostgresMemoryStore.reinforce` と同じ分岐。`ReinforceOptions.nowSeq` の doc
   * コメント参照）。
   */
  /** ADR 0394: `ReinforceOptions.addOwnSubjectSeq` を読める（`reinforce` の実装を参照）。 */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // Issue #1759: 対象が無いときの message は、Postgres と同じく渡された綴りのまま。
    const requestedId = id;
    id = normId(id);
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${requestedId}`);
    }
    // `PostgresMemoryStore.reinforce` は `at` を `timestamptz` 列（`last_reinforced_at`/
    // `decay_floor_at`）へそのまま書き込むため、Invalid Date（`at.getTime()` が `NaN`）を
    // 渡すとクエリ実行時に `invalid input syntax for type timestamp with time zone` で
    // 例外を投げる（実測。Issue #807）。ここで検査しないと、下の no-op 判定
    // （`memory.lastReinforcedAt.getTime() >= at.getTime()`）は `NaN` を含む比較が常に
    // `false` になるため素通りし、`lastReinforcedAt`/`decayFloorAt` が Invalid Date の
    // まま静かに書き込まれてしまう——以後この Memory の減衰計算が `NaN` を返し続ける。
    // クエリを投げる前に弾く Postgres 側に揃える。
    if (Number.isNaN(at.getTime())) {
      throw new Error(`reinforce: at must be a valid Date (got Invalid Date)`);
    }
    // ADR 0640: 下限より前の `at` は、Postgres が何も書かない呼び出し（下の no-op）でも `22008` で拒む（実測）。no-op の判定より前に見る。
    assertWrittenTimestamptzFloor("reinforce", "at", at);
    // ADR 0434: `opts.nowSeq` は `decay_base_seq`・`decay_floor_seq`（`bigint`）へ書く値で、Postgres は整数でない・範囲外を
    // クエリの時点で拒む（`22P02`・`22003`。実測）。**この Memory が `halfLifeRecalls` を持つときだけ**（持たなければ
    // `nowSeq` は使われず、Postgres は何も見ない）。下の「起点より新しい `at` のときだけ書く」の no-op でも
    // Postgres は同じ UPDATE 文を発行するので、no-op の判定より前に見る。`archiveDecayed` の `nowSeq` と同じ検査
    // （`assertQueryInteger`）に、`bigint` の範囲を足したもの。負は、行を実際に書くときの CHECK 制約なので、下で見る。
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      assertQueryBigint("reinforce", "nowSeq", opts.nowSeq);
    }
    // 起点（lastReinforcedAt ?? recordedAt）より新しい at のときだけ書く（Issue #1093）。未強化の
    // 記憶では作成時刻が起点なので、それより前・ちょうどの at は、活動時計の欄も含めて何も書かない。
    if ((memory.lastReinforcedAt ?? memory.recordedAt).getTime() >= at.getTime()) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return snapshot(memory);
    }
    // 活動時計側に書く起点（`opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときだけ）。
    // 何かを書き換える前に決めて検査する——投げたときに、壁時計側の列だけが書き換わった状態を残さない。
    let activityBaseSeq: number | undefined;
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      // ADR 0394: `addOwnSubjectSeq` が true なら、`nowSeq`（T）に Memory 自身の subject の S_x を足す。
      activityBaseSeq =
        opts.addOwnSubjectSeq === true && memory.subjectId != null
          ? opts.nowSeq + (this.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
          : opts.nowSeq;
      // ADR 0434: `memories_decay_seq_non_negative`（CHECK）——書く値が負なら Postgres は拒む。no-op の（何も書かない）
      // 呼び出しでは効かない。`addOwnSubjectSeq` のときは `nowSeq + S_x` が書く値なので、`nowSeq` が負でも `S_x` で
      // 0 以上になれば通る。
      if (activityBaseSeq < 0) {
        throw new Error(`reinforce: decayBaseSeq must not be negative (got ${activityBaseSeq})`);
      }
      // ADR 0500: `addOwnSubjectSeq` のとき Postgres は `nowSeq + S_x`（`decay_base_seq`）と、床 `nowSeq + S_x + offset`
      // （`decay_floor_seq = LEAST(… + offset::bigint, MAX_SAFE_INTEGER)`）を `bigint` で足し、どちらかが 2^63 以上なら
      // `22003 bigint out of range` で UPDATE ごと失敗する（実測）。足すのは、ドライバが `nowSeq` を文字にした値
      // （`String(2**63 - 1024)` は `"9223372036854775000"`）なので、float64 の和ではなく BigInt で同じ値を足す。
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

  /**
   * [Issue #874](https://github.com/takecchi/mnemora/issues/874): `reinforce` を
   * `ids` の各要素について順に呼ぶだけの素直な実装。この fake はテスト用の
   * プレースホルダであり、往復数を束ねる最適化そのものは対象としない
   * ——契約（`reinforce` を呼んだのと同じ結果になること）だけを満たす。
   * `packages/postgres` 側の一括版（`PostgresMemoryStore.reinforceMany`）と違い、
   * ここでは1件ずつ呼んでも同じ結果になる（往復という概念がそもそも無い）。
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
    // 外部キー相当（ADR 0047）: `recall_usages.recall_id → recalls(id)` /
    // `recall_usages.memory_id → memories(id)`。Postgres は単一の
    // `INSERT ... SELECT ... FROM unnest(...)` で全件をまとめて書くため、どれか1件でも
    // 外部キーに違反すれば文全体が失敗し、部分挿入は起きない——ここでも「全件の存在を
    // 先に確かめてから挿入する」ことで同じ全体原子性を再現する。
    //
    // ⚠ `memoryIds` が空配列なら、Postgres 実装（`packages/postgres/src/memory-store.ts`）は
    // クエリを一切発行せず即座に空の結果を返す——`recallId` の実在は問われない。
    // ここでもその早期リターンより後ろで検査することで、同じ非対称を再現する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    // ADR 0439: recall も memory も `ctx` のテナントの行であること（`PostgresMemoryStore` と同じ順・同じ message）。
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
   * roadmap.md 段階4/5: `countByGroup` を置き換える単一集約（`ScopeAggregate`、
   * docs/recall.md §5・packages/core の recall.ts の doc コメント参照）。
   *
   * インメモリ実装なので「単一クエリ」という概念自体は無いが、契約として重要なのは
   * 「groups の総和が totalInScope と一致すること」——ここでは同じ1回のループで
   * 両方を積み上げることでそれを保証する（postgres 実装は単一 SQL 文でこれを保証する）。
   *
   * `opts.digestBand`（ADR 0073 決定7）: `packages/core` の `FakeMemoryStore.aggregateScope`
   * （`packages/core/src/__tests__/runtime-fakes.ts`、参照実装）と同じ意味論——
   * 上のループで既に集めた in-scope の Memory から、`excludeMemoryIds` を除いて
   * `(occurredAt ?? recordedAt)` の降順・同値なら `id` の降順に並べ、`limit` 件まで返す。
   * `digestEligible.count` は `limit` を掛ける前（除外後）の総数。
   */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    // 条件の日時・通し番号は Postgres の型へ変換できなければならない（query-check.ts）。
    // ADR 0547: 読みの口の条件は、下限（4714-11-24 BC）より前でも断らない。Postgres は下限へ寄せてから比べる。列の値は下限以後しか無いので、
    // 寄せずにそのまま比べても同じ答えになる（`since` 系は全件、`until` 系は0件）。寄せない。Invalid Date だけ断る（`22007`）。
    assertQueryDate("aggregateScope", "occurredAfter", scope.occurredAfter);
    assertQueryDate("aggregateScope", "occurredBefore", scope.occurredBefore);
    assertQueryDate("aggregateScope", "validAt", scope.validAt);
    assertQueryDate("aggregateScope", "decayFloorAtAfter", scope.decayFloorAtAfter);
    // ADR 0505: `decayFloorSeqAfter` は `bigint` の引数（行が無くても、範囲外なら Postgres はクエリの時点で拒む）。
    assertQueryBigint("aggregateScope", "decayFloorSeqAfter", scope.decayFloorSeqAfter);
    // ADR 0434: `attributes`（`jsonb` の包含判定の引数）と `labels`（`text[]` の引数）の NUL は、Postgres ではクエリの
    // 時点で拒まれる（`22P05`・`22021`）。`scopeAggregate: "skip"` で `digestBand` も無いときだけ、Postgres は
    // 集計も目次帯も引かずにクエリを1本も発行しないので、見ない。
    // ADR 0543: `labels`・`taxonomyGroupCandidates`（`text[]` の引数）の孤立サロゲートは、Postgres が引数を UTF-8 に変換するときに
    // U+FFFD に置き換わる。保存側（`tags`）が置き換わっているので、引数側も同じにしないと一致しない。
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
    // 目次帯の候補（ADR 0073）: totalInScope に数える条件と**同じ条件**で in-scope の
    // Memory を集める。`digestBand` が要求されなかった場合はこの配列を使わない。
    const inScopeMemories: Memory[] = [];
    // [ADR 0384](../../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)
    // 案C: `"skip"` のときはスコープ判定（`continue` するかどうか）は今までどおり行うが
    // ——`inScopeMemories`（digestBand の候補集め）に必要——、件数の集計（各カウンタの
    // インクリメント）だけを止める。`AggregateScopeOptions.scopeAggregate` の doc コメント
    // 「値だけ受け取って計算は今までどおり行う実装は禁止する」を、この fixture でも守る。
    const skipCounting = opts?.scopeAggregate === "skip";

    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) {
        continue;
      }
      // Issue #608 項目③(b) / ADR 0286: `PostgresMemoryStore.aggregateScope`
      // （`memory-store.ts` の `subjectFilter`）と同じ意味論——`includeSubjectless: true`
      // のときだけ `subject_id IS NULL`（主題なし）も scope 内に含める。
      const subjectMatches =
        scope.subjectId === undefined ||
        memory.subjectId === scope.subjectId ||
        (scope.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: `attributes` も `subjectId` と同じくスコープの外側の
      // 境界——落ちた分は `filtered*` のどの列にも数えず、`totalInScope` にも入れない。
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
      // ここに来るのは status IN ('active','contested') のみ。

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        if (!skipCounting) filteredPeriod += 1;
        continue;
      }
      // Issue #280（Issue #202 第2弾）: validAt ゲート。両端 null は「いつでも真」
      // （`RecallQuery.validAt` の doc 参照）。`postgres` 実装（`memory-store.ts`）と同じ、
      // **独立した2条件**として数える（`count(*) FILTER` を2本立てるのと同じ形）——
      // どちらか一方でも成立すればスコープ外だが、両方成立しうる壊れたデータ
      // （`validFrom > validUntil`）でも両方のカウンタへ計上する。`continue` で
      // 早期に打ち切ると片方しか数えなくなり、postgres 側の独立集計と食い違う。
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
      // Issue #201 PR-B（[ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
      // taxonomy ゲート。`attributes`（上）とは違い `period`/`validity` と同じ側
      // ——`totalInScope` から除かれ、かつ `filtered*` に数えられる
      // （`PostgresMemoryStore.aggregateScope` の `has_qualifying_label` と同じ意味論）。
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
      // ⭐ Issue #329 / ADR 0173: 忘却ゲートで落ちた件数。**`continue` しない**
      // ——`archived`/`period`/`expired` と違い、減衰しきった Memory は
      // `totalInScope`・群カウント・目次帯のいずれからも除かれない（スコープ内に在る）。
      // 述語は `PostgresMemoryStore.aggregateScope` の `isDecayed` と、
      // `recall-runtime.ts` の `survivesDecayGate` の否定と、同じものでなければならない。
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
          // ADR 0390: 除外 kind で索引済み（`notIndexed` の補集合）の行。
          excludedProvenanceIndexed += 1;
        }
      }
      // digestBand の候補集めは "skip" でも続ける（ADR 0384 案C: 目次帯は集計とは
      // 独立した経路。`AggregateScopeOptions.scopeAggregate` の doc コメント参照）。
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

    // Issue #201 PR-B（ADR 0323「決定5」）: `scope.taxonomyGroupCandidates` が渡された
    // ときだけ `axis: 'taxonomy'` の群を足す——`PostgresMemoryStore.aggregateScope` の
    // `taxonomy_label_groups`/`taxonomy_residual_count` と同じ意味論（`inScopeMemories` は
    // 既に `has_qualifying_label` を含む最終スコープなので、`hasQualifyingLabel`
    // フィルタと同じ内側を数える）。カウント0のラベル・残差は載せない
    // （`axis: 'subject'` の `in_scope > 0` と同じ規約）。
    // ADR 0384 案C: "skip" のときは taxonomy 群カウントも計算しない（`groups` は空のまま）
    // ——`RecallQuery.scopeAggregate` の doc コメント「件数集計を止める」が対象にするのは
    // `axis: 'subject'` だけではない。
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
      // `PostgresMemoryStore.aggregateScope` は `digestBand.limit` を生 SQL の `LIMIT`
      // にそのまま渡すため、負数を渡すと Postgres 自身が `LIMIT must not be negative`
      // で例外を投げる（in-memory-vector-store.ts の同種の注記・実測参照）。ここで
      // 検査せず `eligibleMemories.slice(0, opts.digestBand.limit)` へ渡すと、
      // `Array.prototype.slice` の負数引数により、スコープ内のほぼ全件の digest を
      // 静かに返してしまう——クエリを投げる前に弾く Postgres 側に揃える。
      // ⚠ 負数だけでは足りない——`LIMIT` の SQL パラメータは bigint 型であり、`NaN`/
      // `Infinity`/非整数を渡すと Postgres は `invalid input syntax for type bigint: "NaN"`
      // の形で例外を投げる（実測済み。in-memory-vector-store.ts の同種の注記参照）。
      // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
      // 「負数は例外」の回帰テストの文言を変えずに済ませる。
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
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順
      // （ADR 0073、`FakeMemoryStore.aggregateScope` と同じ規則）。
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      // ADR 0384 案C: `digestEligible` は件数の一種なので、"skip" では in-scope の
      // 母数（`totalInScope`）を数えていないぶん `eligibleMemories.length` も
      // 信じられる値ではない——`unknown`/`0` にする。digest 本文の候補一覧
      // （`digests`）自体は `inScopeMemories`（skip でも push を続けている）から
      // 変わらず正しく求まる。
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
      // ADR 0390: 空配列・未指定・"skip" は欄を足さない（"skip" は件数集計自体をしない）。
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

  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5
   * （Issue #305）: `record.advanceActivityClock === true` のとき `this.activitySeq` を
   * `+1` する——`await` を挟まない同期区間で行を作るのと同じ処理の中で行うことで、
   * `PostgresMemoryStore.createRecall` の「同一トランザクション」を模す
   * （`createObservationIdempotent`（ADR 0054）と同じ作法）。**`false`/未指定なら
   * 一切触らない**（既定 `'wall'` のテナントで `activity_seq` が動かない、という
   * ADR の意味論をここでも守る）。
   */
  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(record.subjectId, "record.subjectId");
    // ADR 0437 決定2: 書き込む先の subject のカウンタ（`tenant_subject_activity.subject_id`）も、書く前に断る。
    if (typeof record.advanceActivityClock === "object" && record.advanceActivityClock !== null) {
      assertWellFormedIdentifier(
        record.advanceActivityClock.subjectId,
        "record.advanceActivityClock.subjectId",
      );
    }
    assertRecallRecordStorable(record);
    const id = nextId("rcl");
    // Issue #1237: 省略時は壁時計。
    this.recalls.set(id, {
      ...snapshot(record),
      tenantId: ctx.tenantId,
      // Issue #1731: 呼び手の Date を共有しない（#1120、書き込む時点の複製）。
      createdAt: record.createdAt === undefined ? new Date() : snapshot(record.createdAt),
    });
    if (record.advanceActivityClock === true) {
      const current = this.activitySeq.get(ctx.tenantId) ?? 0;
      this.activitySeq.set(ctx.tenantId, current + 1);
    } else if (
      // ADR 0353（Issue #338）: `T` ではなく `S_x`（subject 単位）を進める。
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

  /**
   * Issue #298 / [ADR 0155](../../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
   * `createRecall` が書いた行を `recallId` から読み戻す。`PostgresMemoryStore.getRecall` と
   * 同じ契約——テナントが一致しない、または見つからなければ `null`。
   */
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
      // この in-memory 実装が保持する行は常に `createRecall` 経由で新規に書かれたものなので
      // `breakdownCaptured: true` で固定してよい（マイグレーション以前の行を模す必要が
      // 無い——それは postgres の適合スイート側の検査になる）。
      returnedMemories: { breakdownCaptured: true, memories: row.returnedMemories },
      createdAt: row.createdAt,
    });
  }

  /**
   * ADR 0079: 索引に載っていない Memory を選んで `pending` へ戻し、`embed` の outbox 行を
   * 積み直す。
   *
   * `PostgresMemoryStore.requeueEmbedJobs` は単一の `WITH ... INSERT ... SELECT` 文で
   * 更新と INSERT を同じトランザクションに入れる。**この実装が「同一トランザクション」を
   * 模せるのは、途中に `await` を挟まない同期区間で両方を行うからである**
   * （`createObservationIdempotent`（ADR 0054）と同じ形）——他の呼び出しの同期区間が
   * 割り込む余地が無いので、「更新だけ起きて INSERT が起きない」中間状態が外から
   * 観測されない。⚠ **`for` の中に `await` を入れないこと。**
   *
   * `statuses` を `readonly EmbeddingStatus[]` へ受け直しているのは、
   * **`NotIndexedReason` が `EmbeddingStatus` の部分集合であることを型で確かめる**
   * ためでもある（どちらかに値が増えてこの包含が崩れたら、ここが赤くなる）。
   */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    // `PostgresMemoryStore.requeueEmbedJobs` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡す。`NaN`・`Infinity`・非整数は、パラメータの bigint への変換の時点で
    // Postgres 自身が例外を投げる（実測: `invalid input syntax for type bigint: "NaN"` 等）。
    // 負数の `LIMIT must not be negative` は常には出ない（実測、ADR 0575 と同じ形）: この `LIMIT` は
    // `WITH target AS (...) UPDATE ... FROM target` の CTE の中にあり、テナントの行が1本も無く、`memories` の
    // 統計が古い（`reltuples = 0`）と、`Limit` は `never executed` になり、何も書かずに
    // `{ requeued: 0 }` で返る。対象の行が1本でもあるか、統計が無ければ投げる。Postgres は負数を断る約束ではない
    // ——この fixture は常に断る。ここで検査せず `.slice(0, Math.max(0, opts.limit))` へ
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
    // ADR 0434: `writeOpts.now` は `available_at`・`created_at`（`timestamptz`）の引数で、Postgres は対象の行が
    // 0件でも Invalid Date を `22007` で拒む（実測）。`memoryIds` が空配列のときだけ、Postgres はクエリを
    // 発行せずに `{ requeued: 0 }` を返す（`buildRequeueEmbedTargetSelect` が `null`）ので、見ない。
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

    // Issue #1237: 積み直す embed ジョブの時刻。省略時は1回だけ壁時計を読む。
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
   * ADR 0114 / [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15
   * （Issue #305）: `docs/memory-model.md` §11 行8の掃引。`status = 'active'` の Memory を
   * `opts.clock`（省略時 `'wall'`）で選び、`decayFloorAt` 昇順で `opts.limit` 件まで
   * `status='archived'` への更新と `kind='archived'` のイベント追記を1つの同期区間
   * （`await` を挟まない）で行う——`requeueEmbedJobs` / `supersedeWithNewMemories` と
   * 同じ作法で、postgres 実装の単一トランザクションを模す。
   *
   * `opts.clock` の分岐は `PostgresMemoryStore`/`buildArchiveDecayedTargetSelect`
   * （`packages/postgres/src/memory-store.ts`）と同じ形——**境界の非対称
   * （ゲートは狭義 `>`、掃引は境界を含む `<=`）を1バイトも変えずに写す**。
   * `'either'` は AND（両方の軸で沈んでいるものだけ掃く。ゲートの OR とは逆向き、
   * `ArchiveDecayedOptions.clock` の doc コメント参照）。
   *
   * `digestSnapshot` には更新前の `digest` を入れる（`updateStatusWithEvent` を経由する
   * `forget` と同じ規約、docs/memory-model.md §9）。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    assertWellFormedCtx(ctx);
    // 条件の日時・通し番号は Postgres の型へ変換できなければならない（query-check.ts）。
    assertQueryTimestamptz("archiveDecayed", "now", opts.now);
    // ADR 0505・Issue #1731: `nowSeq` は `bigint` の引数。整数でない値（`assertQueryBigint` が整数も見る）も範囲外も、行が無くても Postgres はクエリの時点で拒む。
    // ただし壁時計の clock は `nowSeq` を SQL に入れない（`wall` は `decay_floor_at` だけ）ので、どちらも見ない。
    if ((opts.clock ?? "wall") !== "wall") {
      assertQueryBigint("archiveDecayed", "nowSeq", opts.nowSeq);
    }
    // `PostgresMemoryStore.archiveDecayed`（`buildArchiveDecayedTargetSelect`）は
    // `opts.limit` を生 SQL の `LIMIT`（bigint パラメータ）にそのまま渡す。`NaN`・`Infinity`・
    // 非整数は、bigint への変換の時点で Postgres 自身が例外を投げる（実測:
    // `invalid input syntax for type bigint: "NaN"` 等。Issue #880）。負数の
    // `LIMIT must not be negative` は常には出ない（実測、ADR 0575 と同じ形）: この `LIMIT` は
    // `WITH target AS (...) UPDATE ... FROM target` の CTE の中にあり、テナントの行が1本も無く、`memories` の
    // 統計が古い（`reltuples = 0`）と、`Limit` は `never executed` になり、何も書かずに
    // `{ archived: [] }` で返る。対象の行が1本でもあるか、統計が無ければ投げる。Postgres は負数を断る約束ではない
    // ——この fixture は常に断る。ここで検査せず `.slice(0, Math.max(0, opts.limit))` へ渡すと、
    // `Math.max(0, NaN)` は `NaN`（`slice` はこれを `0` として扱う＝0件）に、
    // `Math.max(0, Infinity)` は `Infinity`（`slice` は対象を無条件に全件）にしてしまう
    // ——このメソッドは書き込みの副作用（`status` を `archived` にし、イベントを積む）
    // を持つため、他の口（PR #811/#875 の limit ガード）より実害が大きい。クエリを
    // 投げる前に弾く Postgres 側に揃える（`InMemoryMemoryStore.purgeExpiredEvents` と
    // 同じ2段の順序: 非整数を先に、次に負数を見る）。
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
    const passesWall = (m: Memory): boolean => m.decayFloorAt.getTime() <= nowMs;
    // ADR 0353（Issue #338）: `usesSubjectActivityCounters` が true のときだけ、
    // その Memory の subjectId に対応する `S_x` を足す（postgres 側
    // `activityFloorSeqDeadCondition` と同じ式）。
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
      // ADR 0505: `nowSeq + S_x` が `bigint` を溢れる行で、式が評価されたなら Postgres は `22003` で失敗する
      // （`decay_floor_seq IS NOT NULL AND …` の短絡で、非 NULL の行。subject なしの行は `S_x` を引かない）。
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
      // 'either': AND（両方の軸で沈んでいるものだけ掃く）。
      return passesWall(m) && passesActivity(m);
    };

    // ⭐ ADR 0165 決めたこと8: **並べる軸は、掃く軸に合わせる。**`clock: 'activity'` では
    // `decayFloorSeq` 昇順で選ぶ（`packages/postgres` の `buildArchiveDecayedTargetSelect` と
    // 同じ規律——向こうでは `idx_memories_recall_gate_seq` が並び替えを担えるかどうかが
    // 掛かっている。詳しい経緯はそちらの doc コメントを見ること）。
    // ⚠ **返り値 `archived` の並び順の契約は変えない**——下で `decayFloorAt` 昇順に
    // 並べ直す。ここで変わるのは「`limit` が効くときに *どの行を選ぶか*」だけである。
    // `'either'` は壁時計のまま（掃引の条件が AND なので、どちらの軸も単独では足りない）。
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
        // Issue #1237: `archived` の `at` は `opts.now`（`@mnemora/postgres` と同じ）。
        at: opts.now,
        actor: { type: "system" },
        digestSnapshot,
        sizeBeforeBytes: null,
        meta: {},
      });
      this.events.push(storedEvent);
      archived.push({ memoryId: memory.id, decayFloorAt: new Date(memory.decayFloorAt) });
    }
    // `packages/postgres` の外側クエリ（`ORDER BY decay_floor_at ASC, id ASC`）と
    // 同じ契約に揃える——選び方が clock で変わっても、**返る並びは常に `decayFloorAt` 昇順**。
    archived.sort(
      (a, b) =>
        a.decayFloorAt.getTime() - b.decayFloorAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return { archived, reachedLimit: opts.limit > 0 && archived.length === opts.limit };
  }

  /**
   * Issue #198 / ADR 0124 / [ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md):
   * `forgotten` かつ未 purge（`purgedAt === null`）の Memory だけを対象にした CAS
   * ——`content`/`digest` をトゥームストーンで上書きし `purgedAt` を設定した上で
   * `kind: 'purged'` のイベントを積む。`status` は動かさない（`purged` は `status` の値では
   * ない）。条件を満たさなければ {@link MemoryPurgeConflictError} を投げる（`updateStatus`/
   * `updateStatusWithEvent` と同じ「まだ何も書いていないうちに判定する」作法）。
   *
   * 🔴 ADR 0375 決定1〜3: `content`/`digest`/`purgedAt` に加えて、`tags`/`attributes`/
   * `claimKey` を空にし、label の紐付けを外して `proposedCount` を減らし（`memoryLabels`
   * 参照）、このテナントの `recalls` の `indexBand.digestBand` から該当 `memoryId` の
   * `digest` を書き換える——`packages/postgres` の `purgeMemory` と同じ範囲。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // ADR 0434: 墓石の `content`・`digest` は `text` 列へ書く値で、Postgres は NUL を拒む（`22021`）。対象の行が
    // 無くても・CAS に弾かれる状態でも、同じ UPDATE 文の引数として拒む（実測）ので、行を引く前に見る。
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
    // ADR 0640: `purged_at`・`memory_events.at` に入る `event.at` が下限より前なら、墓石と同じく同じ UPDATE 文の引数として
    // `22008` で拒む（実測。CAS に弾かれる状態の行でも拒む）ので、行を引く前に見る。
    assertWrittenTimestamptzFloor("memory_events", "at", event.at);
    // ADR 0543: 墓石の `content`・`digest` は `text` 列へ書く値。孤立サロゲートは U+FFFD に置き換えて保存する。
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
    // ADR 0466: イベントが指す記憶は `ctx` のテナントの行（墓石を書く前に確かめる）。
    this.assertEventTargetOwn(ctx, event.memoryId, [id]);
    // Issue #1237: `purgedAt` と `memory_events.at` を同じ値にする——省略時も1つの壁時計を
    // 2回読んで別の値になることがないよう、ここで一度だけ決める（`@mnemora/postgres` と同じ規律）。
    // Issue #1731: 呼び手の `event.at` を `purgedAt` と共有しない（#1120、書き込む時点の複製）。
    const at = event.at === undefined ? new Date() : snapshot(event.at);
    memory.content = tombstone.content;
    memory.digest = tombstone.digest;
    memory.tags = [];
    memory.attributes = {};
    memory.claimKey = null;
    memory.purgedAt = at;
    memory.updatedAt = new Date();

    // ADR 0375 決定2: label の紐付けを外し、proposed な label の proposedCount を減らす。
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

    // ADR 0375 決定3: このテナントの recalls.index_band の digestBand から、この
    // memoryId のエントリを見つけてトゥームストーンへ書き換える（`recalls.query` は
    // 触らない——`memoryId` で特定できないため、決定4）。
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
   * [ADR 0437](../../../../docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定3:
   * `packages/postgres` の `scrubPurged` と同じ契約。`forgotten` かつ `purgedAt` が非 `null` の
   * 行だけを対象に、`tags`・`attributes`・`claimKey` を空にし、label の紐付けを外して
   * `proposedCount` を外した本数だけ減らす。残骸の無い行は書き換えない（`updatedAt` も動かさない）。
   * ADR 0512: `recalls.indexBand.digestBand` の、この行のエントリの digest も行の `digest` へ伏せる。
   * in-memory は同期区間で完結する（`await` を挟まない）ので、同時呼び出しでも二重には数えない。
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
      // ADR 0512: このテナントの recalls.indexBand.digestBand の、この行のエントリを、行の digest
      // （トゥームストーン）へ伏せる（truncated は落とす。同じ digest のエントリは書き換えない）。
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
   * Issue #197 / ADR 0134: 両側とも `status === 'active'` の CAS を課したうえで、
   * `status='contested'`・`contestedWithId` を相互に設定する。**in-memory にトランザクションは
   * 無い**——「まだ何も書いていない」ことでロールバックを模す
   * （`supersedeWithNewMemories`/`updateStatusWithEvent` と同じ「まだ何も書いていないうちに
   * 判定する」作法）。存在確認・CAS 判定の両方を先に済ませ、どちらか一方でも失敗したら
   * この時点で throw する——`first`/`second` のどちらの Map エントリもまだ書き換えていない。
   *
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
    // ADR 0466: 2つのイベントが指す記憶は、`ctx` のテナントの行（この呼び出しで更新する2行を含む）。
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
   * Issue #197 / ADR 0150: `markContestedPair` の解決側。両側とも `status === 'contested'`
   * かつ相互参照が成立していることを CAS で課したうえで、`contestedWithId` を両側とも
   * `null` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する。
   * **in-memory にトランザクションは無い**——`markContestedPair` と同じ「まだ何も書いて
   * いないうちに判定する」作法（存在確認・CAS 判定の両方を先に済ませ、どちらか一方でも
   * 失敗したらこの時点で throw する。`first`/`second` のどちらの Map エントリもまだ
   * 書き換えていない）。
   *
   * CAS の失敗（どちらかが `"contested"` でない・相互参照が成り立っていない）は {@link MemoryStatusConflictError}。
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
    // ADR 0499: 型の外の status は、書く前に断る（`PostgresMemoryStore` と同じ位置・同じ文面）。
    assertResolvedStatus("resolveContestedPair", "first", first.status);
    assertResolvedStatus("resolveContestedPair", "second", second.status);
    // ADR 0503: 置き換えた側を伴わない superseded・自己置換・active への supersededById・互いを指す循環は、書く前に断る。
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
    // ADR 0439: `supersededById` は `ctx` のテナントの Memory であること（`PostgresMemoryStore` は UPDATE の中で確かめる）。
    this.assertOwnMemoryRef(ctx, first.supersededById);
    this.assertOwnMemoryRef(ctx, second.supersededById);
    // ADR 0515: 対の外の `forgotten` な記憶を置き換えた側にしない（`resolveContestedGroup` と同じ）。対の相手を指すのは断らない。
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
    // ADR 0466: `markContestedPair` と同じ。
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

  /**
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.markContestedGroup?` の実装（契約は
   * interface 側の doc コメントにある）。**in-memory にトランザクションは無い**——
   * `markContestedPair` と同じ「まだ何も書いていないうちに判定する」作法（全員の
   * 存在確認・CAS 判定を先に済ませ、1件でも失敗したらこの時点で throw する）。
   */
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

    // ADR 0431: 呼び出し時点で既に contested かつ contestedWithId が無いメンバーは、書いても状態が
    // 変わらない（既存の群のメンバーを吸収する場合）。そのメンバーには `updated` を積まない。
    const unchanged = memories.map(
      (memory) => memory.status === "contested" && (memory.contestedWithId ?? null) === null,
    );
    // ADR 0466: イベントを積むメンバーだけ、そのイベントが指す記憶が `ctx` のテナントの行かを確かめる
    // （積まないメンバーは確かめない。`PostgresMemoryStore` と同じ）。書き換える前に。
    members.forEach((m, i) => {
      if (!unchanged[i]) this.assertEventTargetOwn(ctx, m.event.memoryId, ids);
    });
    for (const memory of memories) {
      memory.status = "contested";
      memory.contestedWithId = null;
      memory.updatedAt = new Date();
    }

    // ADR 0381 決定1: 有効期間が重なる組だけに関係の行を張る（ADR 0324 決定4との整合）。
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

  /** `markContestedGroup`/`resolveContestedGroup` が使う内部ヘルパー——双方向2行を冪等に足す。 */
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

  /**
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.resolveContestedGroup?` の実装
   * （契約は interface 側の doc コメントにある）。`markContestedGroup` と対称——
   * 決着の種類に関わらず、このメンバー全員を結んでいた関係の行を消す
   * （ADR 0381 決定3、2者版 `resolveContestedPair` と同じ扱いに揃える）。
   */
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
    // ADR 0499: 型の外の status は、書く前に断る（`PostgresMemoryStore` と同じ位置・同じ文面）。
    members.forEach((m, i) =>
      assertResolvedStatus("resolveContestedGroup", `members[${i}]`, m.status),
    );
    // ADR 0503: 2者版と同じ（置き換えた側の欠落・自己置換・active への supersededById・循環）。
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

    // 2026-09-30 の直し（ADR 0381 追記、段階Bの穴埋め）: `members` が、関係の行で
    // つながった「今も contested な」群の全員と一致することを CAS で課す
    // （`PostgresMemoryStore.resolveContestedGroup` と同じ形。決定10と矛盾しない
    // ——forget 等で抜けたメンバーは `status` が `contested` でなくなっているので、
    // この到達集合には入らない）。
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
        // 2026-09-30 のさらなる直し（ADR 0381 §7 解消）: MemoryStatusConflictError の
        // 再利用をやめ、専用のエラーを投げる。
        throw new ContestedGroupMembershipMismatchError(missing[0]!);
      }
    }
    // ADR 0439: `supersededById` は `ctx` のテナントの Memory であること。
    for (const m of members) {
      this.assertOwnMemoryRef(ctx, m.supersededById);
    }
    // ADR 0503: 群の外の `forgotten` な記憶を置き換えた側にしない（敗者が、もう戻らない勝者に置き換えられた行になる）。
    // 群の中を指すのは、メンバーの status に関わらず断らない。
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
    // ADR 0466: 全メンバーのイベントが指す記憶は、`ctx` のテナントの行。書き換える前に。
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

  /**
   * [Issue #825](https://github.com/takecchi/mnemora/issues/825)（ADR 0150 追記）:
   * `resolveContestedPair`（上）の解決側 CAS を満たせなくなった生存側1件だけを対象にした
   * 別の任意メソッド。契約は `MemoryStore.resolveOrphanedContested`（`@mnemora/core`）側に
   * ある。対向の行には一切触れない。
   *
   * CAS の失敗（`"contested"` でない・対向が渡された値と違う）は {@link MemoryStatusConflictError}。
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
    const memory = this.rawGet(ctx, survivor.id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${survivor.id}`);
    }
    if (memory.status !== "contested" || memory.contestedWithId !== survivor.contestedWithId) {
      throw new MemoryStatusConflictError(survivor.id, "contested", memory.status);
    }

    assertStorableMemoryEvent(survivor.event);
    assertCloneableMemoryEvent(survivor.event);
    // ADR 0466: イベントが指す記憶は `ctx` のテナントの行。
    this.assertEventTargetOwn(ctx, survivor.event.memoryId, [survivor.id]);
    memory.status = "active";
    memory.contestedWithId = null;
    memory.updatedAt = new Date();

    const storedEvent = buildStoredMemoryEvent(ctx, survivor.event);
    this.events.push(storedEvent);

    return snapshot({ memory, event: storedEvent });
  }

  /**
   * Issue #372（(B) 第2段）: `MemoryStore.findActiveByClaimKey?` の実装（契約は interface
   * 側の doc コメントにある）。`packages/postgres` の実装と同じ4つの絞り込み——
   * `subjectId` は `null` 同士も一致・`claimKey` は正規化済み文字列のまま等値比較・
   * `status === "active"`・`contentHash` が違う——に加え、有効期間の重なりを判定する。
   * **LLM を一度も呼ばない。**
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
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    // ADR 0543: 検索値（`text` 列の引数）の孤立サロゲートも、Postgres では U+FFFD に置き換わって比べられる。
    query = { ...query, claimKey: replaceLoneSurrogatesInClaimKey(query.claimKey) };
    // 条件の日時は Postgres の timestamptz へ変換できなければならない（query-check.ts）。
    // ADR 0547: 読みの口の条件は、下限（4714-11-24 BC）より前でも断らない。Postgres は下限へ寄せてから比べる。列の値は下限以後しか無いので、
    // 寄せずにそのまま比べても同じ答えになる（`since` 系は全件、`until` 系は0件）。寄せない。Invalid Date だけ断る（`22007`）。
    // 空の区間かどうかも、寄せずに元の値で決める（両端が下限より前でも from < until なら空ではない）。
    assertQueryDate("findActiveByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findActiveByClaimKey", "validUntil", query.validUntil);
    // ADR 0434: `claim_key_subject`・`claim_key_predicate` は `text` 列。検索値の NUL は Postgres ではクエリの時点で拒まれる。
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
      // ADR 0543: 保存側の `contentHash` は置き換え済み。Postgres は引数（`content_hash <> $n`）も U+FFFD にしてから比べるので、揃える。
      if (m.contentHash === replaceLoneSurrogates(query.contentHash)) return false;
      // 半開区間 [validFrom, validUntil) の重なり判定。`null` は -∞/+∞ として扱う
      // （`packages/postgres` の実装と同じ規約）。
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
    return snapshot(matches);
  }

  /**
   * Issue #933（案2、ADR 0378）: `MemoryStore.findContestedByClaimKey?` の実装（契約は
   * interface 側の doc コメントにある）。`findActiveByClaimKey` と同じ絞り込みのうえで、
   * `status === "active"` の代わりに `status === "contested"` を見る。
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
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    // ADR 0543: `findActiveByClaimKey` と同じ。
    query = { ...query, claimKey: replaceLoneSurrogatesInClaimKey(query.claimKey) };
    // ADR 0547: 読みの口の条件は、下限（4714-11-24 BC）より前でも断らない。Postgres は下限へ寄せてから比べる。列の値は下限以後しか無いので、
    // 寄せずにそのまま比べても同じ答えになる（`since` 系は全件、`until` 系は0件）。寄せない。Invalid Date だけ断る（`22007`）。
    // 空の区間かどうかも、寄せずに元の値で決める（両端が下限より前でも from < until なら空ではない）。
    assertQueryDate("findContestedByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findContestedByClaimKey", "validUntil", query.validUntil);
    // ADR 0434 の負債（ADR 0500）: 兄弟の `findActiveByClaimKey` と同じ。`claim_key_subject`・`claim_key_predicate` は `text` 列で、
    // 検索値の NUL は Postgres ではクエリの時点で拒まれる。
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
      // ADR 0543: `findActiveByClaimKey` と同じ（引数の `contentHash` も置き換えてから比べる）。
      if (m.contentHash === replaceLoneSurrogates(query.contentHash)) return false;
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
    return snapshot(matches);
  }

  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` の実装（契約は
   * interface 側の doc コメントにある）。`packages/postgres` の実装と同じ絞り込み
   * （`subjectId` は `null` 同士も一致・`status === "active"`・`claimKey` を持つ行のみ）
   * のうえで、predicate ごとに最も新しい `createdAt` を代表値にして降順ソートし、
   * `limit` 件までを返す。
   */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
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
    for (const m of this.memories.values()) {
      if (m.tenantId !== ctx.tenantId) continue;
      if ((m.subjectId ?? null) !== query.subjectId) continue;
      if (m.status !== "active") continue;
      // `PostgresMemoryStore.listActiveClaimPredicates` の SQL
      // （`claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`）と同じく、
      // 主語か述語の片方が欠けた claim key は数えない（以前は述語の欠けた鍵から
      // `undefined` を一覧に混ぜていた。歯は `in-memory-list-claim-predicates-incomplete-key.test.ts`）。
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
   * `docs/memory-model.md` §11 行15「`superseded → active`」。契約は
   * `MemoryStore.restoreSupersededBy`（`@mnemora/core`）側にある——ここは選定・更新の
   * 実装のみ。`archiveDecayed`（直上ではなく本クラス冒頭寄りのメソッド）と同じ
   * 「範囲走査 + 一括更新」の形——`await` を挟まない同期区間で選定・更新・イベント
   * 追記を行うことで、postgres 実装の単一トランザクションを模す。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: 指定すると、選定条件に
   * `onlyMemoryIds.includes(m.id)` を積集合として足す——`packages/postgres` の
   * `AND id = ANY(...)` と同じ意味。
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
    // 1件目を書き換える前に、書くイベントが書けるかを確かめる（`at` の Invalid Date・`actor` の
    // structuredClone できない値）。ループの中の `buildStoredMemoryEvent` で初めて投げると、先の行だけが
    // 戻ってイベントの無い半端な状態が残る——Postgres は1文で巻き戻る。対象が無いときは今までどおり
    // 確かめない（投げる入力を増やさない。Postgres も対象が無ければ Invalid Date の `at` で空を返す——
    // #1229 の行3で Postgres の側をこちらに揃えた）。
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
      // ADR 0640: 下限より前の `at` は、対象が1件も無くても Postgres が `22008` で拒む（実測。Invalid Date が対象が無ければ通るのは、上のコメントのとおり別の話）。
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
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口
   * （Issue #515、ADR 0237）。契約は `MemoryStore.previewRestoreSupersededBy`（`@mnemora/core`）
   * 側にある——対象の選び方は `restoreSupersededBy` と同じ `filter` を使う。
   * `this.events`（`InMemoryEventStore` と共有する配列、ファイル冒頭の doc コメント
   * 参照）から、対象ごとに直近の `kind: 'superseded'` イベントを探して
   * `meta.reason` を運ぶ——見つからなければ `null`。書き込みは一切行わない。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy` と
   * 同じ意味の積集合フィルタ——対象の選び方を完全に一致させる。
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

  /**
   * Issue #201 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md):
   * `listLabels?`（`PostgresMemoryStore.listLabels` と同じ契約）。
   *
   * Issue #881 / ADR 0318 追記（2026-09-26、クローン miku の判断）: `name` の並び順は
   * **コードポイント順**（Postgres の `COLLATE "C"` と同じ、バイト順）と決めた。
   * `localeCompare`（ロケール依存の自然順）はこの契約とずれる——`compareLabelName`
   * （このファイル下）に置き換える。
   */
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

  /**
   * Issue #201 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md):
   * `registerLabel?`（`PostgresMemoryStore.registerLabel` と同じ契約）。
   *
   * `name` に NUL（U+0000）を含むと投げる——`PostgresMemoryStore` は `labels.name`（`text` 列）が
   * NUL を拒んで例外になる（`invalid byte sequence for encoding "UTF8": 0x00`、実測）。ラベルの名前は
   * `tags` の要素と同じ語彙で、`tags` の NUL はこの fixture の `createMemory` がすでに拒んでいる
   * （Issue #816）。
   */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    assertWellFormedCtx(ctx);
    if (name.includes("\u0000")) {
      throw new Error(`InMemoryMemoryStore: label name must not contain NUL characters (U+0000)`);
    }
    // ADR 0543: `labels.name` は `text` 列。孤立サロゲートは U+FFFD に置き換えて保存する（`tags` の要素と同じ）。
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
   * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
   * このテナントに属する行を、`memory_labels`・`recall_usages`・`memory_events` →
   * `memories`（+ 冪等キー `extractionIndex`）→ `observations` → `recalls` → `labels` →
   * `tenant_activity`・`tenant_subject_activity` の順で消す
   * （`PostgresMemoryStore.eraseTenant` と同じ表の並び、`MemoryStore.eraseTenant` の
   * doc コメント参照）。
   *
   * この in-memory 実装は `Map`/`Set` の上に成り立っており、外部キー制約も
   * トランザクションの原子性も持たない——`blocked_by_foreign_reference`
   * （他テナントの行がこのテナントの行を FK で参照している）は返さない
   * （`packages/postgres` 固有の振る舞い。`postgres` の実装 doc 参照）。自己参照
   * （`superseded_by_id`/`contested_with_id`）の事前 NULL 化も、`Map` からの削除が
   * FK エラーを起こさないため不要——単純に対象の行を消すだけでよい。
   *
   * [ADR 0426](../../../../docs/decisions/0426-in-memory-erase-tenant-postgres-alignment.md):
   * 消した `memories` の埋め込みは、{@link onMemoriesDeleted} で登録された
   * `InMemoryVectorStore` が一緒に消す（Postgres の `ON DELETE CASCADE`。件数には数えない）。
   * `tenant_subject_activity` は subject ごとに1行として数える。
   *
   * `reachedLimit` は `PostgresMemoryStore.eraseTenant` と同じ「保守的な近似」
   * （ある表でちょうど budget 分だけ削除できた場合、それ以上残っているかを
   * 追加で確認せず `true` を返す）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult> {
    assertWellFormedCtx(ctx);
    // ADR 0493: `limit` は `bigint` の引数へ渡される。整数でない・範囲外は Postgres が拒む（負数そのものは拒まない）。
    assertQueryBigint("eraseTenant", "limit", opts.limit);
    const limit = opts.limit;
    const dryRun = opts.dryRun === true;
    let remaining = limit;
    let total = 0;
    let reachedLimit = false;

    // 汎用ヘルパー: `matches(key, value)` を満たすエントリを budget 個まで集め、
    // `dryRun` でなければ Map/Set から取り除く。戻り値は削除した（またはプレビューで
    // 数えた）件数。
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
    // `labels`/`memoryLabels` は key 自体が `JSON.stringify([tenantId, ...])`——
    // value に `tenantId` を持たないので、key から読む。
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
      // memory_labels
      () => drainKeyedMap(this.memoryLabels),
      // recall_usages（key: `${tenantId}:${recallId}:${memoryId}`）
      // ADR 0604: 前方一致ではなく、鍵から取り出した tenantId の完全一致（`acme` を消しても `acme:eu` は残す）。
      () => drainSet(this.usages, (key) => tenantOfUsageKey(key) === ctx.tenantId),
      // memory_events
      () => drainArray(this.events, (event) => event.tenantId),
      // memory_relations（Issue #207/#933 PR2 の `relations`。`InMemoryRelationStore` と共有）
      () => drainArray(this.relations, (relation) => relation.tenantId),
      // memories（+ 冪等キー extractionIndex の掃除。budget には数えない——見えない
      // 内部索引であり、Postgres 側に対応する別テーブルが無いため）。
      // ADR 0426: 消した memories の埋め込みも listener 経由で消す（Postgres の
      // `ON DELETE CASCADE`）。CASCADE で消えた行と同じく、budget にも `deleted` にも数えない。
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
      // observations
      () => drainMap(this.observations, (observation) => observation.tenantId),
      // recalls
      () => drainMap(this.recalls, (recall) => recall.tenantId),
      // labels
      () => drainKeyedMap(this.labels),
      // tenant_activity（高々1エントリ）
      () => {
        if (remaining <= 0) return 0;
        if (!this.activitySeq.has(ctx.tenantId)) return 0;
        if (!dryRun) this.activitySeq.delete(ctx.tenantId);
        return 1;
      },
      // tenant_subject_activity（`(tenant_id, subject_id)` が主キー——ADR 0426: 内側の
      // `Map<subjectId, seq>` の1エントリを1行として数え、budget ぶんだけ消す）
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
        // budget をちょうど使い切った——保守的に「まだ残っているかもしれない」とみなす
        // （interface doc の近似。`PostgresMemoryStore.eraseTenant` と同じ判断）。
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
    // 区切り文字で繋がず、`JSON.stringify` の配列で表す。`tenantId`・`extractorVersion`・
    // `contentHash` は呼び手の値で `:` を含んでよく、繋ぐと別の組と同じキーになる
    // （`joined-string-keys.postgres.test.ts`）。
    return JSON.stringify([tenantId, sourceObservationId, extractorVersion, contentHash]);
  }
}
