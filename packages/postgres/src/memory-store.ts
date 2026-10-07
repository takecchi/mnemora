import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  computeEventRetentionCutoff,
  DEFAULT_DECAY_CLOCK,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
} from "@mnemora/core";
import {
  ContestedGroupMembershipMismatchError,
  ContestedWithoutCompanionError,
  EMBEDDING_STATUS_ROLLBACK,
  isContestedWithoutCompanion,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  SourceMemoryForgottenError,
  SourceMemoryStatusChangedError,
} from "@mnemora/core";
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
  RecallRecordReturnedMemories,
  RecallScope,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
  ScopeAggregate,
} from "@mnemora/core";
import {
  assertWellFormedCtx,
  assertWellFormedIdentifier,
  assertWellFormedNewMemory,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { assertNewMemoryHalfLivesFitFloat4 } from "./half-life-float4.js";
import { maybeAnalyzeMemoriesAfterWrite } from "./memories-statistics.js";
import { lockTenantForErase } from "./erase-tenant-lock.js";
import { translateClaimKeyIndexLimit } from "./claim-key-index-limit.js";
import {
  assertNoNul,
  assertNoNulInNewMemory,
  assertNoNulInNewMemoryEvent,
  assertNoNulInNewObservation,
  assertNoNulInNewRecall,
  assertNoNulInScopeFilter,
} from "./input-check.js";
import {
  activityFloorSeqAliveCondition,
  activityFloorSeqDeadCondition,
  ownSubjectActivityNow,
} from "./activity-decay-sql.js";
import {
  isUuidLike,
  normalizeUuidCase,
  parsePgTimestamp,
  rowToLabel,
  rowToMemory,
  rowToMemoryEvent,
  rowToObservation,
  rowToOutboxJob,
  rowToRecallRecord,
  isBeforePgTimestamptzMin,
  toPgTimestamp,
  toPgTimestampClamped,
  type LabelRow,
  type MemoryEventRow,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
  type RecallRow,
} from "./mapping.js";

/**
 * `db.transaction(async (tx) => ...)` に渡るコールバック引数と、トランザクションを開いていない `this.db` の両方を受け付ける
 * ための構造的な最小 interface（`.execute` だけを持つ）。
 */
type SqlExecutor = Pick<Db, "execute">;

/**
 * `subject_id` を「NULL 同士も一致」として比較する述語を、**索引で引ける形**で作る。`subject_id IS NOT DISTINCT FROM $n` は
 * 索引で引けないので、`subjectId` が `null` なら `subject_id IS NULL`、そうでなければ `subject_id = $n` に分ける。
 */
function subjectIdMatches(subjectId: string | null): SQL {
  return subjectId === null ? sql`subject_id IS NULL` : sql`subject_id = ${subjectId}`;
}

/**
 * コードポイント順の比較（ADR 0511）。SQL の `ORDER BY name COLLATE "C"`（UTF-8 のバイト順）と同じ並びになる
 * （JS 既定の `sort()` は UTF-16 のコード単位順で、BMP の上位と補助面の文字で食い違う）。
 */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done === true || y.done === true) {
      return x.done === true && y.done === true ? 0 : x.done === true ? -1 : 1;
    }
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/**
 * 既に在る `labels` の行を、名前のコードポイント順に `FOR UPDATE` で先に取る（ADR 0511）。候補をまたぐ順が揃わないと、
 * 同じ語彙を逆の候補順で持つ2つの呼び出しが互いの行を待って 40P01 になるので、全候補の語彙をまとめて呼ぶ。
 * まだ無い名前の行は取れない（新しい行どうしの競合は残る）。`Memory.tags`・`proposedCount` は変えない。
 */
async function lockExistingLabelsInNameOrder(
  exec: SqlExecutor,
  ctx: Ctx,
  tagLists: ReadonlyArray<readonly string[]>,
): Promise<void> {
  // NUL（U+0000）を含む名前は問い合わせに載せない。DB が生の例外で断り、後の名指しの検査（`assertNoNulInNewMemory`）より
  // 前に例外の形が変わるため。
  const names = Array.from(new Set(tagLists.flat())).filter((name) => !name.includes("\u0000"));
  if (names.length === 0) {
    return;
  }
  await exec.execute(sql`
    SELECT l.id FROM labels l
    WHERE l.tenant_id = ${ctx.tenantId} AND l.name = ANY(${sql.param(names)}::text[])
    ORDER BY l.name COLLATE "C" ASC
    FOR UPDATE OF l
  `);
}

/**
 * `opts.abortIfForgotten` を実装する共通部分（ADR 0375）。**呼び出し元のトランザクション（`tx`）の中で、まだ何も書く前に**
 * 呼ぶこと。`SELECT … FOR UPDATE` で対象行をロックしたうえで `status` を見直し、1件でも `"forgotten"` なら
 * {@link SourceMemoryForgottenError} を投げる（`tx` ごと rollback）。空配列・`undefined` なら何もしない。
 *
 * `FOR UPDATE` で、見直しと同じトランザクションの中で対象行をロックする。見直しと書き込みの間に窓が無くなり、commit するまで
 * 他のトランザクション（`forget`/`purge`）が行を書き換えられない。
 *
 * **`ORDER BY id ASC FOR UPDATE`**: 行ロックを掴む順を、`markContestedPair`/`resolveContestedPair`/`markContestedGroup` と
 * 同じ id 昇順に揃える。`ORDER BY` が無いと掴む順が実行計画に依存し、`consolidate` と `markContestedPair` が同じ行を逆順で
 * 掴み合って 40P01（`deadlock detected`）を生のまま漏らしうる。
 */
async function assertNotForgottenForUpdate(
  tx: SqlExecutor,
  ctx: Ctx,
  ids: ReadonlyArray<MemoryId> | undefined,
  method:
    "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents" | "supersedeWithNewMemories",
): Promise<void> {
  if (ids === undefined || ids.length === 0) {
    return;
  }
  const wellFormedIds = ids.filter((id) => isUuidLike(id));
  if (wellFormedIds.length === 0) {
    return;
  }
  const rows = await tx.execute(sql`
    SELECT id, status FROM memories
    WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
    ORDER BY id ASC
    FOR UPDATE
  `);
  const forgottenIds = (rows.rows as unknown as Array<{ id: MemoryId; status: MemoryStatus }>)
    .filter((row) => row.status === "forgotten")
    .map((row) => row.id);
  if (forgottenIds.length > 0) {
    throw new SourceMemoryForgottenError(method, forgottenIds);
  }
}

/**
 * `opts.abortIfSuperseded` を実装する共通部分（ADR 0420）。{@link assertNotForgottenForUpdate} の直後に、同じ
 * トランザクションの中で `FOR UPDATE` でもう一度読み、1件でも `"superseded"` なら
 * {@link SourceMemoryStatusChangedError} を投げる（`tx` ごと rollback）。空配列・`undefined` なら何もしない。
 */
async function assertNotSupersededForUpdate(
  tx: SqlExecutor,
  ctx: Ctx,
  ids: ReadonlyArray<MemoryId> | undefined,
  method:
    "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents" | "supersedeWithNewMemories",
): Promise<void> {
  if (ids === undefined || ids.length === 0) {
    return;
  }
  const wellFormedIds = ids.filter((id) => isUuidLike(id));
  if (wellFormedIds.length === 0) {
    return;
  }
  const rows = await tx.execute(sql`
    SELECT id, status FROM memories
    WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
    ORDER BY id ASC
    FOR UPDATE
  `);
  const changed = (rows.rows as unknown as Array<{ id: MemoryId; status: MemoryStatus }>)
    .filter((row) => row.status === "superseded")
    .map((row) => ({ id: row.id, observedStatus: row.status }));
  if (changed.length > 0) {
    throw new SourceMemoryStatusChangedError(method, changed);
  }
}

/**
 * `created` イベント1件を、呼び出し元のトランザクション（`tx`）の中で `memory_events` へ直接 INSERT する。
 * `EventStore.append` は経由しない（別コミットになるため）。`createMemoriesWithOutboxAndEvents`（ADR 0410）と
 * `supersedeWithNewMemories` の `opts.buildCreatedEvent`（ADR 0416）が共有する。失敗したら投げる（`tx` ごと rollback）。
 */
async function insertCreatedEventRow(
  tx: SqlExecutor,
  ctx: Ctx,
  event: NewMemoryEvent,
  createdMemoryId: string,
): Promise<void> {
  await assertEventTargetInTenant(tx, ctx, event.memoryId, [createdMemoryId]);
  assertNoNulInNewMemoryEvent("PostgresMemoryStore", event);
  await tx.execute(sql`
    INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
    VALUES (
      gen_random_uuid(),
      ${ctx.tenantId},
      ${event.memoryId},
      ${event.kind},
      ${toPgTimestamp(event.at ?? new Date())},
      ${JSON.stringify(event.actor)}::jsonb,
      ${event.digestSnapshot ?? null},
      ${event.sizeBeforeBytes ?? null},
      ${JSON.stringify(event.meta)}::jsonb
    )
  `);
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 候補ごとの savepoint の `rollback to savepoint` が失敗したとき、その失敗を元のエラーへ添える（ADR 0451。ADR 0444 と同じ作法）。
 * 元のエラーの `cause` が空いていれば `cause` に、空いていなければ `rollbackError` に置く。`Error` でないものには添えない。
 */
function attachSavepointRollbackError(original: unknown, rollbackFailure: unknown): void {
  if (!(original instanceof Error)) {
    return;
  }
  if ((original as { cause?: unknown }).cause === undefined) {
    (original as { cause?: unknown }).cause = rollbackFailure;
  } else {
    (original as { rollbackError?: unknown }).rollbackError = rollbackFailure;
  }
}

/** `markContestedGroup` / `resolveContestedGroup` の UPDATE が期待より少ない行数しか返さなかったとき、メンバーごとの UPDATE が投げるものと同じエラーを作る（ADR 0401）。呼び出し側は「入力順で最初に更新されなかった id」を渡す。 */
async function conflictAfterEmptyUpdate(
  tx: Tx,
  ctx: Ctx,
  id: MemoryId,
  expected: MemoryStatus,
): Promise<Error> {
  const current = await tx.execute(sql`
    SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
  `);
  if (current.rows.length === 0) {
    return new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
  }
  const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
  return new MemoryStatusConflictError(id, expected, observedStatus);
}

/**
 * 書き込み口が受け取る、別の行への参照（`superseded_by_id`・`contested_with_id`・`source_observation_id`・`recall_usages` の
 * recall と memory）の入口の検査（ADR 0439）。uuid の形でない id は、DB へ投げる前に「`ctx` のテナントに無い」と同じ message で
 * 弾き（実在しない・別テナントと区別しない）、大文字の uuid は小文字にそろえる。`null`・`undefined` は「参照しない」。
 * **空文字は参照として扱う**（uuid の形でないので弾かれる）。
 */
type RefKind = "memory" | "observation" | "recall";

function refNotFound(kind: RefKind, id: string): Error {
  return new Error(`PostgresMemoryStore: ${kind} not found for tenant: ${id}`);
}

function checkedRef(kind: RefKind, id: string | null | undefined): string | null {
  if (id === null || id === undefined) {
    return null;
  }
  if (!isUuidLike(id)) {
    throw refNotFound(kind, id);
  }
  return id.toLowerCase();
}

/**
 * 「`id` の行が `ctx` のテナントに在る」を表す述語（ADR 0439）。`id` は uuid の形に検査済みの値、または `NULL`（参照しないので真）。
 * **書く文の中に置く**（検査と書き込みの間に別の文を挟まない）。
 */
function refExists(table: "memories" | "observations" | "recalls", tenantId: string, id: SQL): SQL {
  return sql`(${id}::uuid IS NULL OR EXISTS (
    SELECT 1 FROM ${sql.raw(table)} rf WHERE rf.tenant_id = ${tenantId} AND rf.id = ${id}::uuid
  ))`;
}

/**
 * 呼び出し側が渡した `NewMemoryEvent.memoryId` の記憶が `ctx` のテナントに在ることを、イベントを書く前に確かめる
 * （ADR 0456）。`memory_events.memory_id` の外部キーは `tenant_id` を含まないので、確かめないと別テナントの記憶を指す
 * イベントが書ける。実在しない・別テナントは区別せず `memory not found for tenant`。`null`・`undefined` は確かめない。
 * **書き込みと同じトランザクションの中で呼ぶ**（投げれば、同じトランザクションの status 更新も戻る）。
 */
async function assertEventTargetInTenant(
  exec: SqlExecutor,
  ctx: Ctx,
  memoryId: string | null | undefined,
  knownInTenant: readonly string[] = [],
): Promise<void> {
  const id = checkedRef("memory", memoryId);
  if (id === null) {
    return;
  }
  if (knownInTenant.some((known) => known.toLowerCase() === id)) {
    return;
  }
  const found = await exec.execute(
    sql`SELECT 1 AS ok FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1`,
  );
  if (found.rows.length === 0) {
    throw refNotFound("memory", memoryId as string);
  }
}

/**
 * `expectedStatus` を渡された status 更新の CAS 条件（ADR 0499）。**purge 済みの行（`purged_at` が入った行。`status` は
 * `forgotten` のまま）は、どの `expectedStatus` にも一致しない。**`Runtime.purge` の「不可逆」の約束どおり、墓石を
 * `updateStatusWithEvent(T, "active", { expectedStatus: "forgotten" })` が active へ戻せないようにする。`expectedStatus` を渡さない
 * 更新は無条件の書き込みのまま（CAS ではないので、この条件は付けない）。
 */
function expectedStatusCondition(expectedStatus: MemoryStatus | undefined): SQL {
  return expectedStatus !== undefined
    ? sql`AND status = ${expectedStatus} AND purged_at IS NULL`
    : sql``;
}

/** `resolveContestedPair`・`resolveContestedGroup` の `status` は型が `"active" | "superseded"`。型の外の値は、書く前に `RangeError` で断る（値は message に入れない。ADR 0499）。 */
function assertResolvedStatus(method: string, field: string, status: unknown): void {
  if (status !== "active" && status !== "superseded") {
    throw new RangeError(`${method}: ${field}.status must be "active" or "superseded"`);
  }
}

/**
 * `status: "superseded"` の更新は、置き換えた側（`supersededById`）を必ず伴い、それは自分自身でないこと（ADR 0503）。
 * `resolveContested*` の `"active"` に `supersededById` を付けることも断る（active なのに `superseded_by_id` が残る行になる）。
 * 書く前に `RangeError` で断る（値は message に入れない）。id は uuid の大文字小文字を畳んで比べる。
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
    if (normalizeUuidCase(supersededById) === normalizeUuidCase(selfId)) {
      throw new RangeError(`${method}: ${field}.supersededById must not be the memory itself`);
    }
  } else if (opts.forbidWhenNotSuperseded && supersededById !== undefined) {
    throw new RangeError(
      `${method}: ${field}.supersededById must not be set unless status is "superseded"`,
    );
  }
}

/** `supersededById` の鎖が、同じ呼び出しで `superseded` になるメンバーの中で輪になっていないこと（ADR 0503）。輪になっていれば `RangeError`。 */
function assertNoSupersededCycle(
  method: string,
  members: ReadonlyArray<{ id: string; status: string; supersededById?: string | undefined }>,
): void {
  const next = new Map<string, string>();
  for (const m of members) {
    if (m.status === "superseded" && m.supersededById !== undefined) {
      next.set(normalizeUuidCase(m.id), normalizeUuidCase(m.supersededById));
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

/** `UPDATE memories SET superseded_by_id = …` が0行だったときの切り分け（ADR 0439）。対象の行が無い・`supersededById` が `ctx` のテナントの記憶でない・`expectedStatus` が違う、の3つを、この順で別々の例外にする。 */
async function explainEmptyStatusUpdate(
  exec: SqlExecutor,
  ctx: Ctx,
  id: MemoryId,
  supersededById: string | null,
  expectedStatus: MemoryStatus | undefined,
): Promise<Error> {
  const current = await exec.execute(sql`
    SELECT status, ${refExists("memories", ctx.tenantId, sql`${supersededById}`)} AS ref_ok
    FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
  `);
  if (current.rows.length === 0) {
    return refNotFound("memory", id);
  }
  const row = current.rows[0] as unknown as { status: MemoryStatus; ref_ok: boolean };
  if (supersededById !== null && !row.ref_ok) {
    return refNotFound("memory", supersededById);
  }
  if (expectedStatus === undefined) {
    return refNotFound("memory", id);
  }
  return new MemoryStatusConflictError(id, expectedStatus, row.status);
}

/**
 * `memories` へ1行を書く INSERT ... ON CONFLICT DO NOTHING（`createMemory`・`createMemoryWithOutbox`・
 * `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` が共有する）。
 *
 * `sourceObservationId`・`supersededById`・`contestedWithId` が `ctx` のテナントの行であることを、**同じ SQL 文の中で**
 * 確かめる（ADR 0439）。外部キーはテナントを含まないので、検査が無いと別テナントの id を指す行が書ける。
 * `ON CONFLICT DO NOTHING` の「書かなかった」と検査の「拒んだ」は、どちらも挿入が0行なので、戻り値の `*_ok` で区別する。
 *
 * 書いたら行を、冪等の衝突で書かなかったら `null` を返す。
 */
async function insertMemoryRow(
  exec: SqlExecutor,
  ctx: Ctx,
  input: NewMemory,
  method: Parameters<typeof translateClaimKeyIndexLimit>[0],
): Promise<MemoryRow | null> {
  const sourceObservationId = checkedRef("observation", input.sourceObservationId);
  const supersededById = checkedRef("memory", input.supersededById);
  const contestedWithId = checkedRef("memory", input.contestedWithId);
  const extractorVersion = input.extractorVersion ?? null;
  const provenanceKind = input.provenance.kind;
  const result = await translateClaimKeyIndexLimit(method, ctx, input, () =>
    exec.execute(sql`
      WITH chk AS (
        SELECT
          ${refExists("observations", ctx.tenantId, sql`${sourceObservationId}`)} AS ref_source_ok,
          ${refExists("memories", ctx.tenantId, sql`${supersededById}`)} AS ref_superseded_ok,
          ${refExists("memories", ctx.tenantId, sql`${contestedWithId}`)} AS ref_contested_ok
      ), ins AS (
        INSERT INTO memories (
          id, tenant_id, subject_id,
          source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, superseded_by_id, contested_with_id,
          tags,
          occurred_at, recorded_at, last_reinforced_at, valid_from, valid_until,
          claim_key_subject, claim_key_predicate,
          strength, half_life_hours, decay_floor_at,
          decay_base_seq, decay_floor_seq, half_life_recalls,
          embedding_status,
          attributes,
          created_at, updated_at
        )
        SELECT
          gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
          ${sourceObservationId}::uuid, ${extractorVersion},
          ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
          ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.status ?? "active"}, ${supersededById}::uuid, ${contestedWithId}::uuid,
          ${sql.param(input.tags)},
          ${toPgTimestamp(input.occurredAt)}, ${toPgTimestamp(input.recordedAt)}, ${toPgTimestamp(input.lastReinforcedAt)},
          ${toPgTimestamp(input.validFrom)}, ${toPgTimestamp(input.validUntil)},
          ${input.claimKey?.subject ?? null}, ${input.claimKey?.predicate ?? null},
          ${input.strength}, ${input.halfLifeHours}, ${toPgTimestamp(input.decayFloorAt)},
          ${input.decayBaseSeq ?? null}, ${input.decayFloorSeq ?? null}, ${input.halfLifeRecalls ?? null},
          ${input.embeddingStatus},
          ${JSON.stringify(input.attributes ?? {})}::jsonb,
          now(), now()
        FROM chk
        WHERE chk.ref_source_ok AND chk.ref_superseded_ok AND chk.ref_contested_ok
        ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash)
          WHERE source_observation_id IS NOT NULL
        DO NOTHING
        RETURNING *
      )
      SELECT chk.ref_source_ok, chk.ref_superseded_ok, chk.ref_contested_ok, ins.*
      FROM chk LEFT JOIN ins ON TRUE
    `),
  );
  const row = result.rows[0] as unknown as MemoryRow & {
    ref_source_ok: boolean;
    ref_superseded_ok: boolean;
    ref_contested_ok: boolean;
  };
  if (!row.ref_source_ok) {
    throw refNotFound("observation", sourceObservationId!);
  }
  if (!row.ref_superseded_ok) {
    throw refNotFound("memory", supersededById!);
  }
  if (!row.ref_contested_ok) {
    throw refNotFound("memory", contestedWithId!);
  }
  return row.id === null ? null : row;
}

/**
 * `memory_events` へ複数行を**1文**で入れ、**入力と同じ順**で返す（ADR 0401）。行の id は JS 側で採番し、`RETURNING` の
 * 順序に依存せず id で入力順へ戻す。
 */
async function insertMemoryEventsBatch(
  tx: Tx,
  ctx: Ctx,
  events: ReadonlyArray<NewMemoryEvent>,
  knownInTenant: readonly string[],
): Promise<MemoryEvent[]> {
  const known = new Set(knownInTenant.map((id) => id.toLowerCase()));
  const unknownTargets = new Set<string>();
  for (const e of events) {
    const id = checkedRef("memory", e.memoryId);
    if (id !== null && !known.has(id)) {
      unknownTargets.add(id);
    }
  }
  if (unknownTargets.size > 0) {
    const found = await tx.execute(
      sql`SELECT id FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param([...unknownTargets])}::uuid[])`,
    );
    const foundIds = new Set(found.rows.map((r) => String((r as { id: string }).id).toLowerCase()));
    for (const id of unknownTargets) {
      if (!foundIds.has(id)) {
        throw refNotFound("memory", id);
      }
    }
  }
  events.forEach((e) => assertNoNulInNewMemoryEvent("PostgresMemoryStore", e));
  const eventIds = events.map(() => randomUUID());
  // 1つの JSON 配列（jsonb）で渡し、`jsonb_to_recordset` で列へ開く。`meta` は群の大きさに比例して大きくなりうるので、
  // 列ごとの `text[]` に JSON 文字列を詰めて `::jsonb` へキャストする形（二重のエスケープと二重の構文解析）は採らない。
  const payload = JSON.stringify(
    events.map((e, i) => ({
      id: eventIds[i],
      memory_id: e.memoryId ?? null,
      kind: e.kind,
      at: toPgTimestamp(e.at ?? new Date()),
      actor: e.actor,
      digest_snapshot: e.digestSnapshot ?? null,
      size_before_bytes: e.sizeBeforeBytes ?? null,
      meta: e.meta,
    })),
  );
  const result = await tx.execute(sql`
    INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
    SELECT e.id, ${ctx.tenantId}, e.memory_id, e.kind, e.at, e.actor, e.digest_snapshot, e.size_before_bytes, e.meta
    FROM jsonb_to_recordset(${payload}::jsonb) AS e(
      id uuid, memory_id uuid, kind text, at timestamptz, actor jsonb,
      digest_snapshot text, size_before_bytes integer, meta jsonb
    )
    RETURNING *
  `);
  const byId = new Map<string, MemoryEvent>(
    result.rows.map((row) => {
      const event = rowToMemoryEvent(row as unknown as MemoryEventRow);
      return [event.id as string, event] as const;
    }),
  );
  return eventIds.map((id) => byId.get(id)!);
}

/**
 * `MemoryStore` の PostgreSQL 実装（リファレンス実装）。契約は `@mnemora/core` の `MemoryStore` の各メソッドの doc が正で、
 * このクラスのメソッドの doc は Postgres での振る舞いと、契約から外れる点を書く。
 *
 * status を書く口が投げる名前の付いたエラー（`MemoryStatusConflictError`・`ContestedWithoutCompanionError`）は、
 * 各メソッドの doc に書いてある。値域の外の値・列挙に無い値は、Postgres の CHECK 制約・型の検査による例外になる。
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  /**
   * 新規作成された Memory の `tags` から `proposed` ラベルを作り・件数を数え、`memory_labels` で結び付ける（ADR 0318）。
   *
   * **呼び出し元と同一トランザクションで実行すること。**新しい Memory 行を実際に挿入したときだけ呼ぶ。冪等衝突で既存行を
   * 返したときは呼ばない（`tags` は作成時にしか書けない列で、ラベルを二重に数える理由が無い）。
   *
   * `tags` 内の重複は `Set` で1つに潰してから数える（1回の Memory 作成につき、同じラベルの `proposedCount` を1回だけ進める）。
   * `ON CONFLICT` は `status = 'proposed'` のときだけ `proposed_count` を進める。`registered` に昇格済みのラベルは、
   * `tags` に使われ続けても件数を増やさない。
   */
  private async upsertProposedLabels(
    exec: SqlExecutor,
    ctx: Ctx,
    memoryId: MemoryId,
    tags: readonly string[],
  ): Promise<void> {
    // `labels` の行ロックを取る順を、`tags` の並び（LLM が返した順）ではなく名前の順に固定する（ADR 0476）。並びのままだと、
    // 同じ語彙を逆の順で持つ2つの作成が互いの行を待って 40P01（deadlock detected）で落ちる。並べ替えるのはロックの順だけで、
    // `Memory.tags` の並び・重複は変えない。順は SQL の `ORDER BY name COLLATE "C"` と同じ `compareCodePoints`
    // （`lockExistingLabelsInNameOrder`・purge/scrub の先取りと同じ順でないと、経路どうしで循環待ちになる。ADR 0511）。
    const uniqueNames = Array.from(new Set(tags)).sort(compareCodePoints);
    for (const name of uniqueNames) {
      const labelResult = await exec.execute(sql`
        INSERT INTO labels (id, tenant_id, name, status, proposed_count)
        VALUES (gen_random_uuid(), ${ctx.tenantId}, ${name}, 'proposed', 1)
        ON CONFLICT (tenant_id, name) DO UPDATE
          SET proposed_count = labels.proposed_count
            + CASE WHEN labels.status = 'proposed' THEN 1 ELSE 0 END
        RETURNING id
      `);
      const labelId = (labelResult.rows[0] as unknown as { id: string }).id;
      await exec.execute(sql`
        INSERT INTO memory_labels (tenant_id, memory_id, label_id)
        VALUES (${ctx.tenantId}, ${memoryId}, ${labelId})
        ON CONFLICT DO NOTHING
      `);
    }
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    assertNoNulInNewObservation("PostgresMemoryStore", input);
    const externalId = input.externalId ?? null;
    const inserted = await this.db.execute(sql`
      INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at, valid_from, valid_until, attributes)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.subjectId ?? null},
        ${externalId},
        ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb,
        ${toPgTimestamp(input.occurredAt)},
        ${toPgTimestamp(input.recordedAt ?? new Date())},
        ${toPgTimestamp(input.validFrom)},
        ${toPgTimestamp(input.validUntil)},
        ${JSON.stringify(input.attributes ?? {})}::jsonb
      )
      ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `);
    if (inserted.rows.length > 0) {
      return rowToObservation(inserted.rows[0] as unknown as ObservationRow);
    }

    const existing = await this.db.execute(sql`
      SELECT * FROM observations
      WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
      LIMIT 1
    `);
    return rowToObservation(existing.rows[0] as unknown as ObservationRow);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM observations WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToObservation(result.rows[0] as unknown as ObservationRow)
      : null;
  }

  /** Observation の INSERT と outbox へのジョブ書き込みを同一トランザクションで行う（transactional outbox）。新規作成が実際に起きたときだけ outbox 行を積む。 */
  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date | undefined; claimedBy?: string | undefined },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    assertNoNulInNewObservation("PostgresMemoryStore", input);
    const externalId = input.externalId ?? null;
    const outboxNow = opts?.now ?? new Date();
    const claimedBy = opts?.claimedBy;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at, valid_from, valid_until, attributes)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${input.subjectId ?? null},
          ${externalId},
          ${input.kind},
          ${JSON.stringify(input.payload)}::jsonb,
          ${toPgTimestamp(input.occurredAt)},
          ${toPgTimestamp(input.recordedAt ?? new Date())},
          ${toPgTimestamp(input.validFrom)},
          ${toPgTimestamp(input.validUntil)},
          ${JSON.stringify(input.attributes ?? {})}::jsonb
        )
        ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `);

      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`
          SELECT * FROM observations
          WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
          LIMIT 1
        `);
        return {
          observation: rowToObservation(existing.rows[0] as unknown as ObservationRow),
          created: false,
          jobs: [],
        };
      }

      const observation = rowToObservation(inserted.rows[0] as unknown as ObservationRow);
      const jobs: OutboxJobRecord[] = [];
      for (const kind of jobKinds) {
        const jobResult = await tx.execute(sql`
          INSERT INTO outbox (id, tenant_id, kind, payload, available_at, claimed_at, claimed_by, attempts, created_at)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${kind},
            ${JSON.stringify({ observationId: observation.id })}::jsonb,
            ${toPgTimestamp(outboxNow)},
            ${claimedBy === undefined ? null : toPgTimestamp(outboxNow)},
            ${claimedBy ?? null},
            ${claimedBy === undefined ? 0 : 1},
            ${toPgTimestamp(outboxNow)}
          )
          RETURNING *
        `);
        jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
      }
      return { observation, created: true, jobs };
    });
  }

  /**
   * 対をなさない UTF-16 サロゲートコードユニット（`\uD800` 単体など）を含む文字列を渡しても、例外を投げない。ただし読み返した値は
   * 入力と一致しない。node-postgres（`pg`）が JS 文字列を UTF-8 へエンコードする際に対をなさないサロゲートを静かに U+FFFD へ
   * 置換するため、クライアント側で値が変わる。`packages/testkit`/`packages/core` の Fake は入力をそのまま保持するので、
   * 両者の値が食い違う（`MemoryStore.createMemory` の interface doc に記録済みの契約）。
   *
   * `status: "contested"` で `contestedWithId` が無い入力は、何も書かずに {@link ContestedWithoutCompanionError} を投げる。
   * claim key が索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる（ADR 0435）。トランザクションごと戻り、何も残らない。
   */
  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertNoNulInNewMemory("PostgresMemoryStore", input);
    assertWellFormedNewMemory("PostgresMemoryStore", input);
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemory", null);
    }
    assertNewMemoryHalfLivesFitFloat4("PostgresMemoryStore", input);
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;

    const result = await this.db.transaction(async (tx) => {
      const insertedRow = await insertMemoryRow(tx, ctx, input, "createMemory");

      if (insertedRow === null) {
        const existing = await tx.execute(sql`
          SELECT * FROM memories
          WHERE tenant_id = ${ctx.tenantId}
            AND source_observation_id = ${sourceObservationId}
            AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
            AND content_hash = ${input.contentHash}
          LIMIT 1
        `);
        return { memory: rowToMemory(existing.rows[0] as unknown as MemoryRow), created: false };
      }

      const memory = rowToMemory(insertedRow);
      await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
      return { memory, created: true };
    });

    if (result.created) {
      // 統計が実態から遅れているときだけ ANALYZE を撃つ（`memories-statistics.ts`）。新しい行を実際に書いたときだけ数える。
      // トランザクションの**外側**で呼ぶ。ANALYZE が保持する ShareUpdateExclusiveLock を、上のトランザクションが保持する
      // 行ロックに無用に重ねないため。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result.memory;
  }

  /**
   * `createMemoryWithOutbox` の1件ぶんの書き込み（Memory の INSERT ... ON CONFLICT DO NOTHING、衝突時は既存行の SELECT、
   * 新規なら proposed ラベルと outbox ジョブ）を、**呼び出し元のトランザクション `tx` の中で**行う。
   * `createMemoryWithOutbox` と `createMemoriesWithOutboxAndEvents`（ADR 0410）が共有する。
   * 呼び出し元は `isContestedWithoutCompanion` の検査を済ませていること。
   */
  private async insertMemoryWithOutboxRows(
    tx: SqlExecutor,
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
    outboxNow: Date,
    method: "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents",
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    assertNewMemoryHalfLivesFitFloat4("PostgresMemoryStore", input);
    assertNoNulInNewMemory("PostgresMemoryStore", input);
    // 書いたら読み戻したときに MemorySchema を通らなくなる値は、この行の INSERT より前に拒む（ADR 0630）。
    // ここは呼び出し元のトランザクションの内側で、「DB に触れる前」ではない。`createMemoryWithOutbox` では見直しの行ロックを
    // 取った後、`createMemoriesWithOutboxAndEvents` では候補ごとの savepoint の中（先の候補の INSERT は済んでいることがある）。
    // 投げれば、その `tx`／savepoint の分だけ戻る。
    assertWellFormedNewMemory("PostgresMemoryStore", input);
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const insertedRow = await insertMemoryRow(tx, ctx, input, method);

    if (insertedRow === null) {
      const existing = await tx.execute(sql`
        SELECT * FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND source_observation_id = ${sourceObservationId}
          AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
          AND content_hash = ${input.contentHash}
        LIMIT 1
      `);
      return {
        memory: rowToMemory(existing.rows[0] as unknown as MemoryRow),
        created: false,
        jobs: [],
      };
    }

    const memory = rowToMemory(insertedRow);
    await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
    const jobs: OutboxJobRecord[] = [];
    for (const kind of jobKinds) {
      const jobResult = await tx.execute(sql`
        INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${kind},
          ${JSON.stringify({ memoryId: memory.id })}::jsonb,
          ${toPgTimestamp(outboxNow)},
          0,
          ${toPgTimestamp(outboxNow)}
        )
        RETURNING *
      `);
      jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
    }
    return { memory, created: true, jobs };
  }

  /**
   * Memory の INSERT と outbox への埋め込みジョブ書き込みを同一トランザクションで行う（transactional outbox）。抽出の冪等キーに
   * 衝突した場合（`created: false`）は、重複ジョブを積まないよう埋め込みジョブを作らない。
   *
   * `status: "contested"` で `contestedWithId` が無い入力は、何も書かずに {@link ContestedWithoutCompanionError} を投げる。
   * claim key が索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる（ADR 0435）。トランザクションごと戻り、何も残らない。
   */
  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
    opts?: {
      now?: Date | undefined;
      abortIfForgotten?: ReadonlyArray<MemoryId> | undefined;
      abortIfSuperseded?: ReadonlyArray<MemoryId> | undefined;
    },
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemoryWithOutbox", null);
    }
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;

    const result = await this.db.transaction(async (tx) => {
      await assertNotForgottenForUpdate(tx, ctx, abortIfForgotten, "createMemoryWithOutbox");
      await assertNotSupersededForUpdate(
        tx,
        ctx,
        opts?.abortIfSuperseded,
        "createMemoryWithOutbox",
      );
      return this.insertMemoryWithOutboxRows(
        tx,
        ctx,
        input,
        jobKinds,
        outboxNow,
        "createMemoryWithOutbox",
      );
    });

    if (result.created) {
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  /**
   * 抽出の全候補の Memory と `created` イベントを1つの `db.transaction()` で書く（ADR 0410）。
   *
   * - 候補ごとに **SAVEPOINT**（drizzle の入れ子の `tx.transaction`）を張り、保存できない候補（本文の NUL など）が投げたら、
   *   その候補の書き込みだけを `ROLLBACK TO SAVEPOINT` で巻き戻して `dropped` に積む。残りは書く。SAVEPOINT が要る理由:
   *   Postgres は文が失敗するとトランザクション全体が aborted になり、外側で握りつぶしても以後の文が全部落ちる。
   * - 全候補が落ちたら最初の例外を投げる（外側のトランザクションごと rollback。何も書かない）。
   * - 本体が失敗したあとの `ROLLBACK TO SAVEPOINT` 自体が失敗したとき（接続切れ・キャンセルなど）は、続けず、`dropped` にも
   *   積まず、**本体の元のエラー**を投げる（外側ごと rollback。ADR 0451）。巻き戻しの失敗は元のエラーの `cause`（空いていれば）か
   *   `rollbackError` に残す。`RELEASE SAVEPOINT` の失敗も、候補を落とさずその失敗を投げる。
   * - 全候補の成否が確定したあと、書けた候補のうち `created: true` のものだけ、`buildCreatedEvent(memory, dropped)` の
   *   イベントを**同じトランザクションで** `memory_events` へ INSERT する（`EventStore.append` は経由しない）。この INSERT が
   *   失敗したら、Memory も outbox も含めて全部巻き戻る。
   * - `status: "contested"` で `contestedWithId` が無い入力は、その候補だけ {@link ContestedWithoutCompanionError} で落とす。
   * - `opts.abortIfForgotten` が非空なら、どの候補の書き込みより前に同じトランザクションで `SELECT … FOR UPDATE` し、forgotten が
   *   1件でもあれば {@link SourceMemoryForgottenError} を投げる（`dropped` に積まずそのまま投げる。何も書かない。ADR 0416）。
   * - claim key が索引の上限（SQLSTATE 54000）で落ちた候補は、他の保存できない候補と同じく巻き戻して `dropped` に積む
   *   （`dropped[].error` は {@link ClaimKeyIndexLimitError}。ADR 0435）。全候補が落ちたときは最初の例外をそのまま投げ、何も書かない。
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
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;
    const result = await this.db.transaction(async (tx) => {
      // どの候補の INSERT より前に見直す（ADR 0416）。候補ごとの SAVEPOINT の外で呼ぶので、この例外は `dropped` に積まれずに
      // そのまま投げられる（外側のトランザクションごと rollback。何も書かない）。
      await assertNotForgottenForUpdate(
        tx,
        ctx,
        abortIfForgotten,
        "createMemoriesWithOutboxAndEvents",
      );
      await assertNotSupersededForUpdate(
        tx,
        ctx,
        opts?.abortIfSuperseded,
        "createMemoriesWithOutboxAndEvents",
      );
      await lockExistingLabelsInNameOrder(
        tx,
        ctx,
        news.map((entry) => entry.input.tags),
      );
      const written: Array<{
        index: number;
        memory: Memory;
        created: boolean;
        jobs: OutboxJobRecord[];
      }> = [];
      const dropped: Array<{ index: number; error: unknown }> = [];
      for (const [index, { input, jobKinds }] of news.entries()) {
        // drizzle の入れ子の `transaction` は、本体が投げたあとの `rollback to savepoint` が失敗すると、元のエラーを捨てて
        // その失敗を投げる（`release savepoint` の失敗も同じ形）。本体が投げたエラーを控えておき、外へ出てきたものと見比べて
        // 「巻き戻しそのものが失敗した」を見分ける（ADR 0451）。
        let bodyError: { error: unknown } | undefined;
        try {
          const one = await tx.transaction(async (savepoint) => {
            try {
              if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
                throw new ContestedWithoutCompanionError("createMemoriesWithOutboxAndEvents", null);
              }
              return await this.insertMemoryWithOutboxRows(
                savepoint,
                ctx,
                input,
                jobKinds,
                outboxNow,
                "createMemoriesWithOutboxAndEvents",
              );
            } catch (error) {
              bodyError = { error };
              throw error;
            }
          });
          written.push({ index, ...one });
        } catch (error) {
          if (bodyError === undefined) {
            // 本体は成功したのに投げられた（`release savepoint` またはその後の `rollback to savepoint` の失敗）。
            // この savepoint の中の書き込みが残るか戻るか分からないので、候補を落とさずに投げる。
            throw error;
          }
          if (error !== bodyError.error) {
            // 本体の失敗のあと、`rollback to savepoint` 自体が失敗した。トランザクションの状態が分からないので、続けず、
            // `dropped` にも積まず、元のエラーを投げる。失敗は `cause`（空いていれば）か `rollbackError` に残す。
            attachSavepointRollbackError(bodyError.error, error);
            throw bodyError.error;
          }
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
        await insertCreatedEventRow(tx, ctx, buildCreatedEvent(memory, dropped), memory.id);
      }
      return { written, dropped };
    });

    if (result.written.some((entry) => entry.created)) {
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0 ? rowToMemory(result.rows[0] as unknown as MemoryRow) : null;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    const wellFormedIds = ids.filter((id) => isUuidLike(id));
    if (wellFormedIds.length === 0) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * `reextract` が「今回作られた content_hash の集合に含まれない既存 Memory」を判定するための列挙（ADR 0028）。
   * 一意索引 `uq_memories_extraction` が `(tenant_id, source_observation_id, extractor_version)` の前方一致で使える。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(observationId)) {
      return [];
    }
    if (extractorVersion !== null) {
      assertNoNul(
        "PostgresMemoryStore.listBySourceObservation",
        "extractorVersion",
        extractorVersion,
      );
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${observationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * `reextract` が「版を跨いで退けた記憶」を判定するための列挙（ADR 0380）。`uq_memories_extraction` が
   * `(tenant_id, source_observation_id)` の前方一致でも Index Scan に使える。`extractor_version`・`status` のどちらでも絞らない。
   */
  async listBySourceObservationAllVersions(
    ctx: Ctx,
    observationId: ObservationId,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(observationId)) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${observationId}
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * `opts.expectedStatus` を渡すと `AND status = ${expectedStatus}` を足した条件付き UPDATE になる（compare-and-swap。ADR 0030）。
   * 条件付き UPDATE が0行だった場合、「対象の id がそもそも無い」（`memory not found` の `Error`）のか「id はあるが status が
   * 期待と違う」（{@link MemoryStatusConflictError}）のかを、追加の `SELECT` で読み直して区別する。**この読み直しは弾かれた後に
   * 行うため、`observedStatus` は弾かれた瞬間の値ではない。**
   *
   * `"contested"` への遷移は、この口では常に {@link ContestedWithoutCompanionError} を投げる（`markContestedPair` を使う）。
   */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
  ): Promise<Memory> {
    assertWellFormedCtx(ctx);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    assertSupersededByShape("updateStatus", "opts", id, status, opts?.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const supersededById = checkedRef("memory", opts?.supersededById);
    const expectedStatus = opts?.expectedStatus;
    const statusCondition = expectedStatusCondition(expectedStatus);
    const result = await this.db.execute(sql`
      UPDATE memories
      SET status = ${status},
          superseded_by_id = COALESCE(${supersededById}::uuid, superseded_by_id),
          updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
        AND ${refExists("memories", ctx.tenantId, sql`${supersededById}`)}
      RETURNING *
    `);
    if (result.rows.length > 0) {
      return rowToMemory(result.rows[0] as unknown as MemoryRow);
    }

    throw await explainEmptyStatusUpdate(this.db, ctx, id, supersededById, expectedStatus);
  }

  /**
   * `updateStatus` の UPDATE と `EventStore.append` の INSERT を**同一トランザクション**で行う（ADR 0031）。別コミットだと、
   * 前者だけ成功して後者が失敗したとき、行は新しい status のまま対応するイベントが永久に存在しない不整合が残る。
   *
   * CAS に弾かれた場合・対象が存在しない場合は、UPDATE が0行のまま例外を投げるので、`memory_events` への INSERT は発行されない。
   * 投げるもの: `"contested"` への遷移は {@link ContestedWithoutCompanionError}、CAS に弾かれたら {@link MemoryStatusConflictError}
   * （どちらも status もイベントも書かない）。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    assertSupersededByShape("updateStatusWithEvent", "opts", id, status, opts.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const supersededById = checkedRef("memory", opts.supersededById);
    const expectedStatus = opts.expectedStatus;
    const statusCondition = expectedStatusCondition(expectedStatus);

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE memories
        SET status = ${status},
            superseded_by_id = COALESCE(${supersededById}::uuid, superseded_by_id),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
          AND ${refExists("memories", ctx.tenantId, sql`${supersededById}`)}
        RETURNING *
      `);

      if (result.rows.length === 0) {
        throw await explainEmptyStatusUpdate(tx, ctx, id, supersededById, expectedStatus);
      }

      const memory = rowToMemory(result.rows[0] as unknown as MemoryRow);

      await assertEventTargetInTenant(tx, ctx, event.memoryId, [id]);
      assertNoNulInNewMemoryEvent("PostgresMemoryStore", event);
      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${event.memoryId},
          ${event.kind},
          ${toPgTimestamp(event.at ?? new Date())},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      return { memory, event: storedEvent };
    });
  }

  /**
   * `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の supersede、複数可）を1つの `db.transaction()` にまとめる
   * （ADR 0100。docs/memory-model.md §11 行5）。
   *
   * 中身は `createMemoryWithOutbox` と `updateStatusWithEvent` と同じ形。`news` を先に処理し、`supersede` を後に処理する
   * （書く順序で被害を最小にする。途中で落ちても、統合先が無いのに旧行だけ `superseded_by_id` が指す先を失う最悪の状態を避ける。
   * ADR 0089）。
   *
   * `supersede[].id` が存在しなければトランザクション内で throw し、`news` の INSERT も含めてロールバックされる。
   * `supersededById` は `memories.superseded_by_id` の実 FK が検査する。`news` の INSERT は同一トランザクション内で先に実行
   * されているので、`supersededById` が同じ呼び出しの `news` を指していても FK 違反にならない。CAS に弾かれた場合（0行 UPDATE、
   * かつ対象は存在する）は `conflicted` に積んでトランザクションはそのまま commit する（throw しない）。
   *
   * 新しい行に `status: "contested"` で `contestedWithId` が無いものがあれば、何も書かずに {@link ContestedWithoutCompanionError}
   * を投げる（CAS の弾きとは別で、例外になる）。
   *
   * `opts.buildCreatedEvent` が渡されたら、`created: true` の `news` の Memory ごとに `created` イベントを**同じトランザクションで**
   * `memory_events` へ INSERT し（`supersede` の処理の前）、戻り値に `createdEventsWritten: true` を付ける。INSERT が失敗したら
   * `news`・`supersede` ごと全部巻き戻る（ADR 0416）。
   *
   * `news` の claim key が索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる（ADR 0435）。トランザクション
   * ごと戻り、`news` も `supersede` も何も残らず、`supersede` の対象だった旧い行は `active` のまま残る。
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
    news.forEach((entry, i) =>
      assertWellFormedIdentifier(entry.input.subjectId, `news[${i}].input.subjectId`),
    );
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;
    const buildCreatedEvent = opts?.buildCreatedEvent;
    // 呼び手が壊れた索引を渡した場合は、トランザクションを開く前に落とす（ADR 0100）。`conflicted` にも「memory not found」にも
    // 混ぜない（3つとも別の失敗）。
    for (const target of supersede) {
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `PostgresMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
    }
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
      assertNewMemoryHalfLivesFitFloat4("PostgresMemoryStore", input);
      assertNoNulInNewMemory("PostgresMemoryStore", input);
      assertWellFormedNewMemory("PostgresMemoryStore", input);
    }

    const result = await this.db.transaction(async (tx) => {
      // `news`/`supersede` どちらの書き込みより前に見直す（`assertNotForgottenForUpdate` の doc。ADR 0375）。既存の `conflicted`
      // （CAS に弾かれた対象だけ飛ばして他は commit する部分成功）はこの見直しの対象外。
      await assertNotForgottenForUpdate(tx, ctx, abortIfForgotten, "supersedeWithNewMemories");
      await assertNotSupersededForUpdate(
        tx,
        ctx,
        opts?.abortIfSuperseded,
        "supersedeWithNewMemories",
      );
      const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];

      await lockExistingLabelsInNameOrder(
        tx,
        ctx,
        news.map((entry) => entry.input.tags),
      );
      for (const { input, jobKinds } of news) {
        const sourceObservationId = input.sourceObservationId ?? null;
        const extractorVersion = input.extractorVersion ?? null;

        const insertedRow = await insertMemoryRow(tx, ctx, input, "supersedeWithNewMemories");

        if (insertedRow === null) {
          const existing = await tx.execute(sql`
            SELECT * FROM memories
            WHERE tenant_id = ${ctx.tenantId}
              AND source_observation_id = ${sourceObservationId}
              AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
              AND content_hash = ${input.contentHash}
            LIMIT 1
          `);
          created.push({
            memory: rowToMemory(existing.rows[0] as unknown as MemoryRow),
            created: false,
            jobs: [],
          });
          continue;
        }

        const memory = rowToMemory(insertedRow);
        await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
        const jobs: OutboxJobRecord[] = [];
        for (const kind of jobKinds) {
          const jobResult = await tx.execute(sql`
            INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
            VALUES (
              gen_random_uuid(),
              ${ctx.tenantId},
              ${kind},
              ${JSON.stringify({ memoryId: memory.id })}::jsonb,
              ${toPgTimestamp(outboxNow)},
              0,
              ${toPgTimestamp(outboxNow)}
            )
            RETURNING *
          `);
          jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
        }
        created.push({ memory, created: true, jobs });
      }

      if (buildCreatedEvent !== undefined) {
        for (const [index, entry] of created.entries()) {
          if (entry.created) {
            await insertCreatedEventRow(
              tx,
              ctx,
              buildCreatedEvent(entry.memory, index),
              entry.memory.id,
            );
          }
        }
      }

      const superseded: MemoryEvent[] = [];
      const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];

      for (const target of supersede) {
        if (!isUuidLike(target.id)) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
        }
        const expectedStatus = target.expectedStatus;
        const statusCondition = expectedStatusCondition(expectedStatus);

        const anchorId = created[target.supersededByIndex]!.memory.id;
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = 'superseded',
              superseded_by_id = ${anchorId},
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${target.id} ${statusCondition}
          RETURNING *
        `);

        if (result.rows.length === 0) {
          if (expectedStatus === undefined) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
          }
          const current = await tx.execute(sql`
            SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${target.id} LIMIT 1
          `);
          if (current.rows.length === 0) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
          }
          const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
          conflicted.push({ id: target.id, observedStatus });
          continue;
        }

        await assertEventTargetInTenant(tx, ctx, target.event.memoryId, [target.id]);
        assertNoNulInNewMemoryEvent("PostgresMemoryStore", target.event);
        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${target.event.memoryId},
            ${target.event.kind},
            ${toPgTimestamp(target.event.at ?? new Date())},
            ${JSON.stringify(target.event.actor)}::jsonb,
            ${target.event.digestSnapshot ?? null},
            ${target.event.sizeBeforeBytes ?? null},
            ${JSON.stringify({ ...target.event.meta, supersededById: anchorId })}::jsonb
          )
          RETURNING *
        `);
        superseded.push(rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow));
      }

      if (
        opts?.abortIfAllConflicted === true &&
        supersede.length > 0 &&
        conflicted.length === supersede.length
      ) {
        throw new SourceMemoryStatusChangedError("supersedeWithNewMemories", conflicted);
      }

      return { created, superseded, conflicted };
    });

    if (result.created.some((entry) => entry.created)) {
      // `news` は複数件渡せるので、`created` 配列のどれか1件でも実際に新しい行を書いていれば ANALYZE の要否を判定する。
      // トランザクションの**外側**で呼ぶ（`createMemoryWithOutbox` と同じ理由）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return buildCreatedEvent === undefined ? result : { ...result, createdEventsWritten: true };
  }

  /**
   * `memory_events` から期限切れ行を消す本体（ADR 0115）。`purgeExpiredEvents` と `purgeExpiredEventsByRetention`
   * （ADR 0354。保持期間を読む `tx` をそのまま渡し、同じトランザクションの中で削除まで行う）が共有する。
   *
   * **`PostgresEventStore` を一切呼ばない。**`memory_events` へ直接 SQL を発行する（`updateStatusWithEvent`/
   * `supersedeWithNewMemories` が append を `PostgresEventStore` 経由にせず直接 INSERT するのと同じ形）。
   *
   * 対象の選定は {@link buildPurgeExpiredEventsTargetSelect} に切り出してある。`EXPLAIN` の歯がこの関数の返り値を
   * そのまま測るため。
   */
  private async purgeExpiredEventsBody(
    exec: SqlExecutor,
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    const dryRun = opts.dryRun ?? false;
    // cutoff が timestamptz の下限より前なら、それより古い行は存在しえない。問い合わせると `timestamp out of range` で
    // 落ちるので、0件の削除として返す（保持日数が約247万日を超えると `computeEventRetentionCutoff` がこの cutoff を作る）。
    if (isBeforePgTimestamptzMin(opts.olderThan)) {
      return { purged: 0, reachedLimit: false, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
    }
    const target = buildPurgeExpiredEventsTargetSelect(ctx, opts);

    if (dryRun) {
      const candidates = await exec.execute(target);
      const rows = candidates.rows as unknown as { at: string }[];
      const reachedLimit = rows.length > opts.limit;
      const victims = rows.slice(0, opts.limit);
      return {
        purged: victims.length,
        reachedLimit,
        oldestPurgedAt: victims.length > 0 ? parsePgTimestamp(victims[0]!.at) : null,
        newestPurgedAt:
          victims.length > 0 ? parsePgTimestamp(victims[victims.length - 1]!.at) : null,
        dryRun,
      };
    }

    const candidates = await exec.execute(target);
    const rows = candidates.rows as unknown as { id: string; at: string }[];
    const reachedLimit = rows.length > opts.limit;
    const victims = rows.slice(0, opts.limit);

    if (victims.length === 0) {
      return { purged: 0, reachedLimit, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
    }

    const victimIds = victims.map((row) => row.id);
    // 対象の SELECT は行を掴まないので、同時に走った掃除は同じ行を選ぶ。先に消した側が commit した後、こちらの DELETE は
    // その行を消さない。名乗る件数・期間は、選んだ行でなく実際に消した行（RETURNING）から取る。
    const deleted = await exec.execute(sql`
      DELETE FROM memory_events
      WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(victimIds)}::uuid[])
      RETURNING at
    `);
    const deletedAts = (deleted.rows as unknown as { at: string }[])
      .map((row) => parsePgTimestamp(row.at))
      .sort((a, b) => a.getTime() - b.getTime());

    if (deletedAts.length === 0) {
      return { purged: 0, reachedLimit, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
    }

    const oldestPurgedAt = deletedAts[0]!;
    const newestPurgedAt = deletedAts[deletedAts.length - 1]!;

    // `at` は SQL の `now()`（マイクロ秒）ではなく、他の書き込みの口と同じく JS の壁時計を `toPgTimestamp` で渡す（ADR 0427）。
    // ミリ秒のまま列に入れないと、読み戻した `at` を `EventStore.list` の `until` に渡したときにその行自身が当たらない。
    await exec.execute(sql`
      INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        NULL,
        'events_purged',
        ${toPgTimestamp(new Date())},
        ${JSON.stringify({ type: "system" })}::jsonb,
        NULL,
        NULL,
        ${JSON.stringify({
          purgedCount: deletedAts.length,
          oldestPurgedAt,
          newestPurgedAt,
          olderThan: opts.olderThan,
        })}::jsonb
      )
    `);

    return { purged: deletedAts.length, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
  }

  /**
   * `memory_events` から期限切れ行を消す保守ジョブ本体（{@link PostgresMemoryStore.purgeExpiredEventsBody} を共有する。ADR 0115）。
   * `dryRun` のときは対象を数えるだけで `db.transaction` を開かない（削除も INSERT も実行しない）。
   */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun ?? false;
    if (dryRun) {
      return this.purgeExpiredEventsBody(this.db, ctx, opts);
    }
    return this.db.transaction((tx) => this.purgeExpiredEventsBody(tx, ctx, opts));
  }

  /**
   * `MemoryStore.purgeExpiredEventsByRetention?` の Postgres 実装（ADR 0354）。保持期間の読みと削除を1つのトランザクションにする。
   * `tenant_settings.event_retention_days` を `SELECT ... FOR SHARE` で読み（`setEventRetention` の `UPDATE`/`INSERT` と
   * 行ロックで競合する）、`days` のときだけ {@link PostgresMemoryStore.purgeExpiredEventsBody} を**同じトランザクションの中で**呼ぶ。
   * `dryRun` のときも `FOR SHARE` の読みは同じトランザクションで行う（`purgeExpiredEvents` と違い、トランザクションを省略しない）。
   *
   * `TenantSettingsStore` を経由しない。別 adapter を呼ぶとその呼び出し自体がこのトランザクションの外に出てしまう。
   */
  async purgeExpiredEventsByRetention(
    ctx: Ctx,
    opts: PurgeExpiredEventsByRetentionOptions,
  ): Promise<PurgeExpiredEventsByRetentionOutcome> {
    assertWellFormedCtx(ctx);
    return this.db.transaction(async (tx) => {
      const settingsResult = await tx.execute(sql`
        SELECT event_retention_days FROM tenant_settings WHERE tenant_id = ${ctx.tenantId}
        FOR SHARE
      `);
      if (settingsResult.rows.length === 0) {
        return { kind: "unset" };
      }
      const row = settingsResult.rows[0] as unknown as { event_retention_days: number | null };
      if (row.event_retention_days === null) {
        return { kind: "unlimited" };
      }
      const olderThan = computeEventRetentionCutoff(opts.now, row.event_retention_days);
      const result = await this.purgeExpiredEventsBody(tx, ctx, {
        olderThan,
        limit: opts.limit,
        dryRun: opts.dryRun,
      });
      return { kind: "executed", result };
    });
  }

  /**
   * `MemoryStore.purgeExpiredRecalls?` の実装（ADR 0404）。対象の `recalls` を先に確定し（古い順に `limit + 1` 件、`FOR UPDATE` で
   * 行を掴む）、**同じトランザクションで**その子の `recall_usages` → `recalls` の順に消す（`recall_usages.recall_id` は
   * `ON DELETE` 無しの外部キー）。`limit` は recalls の行数で数える。掴んだ行に並行の `recordUsage`（外部キー検査が行ロックを
   * 取る）が割り込むと、そちらが待たされ、こちらの commit 後に外部キー違反になる。`dryRun` のときはトランザクションを開かず、
   * 行も掴まない。
   */
  async purgeExpiredRecalls(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun ?? false;
    if (isBeforePgTimestamptzMin(opts.olderThan)) {
      return {
        purged: 0,
        purgedUsages: 0,
        reachedLimit: false,
        oldestPurgedAt: null,
        newestPurgedAt: null,
        dryRun,
      };
    }
    if (dryRun) {
      return this.purgeExpiredRecallsBody(this.db, ctx, opts, dryRun);
    }
    return this.db.transaction((tx) => this.purgeExpiredRecallsBody(tx, ctx, opts, dryRun));
  }

  private async purgeExpiredRecallsBody(
    exec: SqlExecutor,
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
    dryRun: boolean,
  ): Promise<PurgeExpiredRecallsResult> {
    const candidates = await exec.execute(buildPurgeExpiredRecallsTargetSelect(ctx, opts, !dryRun));
    const rows = candidates.rows as unknown as { id: string; created_at: string }[];
    const reachedLimit = rows.length > opts.limit;
    const victims = rows.slice(0, opts.limit);
    if (victims.length === 0) {
      return {
        purged: 0,
        purgedUsages: 0,
        reachedLimit,
        oldestPurgedAt: null,
        newestPurgedAt: null,
        dryRun,
      };
    }
    const victimIds = victims.map((row) => row.id);

    if (dryRun) {
      const usages = await exec.execute(sql`
        SELECT count(*)::int AS count FROM recall_usages
        WHERE tenant_id = ${ctx.tenantId} AND recall_id = ANY(${sql.param(victimIds)}::uuid[])
      `);
      return {
        purged: victims.length,
        purgedUsages: (usages.rows[0] as unknown as { count: number }).count,
        reachedLimit,
        oldestPurgedAt: parsePgTimestamp(victims[0]!.created_at),
        newestPurgedAt: parsePgTimestamp(victims[victims.length - 1]!.created_at),
        dryRun,
      };
    }

    const usages = await exec.execute(sql`
      DELETE FROM recall_usages
      WHERE tenant_id = ${ctx.tenantId} AND recall_id = ANY(${sql.param(victimIds)}::uuid[])
      RETURNING recall_id
    `);
    const deleted = await exec.execute(sql`
      DELETE FROM recalls
      WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(victimIds)}::uuid[])
      RETURNING created_at
    `);
    const createdAts = (deleted.rows as unknown as { created_at: string }[])
      .map((row) => parsePgTimestamp(row.created_at))
      .sort((a, b) => a.getTime() - b.getTime());
    return {
      purged: createdAts.length,
      purgedUsages: usages.rows.length,
      reachedLimit,
      oldestPurgedAt: createdAts.length > 0 ? createdAts[0]! : null,
      newestPurgedAt: createdAts.length > 0 ? createdAts[createdAts.length - 1]! : null,
      dryRun,
    };
  }

  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // `ready` を `failed` へ巻き戻さない（ADR 0053）。`ready` は VectorStore.upsert が返った*後*にしか書かれない「ベクトル行が在る」
    // の主張で、リースを失った古いワーカーの catch から来る `failed`（at-least-once。ADR 0032）に負けてはならない。
    // 書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよいが、WHERE に入れなければならないのは
    // *読んだ状態*（現在の embedding_status）のほうだけ。アプリ側で現在値を読んで比べてから書くと、読みと書きの間に入った
    // 別の書き込みを上書きしうる（`reinforce`・`updateStatus` の CAS と同じ形）。
    //
    // **共有述語 `isEmbeddingStatusRollback` はここでは呼べない。**比較そのものを DB の1文へ入れる必要があるため、値
    // （`from`/`to`）だけを `EMBEDDING_STATUS_ROLLBACK` から取り、比較の形は SQL 側にもう一度書く（ADR 0053）。
    const rollbackGuard =
      status === EMBEDDING_STATUS_ROLLBACK.to
        ? sql` AND embedding_status <> ${EMBEDDING_STATUS_ROLLBACK.from}`
        : sql``;

    // **更新できなかったときに返す行も、同じ1文の中で読む。**1文なら、更新できた場合もできなかった場合も同じスナップショットを
    // 通る。`UPDATE ... RETURNING *` → 0 行なら別の `SELECT` の2文に割ると、2文のあいだに他の接続のコミットが入ったとき、
    // 新しいスナップショットの行を返しうる。`setEmbeddingStatus` には手前の `SELECT` が無く（存在検査は `isUuidLike` だけ）、
    // ガードで弾かれる `UPDATE` は行ロックを取らないので、並行時にどちらのスナップショットを返すべきかの判断は、今の口では置けない
    // （ADR 0053）。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET embedding_status = ${status}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}${rollbackGuard}
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    if (result.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  /** `ReinforceOptions.addOwnSubjectSeq` を読める（行ごとに Memory 自身の subject の `S_x` を UPDATE の中で足す。ADR 0394）。 */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const current = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    if (current.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const memory = rowToMemory(current.rows[0] as unknown as MemoryRow);
    const decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: at,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });

    // `opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときに限り、活動時計側の起点・床
    // （decay_base_seq/decay_floor_seq）も同じ強化イベントとして進める（ADR 0165）。`halfLifeRecalls` が無い Memory は
    // 活動時計では沈まないので、列を作らない。この条件片は同じ SET の末尾に足すだけで、`opts.nowSeq` が無い呼び出しでは
    // 空文字列になり、壁時計側だけの SQL とバイト単位で同じ文になる。
    //
    // `opts.addOwnSubjectSeq === true` のときは、`opts.nowSeq`（= `T`）にこの行自身の subject の `S_x` を UPDATE の中で足して
    // 起点にする（ADR 0394）。床は `起点 + ceil(offset)`（`defaultActivityDecayStrategy.floorAt` と同じ式。`baseSeq: 0` で
    // offset だけを取り、起点は SQL 側で足す）。`Number.MAX_SAFE_INTEGER` で丸める規律も同じ。
    let activitySet = sql``;
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      if (opts.addOwnSubjectSeq === true) {
        const offset = defaultActivityDecayStrategy.floorAt({
          baseSeq: 0,
          strength: memory.strength,
          halfLifeRecalls: memory.halfLifeRecalls,
        });
        const effectiveNow = ownSubjectActivityNow({
          tenantSeq: sql`${opts.nowSeq}`,
          tenantIdExpr: sql`memories.tenant_id`,
          subjectIdExpr: sql`memories.subject_id`,
        });
        activitySet = sql`, decay_base_seq = ${effectiveNow}, decay_floor_seq = LEAST(${effectiveNow} + ${offset}::bigint, ${Number.MAX_SAFE_INTEGER}::bigint)`;
      } else {
        activitySet = sql`, decay_base_seq = ${opts.nowSeq}, decay_floor_seq = ${defaultActivityDecayStrategy.floorAt(
          {
            baseSeq: opts.nowSeq,
            strength: memory.strength,
            halfLifeRecalls: memory.halfLifeRecalls,
          },
        )}`;
      }
    }

    // **減衰の起点を巻き戻さない条件は WHERE 句に置く**（ADR 0048）。上の SELECT で読んだ値をアプリ側で比べて書くかどうか決めると、
    // 読みと書きの間に入った別の強化を上書きしうる。
    //
    // 古い `at` は**失敗にしない。**呼び出し側から見れば「すでにもっと新しい強化が入っている」だけで、例外にすると
    // `runtime.observe` の使用報告ループが途中で止まる（`updateStatus` の CAS は status の取り違えなので違う）。
    //
    // **更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、「上で読んだ古い値をそのまま返す」実装との
    // 差が外から観測できない枝になる。活動時計側の3列も、壁時計側と**同じ WHERE 句**で守る。両方とも「同じ強化イベント」の
    // 一部で、片方だけ別の条件で進むと2軸の起点がずれる（ADR 0165）。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET last_reinforced_at = ${toPgTimestamp(at)}, decay_floor_at = ${toPgTimestamp(decayFloorAt)}, updated_at = now()${activitySet}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          AND COALESCE(last_reinforced_at, recorded_at) < ${toPgTimestamp(at)}
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  /**
   * `reinforce` を `ids` の各要素について呼んだのと同じ結果になる一括版（契約は `MemoryStore.reinforceMany` の doc。ADR 0303）。
   * `ids` の件数によらず**定数2往復**: (1) 単調性・活動時計の判定に使う不変の列を全件ぶん1回で SELECT、(2) 行ごとに計算した値を
   * `VALUES (...)` で持ち込み、`COALESCE(last_reinforced_at, recorded_at) < at` という**同じ CAS 条件**で1文にまとめて UPDATE する。
   * 更新できなかった行は、同じ文の中で現在値を読み直して返す（`reinforce` の `UNION ALL` と同じ理由）。
   *
   * **単調性の比較そのものは、1件ずつのときと同じく UPDATE の WHERE 句の中で行う。**上の SELECT で読んだ値は比較には使わない。
   *
   * `ids` に重複がある場合は1回だけ処理する。戻り値は元の `ids`（重複・順序とも）に合わせて組み直す。入口で uuid の形の id を
   * 小文字にそろえてから去重・突き合わせる。DB は uuid を大文字小文字を区別せず比べて小文字で返すので、渡された id のまま
   * 突き合わせると、大文字の id だけで「memory not found」になり `reinforce` と結果が割れる。
   *
   * `ids` に存在しない・形式が不正な id が含まれる場合、**書ける対象へは書き込みを済ませてから**、`reinforce` と同じ
   * 「memory not found」の `Error` を投げる。**これは1件ずつのループと厳密には一致しない**（ループは最初に見つからない id で
   * 投げ、それ以降の id には触れない）。runtime の唯一の呼び出し元（`handleMemoryUsage`）では起こらない（`recall_usages.memory_id` が
   * 外部キーを持つので、`insertedMemoryIds` は常に実在する行を指す）。厳密に揃えるには見つからない id の手前で打ち切る必要があり、
   * 「定数回の往復で束ねる」目的と衝突するので、揃えなかった。
   */
  async reinforceMany(
    ctx: Ctx,
    ids: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    return this.reinforceManyOn(this.db, ctx, ids, at, opts);
  }

  /** `reinforceMany` の本体。`recordUsageAndReinforce` がトランザクションの中から呼ぶため、実行者を受け取る。 */
  private async reinforceManyOn(
    exec: SqlExecutor,
    ctx: Ctx,
    ids: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<Memory[]> {
    if (ids.length === 0) {
      return [];
    }

    // 入口の正規化。形の合わない id はそのまま（どの行とも一致しない）。
    const normalizedIds = ids.map(normalizeUuidCase);
    const uniqueIds = [...new Set(normalizedIds)];
    const wellFormedIds = uniqueIds.filter((id) => isUuidLike(id));

    const current = await exec.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
    `);
    const currentById = new Map<string, Memory>();
    for (const row of current.rows) {
      const memory = rowToMemory(row as unknown as MemoryRow);
      currentById.set(memory.id, memory);
    }

    // `ids` の元の順で最初に見つからない id（`reinforce` 単体なら「memory not found」になる id）。書き込みはこれとは独立に「見つかった id 全部」へ行う。
    const missingId = normalizedIds.find((id) => !currentById.has(id));
    const existingIds = wellFormedIds.filter((id) => currentById.has(id));

    if (existingIds.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${missingId}`);
    }

    const addOwnSubjectSeq = opts?.addOwnSubjectSeq === true;
    const rows = existingIds.map((id) => {
      const memory = currentById.get(id)!;
      const decayFloorAt = defaultDecayStrategy.floorAt({
        recordedAt: memory.recordedAt,
        lastReinforcedAt: at,
        strength: memory.strength,
        halfLifeHours: memory.halfLifeHours,
      });
      // 行ごとに判定する。`halfLifeRecalls` を持つ行だけ活動時計側の列に触れる（`reinforce` と同じ分岐。ADR 0165）。
      const hasActivity = opts?.nowSeq !== undefined && memory.halfLifeRecalls != null;
      // `addOwnSubjectSeq` のときは、入力の列に起点でなく `T` と床までの相対（offset）を持ち込み、起点と床は UPDATE の中でその行自身の
      // subject の `S_x` を足して作る（ADR 0394）。
      const activityFloorSeq = hasActivity
        ? defaultActivityDecayStrategy.floorAt({
            baseSeq: addOwnSubjectSeq ? 0 : opts!.nowSeq!,
            strength: memory.strength,
            halfLifeRecalls: memory.halfLifeRecalls!,
          })
        : null;
      return {
        id,
        decayFloorAt,
        hasActivity,
        activityBaseSeq: hasActivity ? opts!.nowSeq! : null,
        activityFloorSeq,
      };
    });

    // 行ごとに 5 個のバインドパラメータを `VALUES` に並べると、13107 件目で PG の上限（65535）を超える。列ごとの配列 5 個（`unnest`）で
    // 渡し、件数によらずパラメータを 5 個に固定する（ADR 0443）。
    const inputIds = sql.param(rows.map((r) => r.id));
    const inputDecayFloorAts = sql.param(rows.map((r) => toPgTimestamp(r.decayFloorAt)));
    const inputHasActivities = sql.param(rows.map((r) => r.hasActivity));
    const inputActivityBaseSeqs = sql.param(rows.map((r) => r.activityBaseSeq));
    const inputActivityFloorSeqs = sql.param(rows.map((r) => r.activityFloorSeq));

    // `addOwnSubjectSeq` のときだけ、起点・床を行ごとに UPDATE の中で組む（`input.activity_base_seq` は `T`、`input.activity_floor_seq` は
    // 床までの相対 offset。ADR 0394）。そうでなければ `tenant_subject_activity` を参照しない文にする。
    const effectiveNow = ownSubjectActivityNow({
      tenantSeq: sql`input.activity_base_seq`,
      tenantIdExpr: sql`m.tenant_id`,
      subjectIdExpr: sql`m.subject_id`,
    });
    const activitySetMany = addOwnSubjectSeq
      ? sql`decay_base_seq = CASE WHEN input.has_activity THEN ${effectiveNow} ELSE m.decay_base_seq END,
            decay_floor_seq = CASE WHEN input.has_activity THEN LEAST(${effectiveNow} + input.activity_floor_seq, ${Number.MAX_SAFE_INTEGER}::bigint) ELSE m.decay_floor_seq END`
      : sql`decay_base_seq = CASE WHEN input.has_activity THEN input.activity_base_seq ELSE m.decay_base_seq END,
            decay_floor_seq = CASE WHEN input.has_activity THEN input.activity_floor_seq ELSE m.decay_floor_seq END`;

    const result = await exec.execute(sql`
      WITH input(id, decay_floor_at, has_activity, activity_base_seq, activity_floor_seq) AS (
        SELECT * FROM unnest(
          ${inputIds}::uuid[], ${inputDecayFloorAts}::timestamptz[], ${inputHasActivities}::boolean[],
          ${inputActivityBaseSeqs}::bigint[], ${inputActivityFloorSeqs}::bigint[]
        )
      ),
      updated AS (
        UPDATE memories m
        SET last_reinforced_at = ${toPgTimestamp(at)},
            decay_floor_at = input.decay_floor_at,
            updated_at = now(),
            ${activitySetMany}
        FROM input
        WHERE m.tenant_id = ${ctx.tenantId} AND m.id = input.id
          AND COALESCE(m.last_reinforced_at, m.recorded_at) < ${toPgTimestamp(at)}
        RETURNING m.*
      )
      SELECT * FROM updated
      UNION ALL
      SELECT m.* FROM memories m
      JOIN input ON input.id = m.id
      WHERE m.tenant_id = ${ctx.tenantId}
        AND NOT EXISTS (SELECT 1 FROM updated u WHERE u.id = m.id)
    `);

    const resultById = new Map<string, Memory>();
    for (const row of result.rows) {
      const memory = rowToMemory(row as unknown as MemoryRow);
      resultById.set(memory.id, memory);
    }

    if (missingId !== undefined) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${missingId}`);
    }

    return normalizedIds.map((id) => resultById.get(id)!);
  }

  async recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    assertWellFormedCtx(ctx);
    return this.recordUsageOn(this.db, ctx, recallId, memoryIds);
  }

  /**
   * `recordUsage` と、それが返した `insertedMemoryIds` への強化（`reinforceMany` と同じ SQL）を1トランザクションで撃つ。強化の UPDATE が
   * 失敗すれば `recall_usages` の INSERT も巻き戻るので、同じ使用報告の再送がそのまま両方をやり直す。
   */
  async recordUsageAndReinforce(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    assertWellFormedCtx(ctx);
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    return this.db.transaction(async (tx) => {
      const result = await this.recordUsageOn(tx, ctx, recallId, memoryIds);
      if (result.insertedMemoryIds.length > 0) {
        await this.reinforceManyOn(tx, ctx, result.insertedMemoryIds, at, opts);
      }
      return result;
    });
  }

  /** `recordUsage` の本体。`recordUsageAndReinforce` がトランザクションの中から呼ぶため、実行者を受け取る。 */
  private async recordUsageOn(
    exec: SqlExecutor,
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    const checkedRecallId = checkedRef("recall", recallId)!;
    const ids = memoryIds.map((id) => checkedRef("memory", id)!);
    // 確かめと書き込みを1つの SQL 文にする。外部キーはテナントを含まないので、検査が無いと別テナントの recall・memory を指す行が
    // `ctx` の行として書け、その行が相手のテナントの `purgeExpiredRecalls`（外部キー違反）と `eraseTenant` を止める。
    // どれか1件でも違えば、全体を書かない。
    const result = await exec.execute(sql`
      WITH chk AS (
        SELECT
          ${refExists("recalls", ctx.tenantId, sql`${checkedRecallId}`)} AS recall_ok,
          (
            SELECT u.id FROM unnest(${sql.param(ids)}::uuid[]) AS u(id)
            WHERE NOT EXISTS (
              SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = u.id
            )
            LIMIT 1
          ) AS missing_memory_id
      ), ins AS (
        INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at)
        SELECT ${ctx.tenantId}, ${checkedRecallId}::uuid, m.id, now()
        FROM unnest(${sql.param(ids)}::uuid[]) AS m(id), chk
        WHERE chk.recall_ok AND chk.missing_memory_id IS NULL
        ON CONFLICT (tenant_id, recall_id, memory_id) DO NOTHING
        RETURNING memory_id
      )
      SELECT chk.recall_ok, chk.missing_memory_id, ins.memory_id
      FROM chk LEFT JOIN ins ON TRUE
    `);
    const rows = result.rows as unknown as Array<{
      recall_ok: boolean;
      missing_memory_id: string | null;
      memory_id: string | null;
    }>;
    if (!rows[0]!.recall_ok) {
      throw refNotFound("recall", checkedRecallId);
    }
    if (rows[0]!.missing_memory_id !== null) {
      throw refNotFound("memory", rows[0]!.missing_memory_id);
    }
    return {
      insertedMemoryIds: rows.flatMap((row) => (row.memory_id === null ? [] : [row.memory_id])),
    };
  }

  /**
   * **単一の集約クエリ**で、群カウント（第3階）・スコープ内総数・スコープを定義するフィルタ（status/period）で落ちた件数・
   * not_indexed 件数のすべてを返す。別々のクエリから出すと、その間の書き込みで総和が一致しなくなる（ADR 0011 が段1から
   * 締め出した `count(*) OVER ()` と同じ理由）。`opts.digestBand`（目次帯。ADR 0073）と忘却ゲートの件数（`decayed_filtered`。
   * ADR 0173）も同じ SQL 文・1回の往復に相乗りさせる。別クエリにすると別スナップショットになり、並行する書き込みの下で
   * 被覆不変条件や `totalInScope` との整合が崩れる。
   *
   * `status` の4分岐（scope 内 / archived / superseded / forgotten）と period の内外は、`FILTER (WHERE ...)` による条件付き集約で
   * 1回のスキャンで計算する。**superseded と forgotten は別々の列として数える**（ADR 0027）。前者は機構の都合、後者は
   * 利用者が意図して忘れさせた製品の振る舞いで、束ねると呼び出し側がどちらだったか判定できない。
   *
   * ## 単一パス（ADR 0307）
   *
   * 各行の述語（`live`/`in_period`/`is_valid`/`is_expired`/`is_not_yet_valid`/`is_decayed`）は `flags` CTE で1回だけ boolean として
   * 計算し、`GROUP BY subject_id` で subject ごとの各カウンタを1パスで出す（`agg` CTE）。外側で `groups`（`in_scope > 0` の subject のみ）と
   * 各合計を1回の `Aggregate` で取る。合計は `coalesce(sum(...), 0)` にする（空テナントで `agg` が0行になっても `NULL` でなく `0` を返す）。
   *
   * **`scoped` を `MATERIALIZED` にしない。**1回しか参照されない非再帰 CTE は PG12+ が自動でインライン化する。実体化すると、
   * digest を持たない狭い行でも大きなテナントで `work_mem`（既定 4MB。GUC はアプリの既定を変えるので変えない）を超えて
   * ディスクへ溢れ、述語を複数回再評価するより遅くなる。`scoped` の projection に `digest`（テキスト列）を含めない
   * （含めると、複数回参照される CTE の実体化でテナント全件の本文がディスクへ溢れる）。
   *
   * **`digestBand` は `scoped`/`agg` を経由せず、`memories` を直接（同じ `tenant_id`/`subjectFilter` の WHERE で）引くサブクエリ**にする。
   * `digests`（top-N）は digest 本文が要るので `memories` を直接スキャンする。`digest_eligible_count` は再スキャンせず、`agg` の
   * `in_scope` 合計から、`excludeMemoryIds`（高々 digestBand.limit 件）に該当する行のうち in_scope 条件を満たす件数を引き算して出す
   * （`id = ANY(...)` は主キーに乗るので、テナント規模に依存しない定数コスト）。
   *
   * **`groups` の出現順序は契約ではない**（`ScopeAggregate.groups` の doc は順序に触れておらず、呼び出し側も依存しない）。
   * `json_agg` に `ORDER BY` を持たず、`GroupAggregate` の実行順に従う。
   */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    // `skip` で `digestBand` も無いとき、クエリを1本も発行しないので NUL を見ない（testkit のインメモリ実装と同じ。ADR 0434）。
    if (!(opts?.scopeAggregate === "skip" && opts.digestBand === undefined)) {
      assertNoNulInScopeFilter("PostgresMemoryStore.aggregateScope", scope, "scope");
    }
    const subjectFilter =
      scope.subjectId !== undefined
        ? scope.includeSubjectless === true
          ? sql`AND (subject_id = ${scope.subjectId} OR subject_id IS NULL)`
          : sql`AND subject_id = ${scope.subjectId}`
        : sql``;
    // `attributes` も `subjectId` と同じくスコープの外側の境界。`scoped` CTE の WHERE に足すことで、この絞り込みの外は `totalInScope` は
    // もちろん `filtered*` のどの列にも数えない（ADR 0312）。`@>` は `idx_memories_attributes` の GIN 索引が効く述語。
    const attributesFilter =
      scope.attributes !== undefined
        ? sql`AND attributes @> ${JSON.stringify(scope.attributes)}::jsonb`
        : sql``;
    // taxonomy は `attributes`/`subjectId` と違い、「period/validity と同じ、filtered として報告されるゲート」である
    // （`FILTERED_CONDITION_SCOPE_RELATION.taxonomy === 'outside_scope'`。ADR 0323）。⟹ `scoped` の WHERE には入れず、
    // `flags`/`agg` の中で boolean として持つ（直前までのゲートを通過し、このゲートだけで落ちた件数を数えるため）。
    // `labels.name` は書き込み経路が `tags` からしか作らないので1対1で一致し、`memory_labels`/`labels` を JOIN せず
    // `tags` の配列の重なりだけで判定できる。
    const hasQualifyingLabel =
      scope.labels !== undefined ? sql`(tags && ${sql.param(scope.labels)}::text[])` : sql`true`;
    const occurredAfter = toPgTimestampClamped(scope.occurredAfter);
    const occurredBefore = toPgTimestampClamped(scope.occurredBefore);

    const inPeriod = sql`(
      ${occurredAfter}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) >= ${occurredAfter}::timestamptz
    ) AND (
      ${occurredBefore}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) <= ${occurredBefore}::timestamptz
    )`;

    const validAt = toPgTimestampClamped(scope.validAt);
    const isValid = sql`(
      ${validAt}::timestamptz IS NULL OR (
        (valid_from IS NULL OR valid_from <= ${validAt}::timestamptz)
        AND (valid_until IS NULL OR valid_until > ${validAt}::timestamptz)
      )
    )`;
    const isExpired = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_until IS NOT NULL AND valid_until <= ${validAt}::timestamptz
    )`;
    const isNotYetValid = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_from IS NOT NULL AND valid_from > ${validAt}::timestamptz
    )`;

    // 忘却ゲート（`decay_floor_at` / `decay_floor_seq`）が落とした件数を、**段1の押し下げ（`PostgresVectorStore.search` の
    // `decayFloorAtCondition` / `decayFloorSeqCondition` / `decayFloorAnyAxis`）とまったく同じ述語**で厳密に数える（ADR 0173）。
    // 生き残る側の述語を書いて否定することで、「押し下げが通したもの」と「ここが数えないもの」が定義上一致する。
    // **`NOT` を分配して書き直さないこと。**'either' は OR なので `NOT (wall OR seq)` = `NOT wall AND NOT seq` で、AND/OR を
    // 取り違えると「段1で落ちた数」と「集約が数えた数」が黙って食い違う。
    // `decay_floor_at` は NOT NULL なので三値論理の穴は無い。`decay_floor_seq` は NULL を取りうるが、生き残る側が
    // `IS NULL OR ...` の形なので、その否定は `IS NOT NULL AND ... <= p` になり、NULL が UNKNOWN で漏れることは無い。
    const decayFloorAtAfter = scope.decayFloorAtAfter;
    const decayFloorSeqAfter = scope.decayFloorSeqAfter;
    const wallAxisAlive =
      decayFloorAtAfter !== undefined
        ? sql`(decay_floor_at > ${toPgTimestampClamped(decayFloorAtAfter)}::timestamptz)`
        : undefined;
    // `scope.decayFloorSeqUsesSubjectCounters` が true のときだけ相関サブクエリで subject 単位のカウンタを足す（段1と同じ述語。ADR 0353）。
    // この述語は `flags` CTE（`FROM scoped`）の中で評価される。相関サブクエリの中の修飾の無い `tenant_id`/`subject_id` は内側の
    // `tenant_subject_activity` の列に解決されて恒真になる（ADR 0438）ので、テナントは `scoped` の行が全部 `ctx.tenantId` であることを
    // 使って値で渡し、subject は `scoped.` で修飾する。
    const activityAxisAlive = activityFloorSeqAliveCondition({
      decayFloorSeqAfter,
      usesSubjectCounters: scope.decayFloorSeqUsesSubjectCounters === true,
      floorSeqExpr: sql`decay_floor_seq`,
      tenantIdExpr: sql`${ctx.tenantId}`,
      subjectIdExpr: sql`scoped.subject_id`,
    });
    let isDecayed: SQL;
    if (wallAxisAlive === undefined && activityAxisAlive === undefined) {
      // ゲート無効（`RecallQuery.includeFullyDecayed: true`）。**0件と数える**（「ゲートを外した」ことと「0件落ちた」ことは、呼び出し側から見て同じ）。
      isDecayed = sql`false`;
    } else if (
      scope.decayFloorAnyAxis === true &&
      wallAxisAlive !== undefined &&
      activityAxisAlive !== undefined
    ) {
      isDecayed = sql`(NOT ${wallAxisAlive} AND NOT ${activityAxisAlive})`;
    } else if (wallAxisAlive !== undefined && activityAxisAlive !== undefined) {
      isDecayed = sql`(NOT ${wallAxisAlive} OR NOT ${activityAxisAlive})`;
    } else if (wallAxisAlive !== undefined) {
      isDecayed = sql`(NOT ${wallAxisAlive})`;
    } else {
      isDecayed = sql`(NOT ${activityAxisAlive!})`;
    }

    // 段1の ANN から除外した kind（非空のときだけ）で**索引済み**（`embedding_status = 'ready'`）の行を、`in_scope` と同じ絞りの上で
    // 数える列を足す（`recall()` が `eligible`（`in_scope` − `not_indexed`）から引くため。ADR 0390）。未指定・空配列のときは、
    // 列も欄も足さない（SQL テキストが変わらない）。
    const excludeProvenanceKinds =
      opts?.excludeProvenanceKinds !== undefined && opts.excludeProvenanceKinds.length > 0
        ? [...opts.excludeProvenanceKinds]
        : undefined;
    const provenanceScopedColumn = excludeProvenanceKinds ? sql`, provenance_kind` : sql``;
    const provenanceFlagColumn = excludeProvenanceKinds
      ? sql`,
          (provenance_kind = ANY(${sql.param(excludeProvenanceKinds)}::text[])) AS is_excluded_provenance`
      : sql``;
    const provenanceAggColumn = excludeProvenanceKinds
      ? sql`,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'ready' AND is_excluded_provenance
          )::int AS excluded_provenance_indexed`
      : sql``;
    const provenanceResultColumn = excludeProvenanceKinds
      ? sql`,
        coalesce(sum(excluded_provenance_indexed), 0)::int AS excluded_provenance_indexed`
      : sql``;

    const digestBand = opts?.digestBand;
    const excludeMemoryIds = digestBand ? digestBand.excludeMemoryIds.filter(isUuidLike) : [];
    // `digests` の `ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC LIMIT n` は、部分索引 `idx_memories_digest_band`
    // （`migrations/0028_digest_band_index.sql`。ADR 0384）に支えられる。`occurredAfter`/`occurredBefore`/`validAt`/`labels` を指定
    // しない既定の呼び出しでは `in_period`/`is_valid`/`has_qualifying_label` が定数 `true` になるため、索引だけで `LIMIT` まで打ち切れる。
    const digestBandColumns = digestBand
      ? sql`,
        (
          SELECT coalesce(
            json_agg(
              json_build_object('memoryId', id, 'digest', digest)
              ORDER BY eff_time DESC, id DESC
            ),
            '[]'::json
          )
          FROM (
            SELECT id, digest, COALESCE(occurred_at, recorded_at) AS eff_time
            FROM memories
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND NOT (id = ANY(${sql.param(excludeMemoryIds)}::uuid[]))
            ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
            LIMIT ${digestBand.limit}
          ) band
        ) AS digests,
        (
          coalesce(sum(in_scope), 0) - coalesce((
            SELECT count(*)
            FROM memories
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND id = ANY(${sql.param(excludeMemoryIds)}::uuid[])
          ), 0)
        )::int AS digest_eligible_count`
      : sql``;

    // `RecallQuery.taxonomyGroups: true` のときだけ追加する（`scope.taxonomyGroupCandidates` が `undefined` なら SQL テキストにも
    // 実行計画にも現れない。ADR 0323）。`scoped`/`flags`/`agg` を経由せず `memories` を直接再スキャンする。`unnest(tags)` を伴う
    // `GROUP BY` は `agg` の `GROUP BY subject_id` と粒度が違うので、単一パスに混ぜない。`hasQualifyingLabel` の内側を数える
    // （「絞り込み済みの現在のスコープ」をテナントの語彙全体で内訳する）。
    //
    // **1件の Memory は、1つのラベル群に1回だけ数える**（`GroupCount.count` は Memory の件数）。`tags` は作成時の値をそのまま持つので、
    // 同じ名前が重なりうる。`unnest(tags)` をそのまま数えると、重なった名前の群を多く数えてしまう。`array_position(tags, tag) = position` で、
    // その名前が `tags` の中で最初に現れた位置だけを残す（並べ替えを伴う `DISTINCT`・`count(DISTINCT id)` を足さずに済む形）。
    const taxonomyGroupCandidates = scope.taxonomyGroupCandidates;
    const taxonomyGroupColumns =
      taxonomyGroupCandidates !== undefined
        ? sql`,
        (
          SELECT coalesce(json_agg(json_build_object('key', tag, 'count', tag_count)), '[]'::json)
          FROM (
            SELECT tag, count(*)::int AS tag_count
            FROM memories, unnest(tags) WITH ORDINALITY AS labels_of_memory(tag, position)
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND tag = ANY(${sql.param([...taxonomyGroupCandidates])}::text[])
              AND array_position(tags, tag) = position
            GROUP BY tag
          ) t
        ) AS taxonomy_label_groups,
        (
          SELECT count(*)::int
          FROM memories
          WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
            AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
            AND ${hasQualifyingLabel}
            AND NOT (tags && ${sql.param([...taxonomyGroupCandidates])}::text[])
        ) AS taxonomy_residual_count`
        : sql``;

    // `opts.scopeAggregate === "skip"` のときは、下の `scoped`/`flags`/`agg` の集計クエリ（この関数の支配項）を**まったく実行しない**
    // （ADR 0384）。`AggregateScopeOptions.scopeAggregate` の doc が禁じる「値だけ受け取って計算は今までどおり行う実装」にしない。
    // `digestBand` が指定されていれば、それだけ独立した `SELECT`（部分索引 `idx_memories_digest_band` が支える）で digest を引く。
    // 集計とは別の経路なので、"skip" でも目次帯自体は出る（`digestEligible` は件数の一種なので `unknown` にする）。
    // `taxonomyGroupCandidates` が同時に指定されていても、taxonomy 群カウントも計算しない（`groups` は空のまま）。
    if (opts?.scopeAggregate === "skip") {
      let digests: ScopeAggregate["digests"] = [];
      if (digestBand) {
        const digestsResult = await this.db.execute(sql`
          SELECT id, digest
          FROM memories
          WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
            AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
            AND ${hasQualifyingLabel}
            AND NOT (id = ANY(${sql.param(excludeMemoryIds)}::uuid[]))
          ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
          LIMIT ${digestBand.limit}
        `);
        digests = (digestsResult.rows as unknown as { id: string; digest: string }[]).map((d) => ({
          memoryId: d.id as MemoryId,
          digest: d.digest,
        }));
      }
      const unknownCount = { count: 0, countKind: "unknown" as const };
      return {
        groups: [],
        totalInScope: 0,
        countKind: "unknown",
        notIndexed: {
          pending: unknownCount,
          failed: unknownCount,
          skipped: unknownCount,
        },
        filteredArchived: unknownCount,
        filteredSuperseded: unknownCount,
        filteredForgotten: unknownCount,
        filteredPeriod: unknownCount,
        filteredExpired: unknownCount,
        filteredNotYetValid: unknownCount,
        filteredTaxonomy: unknownCount,
        filteredDecayed: unknownCount,
        digests,
        // `digestBand` を渡していなければ集計自体が起きないので、`digestEligible: { count: 0, countKind: 'exact' }` という契約
        // （`AggregateScopeOptions.digestBand` の doc）を "skip" でも保つ。
        digestEligible: digestBand ? unknownCount : { count: 0, countKind: "exact" },
      };
    }

    // 各行の述語を `scoped` の上の `flags` で1回だけ boolean として計算し、`agg` で `GROUP BY subject_id` して subject ごとの
    // 各カウンタを1パスで出す（ADR 0307）。`scoped`・`agg` はどちらも1回しか参照されないので、Postgres は既定でインライン化する。
    // **`MATERIALIZED` を明示しない**（メソッドの doc 参照）。
    const result = await this.db.execute(sql`
      WITH scoped AS (
        SELECT subject_id, occurred_at, recorded_at, embedding_status, status,
               valid_from, valid_until, decay_floor_at, decay_floor_seq, tags${provenanceScopedColumn}
        FROM memories
        WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
      ),
      -- 述語を1回だけ boolean にする層。scoped を素の射影のまま残すのは、ADR 0303 の
      -- 前提の歯（scripts/__tests__/decay-floor-owner-premises.test.mjs）が scoped の本体を
      -- 字句で読んで「status で絞らない」を検査しているため。どの CTE も1回しか参照されず
      -- インライン化されるので、層を分けてもプランは変わらない。
      flags AS (
        SELECT
          subject_id,
          status,
          embedding_status,
          (status IN ('active', 'contested')) AS live,
          (${inPeriod}) AS in_period,
          (${isValid}) AS is_valid,
          (${isExpired}) AS is_expired,
          (${isNotYetValid}) AS is_not_yet_valid,
          (${isDecayed}) AS is_decayed,
          (${hasQualifyingLabel}) AS has_qualifying_label${provenanceFlagColumn}
        FROM scoped
      ),
      agg AS (
        SELECT
          subject_id,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
          )::int AS in_scope,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'pending'
          )::int AS not_indexed_pending,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'failed'
          )::int AS not_indexed_failed,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'skipped'
          )::int AS not_indexed_skipped,
          count(*) FILTER (WHERE status = 'archived')::int AS archived,
          count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
          count(*) FILTER (WHERE status = 'forgotten')::int AS forgotten,
          count(*) FILTER (WHERE live AND NOT in_period)::int AS period_filtered,
          count(*) FILTER (WHERE live AND in_period AND is_expired)::int AS expired_filtered,
          count(*) FILTER (
            WHERE live AND in_period AND is_not_yet_valid
          )::int AS not_yet_valid_filtered,
          -- Issue #201 PR-B（ADR 0323）: taxonomy ゲートで落ちた件数。period_filtered/
          -- expired_filtered と同じ「直前までのゲートを通過し、このゲートだけで落ちた」
          -- 集計——in_scope から除かれる（decayed_filtered とは違う。下のコメント参照）。
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND NOT has_qualifying_label
          )::int AS taxonomy_filtered,
          -- Issue #329 / ADR 0173: 忘却ゲートで落ちた件数。in_scope と同じ絞り
          -- (status + period + validity + taxonomy) の上に載る = in_scope の部分集合であり、
          -- archived/period/expired/taxonomy のように in_scope から除かれた件数ではない。
          -- 被覆不変条件 (axis: 'subject' の群カウントの総和 = totalInScope) は動かない。
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label AND is_decayed
          )::int AS decayed_filtered${provenanceAggColumn}
        FROM flags
        GROUP BY subject_id
      )
      SELECT
        -- 現物の groups と同じ集合（in_scope > 0 の subject のみ）。順序は契約ではない
        -- （doc コメント「単一パス書き換え」節、旧実装も json_agg に ORDER BY を持たない）。
        coalesce(
          json_agg(json_build_object('key', subject_id, 'count', in_scope)) FILTER (WHERE in_scope > 0),
          '[]'::json
        ) AS groups,
        -- 空テナント（agg が0行）でも NULL ではなく現物と同じ 0 を返す。
        coalesce(sum(in_scope), 0)::int AS in_scope,
        coalesce(sum(not_indexed_pending), 0)::int AS not_indexed_pending,
        coalesce(sum(not_indexed_failed), 0)::int AS not_indexed_failed,
        coalesce(sum(not_indexed_skipped), 0)::int AS not_indexed_skipped,
        coalesce(sum(archived), 0)::int AS archived,
        coalesce(sum(superseded), 0)::int AS superseded,
        coalesce(sum(forgotten), 0)::int AS forgotten,
        coalesce(sum(period_filtered), 0)::int AS period_filtered,
        coalesce(sum(expired_filtered), 0)::int AS expired_filtered,
        coalesce(sum(not_yet_valid_filtered), 0)::int AS not_yet_valid_filtered,
        coalesce(sum(taxonomy_filtered), 0)::int AS taxonomy_filtered,
        coalesce(sum(decayed_filtered), 0)::int AS decayed_filtered${provenanceResultColumn}
        ${digestBandColumns}
        ${taxonomyGroupColumns}
      FROM agg
    `);

    const row = result.rows[0] as unknown as {
      groups: { key: string | null; count: number }[];
      in_scope: number;
      not_indexed_pending: number;
      not_indexed_failed: number;
      not_indexed_skipped: number;
      archived: number;
      superseded: number;
      forgotten: number;
      period_filtered: number;
      expired_filtered: number;
      not_yet_valid_filtered: number;
      taxonomy_filtered: number;
      decayed_filtered: number;
      excluded_provenance_indexed?: number;
      digests?: { memoryId: string; digest: string }[];
      digest_eligible_count?: number;
      taxonomy_label_groups?: { key: string; count: number }[];
      taxonomy_residual_count?: number;
    };

    const groups: ScopeAggregate["groups"] = (row.groups ?? []).map((g) => ({
      axis: "subject" as const,
      key: g.key,
      count: g.count,
      countKind: "exact" as const,
    }));

    if (taxonomyGroupCandidates !== undefined) {
      for (const g of row.taxonomy_label_groups ?? []) {
        groups.push({ axis: "taxonomy" as const, key: g.key, count: g.count, countKind: "exact" });
      }
      const residualCount = row.taxonomy_residual_count ?? 0;
      if (residualCount > 0) {
        groups.push({
          axis: "taxonomy" as const,
          key: null,
          count: residualCount,
          countKind: "exact",
        });
      }
    }

    const digests: ScopeAggregate["digests"] = digestBand
      ? (row.digests ?? []).map((d) => ({
          memoryId: d.memoryId as MemoryId,
          digest: d.digest,
        }))
      : [];
    const digestEligible: ScopeAggregate["digestEligible"] = digestBand
      ? { count: row.digest_eligible_count ?? 0, countKind: "exact" }
      : { count: 0, countKind: "exact" };

    return {
      groups,
      totalInScope: row.in_scope,
      countKind: "exact",
      ...(excludeProvenanceKinds !== undefined
        ? { excludedProvenanceIndexedCount: row.excluded_provenance_indexed ?? 0 }
        : {}),
      notIndexed: {
        pending: { count: row.not_indexed_pending, countKind: "exact" },
        failed: { count: row.not_indexed_failed, countKind: "exact" },
        skipped: { count: row.not_indexed_skipped, countKind: "exact" },
      },
      filteredArchived: { count: row.archived, countKind: "exact" },
      filteredSuperseded: { count: row.superseded, countKind: "exact" },
      filteredForgotten: { count: row.forgotten, countKind: "exact" },
      filteredPeriod: { count: row.period_filtered, countKind: "exact" },
      filteredExpired: { count: row.expired_filtered, countKind: "exact" },
      filteredNotYetValid: { count: row.not_yet_valid_filtered, countKind: "exact" },
      filteredTaxonomy: { count: row.taxonomy_filtered, countKind: "exact" },
      filteredDecayed: { count: row.decayed_filtered, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  /**
   * `record.advanceActivityClock === true` のとき、`recalls` への INSERT と**同一の1文で**（ADR 0395）`tenant_activity.activity_seq` を
   * `+1` する（UPSERT。行が無ければ `activity_seq = 1` の行を作る。`+1` は既存値に依存するので `EXCLUDED` は使わない）。
   * **`false`/未指定なら `UPDATE` を1本も撃たない**（既定 `'wall'` のテナントでは、この行を一度も触らない。ADR 0165）。
   *
   * `record.advanceActivityClock` が `{ scope: "subject", subjectId }` のときは、`tenant_activity`（`T`）ではなく
   * `tenant_subject_activity`（`subjectId` の行、`S_x`）を `+1` する。**`T` には触れない。**（ADR 0353）
   */
  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(record.subjectId, "record.subjectId");
    if (typeof record.advanceActivityClock === "object" && record.advanceActivityClock !== null) {
      assertWellFormedIdentifier(
        record.advanceActivityClock.subjectId,
        "record.advanceActivityClock.subjectId",
      );
    }
    assertNoNulInNewRecall(record);
    const returnedMemories: RecallRecordReturnedMemories = {
      breakdownCaptured: true,
      memories: record.returnedMemories,
    };
    const createdAt = record.createdAt ?? new Date();
    const insertRecallBody = sql`
      INSERT INTO recalls (
        id, tenant_id, subject_id, query, budget, omitted, usage, index_band, explain,
        returned_memories, created_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${record.subjectId ?? null},
        ${JSON.stringify(record.query)}::jsonb,
        ${record.budget !== undefined && record.budget !== null ? JSON.stringify(record.budget) : null}::jsonb,
        ${JSON.stringify(record.omitted)}::jsonb,
        ${JSON.stringify(record.usage)}::jsonb,
        ${JSON.stringify(record.indexBand)}::jsonb,
        ${JSON.stringify(record.explain)}::jsonb,
        ${JSON.stringify(returnedMemories)}::jsonb,
        ${toPgTimestamp(createdAt)}
      )
      RETURNING id
    `;

    // advance ありの2分岐は、`recalls` の INSERT とカウンタの UPSERT を**1つの SQL 文**（data-modifying CTE）で撃つ（ADR 0395）。
    // 1文は1トランザクションで走るので、明示的な `BEGIN`/`COMMIT` は要らず、どちらかが失敗すれば両方が戻る。2文＋`db.transaction` に
    // すると、INSERT・UPSERT・COMMIT の3往復のあいだカウンタの行ロックを持ち、同じテナントへの同時 createRecall がそこで直列になる。
    // `u`（UPSERT）は外側の SELECT から参照されないが、data-modifying CTE は参照の有無によらず最後まで実行される（PostgreSQL の仕様）。
    if (record.advanceActivityClock === true) {
      const result = await this.db.execute(sql`
        WITH r AS (${insertRecallBody}),
        u AS (
          INSERT INTO tenant_activity (tenant_id, activity_seq, updated_at)
          VALUES (${ctx.tenantId}, 1, now())
          ON CONFLICT (tenant_id) DO UPDATE
            SET activity_seq = tenant_activity.activity_seq + 1, updated_at = now()
        )
        SELECT id FROM r
      `);
      return (result.rows[0] as unknown as { id: string }).id;
    }

    if (
      typeof record.advanceActivityClock === "object" &&
      record.advanceActivityClock !== null &&
      record.advanceActivityClock.scope === "subject"
    ) {
      const subjectId = record.advanceActivityClock.subjectId;
      const result = await this.db.execute(sql`
        WITH r AS (${insertRecallBody}),
        u AS (
          INSERT INTO tenant_subject_activity (tenant_id, subject_id, activity_seq, updated_at)
          VALUES (${ctx.tenantId}, ${subjectId}, 1, now())
          ON CONFLICT (tenant_id, subject_id) DO UPDATE
            SET activity_seq = tenant_subject_activity.activity_seq + 1, updated_at = now()
        )
        SELECT id FROM r
      `);
      return (result.rows[0] as unknown as { id: string }).id;
    }

    const result = await this.db.execute(insertRecallBody);
    return (result.rows[0] as unknown as { id: string }).id;
  }

  /** `createRecall` が書いた `recalls` 行1件を `recallId` から読み戻す（ADR 0155）。見つからなければ `null`（例外にしない）。 */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM recalls WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToRecallRecord(result.rows[0] as unknown as RecallRow)
      : null;
  }

  /**
   * 索引に載っていない Memory を選んで `pending` へ戻し、**同じ1文の中で** `embed` の outbox 行を積み直す（ADR 0079）。
   *
   * **`memories` の更新と `outbox` の INSERT は、同一トランザクションでなければならない。**更新だけ起きると、`pending` に戻ったのに
   * 運ぶジョブが無く、その行は永久に `pending` のままになる。INSERT だけ起きると、`failed` のまま `embed` ジョブが積まれ、
   * `aggregateScope` の `notIndexed.failed` がジョブの成功まで減らない。単一の `WITH ... INSERT ... SELECT` 文にしてあるので、
   * 明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る（`createMemoryWithOutbox` は複数文なので `db.transaction` で包む）。
   *
   * `FOR UPDATE SKIP LOCKED` は `claimBatch`（`./outbox-store.ts`）と同じ理由で使う。2つの呼び出しが同時に走っても、同じ Memory を
   * 二重に積み直さない。
   */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    const target = buildRequeueEmbedTargetSelect(ctx, opts);
    const outboxNow = writeOpts?.now ?? new Date();
    // `memoryIds` を渡されたのに well-formed な id が1つも残らなかった場合（空集合との積）は、問い合わせる意味が無い。
    if (target === null) {
      return { requeued: 0, memoryIds: [] };
    }

    const result = await this.db.execute(sql`
      WITH target AS (
        ${target}
      ),
      requeued AS (
        UPDATE memories m
        SET embedding_status = 'pending', updated_at = now()
        FROM target t
        WHERE m.id = t.id
        RETURNING m.id
      )
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
      SELECT
        gen_random_uuid(), ${ctx.tenantId}, 'embed',
        jsonb_build_object('memoryId', r.id), ${toPgTimestamp(outboxNow)}, 0,
        ${toPgTimestamp(outboxNow)}
      FROM requeued r
      RETURNING (payload->>'memoryId') AS memory_id
    `);

    const memoryIds = result.rows.map((row) => (row as unknown as { memory_id: string }).memory_id);
    return { requeued: memoryIds.length, memoryIds };
  }

  /**
   * `docs/memory-model.md` §11 行8 の掃引（ADR 0114）。契約は `MemoryStore.archiveDecayed` の doc で、ここはクエリの実装のみ。
   *
   * `memories` の UPDATE と `memory_events` への INSERT は、`requeueEmbedJobs` と同じ理由で**単一の `WITH ... UPDATE ... INSERT ... SELECT` 文**に
   * まとめる（「片方だけ起きる」を構造的に作れない）。`digest_snapshot` には archived にする直前の `digest` を入れる
   * （`forget` が `digestSnapshot: current.digest` を渡すのと同じ規約）。
   *
   * 最終 `SELECT` に `ORDER BY` を付けるのは、`archived`（返り値）の並びをターゲット選択の並び（`decay_floor_at` 昇順）と一致させるため。
   * `UPDATE ... FROM target` の `RETURNING` はターゲットの行順を保証しない。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    assertWellFormedCtx(ctx);
    const target = buildArchiveDecayedTargetSelect(ctx, opts);

    const result = await this.db.execute(sql`
      WITH target AS (
        ${target}
      ),
      archived AS (
        UPDATE memories m
        SET status = 'archived', updated_at = now()
        FROM target t
        WHERE m.id = t.id
        RETURNING m.id AS id, m.decay_floor_at AS decay_floor_at, m.digest AS digest
      ),
      inserted_events AS (
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        SELECT
          gen_random_uuid(), ${ctx.tenantId}, a.id, 'archived', ${toPgTimestamp(opts.now)},
          '{"type":"system"}'::jsonb, a.digest, NULL, '{}'::jsonb
        FROM archived a
        RETURNING memory_id
      )
      SELECT id, decay_floor_at FROM archived
      ORDER BY decay_floor_at ASC, id ASC
    `);

    const archived = result.rows.map((row) => {
      const r = row as unknown as { id: string; decay_floor_at: string };
      return { memoryId: r.id as MemoryId, decayFloorAt: parsePgTimestamp(r.decay_floor_at) };
    });
    return { archived, reachedLimit: opts.limit > 0 && archived.length === opts.limit };
  }

  /**
   * `forgotten` かつ未 purge（`purged_at IS NULL`）の Memory だけを対象にした CAS（ADR 0124）。条件付き `UPDATE` が0行なら、
   * 対象がそもそも存在しないのか、条件を満たさなかったのか（読み直して {@link MemoryPurgeConflictError} を投げる）を切り分ける。
   * `status` は更新しない（`purged` は `memories.status` の値ではない。docs/memory-model.md §11 行10）。
   *
   * `content`/`digest`/`purged_at` に加えて、`tags`・`attributes`・`claim_key_subject`/`claim_key_predicate` もこの UPDATE で空にする
   * （「その記憶の本文から直接たどれる派生物」を一緒に消す。CAS が弾かれれば、これらも一切書かない。ADR 0375）。
   *
   * CAS が通った後、同じトランザクションで2つの派生的な書き込みを追加する（ADR 0375）:
   * 1. `memory_labels` からこの Memory の行を削除し、`status = 'proposed'` のまま残る `labels.proposed_count` を、外した本数だけ減らす
   *    （`GREATEST(…, 0)` で床を敷く。`upsertProposedLabels` の increment と対称で、`proposed_count` が近似値である点も同じ）。
   * 2. このテナントの `recalls.index_band` の `digestBand` に、この `memoryId` を持つエントリがあれば `digest` をトゥームストーンへ書き換える
   *    （`truncated` は落とす）。`recalls.query` は `memoryId` で特定できないので触らない。
   *
   * この `recalls` の UPDATE の `@>` は、式 GIN 索引 `idx_recalls_digest_band`（`migrations/0030_recalls_digest_band_index.sql`。
   * `(index_band->'digestBand') jsonb_path_ops`）で引ける（ADR 0389）。**索引の式と `WHERE` の式が一致していることに依存する**ので、
   * この述語を書き換えるときは索引も見直すこと。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // 大文字の uuid でも `recalls.index_band` の目次帯（文字列で比べる）に当たるよう、入口でそろえる（ADR 0438）。
    id = normalizeUuidCase(id);
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    assertNoNul("PostgresMemoryStore", "tombstone.content", tombstone.content);
    assertNoNul("PostgresMemoryStore", "tombstone.digest", tombstone.digest);

    // `purged_at` と `memory_events.at` を同じ値にする（省略時も1つの壁時計を2回読んで別の値になることがないよう、ここで一度だけ決める）。
    const at = event.at ?? new Date();

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE memories
        SET content = ${tombstone.content},
            digest = ${tombstone.digest},
            tags = '{}',
            attributes = '{}'::jsonb,
            claim_key_subject = NULL,
            claim_key_predicate = NULL,
            purged_at = ${toPgTimestamp(at)},
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          AND status = 'forgotten' AND purged_at IS NULL
        RETURNING *
      `);

      if (result.rows.length === 0) {
        const current = await tx.execute(sql`
          SELECT status, purged_at FROM memories
          WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
        `);
        if (current.rows.length === 0) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        const row = current.rows[0] as unknown as {
          status: MemoryStatus;
          purged_at: string | null;
        };
        throw new MemoryPurgeConflictError(id, row.status, parsePgTimestamp(row.purged_at));
      }

      const memory = rowToMemory(result.rows[0] as unknown as MemoryRow);

      await assertEventTargetInTenant(tx, ctx, event.memoryId, [id]);
      assertNoNulInNewMemoryEvent("PostgresMemoryStore", event);
      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${event.memoryId},
          ${event.kind},
          ${toPgTimestamp(at)},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      // 減らす前に、このメモリのラベルの行を名前順に `FOR UPDATE` で取る（ADR 0511）。下の `UPDATE … FROM counted` の更新順は
      // 計画次第で、作成の名前順とずれて 40P01 になりうる。
      await tx.execute(sql`
        SELECT l.id FROM labels l
        WHERE l.tenant_id = ${ctx.tenantId}
          AND l.id IN (
            SELECT ml.label_id FROM memory_labels ml
            WHERE ml.tenant_id = ${ctx.tenantId} AND ml.memory_id = ${id}
          )
        ORDER BY l.name COLLATE "C" ASC
        FOR UPDATE OF l
      `);
      await tx.execute(sql`
        WITH removed_labels AS (
          DELETE FROM memory_labels
          WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${id}
          RETURNING label_id
        ),
        counted AS (
          SELECT label_id, count(*) AS n FROM removed_labels GROUP BY label_id
        )
        UPDATE labels
        SET proposed_count = GREATEST(labels.proposed_count - counted.n, 0)
        FROM counted
        WHERE labels.tenant_id = ${ctx.tenantId}
          AND labels.id = counted.label_id
          AND labels.status = 'proposed'
      `);

      await tx.execute(sql`
        UPDATE recalls
        SET index_band = jsonb_set(
          index_band,
          '{digestBand}',
          (
            SELECT coalesce(jsonb_agg(
              CASE
                WHEN elem->>'memoryId' = ${id}
                THEN jsonb_build_object('memoryId', elem->'memoryId', 'digest', ${tombstone.digest}::text)
                ELSE elem
              END
              ORDER BY ord
            ), '[]'::jsonb)
            FROM jsonb_array_elements(index_band->'digestBand') WITH ORDINALITY AS t(elem, ord)
          )
        )
        WHERE tenant_id = ${ctx.tenantId}
          AND index_band ? 'digestBand'
          AND index_band->'digestBand' @> jsonb_build_array(jsonb_build_object('memoryId', ${id}::text))
      `);

      return { memory, event: storedEvent };
    });
  }

  /**
   * v1.1.0（ADR 0375）より前の `purgeMemory` が残した、`tags`・`attributes`・`claim_key_subject`/`claim_key_predicate`・`memory_labels` を、
   * **既に purge 済みの行**（`status = 'forgotten' AND purged_at IS NOT NULL`）について消し、`labels.proposed_count`
   * （`status = 'proposed'` のもの）を外した紐付けの本数だけ減らす（`GREATEST(…, 0)`。ADR 0437）。
   *
   * - **1トランザクション。**どの文も `purged_at IS NOT NULL` の行だけを対象にするので、未 purge の行・他テナントの行は、渡された id に
   *   含まれていても触らない。
   * - **べき等。**`memories` の UPDATE は「残骸が在る行」だけを更新する（`updated_at` も、残骸の無い行では動かさない）。
   *   `memory_labels` の DELETE は `RETURNING` した本数だけ `proposed_count` を減らすので、2回目以降は減算が0件になる。同時に2本が
   *   同じ行を消しにきても、後から来た DELETE は先の DELETE の確定後に行を見直すので、二重には数えない（`READ COMMITTED`）。
   * - 形式不正な id は、`deleteAcrossSpaces` と同じく「無い」として落とす（クエリを投げる前に）。
   * - このテナントの `recalls.index_band` の `digestBand` のうち、purge 済みの行のエントリの `digest` を、その行の `digest`
   *   （トゥームストーン）へ伏せる（ADR 0512）。`recalls.query`・`explain` は書かない。
   * - `content`/`digest`/`purged_at`・`memory_events` は書かない（監査イベントも積まない）。
   */
  async scrubPurged(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE memories
        SET tags = '{}',
            attributes = '{}'::jsonb,
            claim_key_subject = NULL,
            claim_key_predicate = NULL,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param(validIds)}::uuid[])
          AND status = 'forgotten' AND purged_at IS NOT NULL
          AND (
            cardinality(tags) > 0
            OR attributes <> '{}'::jsonb
            OR claim_key_subject IS NOT NULL
            OR claim_key_predicate IS NOT NULL
          )
      `);
      await tx.execute(sql`
        SELECT l.id FROM labels l
        WHERE l.tenant_id = ${ctx.tenantId}
          AND l.id IN (
            SELECT ml.label_id FROM memory_labels ml
            WHERE ml.tenant_id = ${ctx.tenantId}
              AND ml.memory_id = ANY(${sql.param(validIds)}::uuid[])
          )
        ORDER BY l.name COLLATE "C" ASC
        FOR UPDATE OF l
      `);
      await tx.execute(sql`
        WITH removed_labels AS (
          DELETE FROM memory_labels ml
          USING memories m
          WHERE ml.tenant_id = ${ctx.tenantId}
            AND ml.memory_id = ANY(${sql.param(validIds)}::uuid[])
            AND m.tenant_id = ml.tenant_id AND m.id = ml.memory_id
            AND m.status = 'forgotten' AND m.purged_at IS NOT NULL
          RETURNING ml.label_id
        ),
        counted AS (
          SELECT label_id, count(*) AS n FROM removed_labels GROUP BY label_id
        )
        UPDATE labels
        SET proposed_count = GREATEST(labels.proposed_count - counted.n, 0)
        FROM counted
        WHERE labels.tenant_id = ${ctx.tenantId}
          AND labels.id = counted.label_id
          AND labels.status = 'proposed'
      `);
      // v1.0.x の purge は `recalls.index_band` を書き換えなかった。このテナントの digestBand から、渡された id のうち purge 済みの行の
      // エントリだけを、その行の `memories.digest`（purge が書いたトゥームストーン）へ書き換える（`truncated` は落とす）。
      // 既に同じ digest のエントリしか無い行は更新しない（べき等。ADR 0512）。
      await tx.execute(sql`
        UPDATE recalls r
        SET index_band = jsonb_set(
          r.index_band,
          '{digestBand}',
          (
            SELECT coalesce(jsonb_agg(
              CASE
                WHEN p.digest IS NOT NULL
                THEN jsonb_build_object('memoryId', t.elem->'memoryId', 'digest', p.digest)
                ELSE t.elem
              END
              ORDER BY t.ord
            ), '[]'::jsonb)
            FROM jsonb_array_elements(r.index_band->'digestBand') WITH ORDINALITY AS t(elem, ord)
            LEFT JOIN (
              SELECT id::text AS id, digest FROM memories
              WHERE tenant_id = ${ctx.tenantId}
                AND id = ANY(${sql.param(validIds)}::uuid[])
                AND status = 'forgotten' AND purged_at IS NOT NULL
            ) p ON p.id = t.elem->>'memoryId'
          )
        )
        WHERE r.tenant_id = ${ctx.tenantId}
          AND r.index_band ? 'digestBand'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(r.index_band->'digestBand') AS e
            JOIN memories m ON m.id::text = e->>'memoryId'
            WHERE m.tenant_id = ${ctx.tenantId}
              AND m.id = ANY(${sql.param(validIds)}::uuid[])
              AND m.status = 'forgotten' AND m.purged_at IS NOT NULL
              AND (e->>'digest' IS DISTINCT FROM m.digest OR e ? 'truncated')
          )
      `);
    });
  }

  /**
   * 両側とも `status = 'active'` の CAS を課したうえで、`status='contested'`・`contested_with_id` を相互に設定する（ADR 0134）。
   * 1トランザクションで完結し、対象2件それぞれについて「条件付き UPDATE が0行なら読み直して切り分ける」。**どちらか一方が失敗したら、
   * その場で throw してロールバックする**（もう一方が先に成功していても巻き戻る）。対向ペアは本質的に結合しており、部分成功を許さない。
   */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    first = { ...first, id: normalizeUuidCase(first.id) };
    second = { ...second, id: normalizeUuidCase(second.id) };
    if (first.id === second.id) {
      throw new RangeError("PostgresMemoryStore: first.id and second.id must differ");
    }
    if (!isUuidLike(first.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
    }
    if (!isUuidLike(second.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
    }

    return this.db.transaction(async (tx) => {
      // 存在確認を、**両方の UPDATE を撃つ前に済ませる**。先に第1の UPDATE で `contested_with_id = second.id` を書こうとすると、
      // `second.id` が存在しない場合に外部キー違反という別種の失敗になり、「memory not found」に揃わない。
      //
      // **`ORDER BY id ASC FOR UPDATE` で、両側の行ロックを呼び出し順ではなく常に id 昇順で取る。**`markContestedPair(A, B)` と
      // `markContestedPair(B, A)` が「渡された引数の順」に行ロックを取ると、A→B と B→A で掴み合い、40P01（`deadlock detected`）で
      // 片方が落ちて、契約の {@link MemoryStatusConflictError} でなく生の Postgres 例外が漏れる。常に id 昇順で取れば、循環待ちが
      // 構造的に起きない。後から来たほうは先着の解放待ちになり、解放後に読み直した `status` が `'active'` でなければ下の CAS が
      // {@link MemoryStatusConflictError} を投げる。
      const existing = await tx.execute(sql`
        SELECT id, status FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param([first.id, second.id])}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const statusById = new Map(
        existing.rows.map((row) => {
          const r = row as unknown as { id: string; status: MemoryStatus };
          return [r.id, r.status] as const;
        }),
      );
      if (!statusById.has(first.id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
      }
      if (!statusById.has(second.id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
      }
      if (statusById.get(first.id) !== "active") {
        throw new MemoryStatusConflictError(first.id, "active", statusById.get(first.id)!);
      }
      if (statusById.get(second.id) !== "active") {
        throw new MemoryStatusConflictError(second.id, "active", statusById.get(second.id)!);
      }

      const updateSide = async (id: MemoryId, oppositeId: MemoryId): Promise<Memory> => {
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = 'contested',
              contested_with_id = ${oppositeId},
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${id} AND status = 'active'
          RETURNING *
        `);
        if (result.rows.length === 0) {
          // 存在確認を通った直後にここへ来るとすれば TOCTOU（存在確認と UPDATE の間に別の書き込みが割り込んだ）。読み直して切り分ける。
          const current = await tx.execute(sql`
            SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
          `);
          if (current.rows.length === 0) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
          }
          const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
          throw new MemoryStatusConflictError(id, "active", observedStatus);
        }
        return rowToMemory(result.rows[0] as unknown as MemoryRow);
      };

      const firstMemory = await updateSide(first.id, second.id);
      const secondMemory = await updateSide(second.id, first.id);

      const insertEvent = async (event: NewMemoryEvent) => {
        await assertEventTargetInTenant(tx, ctx, event.memoryId, [first.id, second.id]);
        assertNoNulInNewMemoryEvent("PostgresMemoryStore", event);
        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${event.memoryId},
            ${event.kind},
            ${toPgTimestamp(event.at ?? new Date())},
            ${JSON.stringify(event.actor)}::jsonb,
            ${event.digestSnapshot ?? null},
            ${event.sizeBeforeBytes ?? null},
            ${JSON.stringify(event.meta)}::jsonb
          )
          RETURNING *
        `);
        return rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);
      };

      const firstEvent = await insertEvent(first.event);
      const secondEvent = await insertEvent(second.event);

      return {
        first: firstMemory,
        second: secondMemory,
        events: [firstEvent, secondEvent] as [MemoryEvent, MemoryEvent],
      };
    });
  }

  /**
   * `MemoryStore.findActiveByClaimKey?` の実装（契約は interface の doc）。`idx_memories_claim_key`（`(tenant_id, subject_id,
   * claim_key_subject, claim_key_predicate)`。`migrations/0021_memories_claim_key.sql`）に載る4列の等値比較で絞り込み、
   * `status`/`content_hash`/有効期間の重なりを追加の `WHERE` で絞る。**LLM を一度も呼ばない。**
   *
   * `subject_id` は NULL 同士も一致として扱う。`=` は `NULL = NULL` を `NULL` に評価するので、素の `=` では `subjectId: null` の
   * Memory 同士が一致しない。**`IS NOT DISTINCT FROM` そのものは書かない。**索引で引けない形で、`subject_id` が Index Cond に入らず
   * Filter に落ちる（同じ claim key を持つテナント中の全 subject の行を読んでから捨てる）。同じ意味を、索引で引ける
   * `subject_id = $n` / `subject_id IS NULL` に分けて書く（{@link subjectIdMatches}）。
   *
   * `excludeMemoryId` は SQL の条件にしない。`id` は `uuid` 型の列で、壊れた形式の文字列を `<>` に渡すと暗黙キャストでクエリ全体が
   * 例外を投げる。この口の契約は「渡された id を除いた行を返す」で「壊れた id を拒否する」ではないので、**返ってきた行を JS 側で除く**。
   *
   * 有効期間の重なりは半開区間 `[valid_from, valid_until)` の標準的な判定（`a1 < b2 AND a2 < b1`）を、`NULL` を `-∞`/`+∞` として
   * 読み替えて書く。
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
    assertNoNul(
      "PostgresMemoryStore.findActiveByClaimKey",
      "claimKey.subject",
      query.claimKey.subject,
    );
    assertNoNul(
      "PostgresMemoryStore.findActiveByClaimKey",
      "claimKey.predicate",
      query.claimKey.predicate,
    );
    // 入口の正規化。下の除外は JS で比べるので、DB が返す小文字の id に揃える（揃えないと、大文字の UUID を渡したとき自分自身が返る）。
    const excludeMemoryId = normalizeUuidCase(query.excludeMemoryId);
    const validFrom = toPgTimestampClamped(query.validFrom);
    const validUntil = toPgTimestampClamped(query.validUntil);
    const emptyInterval =
      query.validFrom != null &&
      query.validUntil != null &&
      query.validFrom.getTime() >= query.validUntil.getTime();
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND ${subjectIdMatches(query.subjectId)}
        AND claim_key_subject = ${query.claimKey.subject}
        AND claim_key_predicate = ${query.claimKey.predicate}
        AND status = 'active'
        AND content_hash <> ${query.contentHash}
        AND (
          ${validFrom}::timestamptz IS NULL OR valid_until IS NULL
          OR ${validFrom}::timestamptz < valid_until
        )
        AND (
          valid_from IS NULL OR ${validUntil}::timestamptz IS NULL
          OR valid_from < ${validUntil}::timestamptz
        )
        -- 空の区間・逆転した区間（from >= until）は点を1つも含まないので、何とも重ならない（ADR 0473）
        -- ⚠ 両端が下限より前のとき、寄せた値は等しくなる。空かどうかは寄せる前の値で JS が決める（ADR 0547）
        AND NOT ${emptyInterval}::boolean
        AND (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
    `);
    return result.rows
      .map((row) => rowToMemory(row as unknown as MemoryRow))
      .filter((memory) => memory.id !== excludeMemoryId);
  }

  /**
   * `MemoryStore.findContestedByClaimKey?` の実装（契約は interface の doc。ADR 0378）。`findActiveByClaimKey` と完全に同じクエリで、
   * `status = 'active'` の代わりに `status = 'contested'` を見るだけ。`idx_memories_claim_key` は `status` を索引の条件に含めていない
   * 汎用索引なので、この口のために新しい索引・migration は要らない。
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
    assertNoNul(
      "PostgresMemoryStore.findContestedByClaimKey",
      "claimKey.subject",
      query.claimKey.subject,
    );
    assertNoNul(
      "PostgresMemoryStore.findContestedByClaimKey",
      "claimKey.predicate",
      query.claimKey.predicate,
    );
    const excludeMemoryId = normalizeUuidCase(query.excludeMemoryId);
    const validFrom = toPgTimestampClamped(query.validFrom);
    const validUntil = toPgTimestampClamped(query.validUntil);
    const emptyInterval =
      query.validFrom != null &&
      query.validUntil != null &&
      query.validFrom.getTime() >= query.validUntil.getTime();
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND ${subjectIdMatches(query.subjectId)}
        AND claim_key_subject = ${query.claimKey.subject}
        AND claim_key_predicate = ${query.claimKey.predicate}
        AND status = 'contested'
        AND content_hash <> ${query.contentHash}
        AND (
          ${validFrom}::timestamptz IS NULL OR valid_until IS NULL
          OR ${validFrom}::timestamptz < valid_until
        )
        AND (
          valid_from IS NULL OR ${validUntil}::timestamptz IS NULL
          OR valid_from < ${validUntil}::timestamptz
        )
        -- 空の区間・逆転した区間（from >= until）は点を1つも含まないので、何とも重ならない（ADR 0473）
        -- ⚠ 両端が下限より前のとき、寄せた値は等しくなる。空かどうかは寄せる前の値で JS が決める（ADR 0547）
        AND NOT ${emptyInterval}::boolean
        AND (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
    `);
    return result.rows
      .map((row) => rowToMemory(row as unknown as MemoryRow))
      .filter((memory) => memory.id !== excludeMemoryId);
  }

  /**
   * `MemoryStore.listActiveClaimPredicates?` の実装（契約は interface の doc。ADR 0329）。`(tenant_id, subject_id)` で絞り込み、
   * `status`/`claim_key_predicate IS NOT NULL` を追加の `WHERE` で絞ったうえで `GROUP BY claim_key_predicate` して
   * `MAX(created_at)` で新しい順に並べる。専用の部分索引 `idx_memories_claim_predicates`
   * （`migrations/0029_memories_claim_predicates_index.sql`）が支える。`subject_id` は NULL 同士も一致として扱う（{@link subjectIdMatches}）。
   *
   * **索引を使わせるために WHERE を工夫している。**工夫が無いと Seq Scan（別テナントを含む表全体）になる。`subject_id IS NOT DISTINCT FROM` が
   * 索引で引けない形であることに加え、`idx_memories_claim_key` は部分索引（`WHERE claim_key_subject IS NOT NULL`）なのに、WHERE が
   * `claim_key_predicate IS NOT NULL` だけでは部分索引の述語を導けないため。⟹ `claim_key_subject IS NOT NULL` を足す。claim key は2列とも NULL か
   * 2列とも非 NULL なので、書き込みの口から作られる行について結果は変わらない。
   *
   * **同着の副キーは `claim_key_predicate COLLATE "C" ASC`**（コードポイント順の昇順。interface の契約）。`COLLATE "C"` は UTF-8 のバイト順で、
   * DB の既定の照合順序に依らない。
   *
   * `DISTINCT ON` でなく `GROUP BY` にするのは、`DISTINCT ON` が「先頭1行を残す」ことしかせず、複数行にまたがる集約（`MAX`）を表現できないため。
   */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(query.subjectId, "query.subjectId");
    const result = await this.db.execute(sql`
      SELECT claim_key_predicate AS predicate
      FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND ${subjectIdMatches(query.subjectId)}
        AND status = 'active'
        AND claim_key_subject IS NOT NULL
        AND claim_key_predicate IS NOT NULL
      GROUP BY claim_key_predicate
      ORDER BY MAX(created_at) DESC, claim_key_predicate COLLATE "C" ASC
      LIMIT ${query.limit}
    `);
    return result.rows.map((row) => (row as unknown as { predicate: string }).predicate);
  }

  /**
   * `markContestedPair` の解決側（ADR 0150）。両側とも `status = 'contested'` かつ相互参照が成立していることを CAS で課したうえで、
   * `contested_with_id` を両側とも `NULL` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する。
   * 1トランザクションで完結し、**どちらか一方が失敗したら、その場で throw してロールバックする**（`markContestedPair` と同じく部分成功を許さない）。
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
    const normalizeSide = <T extends { id: MemoryId; supersededById?: MemoryId }>(side: T): T => ({
      ...side,
      id: normalizeUuidCase(side.id),
      ...(side.supersededById === undefined
        ? {}
        : { supersededById: normalizeUuidCase(side.supersededById) }),
    });
    first = normalizeSide(first);
    second = normalizeSide(second);
    if (first.id === second.id) {
      throw new RangeError("PostgresMemoryStore: first.id and second.id must differ");
    }
    assertResolvedStatus("resolveContestedPair", "first", first.status);
    assertResolvedStatus("resolveContestedPair", "second", second.status);
    assertSupersededByShape(
      "resolveContestedPair",
      "first",
      first.id,
      first.status,
      first.supersededById,
      { forbidWhenNotSuperseded: true },
    );
    assertSupersededByShape(
      "resolveContestedPair",
      "second",
      second.id,
      second.status,
      second.supersededById,
      { forbidWhenNotSuperseded: true },
    );
    assertNoSupersededCycle("resolveContestedPair", [first, second]);
    if (!isUuidLike(first.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
    }
    if (!isUuidLike(second.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
    }
    checkedRef("memory", first.supersededById);
    checkedRef("memory", second.supersededById);

    return this.db.transaction(async (tx) => {
      // 存在確認を両方の UPDATE を撃つ前に済ませる（`markContestedPair` と同じ理由）。ここで `contested_with_id` も読み、
      // CAS（相互参照の成立）を判定する。`markContestedPair` と同じ理由で `ORDER BY id ASC FOR UPDATE`（引数の順に行ロックを取ると、
      // 同じ対を逆順で呼ぶ2つの並行呼び出しが 40P01 で片方落ち、生の Postgres 例外が漏れる）。
      const existing = await tx.execute(sql`
        SELECT id, status, contested_with_id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param([first.id, second.id])}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const rowById = new Map(
        existing.rows.map((row) => {
          const r = row as unknown as {
            id: string;
            status: MemoryStatus;
            contested_with_id: string | null;
          };
          return [r.id, r] as const;
        }),
      );
      const firstExisting = rowById.get(first.id);
      if (!firstExisting) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
      }
      const secondExisting = rowById.get(second.id);
      if (!secondExisting) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
      }
      if (firstExisting.status !== "contested" || firstExisting.contested_with_id !== second.id) {
        throw new MemoryStatusConflictError(first.id, "contested", firstExisting.status);
      }
      if (secondExisting.status !== "contested" || secondExisting.contested_with_id !== first.id) {
        throw new MemoryStatusConflictError(second.id, "contested", secondExisting.status);
      }

      // 対の外の `forgotten` な記憶を置き換えた側にしない（`resolveContestedGroup` と同じ。ADR 0515）。対の相手を指すのは断らない
      // （ここまでで両方 contested と確かめ済み）。別テナント・実在しない id は、下の UPDATE の切り分けに任せる（ADR 0439）。
      for (const [field, side] of [
        ["first", first],
        ["second", second],
      ] as const) {
        const ref = side.supersededById;
        if (ref === undefined || ref === first.id || ref === second.id) continue;
        const forgotten = await tx.execute(sql`
          SELECT 1 FROM memories
          WHERE tenant_id = ${ctx.tenantId} AND id = ${checkedRef("memory", ref)}::uuid
            AND status = 'forgotten'
        `);
        if (forgotten.rows.length > 0) {
          throw new RangeError(
            `resolveContestedPair: ${field}.supersededById must not be a forgotten memory outside the pair`,
          );
        }
      }

      const updateSide = async (
        side: { id: MemoryId; status: "active" | "superseded"; supersededById?: MemoryId },
        oppositeId: MemoryId,
      ): Promise<Memory> => {
        const supersededById = checkedRef("memory", side.supersededById);
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = ${side.status},
              contested_with_id = NULL,
              superseded_by_id = COALESCE(${supersededById}::uuid, superseded_by_id),
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${side.id}
            AND status = 'contested' AND contested_with_id = ${oppositeId}
            AND ${refExists("memories", ctx.tenantId, sql`${supersededById}`)}
          RETURNING *
        `);
        if (result.rows.length === 0) {
          // 存在確認を通った直後にここへ来るとすれば、`supersededById` が `ctx` のテナントの記憶でなかった（ADR 0439）、
          // または TOCTOU。読み直して切り分ける。
          throw await explainEmptyStatusUpdate(tx, ctx, side.id, supersededById, "contested");
        }
        return rowToMemory(result.rows[0] as unknown as MemoryRow);
      };

      const firstMemory = await updateSide(first, second.id);
      const secondMemory = await updateSide(second, first.id);

      const insertEvent = async (event: NewMemoryEvent) => {
        await assertEventTargetInTenant(tx, ctx, event.memoryId, [first.id, second.id]);
        assertNoNulInNewMemoryEvent("PostgresMemoryStore", event);
        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${event.memoryId},
            ${event.kind},
            ${toPgTimestamp(event.at ?? new Date())},
            ${JSON.stringify(event.actor)}::jsonb,
            ${event.digestSnapshot ?? null},
            ${event.sizeBeforeBytes ?? null},
            ${JSON.stringify(event.meta)}::jsonb
          )
          RETURNING *
        `);
        return rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);
      };

      const firstEvent = await insertEvent(first.event);
      const secondEvent = await insertEvent(second.event);

      return {
        first: firstMemory,
        second: secondMemory,
        events: [firstEvent, secondEvent] as [MemoryEvent, MemoryEvent],
      };
    });
  }

  /**
   * `resolveContestedPair` の解決側 CAS を満たせなくなった生存側1件だけを対象にした別の任意メソッド（ADR 0150）。契約は
   * `MemoryStore.resolveOrphanedContested` の doc。対象は1件だけで対向の行には触れないので、行ロック順序の調整は不要。
   */
  async resolveOrphanedContested(
    ctx: Ctx,
    survivor: { id: MemoryId; contestedWithId: MemoryId; event: NewMemoryEvent },
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    survivor = {
      ...survivor,
      id: normalizeUuidCase(survivor.id),
      contestedWithId: normalizeUuidCase(survivor.contestedWithId),
    };
    if (!isUuidLike(survivor.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${survivor.id}`);
    }

    return this.db.transaction(async (tx) => {
      // 形の合わない `contestedWithId` は、どの行の `contested_with_id` とも一致しない。UPDATE を撃たず（撃つと uuid への型変換で
      // DB の例外が漏れる）、下の読み直しで `MemoryStatusConflictError`（行が無ければ「memory not found」）に落とす。
      const updatedRows = isUuidLike(survivor.contestedWithId)
        ? (
            await tx.execute(sql`
              UPDATE memories
              SET status = 'active',
                  contested_with_id = NULL,
                  updated_at = now()
              WHERE tenant_id = ${ctx.tenantId} AND id = ${survivor.id}
                AND status = 'contested' AND contested_with_id = ${survivor.contestedWithId}
              RETURNING *
            `)
          ).rows
        : [];
      if (updatedRows.length === 0) {
        // TOCTOU（事前の確認と UPDATE の間に別の書き込みが割り込んだ）を含め、読み直して切り分ける。
        const current = await tx.execute(sql`
          SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${survivor.id} LIMIT 1
        `);
        if (current.rows.length === 0) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${survivor.id}`);
        }
        const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
        throw new MemoryStatusConflictError(survivor.id, "contested", observedStatus);
      }
      const memory = rowToMemory(updatedRows[0] as unknown as MemoryRow);

      await assertEventTargetInTenant(tx, ctx, survivor.event.memoryId, [survivor.id]);
      assertNoNulInNewMemoryEvent("PostgresMemoryStore", survivor.event);
      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${survivor.event.memoryId},
          ${survivor.event.kind},
          ${toPgTimestamp(survivor.event.at ?? new Date())},
          ${JSON.stringify(survivor.event.actor)}::jsonb,
          ${survivor.event.digestSnapshot ?? null},
          ${survivor.event.sizeBeforeBytes ?? null},
          ${JSON.stringify(survivor.event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      return { memory, event: storedEvent };
    });
  }

  /**
   * `MemoryStore.markContestedGroup?` の実装（契約は interface の doc。ADR 0381）。`memories`・`memory_relations`・`memory_events` を
   * 1トランザクションで書く。`memory_relations` へは `PostgresRelationStore` を経由せず、ここで直接 SQL を発行する。
   */
  async markContestedGroup(
    ctx: Ctx,
    members: ReadonlyArray<{ id: MemoryId; event: NewMemoryEvent }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }> {
    assertWellFormedCtx(ctx);
    if (members.length < 3) {
      throw new RangeError("markContestedGroup: members must have at least 3 entries");
    }
    const normalized = members.map((m) => ({ ...m, id: normalizeUuidCase(m.id) }));
    const ids = normalized.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("markContestedGroup: member ids must be unique");
    }
    for (const id of ids) {
      if (!isUuidLike(id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
      }
    }

    return this.db.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        SELECT * FROM memories
        WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const rowById = new Map(
        existing.rows.map((row) => {
          const memory = rowToMemory(row as unknown as MemoryRow);
          return [memory.id, memory] as const;
        }),
      );

      for (const id of ids) {
        if (!rowById.has(id)) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
      }
      for (const id of ids) {
        const memory = rowById.get(id)!;
        const eligible =
          memory.status === "active" ||
          (memory.status === "contested" &&
            (memory.contestedWithId === null ||
              memory.contestedWithId === undefined ||
              ids.includes(memory.contestedWithId)));
        if (!eligible) {
          throw new MemoryStatusConflictError(id, "active", memory.status);
        }
      }

      // メンバーごとの UPDATE をやめ、全員を1文で更新する（文の数を N に依らず一定にする。ADR 0401）。SET も WHERE の3条件も
      // 全員で同じ式なので、`id = ANY(...)` に畳んでも、1件ずつ打った結果と更新される行の集合は同じ。
      const result = await tx.execute(sql`
        UPDATE memories
        SET status = 'contested', contested_with_id = NULL, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
          AND (
            status = 'active'
            OR (status = 'contested' AND (contested_with_id IS NULL OR contested_with_id = ANY(${sql.param(ids)}::uuid[])))
          )
        RETURNING *
      `);
      const updatedById = new Map<MemoryId, Memory>(
        result.rows.map((row) => {
          const memory = rowToMemory(row as unknown as MemoryRow);
          return [memory.id, memory] as const;
        }),
      );
      if (updatedById.size !== ids.length) {
        // FOR UPDATE で既にロックを保持しているため、通常はここへ来ない（防御的な二重チェック）。入力順に最初に0行だった id を名指しする。
        const failedId = ids.find((id) => !updatedById.has(id))!;
        throw await conflictAfterEmptyUpdate(tx, ctx, failedId, "active");
      }

      // 「完全グラフ」は「一致した全員を結ぶ」ではなく「その中で実際に有効期間が重なる組を結ぶ」と読み替える（ADR 0381、ADR 0324）。
      // 重なりの判定は `findActiveByClaimKey`/`findContestedByClaimKey` と**文字どおり同じ SQL の半開区間の式**で、JS 側に同じ式を
      // 二重に持たない。`a.id <> b.id` の自己結合1本で、重なる**順序対**（a→b と b→a の両方）を一度に生成する。既に存在する行は
      // `ON CONFLICT DO NOTHING` で冪等に無視する。
      //
      // 実表 `memories a` × `memories b` を直接結合すると、N² の組それぞれで b 側の実表を引く。対象の memories を `MATERIALIZED` の
      // CTE で**1回だけ**読み、その N 行どうしを結合する（ADR 0401）。
      await tx.execute(sql`
        WITH m AS MATERIALIZED (
          SELECT id, valid_from, valid_until
          FROM memories
          WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
        )
        INSERT INTO memory_relations (id, tenant_id, from_memory_id, to_memory_id, kind)
        SELECT gen_random_uuid(), ${ctx.tenantId}, a.id, b.id, 'contradicts'
        FROM m a
        JOIN m b
          ON b.id <> a.id
         AND (a.valid_from IS NULL OR b.valid_until IS NULL OR a.valid_from < b.valid_until)
         AND (b.valid_from IS NULL OR a.valid_until IS NULL OR b.valid_from < a.valid_until)
        ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
      `);

      // 呼び出し時点で既に contested かつ contestedWithId が無いメンバーは、UPDATE しても状態が変わらない（既存の群のメンバーを吸収する場合）。
      // そのメンバーには `updated` を積まない（ADR 0431）。判定は FOR UPDATE で読んだ行（`rowById`）から、つまり UPDATE の前の状態で行う。
      const events = await insertMemoryEventsBatch(
        tx,
        ctx,
        normalized
          .filter((m) => {
            const before = rowById.get(m.id)!;
            return !(before.status === "contested" && (before.contestedWithId ?? null) === null);
          })
          .map((m) => m.event),
        ids,
      );

      return { members: ids.map((id) => updatedById.get(id)!), events };
    });
  }

  /** `MemoryStore.resolveContestedGroup?` の実装（契約は interface の doc。ADR 0381）。`markContestedGroup` と対称で、`memories`・`memory_relations`（削除）・`memory_events` を1トランザクションで書く。 */
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
    if (members.length < 3) {
      throw new RangeError("resolveContestedGroup: members must have at least 3 entries");
    }
    const normalized = members.map((m) => ({
      ...m,
      id: normalizeUuidCase(m.id),
      ...(m.supersededById === undefined
        ? {}
        : { supersededById: normalizeUuidCase(m.supersededById) }),
    }));
    const ids = normalized.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new RangeError("resolveContestedGroup: member ids must be unique");
    }
    normalized.forEach((m, i) =>
      assertResolvedStatus("resolveContestedGroup", `members[${i}]`, m.status),
    );
    normalized.forEach((m, i) =>
      assertSupersededByShape(
        "resolveContestedGroup",
        `members[${i}]`,
        m.id,
        m.status,
        m.supersededById,
        { forbidWhenNotSuperseded: true },
      ),
    );
    assertNoSupersededCycle("resolveContestedGroup", normalized);
    for (const id of ids) {
      if (!isUuidLike(id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
      }
    }
    const supersededRefs = [
      ...new Set(
        normalized.flatMap((m) => {
          const ref = checkedRef("memory", m.supersededById);
          return ref === null ? [] : [ref];
        }),
      ),
    ];

    return this.db.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        SELECT id, status FROM memories
        WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const statusById = new Map(
        existing.rows.map((row) => {
          const r = row as unknown as { id: string; status: MemoryStatus };
          return [r.id, r.status] as const;
        }),
      );
      for (const id of ids) {
        if (!statusById.has(id)) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
      }
      for (const id of ids) {
        if (statusById.get(id) !== "contested") {
          throw new MemoryStatusConflictError(id, "contested", statusById.get(id)!);
        }
      }

      // 渡された members が、関係の行でつながった群の「今も contested な」全員と一致することを CAS で課す（一部だけを渡した部分解消を拒む。
      // ADR 0381）。`WITH RECURSIVE` で `members` から `memory_relations`（双方向2行が張られているので `from_memory_id` の向きだけ辿れば足りる）を
      // 辿り、`status = 'contested'` のものだけに絞った到達集合を求める。forget/supersede/purge/archive で抜けたメンバーは
      // `status <> 'contested'` なので、この到達集合には入らない（行は残るが「今の群」には数えない）。
      const reachable = await tx.execute(sql`
        WITH RECURSIVE reachable(id) AS (
          SELECT unnest(${sql.param(ids)}::uuid[])
          UNION
          SELECT r.to_memory_id
          FROM memory_relations r
          JOIN reachable rc ON r.from_memory_id = rc.id
          WHERE r.tenant_id = ${ctx.tenantId} AND r.kind = 'contradicts'
        )
        SELECT DISTINCT m.id FROM memories m
        JOIN reachable rc ON m.id = rc.id
        WHERE m.tenant_id = ${ctx.tenantId} AND m.status = 'contested'
      `);
      const reachableIds = new Set(
        reachable.rows.map((row) => (row as unknown as { id: string }).id),
      );
      const idSetForCheck = new Set(ids);
      const missing = [...reachableIds].filter((id) => !idSetForCheck.has(id));
      if (missing.length > 0) {
        // 群の一部だけを渡した。足りない側（まだ contested のまま群に残っているのに渡されなかったメンバー）を名指しして、何も書かずに
        // 専用のエラーとして扱う（`MemoryStatusConflictError` は再利用しない。ADR 0381）。
        throw new ContestedGroupMembershipMismatchError(missing[0] as MemoryId);
      }

      // 群の外の `forgotten` な記憶を置き換えた側にしない（ADR 0503）。群の中を指すのは、メンバーの status に関わらず断らない
      // （メンバーはここまでで全員 contested と確かめ済み）。別テナント・実在しない id は、下の UPDATE の切り分けに任せる（ADR 0439）。
      const outsideRefs = supersededRefs.filter((ref) => !idSetForCheck.has(ref));
      if (outsideRefs.length > 0) {
        const forgotten = await tx.execute(sql`
          SELECT id FROM memories
          WHERE tenant_id = ${ctx.tenantId}
            AND id = ANY(${sql.param(outsideRefs)}::uuid[])
            AND status = 'forgotten'
        `);
        const forgottenIds = new Set(
          forgotten.rows.map((row) => (row as unknown as { id: string }).id),
        );
        const badIndex = normalized.findIndex(
          (m) => m.supersededById !== undefined && forgottenIds.has(m.supersededById),
        );
        if (badIndex >= 0) {
          throw new RangeError(
            `resolveContestedGroup: members[${badIndex}].supersededById must not be a forgotten memory outside the group`,
          );
        }
      }

      // メンバーごとの UPDATE を `UPDATE ... FROM unnest(...)` の1文にまとめる（ADR 0401）。`supersededById` の COALESCE も、メンバーごとの値を配列で渡して同じ式のまま。
      const result = await tx.execute(sql`
        UPDATE memories AS t
        SET status = v.status,
            contested_with_id = NULL,
            superseded_by_id = COALESCE(v.superseded_by_id, t.superseded_by_id),
            updated_at = now()
        FROM unnest(
          ${sql.param(ids)}::uuid[],
          ${sql.param(normalized.map((m) => m.status))}::text[],
          ${sql.param(normalized.map((m) => m.supersededById ?? null))}::uuid[]
        ) AS v(id, status, superseded_by_id)
        WHERE t.tenant_id = ${ctx.tenantId} AND t.id = v.id AND t.status = 'contested'
          AND ${refExists("memories", ctx.tenantId, sql`v.superseded_by_id`)}
        RETURNING t.*
      `);
      const updatedById = new Map<MemoryId, Memory>(
        result.rows.map((row) => {
          const memory = rowToMemory(row as unknown as MemoryRow);
          return [memory.id, memory] as const;
        }),
      );
      if (updatedById.size !== ids.length) {
        // 全員が contested であることは上で確かめて行ロックも掴んでいるので、0行になる理由は `supersededById` が `ctx` のテナントの記憶でない
        // こと（ADR 0439）。先にそれを名指しする。
        if (supersededRefs.length > 0) {
          const badRef = await tx.execute(sql`
            SELECT r.id FROM unnest(${sql.param(supersededRefs)}::uuid[]) AS r(id)
            WHERE NOT EXISTS (
              SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = r.id
            )
            LIMIT 1
          `);
          if (badRef.rows.length > 0) {
            throw refNotFound("memory", (badRef.rows[0] as unknown as { id: string }).id);
          }
        }
        const failedId = ids.find((id) => !updatedById.has(id))!;
        throw await conflictAfterEmptyUpdate(tx, ctx, failedId, "contested");
      }

      // `both_active`/`supersede` のどちらでも、このメンバー全員を結んでいた関係の行を双方向とも削除する（ADR 0381）。2者版 `resolveContestedPair` が
      // 決着の種類に関わらず常に `contested_with_id = NULL` へ戻すのと同じ扱いで、「一度解消したら再び争わせない」印は作らない。
      await tx.execute(sql`
        DELETE FROM memory_relations
        WHERE tenant_id = ${ctx.tenantId}
          AND from_memory_id = ANY(${sql.param(ids)}::uuid[])
          AND to_memory_id = ANY(${sql.param(ids)}::uuid[])
          AND kind = 'contradicts'
      `);

      const events = await insertMemoryEventsBatch(
        tx,
        ctx,
        normalized.map((m) => m.event),
        ids,
      );

      return { members: ids.map((id) => updatedById.get(id)!), events };
    });
  }

  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」。契約は `MemoryStore.restoreSupersededBy` の doc で、ここはクエリの実装のみ。
   *
   * `archiveDecayed` と同じ理由で、UPDATE と INSERT を単一の `WITH ... UPDATE ... INSERT ... SELECT` 文にまとめる。`target` の `WHERE` は既存の
   * 部分索引 `idx_memories_superseded_by`（`migrations/0001_init.sql`）がそのまま担う。
   *
   * **`restored` の `UPDATE ... FROM target t WHERE m.id = t.id` に、`m.status = 'superseded' AND m.superseded_by_id = ${supersededById}` を
   * 明示的に重ねている**（`t` ではなく `m`。生きている行に対する条件）。`target` はこの文の先頭で1度読んだスナップショットで、READ COMMITTED の
   * 下では、`target` を読んでから `restored` の UPDATE がその行をロックするまでの間に、別のトランザクションが同じ行を `superseded → forgotten`
   * へ進めてコミットしうる。`m.id = t.id` だけだと、Postgres は EvalPlanQual で最新版の行を再取得して**この UPDATE 自身の WHERE** を
   * 再評価するが、`target` の条件（`status = 'superseded'`）はその再評価に含まれない（`t.id` は確定済みの値の集合でしかない）。その結果、直前に
   * forget/purge でコミットされた行を `active` へ巻き戻し、`unsuperseded` イベントを誤って積みうる。2条件を UPDATE 自身の WHERE に重ねることで
   * EvalPlanQual の再評価対象に入り、最新版の行が条件を満たさなければ `restored` から落ちる。
   *
   * `digest_snapshot` には（変更しない）現在の `digest` を入れる（`archiveDecayed`/`forget` と同じ規約）。`meta` は `{ reason, supersededById }` で、
   * `reason` は呼び出し側が渡した値、省略時は固定タグ `'unsuperseded'`（`updateStatusWithEvent` 経由の「省略時はキー自体を持たせない」規律とは
   * ここだけ意図的に違う。interface の契約節）。
   *
   * `filter?.onlyMemoryIds`（ADR 0258）を指定すると `target` CTE に `AND id = ANY(...)::uuid[]` を足すだけ。新しい索引は要らない
   * （`memories.id` は `PRIMARY KEY` で、`idx_memories_superseded_by` による絞り込みの上に重ねるだけ）。
   */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string | undefined; actor?: EventActor | undefined; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ restored: Memory[] }> {
    assertWellFormedCtx(ctx);
    supersededById = normalizeUuidCase(supersededById);
    if (!isUuidLike(supersededById)) {
      return { restored: [] };
    }
    const actor = event.actor ?? { type: "system" };
    const meta = { reason: event.reason ?? "unsuperseded", supersededById };
    const onlyMemoryIdsClause =
      filter?.onlyMemoryIds !== undefined
        ? // uuid の形をしていない id は群に居ないのと同じ——`getMany` と同じく、問い合わせの前に落とし、
          // `invalid input syntax for type uuid` を漏らさない（mapping.ts の isUuidLike の doc参照）。
          sql`AND id = ANY(${sql.param(filter.onlyMemoryIds.filter((id) => isUuidLike(id)))}::uuid[])`
        : sql``;

    // `at` が Invalid Date のとき、下の1文は対象が無くても `at` を `timestamptz` に変えて例外になる。戻す対象が無いなら、書くものが無いので
    // testkit の fixture と同じく空で返す。対象が在るときは、下の1文をそのまま流すので、同じ種類の例外になり、1件も戻さない。
    if (Number.isNaN(event.at.getTime())) {
      const exists = await this.db.execute(sql`
        SELECT 1 FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND superseded_by_id = ${supersededById}
          AND status = 'superseded'
          ${onlyMemoryIdsClause}
        LIMIT 1
      `);
      if (exists.rows.length === 0) {
        return { restored: [] };
      }
    }

    assertNoNulInNewMemoryEvent("PostgresMemoryStore", { actor, meta });
    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND superseded_by_id = ${supersededById}
          AND status = 'superseded'
          ${onlyMemoryIdsClause}
      ),
      restored AS (
        UPDATE memories m
        SET status = 'active', superseded_by_id = NULL, updated_at = now()
        FROM target t
        WHERE m.id = t.id
          AND m.status = 'superseded'
          AND m.superseded_by_id = ${supersededById}
        RETURNING m.*
      ),
      inserted_events AS (
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        SELECT
          gen_random_uuid(), ${ctx.tenantId}, r.id, 'unsuperseded', ${toPgTimestamp(event.at)},
          ${JSON.stringify(actor)}::jsonb, r.digest, NULL, ${JSON.stringify(meta)}::jsonb
        FROM restored r
        RETURNING memory_id
      )
      SELECT * FROM restored ORDER BY id ASC
    `);

    const restored = result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
    return { restored };
  }

  /**
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口（ADR 0237。契約は `MemoryStore.previewRestoreSupersededBy` の doc）。
   *
   * `target` の `WHERE` は `restoreSupersededBy` の `target` CTE と**1文字も違わない**（同じ部分索引 `idx_memories_superseded_by`）。`SELECT` のみの
   * 文なので、トランザクションを開始する必要も無い。
   *
   * `latest_superseded_event` は、対象ごとに直近の `kind = 'superseded'` の `memory_events` 行を1件選ぶ（`DISTINCT ON (memory_id) ... ORDER BY
   * memory_id, at DESC`）。`idx_memory_events_by_memory`（`tenant_id, memory_id, at`）が `memory_id = 対象` を絞る側を担い、走査量は群のサイズに
   * 比例する。`meta->>'reason'` が無い場合も、対象に一致する行が1件も無い場合（`LEFT JOIN`）も `NULL` で、この2つを区別する必要は無い
   * （どちらも「取れない」の一種）。
   *
   * `filter?.onlyMemoryIds`（ADR 0258）: `restoreSupersededBy` と**1文字も違わない** `AND id = ANY(...)::uuid[]` を `target` CTE に足す
   * （対象の選び方を完全に一致させる契約）。
   */
  async previewRestoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    assertWellFormedCtx(ctx);
    if (!isUuidLike(supersededById)) {
      return { candidates: [] };
    }
    const onlyMemoryIdsClause =
      filter?.onlyMemoryIds !== undefined
        ? // uuid の形をしていない id は群に居ないのと同じ——`getMany` と同じく、問い合わせの前に落とし、
          // `invalid input syntax for type uuid` を漏らさない（mapping.ts の isUuidLike の doc参照）。
          sql`AND id = ANY(${sql.param(filter.onlyMemoryIds.filter((id) => isUuidLike(id)))}::uuid[])`
        : sql``;

    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND superseded_by_id = ${supersededById}
          AND status = 'superseded'
          ${onlyMemoryIdsClause}
      ),
      latest_superseded_event AS (
        SELECT DISTINCT ON (me.memory_id) me.memory_id, me.meta ->> 'reason' AS reason
        FROM memory_events me
        JOIN target t ON t.id = me.memory_id
        WHERE me.tenant_id = ${ctx.tenantId}
          AND me.kind = 'superseded'
        ORDER BY me.memory_id, me.at DESC
      )
      SELECT t.id, lse.reason
      FROM target t
      LEFT JOIN latest_superseded_event lse ON lse.memory_id = t.id
      ORDER BY t.id ASC
    `);

    return {
      candidates: result.rows.map((row) => {
        const r = row as unknown as { id: string; reason: string | null };
        return { memoryId: r.id as MemoryId, supersededReason: r.reason };
      }),
    };
  }

  /**
   * `listLabels?`（契約は interface の doc。ADR 0318）。`name` の並び順は **コードポイント順**（バイト順）。`ORDER BY name`（COLLATE 指定なし）は
   * DB の既定の照合順序に従い、既定が `C` でない DB（例: `en_US.utf8`）ではロケール依存の自然順になるので、`COLLATE "C"` を明示する。
   */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT * FROM labels WHERE tenant_id = ${ctx.tenantId} ORDER BY name COLLATE "C" ASC
    `);
    return result.rows.map((row) => rowToLabel(row as unknown as LabelRow));
  }

  /**
   * `registerLabel?`（契約は interface の doc。ADR 0318）。行が無ければ `proposed_count: 0` の `registered` 行を作る。既に `proposed` なら
   * `registered` へ更新し `registered_at` を今にする。既に `registered` なら `registered_at` を変えない（`COALESCE(labels.registered_at, now())`）。
   */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      INSERT INTO labels (id, tenant_id, name, status, proposed_count, registered_at)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, ${name}, 'registered', 0, now())
      ON CONFLICT (tenant_id, name) DO UPDATE
        SET status = 'registered',
            registered_at = COALESCE(labels.registered_at, now())
      RETURNING *
    `);
    return rowToLabel(result.rows[0] as unknown as LabelRow);
  }

  /**
   * `MemoryStore.eraseTenant?` の Postgres 実装（ADR 0383）。契約の全文は `@mnemora/core` の interface doc（`packages/core/src/interfaces/memory-store.ts`）。
   *
   * ## 検査（`blocked_by_foreign_reference`）
   *
   * 削除と**同じトランザクションの先頭で**、他テナントの行がこのテナントの行を外部キーで参照していないかを数える
   * （{@link countForeignReferences}）。参照の経路は表名を焼き込まず、`pg_constraint` から数え上げる。**埋め込み空間の表
   * （`memory_embeddings_<space>`、`ON DELETE CASCADE`）も入る。**CASCADE の表を入れないと、他テナントの埋め込みの行が `memories` の
   * 削除に巻き込まれて黙って消える（「他テナントの行は書き換えない」に反する）。後から表が増えても、外部キーを張っていれば自動で入る。
   *
   * 1件でもあれば、**1行も消さずに** `{ kind: "blocked_by_foreign_reference", count }` を返す（`dryRun` でも同じ検査をする）。検査と削除の間に
   * 他テナントが参照を作って外部キー違反（SQLSTATE 23503）になった場合は、トランザクションごとロールバックされたうえで数え直し、
   * `blocked_by_foreign_reference` を返す（数え直して0件なら、他テナント由来ではないので元の例外をそのまま投げる）。
   * 数える問い合わせは、参照される側を `tenant_id = $1` で絞り、参照する側を外部キーの列で引く（`migrations/0027_erase_tenant_fk_indexes.sql` の
   * 単一列索引が効く向き）。
   *
   * ## 本体
   *
   * `dryRun` の有無に関わらず `db.transaction` で包む。複数の表にまたがる budget（`opts.limit`）の消費を、1つの一貫したスナップショットの
   * 上で数えるため（`purgeExpiredEventsByRetention` と同じ判断）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun === true;
    try {
      return await this.db.transaction(async (tx) => {
        await lockTenantForErase(tx, ctx.tenantId);
        const blocked = await countForeignReferences(tx, ctx.tenantId);
        if (blocked > 0) {
          return { kind: "blocked_by_foreign_reference", count: blocked };
        }
        return this.eraseTenantBody(tx, ctx, opts.limit, dryRun);
      });
    } catch (err) {
      if (sqlStateOf(err) !== PG_FOREIGN_KEY_VIOLATION_SQLSTATE) {
        throw err;
      }
      const count = await countForeignReferences(this.db, ctx.tenantId);
      if (count === 0) {
        throw err;
      }
      return { kind: "blocked_by_foreign_reference", count };
    }
  }

  /**
   * {@link PostgresMemoryStore.eraseTenant} の本体。表ごとに budget（残りの削除可能数）を消費しながら、子→親の順で処理する。
   *
   * `dryRun` のときは `DELETE`/`UPDATE` を一切発行せず、`SELECT count(*)` で「削除していたら消えていたであろう件数」だけを数える。
   * `reachedLimit` は「ある表でちょうど budget 分だけ削除/カウントできた」ときに `true` にする保守的な近似（その表にもう行が残っていなくても
   * `true` になりうる。呼び直しても安全）。
   */
  private async eraseTenantBody(
    tx: Db,
    ctx: Ctx,
    limit: number,
    dryRun: boolean,
  ): Promise<EraseTenantStoreResult> {
    let remaining = limit;
    let total = 0;
    let reachedLimit = false;

    // 単一列 PK（id）の表向けの汎用ステップ。`table` は呼び出し元がすべてハードコードした文字列リテラルで、利用者入力ではない
    // （`sql.identifier` は同じ形の文を表ごとに書き写さないための道具）。
    const drainById = async (table: string, budget: number): Promise<number> => {
      if (dryRun) {
        const result = await tx.execute(sql`
          SELECT count(*)::int AS count FROM (
            SELECT 1 FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} LIMIT ${budget}
          ) s
        `);
        return (result.rows[0] as unknown as { count: number }).count;
      }
      const result = await tx.execute(sql`
        WITH victims AS (
          SELECT id FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} LIMIT ${budget}
        )
        DELETE FROM ${sql.identifier(table)} AS t
        USING victims v
        WHERE t.tenant_id = ${ctx.tenantId} AND t.id = v.id
        RETURNING t.id
      `);
      return result.rows.length;
    };

    const runStep = async (step: () => Promise<number>): Promise<void> => {
      if (remaining <= 0) {
        reachedLimit = true;
        return;
      }
      const budgetBeforeStep = remaining;
      const deleted = await step();
      total += deleted;
      remaining -= deleted;
      if (deleted === budgetBeforeStep && deleted > 0) {
        reachedLimit = true;
      }
    };

    await runStep(() =>
      dryRun
        ? tx
            .execute(
              sql`
              SELECT count(*)::int AS count FROM (
                SELECT 1 FROM memory_labels WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              ) s
            `,
            )
            .then((r) => (r.rows[0] as unknown as { count: number }).count)
        : tx
            .execute(
              sql`
              WITH victims AS (
                SELECT memory_id, label_id FROM memory_labels
                WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              )
              DELETE FROM memory_labels ml
              USING victims v
              WHERE ml.tenant_id = ${ctx.tenantId}
                AND ml.memory_id = v.memory_id AND ml.label_id = v.label_id
              RETURNING ml.memory_id
            `,
            )
            .then((r) => r.rows.length),
    );

    await runStep(() =>
      dryRun
        ? tx
            .execute(
              sql`
              SELECT count(*)::int AS count FROM (
                SELECT 1 FROM recall_usages WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              ) s
            `,
            )
            .then((r) => (r.rows[0] as unknown as { count: number }).count)
        : tx
            .execute(
              sql`
              WITH victims AS (
                SELECT recall_id, memory_id FROM recall_usages
                WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              )
              DELETE FROM recall_usages ru
              USING victims v
              WHERE ru.tenant_id = ${ctx.tenantId}
                AND ru.recall_id = v.recall_id AND ru.memory_id = v.memory_id
              RETURNING ru.recall_id
            `,
            )
            .then((r) => r.rows.length),
    );

    await runStep(() => drainById("memory_events", remaining));

    // 3b. memory_relations（`from_memory_id`/`to_memory_id` の両方が `memories(id)` を参照する）。`purgeMemory` はこの表に触れない
    // （ADR 0381）が、テナントを丸ごと消すときは消す（ADR 0383）。
    await runStep(() => drainById("memory_relations", remaining));

    // 4. memories。削除の前に、このテナントの自己参照（superseded_by_id/contested_with_id）を丸ごと NULL 化する。`limit` で区切った
    // バッチをまたいで自己参照が残っていると（このバッチで消す行を、まだ消していない別バッチの行が指している場合）、`memories(id)` への FK
    // （`ON DELETE` 指定なし＝`NO ACTION`）が違反になる。budget には数えない（削除ではないため）。dryRun では行わない。
    await runStep(async () => {
      if (!dryRun) {
        await tx.execute(sql`
          UPDATE memories
          SET superseded_by_id = NULL, contested_with_id = NULL
          WHERE tenant_id = ${ctx.tenantId}
            AND (superseded_by_id IS NOT NULL OR contested_with_id IS NOT NULL)
        `);
      }
      return drainById("memories", remaining);
    });

    // 5. observations（memories の親。source_observation_id の参照元である memories 行がこのテナントに残っていると、消せば FK 違反になる。
    // memories が budget 不足で残っていれば、このステップの budget は既に0なので `runStep` の冒頭チェックで何もしない）。
    await runStep(() => drainById("observations", remaining));

    await runStep(() => drainById("recalls", remaining));

    await runStep(() => drainById("labels", remaining));

    await runStep(() =>
      dryRun
        ? tx
            .execute(
              sql`SELECT count(*)::int AS count FROM tenant_activity WHERE tenant_id = ${ctx.tenantId}`,
            )
            .then((r) => (r.rows[0] as unknown as { count: number }).count)
        : tx
            .execute(
              sql`DELETE FROM tenant_activity WHERE tenant_id = ${ctx.tenantId} RETURNING tenant_id`,
            )
            .then((r) => r.rows.length),
    );

    await runStep(() =>
      dryRun
        ? tx
            .execute(
              sql`
              SELECT count(*)::int AS count FROM (
                SELECT 1 FROM tenant_subject_activity WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              ) s
            `,
            )
            .then((r) => (r.rows[0] as unknown as { count: number }).count)
        : tx
            .execute(
              sql`
              WITH victims AS (
                SELECT subject_id FROM tenant_subject_activity
                WHERE tenant_id = ${ctx.tenantId} LIMIT ${remaining}
              )
              DELETE FROM tenant_subject_activity t
              USING victims v
              WHERE t.tenant_id = ${ctx.tenantId} AND t.subject_id = v.subject_id
              RETURNING t.subject_id
            `,
            )
            .then((r) => r.rows.length),
    );

    return { kind: "executed", deleted: total, reachedLimit };
  }
}

/**
 * `archiveDecayed` が「どの行を archived にするか」を選ぶ `SELECT`（ADR 0114、ADR 0165）。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある**（`buildRequeueEmbedTargetSelect` と同じ理由。テスト側に述語を書き写すと、
 * 本体の述語を直したときに歯だけが古い述語を測り続ける）。
 *
 * `opts.clock` で述語を切り替える（省略時は `'wall'`）:
 * - `'wall'`: `decay_floor_at <= opts.now`（既存索引 `idx_memories_recall_gate` を使う。`status = 'active'` は部分索引の述語
 *   `status IN ('active','contested')` を含意する）。
 * - `'activity'`: `decay_floor_seq IS NOT NULL AND decay_floor_seq <= opts.nowSeq`（`idx_memories_recall_gate_seq` を使う。`opts.nowSeq` 必須）。
 * - `'either'`: **AND**（両方の軸で沈んでいるものだけ掃く。ゲートの `'either'` が OR なのとは逆。`ArchiveDecayedOptions.clock` の doc）。
 *
 * **`decay_floor_at <= opts.now`・`decay_floor_seq <= opts.nowSeq`（どちらも境界を含む）。**`VectorFilter.decayFloorAtAfter`/`decayFloorSeqAfter` は
 * 狭義の `>`（境界を含まない）で、この非対称は意図である（`ArchiveDecayedOptions.clock` の doc）。
 *
 * **`ORDER BY decay_floor_at ASC` は `'activity'`/`'either'` でもそのまま使う。**`ArchiveDecayedResult.archived` の doc は「`decay_floor_at` 昇順」しか
 * 約束せず、返り値の型も `decayFloorSeq` を持たない。`decay_floor_at` は常に non-null なので、この列で安定した順序を作れる。
 */
export function buildArchiveDecayedTargetSelect(ctx: Ctx, opts: ArchiveDecayedOptions): SQL {
  const clock = opts.clock ?? DEFAULT_DECAY_CLOCK;
  const wallCondition = sql`decay_floor_at <= ${toPgTimestamp(opts.now)}`;
  const activityCondition = (): SQL => {
    if (opts.nowSeq === undefined) {
      throw new Error(
        `PostgresMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
      );
    }
    return activityFloorSeqDeadCondition({
      nowSeq: opts.nowSeq,
      usesSubjectCounters: opts.usesSubjectActivityCounters === true,
      floorSeqExpr: sql`decay_floor_seq`,
      // 相関サブクエリの中では、修飾の無い列名は内側の `tenant_subject_activity` に解決される（ADR 0438）。
      tenantIdExpr: sql`memories.tenant_id`,
      subjectIdExpr: sql`memories.subject_id`,
    });
  };

  let clockCondition: SQL;
  if (clock === "wall") {
    clockCondition = wallCondition;
  } else if (clock === "activity") {
    clockCondition = activityCondition();
  } else {
    clockCondition = sql`(${wallCondition} AND ${activityCondition()})`;
  }

  // **並べる軸は、掃く軸に合わせる**（ADR 0165）。`clock: 'activity'` のときに `decay_floor_at` で並べると、`idx_memories_recall_gate_seq`
  // （`(tenant_id, status, decay_floor_seq)`）は並び替えを満たせないので選ばれず、プランナは壁時計側の索引を走査して `decay_floor_seq` を
  // Filter に落とす。活動軸で沈んだ行が疎なテナントでは、`limit` 件を見つけるまで壁時計順に大量の行を走査する（正しさではなく処理量の問題）。
  // `archiveDecayed` の外側のクエリが返す行を常に `ORDER BY decay_floor_at ASC, id ASC` に並べ直すので、`archived` の並び順の契約は変わらない。
  // ここで変わるのは「`limit` が効くときにどの行を選ぶか」だけ。
  // `'either'` は壁時計のまま。掃引の条件が AND で、どちらの索引も単独では述語を満たしきれない。
  const targetOrder = clock === "activity" ? sql`decay_floor_seq ASC` : sql`decay_floor_at ASC`;

  return sql`
    SELECT id FROM memories
    WHERE tenant_id = ${ctx.tenantId}
      AND status = 'active'
      AND ${clockCondition}
    ORDER BY ${targetOrder}, id ASC
    LIMIT ${opts.limit}
    FOR UPDATE SKIP LOCKED`;
}

/**
 * `requeueEmbedJobs` が「どの行を積み直すか」を選ぶ `SELECT`（ADR 0079）。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**テスト側に SQL を書き写すと、本体の述語を直したときに歯だけが古い述語を測り続ける。
 *
 * **`statuses` のどれにも当たる行が無い（全 status が0件の）ときは、0007 の索引を最後まで読み、`ready` 以外の行を Filter で捨てて0行を返す**
 * （走査の量はそのテナントの `ready` 以外の行数に比例する）。測って、直さないと判断した（ADR 0413。呼び出し元は手動の保守操作 `Runtime.reembed` だけ）。
 *
 * `memoryIds` を渡されたのに well-formed な id が1つも残らなかったときは `null` を返す。形式が壊れた id は `getMany` と同じく静かに落とす
 * （uuid 列への cast で文全体が例外になるのを避ける）が、絞り込みを渡されたのに残りが0件なら、それは空集合との積で、問い合わせる意味が無い。
 */
export function buildRequeueEmbedTargetSelect(ctx: Ctx, opts: RequeueEmbedJobsOptions): SQL | null {
  let idFilter = sql``;
  if (opts.memoryIds !== undefined) {
    const wellFormedIds = opts.memoryIds.filter((id) => isUuidLike(id));
    if (wellFormedIds.length === 0) {
      return null;
    }
    idFilter = sql` AND id = ANY(${sql.param(wellFormedIds)}::uuid[])`;
  }

  return sql`
    SELECT id FROM memories
    WHERE tenant_id = ${ctx.tenantId}
      AND status IN ('active', 'contested')
      -- ⚠ **ここに "AND embedding_status <> 'ready'" を書き足さないこと。**
      -- 部分索引 idx_memories_requeue_embed（migration 0007）の述語を WHERE へ写して
      -- 含意を助ける必要がある、と当初は考えた。**CI の EXPLAIN で逆だと分かった**
      -- （ADR 0079「測ったこと」に全文）: プランナは "= ANY($n)" の実引数を定数として
      -- 見るので（node-postgres の unnamed statement は custom plan になる）、
      -- 述語 "embedding_status <> 'ready'" は書かなくても含意される。
      -- そして**書くと逆に遅くなる**——その条件片が Recheck Cond に回って Bitmap Heap
      -- Scan が選ばれ、ORDER BY のために Sort が挟まる（cost 843、LIMIT の早期打ち切りが
      -- 効かない）。書かなければ素の Index Scan で並びがそのまま供給される（cost 58）。
      AND embedding_status = ANY(${sql.param(opts.statuses)}::text[])
      ${idFilter}
    ORDER BY updated_at ASC, id ASC
    LIMIT ${opts.limit}
    FOR UPDATE SKIP LOCKED`;
}

/**
 * `purgeExpiredEvents` が消す対象の `memory_events` の行を選ぶ SELECT（`kind <> 'events_purged'`、`at < opts.olderThan`、古い順に `opts.limit + 1` 件）を
 * 組み立てる（ADR 0115）。**本体と `EXPLAIN` の歯が、同じものを使うために切り出してある**（`buildRequeueEmbedTargetSelect` と同じ理由）。
 *
 * `LIMIT opts.limit + 1` で1件多く取る。`reachedLimit`（「1回で消しきれなかった」）を `purged === opts.limit` からの推測に頼らず、専用の信号として
 * 立てるため。
 *
 * **`opts.limit` は0以上の整数を渡す前提で、負数を渡したときの結果は未定義**（`PurgeExpiredEventsOptions.limit` の doc）。この `+1` の算術ゆえに
 * `opts.limit === -1` だけは `LIMIT 0` になり例外にならず、`reachedLimit: true` を返す（意図した設計ではなく偶然で、契約として真似る理由は無い。ADR 0115）。
 *
 * `kind <> 'events_purged'` は `memory_events` の `(tenant_id, at)` の索引（`migrations/0010_memory_events_retention_index.sql`）を張ったうえで
 * Filter として残す。`kind` は行数の大半を削る述語ではなく、部分索引にする動機が薄い。
 */
export function buildPurgeExpiredEventsTargetSelect(
  ctx: Ctx,
  opts: PurgeExpiredEventsOptions,
): SQL {
  return sql`
    SELECT id, at FROM memory_events
    WHERE tenant_id = ${ctx.tenantId}
      AND at < ${toPgTimestamp(opts.olderThan)}
      AND kind <> 'events_purged'
    ORDER BY at ASC
    LIMIT ${opts.limit + 1}`;
}

/**
 * `purgeExpiredRecalls` が消す対象の `recalls` の行を選ぶ SELECT（`created_at < opts.olderThan`、古い順に `opts.limit + 1` 件。上限に届いたかを判定するため）。
 * `lock` が真なら `FOR UPDATE` で行を掴む（削除するとき）。
 */
export function buildPurgeExpiredRecallsTargetSelect(
  ctx: Ctx,
  opts: PurgeExpiredRecallsOptions,
  lock = false,
): SQL {
  return sql`
    SELECT id, created_at FROM recalls
    WHERE tenant_id = ${ctx.tenantId}
      AND created_at < ${toPgTimestamp(opts.olderThan)}
    ORDER BY created_at ASC, id ASC
    LIMIT ${opts.limit + 1}${lock ? sql` FOR UPDATE` : sql``}`;
}

/** 外部キー違反の SQLSTATE（`eraseTenant` が他テナントからの参照を見分けるのに使う）。 */
const PG_FOREIGN_KEY_VIOLATION_SQLSTATE = "23503";

/** 例外から SQLSTATE を取り出す。drizzle は pg のエラーを `cause` に包むことがあるので、`cause` を辿る。 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 他テナントの行が、テナント `tenantId` の行を外部キーで参照している件数を数える（ADR 0383）。経路は `pg_constraint` から数え上げる
 * （表名を焼き込まない）: `current_schema()` の中の単一列の外部キーで、参照する側・される側の両方に `tenant_id` 列があるもの全部。
 * 複数列の外部キー（`tenant_id` を含めればテナントを跨げない）と、`tenant_id` を持たない表からの参照は対象外。
 */
async function countForeignReferences(tx: Db, tenantId: string): Promise<number> {
  const paths = await tx.execute(sql`
    SELECT child.relname AS child_table, ca.attname AS child_column,
           parent.relname AS parent_table, pa.attname AS parent_column
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND n.nspname = current_schema()
      AND parent.relnamespace = child.relnamespace
      AND array_length(con.conkey, 1) = 1
      AND EXISTS (
        SELECT 1 FROM pg_attribute t
        WHERE t.attrelid = child.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
      )
      AND EXISTS (
        SELECT 1 FROM pg_attribute t
        WHERE t.attrelid = parent.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
      )
    ORDER BY child.relname, ca.attname
  `);
  let total = 0;
  for (const row of paths.rows) {
    const p = row as unknown as {
      child_table: string;
      child_column: string;
      parent_table: string;
      parent_column: string;
    };
    const result = await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM ${sql.identifier(p.parent_table)} AS mine
      JOIN ${sql.identifier(p.child_table)} AS other
        ON other.${sql.identifier(p.child_column)} = mine.${sql.identifier(p.parent_column)}
      WHERE mine.tenant_id = ${tenantId} AND other.tenant_id <> ${tenantId}
    `);
    total += (result.rows[0] as unknown as { count: number }).count;
  }
  return total;
}
