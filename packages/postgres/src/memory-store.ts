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
import { assertWellFormedCtx, assertWellFormedIdentifier } from "@mnemora/core";
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
  toPgTimestamp,
  type LabelRow,
  type MemoryEventRow,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
  type RecallRow,
} from "./mapping.js";

/**
 * `MemoryStore` の Postgres 実装（docs/architecture.md §5.1、docs/memory-model.md §10）。
 *
 * クエリは drizzle-orm の `sql` タグ付きテンプレートで書く。冪等な作成
 * （`createObservation` / `createMemory`）は `INSERT ... ON CONFLICT (...) WHERE ... DO NOTHING
 * RETURNING *` を使い、行が返らなかった場合（＝既存行と衝突した場合）だけ追加の SELECT で
 * 既存行を取得する。`ON CONFLICT` の衝突検出はテーブルの一意索引そのものが担うため、
 * 同時実行でも正しく機能する（先に commit した側の行だけが見える）。
 */
/**
 * `db.transaction(async (tx) => ...)` に渡るコールバック引数と、トランザクションを
 * 開いていない `this.db` の両方を受け付けるための構造的な最小 interface。
 *
 * 個々の `.execute(sql\`...\`)` 呼び出ししか使わない `upsertProposedLabels` にとっては、
 * 呼び出し元が `Db`（`createMemory` のようにこのメソッド自身がトランザクションを開く場合）
 * であろうと、`db.transaction` のコールバック引数（`createMemoryWithOutbox`/
 * `supersedeWithNewMemories` のように、既に開いているトランザクションに相乗りする場合）
 * であろうと違いが無い——両方とも `.execute` を持つ。
 */
type SqlExecutor = Pick<Db, "execute">;

/**
 * `subject_id` を「NULL 同士も一致」として比較する述語を、**索引で引ける形**で作る
 * （`findActiveByClaimKey`/`listActiveClaimPredicates` が使う）。
 * `subject_id IS NOT DISTINCT FROM $n` と同じ意味だが、その形は索引で引けないので、
 * `subjectId` が `null` なら `subject_id IS NULL`、そうでなければ `subject_id = $n` に分ける。
 */
function subjectIdMatches(subjectId: string | null): SQL {
  return subjectId === null ? sql`subject_id IS NULL` : sql`subject_id = ${subjectId}`;
}

/**
 * Issue #1226 / ADR 0375 決定7: `createMemoryWithOutbox`/`supersedeWithNewMemories` の
 * `opts.abortIfForgotten` を実装する共通部分。**呼び出し元のトランザクション（`tx`）の中で、
 * まだ何も書く前に**呼ぶこと——`SELECT … FOR UPDATE` で対象行をロックしたうえで
 * `status` を見直し、1件でも `"forgotten"` なら {@link SourceMemoryForgottenError} を投げる
 * （呼び出し元の `tx` ごと rollback される）。空配列・`undefined` なら何もしない
 * （見直しを一切行わない——今日どおり）。
 *
 * `FOR UPDATE` を使う理由: 見直しと同じトランザクションの中で対象行をロックすることで、
 * 見直した後にこのトランザクションが commit するまで、他のトランザクション（`forget`/
 * `purge`）がこの行を書き換えられなくする。見直し（この関数）と書き込み（呼び出し元が
 * この後に行う INSERT/UPDATE）の間に窓が無い——`embed` ジョブの同種のレースを閉じた
 * [Issue #1035](https://github.com/takecchi/mnemora/issues/1035) は「書いた後に読み直す」形
 * だったが、ここは「書く**前**に見直す」——ADR 0375 決定7参照。
 *
 * `tenant_id` の絞り込みも同じ `WHERE` に含める——他テナントの同じ id を誤って見ない。
 *
 * ⚠ `ORDER BY id ASC FOR UPDATE`: 行ロックを掴む順を、`markContestedPair`/`resolveContestedPair`/
 * `markContestedGroup` と同じ id 昇順に揃える。`ORDER BY` が無いと掴む順が実行計画（ふつうは heap の並び）に
 * 依存し、`consolidate` と `markContestedPair` が同じ行を逆順で掴み合って 40P01（`deadlock detected`）を
 * 生のまま漏らしうる。歯は `__tests__/assert-not-forgotten-lock-order.postgres.test.ts`。
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
  // `getMany` と同じ理由（`isUuidLike` の doc 参照）——形式が壊れた id は「無い」のと
  // 同じ扱いにする。呼び出し側（runtime）は既に実在を確かめた id しか渡さないため、
  // 実際にはここで落ちることは無いはずだが、クエリを投げる前に取り除く作法は揃える。
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
 * ADR 0420: `opts.abortIfSuperseded` を実装する共通部分。{@link assertNotForgottenForUpdate} の直後に、
 * 同じトランザクションの中で（すでにロックした行を）`FOR UPDATE` でもう一度読み、1件でも
 * `"superseded"` なら {@link SourceMemoryStatusChangedError} を投げる（呼び出し元の `tx` ごと rollback）。
 * 空配列・`undefined` なら何もしない。行ロックの下で見るので、見直しの後に他のトランザクションが
 * `superseded` へ動かすことはない（すでに動かした側が先に commit していれば、ここで見える）。
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
 * `supersedeWithNewMemories` の `opts.buildCreatedEvent`（ADR 0416）が共有する——書き写さない。
 * 失敗したら投げる（呼び出し元の `tx` ごと rollback される）。
 */
async function insertCreatedEventRow(
  tx: SqlExecutor,
  ctx: Ctx,
  event: NewMemoryEvent,
  createdMemoryId: string,
): Promise<void> {
  // ADR 0456: イベントが指す記憶が、今作った行でなければ（呼び出し側の `buildCreatedEvent` が別の id を返したとき）、
  // `ctx` のテナントの行かを確かめる。
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
 * ADR 0451: 候補ごとの savepoint の `rollback to savepoint` が失敗したとき、その失敗を元のエラーへ添える。
 * ADR 0444 と同じ作法——元のエラーの `cause` が空いていれば `cause` に、空いていなければ `rollbackError` に置く。
 * `Error` でないもの（投げられた値が文字列など）には添えない。新しい例外の型は作らない。
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

/**
 * `markContestedGroup` / `resolveContestedGroup` の UPDATE が期待より少ない行数しか返さなかった
 * とき、旧実装（メンバーごとの UPDATE）が投げていたものと同じエラーを作る
 * （Issue #1449 PR1、ADR 0401）。呼び出し側は「入力順で最初に更新されなかった id」を渡す。
 */
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
 * ADR 0439: 書き込み口が受け取る、別の行への参照（`superseded_by_id`・`contested_with_id`・`source_observation_id`・
 * `recall_usages` の recall と memory）の入口の検査。DB へ投げる前に、uuid の形でない id を「`ctx` のテナントに無い」と
 * 同じ message で弾き（実在しない・別テナントと区別しない）、大文字の uuid は小文字にそろえる。
 * `null`・`undefined` は「参照しない」。**空文字は参照として扱う**（uuid の形でないので弾かれる）。
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
 * ADR 0439: 「`id` の行が `ctx` のテナントに在る」を表す述語（`id` は uuid の形に検査済みの値、または `NULL`）。
 * `NULL` は参照しないので真。**書く文の中に置く**（検査と書き込みの間に別の文を挟まない）。
 */
function refExists(table: "memories" | "observations" | "recalls", tenantId: string, id: SQL): SQL {
  return sql`(${id}::uuid IS NULL OR EXISTS (
    SELECT 1 FROM ${sql.raw(table)} rf WHERE rf.tenant_id = ${tenantId} AND rf.id = ${id}::uuid
  ))`;
}

/**
 * ADR 0456（ADR 0436・0439 の続き）: 呼び出し側が渡した `NewMemoryEvent.memoryId` の記憶が `ctx` のテナントに在ることを、
 * イベントを書く前に確かめる。`memory_events.memory_id` の外部キーは `tenant_id` を含まないので、確かめないと
 * 別テナントの記憶を指すイベントが `ctx` のテナントの行として書けた。実在しない・別テナントは区別せず
 * `memory not found for tenant`（uuid の形でない id も同じ文面。以前は生の `DrizzleQueryError`）。
 * `null`・`undefined`（記憶を指さないイベント）は確かめない。**書き込みと同じトランザクションの中で呼ぶ**
 * （投げれば、同じトランザクションの status 更新も戻る）。
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
  // この呼び出しが今まさに更新・作成した行の id（`ctx` のテナントの行と分かっている）なら、問い合わせない。
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
 * ADR 0499（ADR 0447 の材料）: `expectedStatus` を渡された status 更新の CAS 条件。**purge 済みの行（`purged_at` が入った行。
 * `status` は `forgotten` のまま）は、どの `expectedStatus` にも一致しない**——`Runtime.purge` の「不可逆」の約束どおり、
 * 墓石を `updateStatusWithEvent(T, "active", { expectedStatus: "forgotten" })` が active へ戻せない（以前は `purged_at` を
 * 見ず、戻せた）。0行になった理由の切り分け（`explainEmptyStatusUpdate`）は、通常の CAS 違反と同じ `MemoryStatusConflictError`
 * にする。`expectedStatus` を渡さない更新は、無条件の書き込みのまま（CAS ではないので、この条件は付けない）。
 */
function expectedStatusCondition(expectedStatus: MemoryStatus | undefined): SQL {
  return expectedStatus !== undefined
    ? sql`AND status = ${expectedStatus} AND purged_at IS NULL`
    : sql``;
}

/**
 * ADR 0499（ADR 0450 の材料）: `resolveContestedPair`・`resolveContestedGroup` の `status` は型が `"active" | "superseded"`。
 * 型の外の値（`"forgotten"`・`"contested"`・`"archived"` など）は、以前は通って行をその status にしていた。
 * 書く前に `RangeError` で断る（値は message に入れない）。
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
 * testkit の `InMemoryMemoryStore` と同じ文面。id は uuid の大文字小文字を畳んで比べる。
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

/**
 * `UPDATE memories SET superseded_by_id = …` が0行だったときの切り分け（ADR 0439）。対象の行が無い・`supersededById` が
 * `ctx` のテナントの記憶でない・`expectedStatus` が違う、の3つを、この順で別々の例外にする。
 */
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
 * `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` が共有する。書き写さない）。
 *
 * ADR 0439: `sourceObservationId`・`supersededById`・`contestedWithId` が `ctx` のテナントの行であることを、
 * **同じ SQL 文の中で**確かめる（`WITH chk AS (SELECT … EXISTS …), ins AS (INSERT … SELECT … FROM chk WHERE …)`）。
 * 外部キーは `observations(id)`・`memories(id)` だけでテナントを含まないので、検査が無いと別テナントの id を指す行が
 * 書けた。拒まれたときは行を書かずに投げる。`ON CONFLICT DO NOTHING` の「書かなかった」と検査の「拒んだ」は、
 * 戻り値の `*_ok` で区別する（どちらも挿入は0行）。
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
 * `memory_events` へ複数行を**1文**で入れ、**入力と同じ順**で返す（Issue #1449 PR1、ADR 0401）。
 * 行の id は JS 側で採番し、`RETURNING` の順序に依存せず id で入力順へ戻す。
 * 各列の式は、旧実装のメンバーごとの `INSERT ... VALUES` と同じ（`at` は `toPgTimestamp` の
 * 文字列を `timestamptz` へ、`actor`/`meta` は `jsonb` へ）。
 */
async function insertMemoryEventsBatch(
  tx: Tx,
  ctx: Ctx,
  events: ReadonlyArray<NewMemoryEvent>,
  knownInTenant: readonly string[],
): Promise<MemoryEvent[]> {
  // ADR 0456: 群の操作が更新した行（`knownInTenant`）以外を指すイベントは、`ctx` のテナントの行かを1文で確かめる。
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
  // ADR 0499: NUL は DB の生の例外でなく、名指しの例外で断る（イベントを書く文の直前）。
  events.forEach((e) => assertNoNulInNewMemoryEvent("PostgresMemoryStore", e));
  const eventIds = events.map(() => randomUUID());
  // 1つの JSON 配列（jsonb）で渡し、`jsonb_to_recordset` で列へ開く。`meta` は群の大きさに比例して
  // 大きくなりうる（多者間の検出は全メンバーの id を載せる）ので、列ごとの `text[]` に JSON 文字列を
  // 詰めて `::jsonb` へキャストする形（二重のエスケープと二重の構文解析）は採らない。
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
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * 新規作成された Memory の `tags` から `proposed` ラベルを作り・件数を数え、
   * `memory_labels` で結び付ける。
   *
   * 🔴 **呼び出し元と同一トランザクションで実行すること。**`createMemory`/
   * `createMemoryWithOutbox`/`supersedeWithNewMemories` のいずれも、この呼び出しは
   * 「新しい Memory 行を実際に挿入した」ときだけ行う——冪等衝突で既存行を返した
   * ときは呼ばない（`tags` は作成時にしか書けない列であり、既存行に対してラベルを
   * 二重に数える理由が無い。`docs/memory-model.md` §8 にはこの区別についての明記は
   * 無いが、`createMemoryWithOutbox` が冪等衝突時に outbox ジョブを積まないのと
   * 同じ判断を踏襲する）。
   *
   * `tags` が空配列なら何もしない（ループが0回）。`tags` 内の重複は `Set` で1つに
   * 潰してから数える——1回の Memory 作成につき、同じラベルの `proposedCount` を
   * 1回だけ進める。`ON CONFLICT` は `status = 'proposed'` のときだけ
   * `proposed_count` を進める——`registered` に昇格済みのラベルは、`tags` に
   * 使われ続けても件数を増やさない（`listLabels?`/`registerLabel?` の doc コメント
   * 「`registered` 昇格後の意味」参照。`docs/memory-model.md` §8「strict モードが
   * 変えるのは検索側だけ」という決定と対称に、`registered` かどうかで書き込み側の
   * 挙動を変えるのはこの1点だけである）。
   */
  private async upsertProposedLabels(
    exec: SqlExecutor,
    ctx: Ctx,
    memoryId: MemoryId,
    tags: readonly string[],
  ): Promise<void> {
    // ADR 0476: `labels` の行ロックを取る順を、`tags` の並び（LLM が返した順）ではなく名前の順に固定する。
    // 並びのままだと、同じ語彙を逆の順で持つ2つの作成が互いの行を待って 40P01（deadlock detected）で落ちる。
    // 並べ替えるのはロックの順だけで、`Memory.tags` の並び・重複は変えない。
    const uniqueNames = Array.from(new Set(tags)).sort();
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
    // ADR 0505: NUL は DB の生の例外でなく、名指しの例外で断る（INSERT の前）。
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

    // externalId が null の場合は一意制約の対象外なので、ここに来るのは externalId が
    // 非 null で既存行と衝突したときだけである。
    const existing = await this.db.execute(sql`
      SELECT * FROM observations
      WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
      LIMIT 1
    `);
    return rowToObservation(existing.rows[0] as unknown as ObservationRow);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    assertWellFormedCtx(ctx);
    // id 列は uuid 型。UUID の形をしていない入力は「存在しない」と同じ扱いにする
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
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

  /**
   * transactional outbox（docs/architecture.md §3.4）: Observation の INSERT と outbox への
   * ジョブ書き込みを同一トランザクションで行う。`db.transaction()`（drizzle-orm が単一の
   * 接続上で `BEGIN`/`COMMIT` を発行する）を使う——`createObservation` と同じ
   * `ON CONFLICT ... DO NOTHING RETURNING *` の形を踏襲しつつ、新規作成が実際に起きた
   * ときだけ outbox 行を積む。
   */
  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date | undefined; claimedBy?: string | undefined },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertWellFormedIdentifier(input.externalId, "input.externalId");
    // ADR 0505: NUL は DB の生の例外でなく、名指しの例外で断る（INSERT の前）。
    assertNoNulInNewObservation("PostgresMemoryStore", input);
    const externalId = input.externalId ?? null;
    // Issue #1237: 省略時は1回だけ壁時計を読み、この呼び出しで積む outbox 行すべてに
    // 同じ値を使う（job ごとに違う `now()` を呼ばない）。
    const outboxNow = opts?.now ?? new Date();
    // ADR 0407: 渡されたら、積む行を「その名前で claim 済み」（`attempts: 1`）で作る。
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
   * 孤立サロゲート（Issue #816、実測）: `content`/`subjectId`/`tags`/`digest` 等に
   * 対をなさない UTF-16 サロゲートコードユニット（`\uD800` 単体など）を含む文字列を
   * 渡しても、この実装は例外を投げない——ただし読み返した値は入力と一致しない。
   * node-postgres（`pg`）ドライバが JS 文字列を UTF-8 バイト列へエンコードする際
   * （`Buffer.from(str, "utf8")`）、対をなさないサロゲートを静かに U+FFFD（置換文字）へ
   * 置換するため、クエリが Postgres へ届く前、クライアント側で既に値が変わる
   * （Postgres 自身の挙動ではない）。`packages/testkit`/`packages/core` の Fake は
   * 逆に入力をそのまま保持するため、ここで両者の値が食い違う——この非対称は現状の
   * 契約として `MemoryStore.createMemory` の interface doc コメントに記録してある
   * （`@mnemora/core`）。挙動は変えない。
   *
   * `status: "contested"` で `contestedWithId` が無い入力は、何も書かずに {@link ContestedWithoutCompanionError} を投げる。
   * ADR 0435: claim key が索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる（以前は生の drizzle の例外）。トランザクションごと戻り、何も残らない。
   */
  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(input.subjectId, "input.subjectId");
    assertNoNulInNewMemory("PostgresMemoryStore", input);
    // ADR 0140: DB へ1バイトも書く前に落とす（`supersededByIndex` の範囲検査と同じ位置）。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemory", null);
    }
    // 半減期が float4（`real` 列）に収まらない値は、DB の生の例外でなく明示の例外で断る（testkit と同じ判定）。
    assertNewMemoryHalfLivesFitFloat4("PostgresMemoryStore", input);
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;

    // Issue #201 / ADR 0318: 新しく作った Memory の `tags` から `proposed` ラベルを
    // 同一トランザクションで作るため、このメソッド自身がトランザクションを開く
    // ようになった（本 PR 以前は単発の INSERT 文、衝突時は単発の SELECT 文だった——
    // 返す値は変わらない。`inserted`/`existing`/`rowToMemory` の呼び方は1行も
    // 変えていない）。Issue #152/#153 / ADR 0312: `attributes` 列を INSERT に足した
    // （PR #724 の追加をそのまま引き継ぐ）。Issue #371: `claim_key_subject`/
    // `claim_key_predicate` 列を足した（PR #736 の追加をそのまま引き継ぐ）。
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
      // Issue #269: 統計が実態から遅れているときだけ ANALYZE memories を撃つ
      // (詳細は ./memories-statistics.ts のファイル doc)。新しい行を実際に書いた
      // ときだけ数える——上の ON CONFLICT で既存行を返しただけの呼び出しは数えない。
      // トランザクションの**外側**で呼ぶ——`createMemoryWithOutbox` と同じ理由
      // （ANALYZE が保持する ShareUpdateExclusiveLock を、上のトランザクションが
      // 保持する行ロックに無用に重ねないため）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result.memory;
  }

  /**
   * `createMemoryWithOutbox` の1件ぶんの書き込み（Memory の INSERT ... ON CONFLICT DO NOTHING、衝突時は既存行の
   * SELECT、新規なら proposed ラベルと outbox ジョブ）を、**呼び出し元のトランザクション `tx` の中で**行う。
   * `createMemoryWithOutbox` と `createMemoriesWithOutboxAndEvents`（ADR 0410）が共有する——書き写さない。
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
    // Issue #201 / ADR 0318: 同一トランザクションで proposed ラベルを作る
    // （冪等衝突〔上の `inserted.rows.length === 0`〕では呼ばない——`createMemory`
    // の doc コメントと同じ判断）。
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
   * transactional outbox（docs/architecture.md §3.4・memory-model.md §11 行3）: Memory の
   * INSERT と outbox への埋め込みジョブ書き込みを同一トランザクションで行う。抽出の
   * 冪等キーに衝突した場合（`created: false`）は埋め込みジョブを作らない——既に埋め込み済み
   * か、既に埋め込みジョブが積まれているはずの Memory に対して重複ジョブを積まない。
   *
   * `status: "contested"` で `contestedWithId` が無い入力は、何も書かずに {@link ContestedWithoutCompanionError} を投げる。
   * ADR 0435: claim key が索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる（以前は生の drizzle の例外）。トランザクションごと戻り、何も残らない。
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
    // ADR 0140: トランザクションを開く前に落とす（`createMemory` と同じ位置・同じ理由）。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemoryWithOutbox", null);
    }
    // Issue #1237: `createObservationWithOutbox` と同じ理由——省略時は1回だけ壁時計を読む。
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;

    const result = await this.db.transaction(async (tx) => {
      // Issue #1226 / ADR 0375 決定7: INSERT より前に見直す（`assertNotForgottenForUpdate`
      // の doc コメント参照）。`abortIfForgotten` が空・省略なら何もしない。
      await assertNotForgottenForUpdate(tx, ctx, abortIfForgotten, "createMemoryWithOutbox");
      // ADR 0420: forgotten の見直しに続けて superseded も見直す（同じ行ロックの下）。
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
      // Issue #269: `createMemory` と同じ理由で ANALYZE の要否を判定する。
      // トランザクションの**外側**で呼ぶ——`ANALYZE` はトランザクション内でも
      // 実行できるが、上のトランザクションが保持する行ロックと
      // `ShareUpdateExclusiveLock`（ADR 0143 決定3）を無用に重ねないため
      // （詳細は ./memories-statistics.ts のファイル doc）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  /**
   * [ADR 0410](../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)（穴 D-3）:
   * 抽出の全候補の Memory と `created` イベントを1つの `db.transaction()` で書く。
   *
   * - 候補ごとに **SAVEPOINT**（drizzle の入れ子の `tx.transaction`）を張り、保存できない候補
   *   （本文の NUL など）が投げたら、その候補の書き込みだけを `ROLLBACK TO SAVEPOINT` で巻き戻して
   *   `dropped` に積む。残りは書く。**SAVEPOINT が要る理由**: Postgres は文が失敗するとトランザクション全体が
   *   aborted になり、外側で握りつぶしても以後の文が全部落ちる。
   * - 全候補が落ちたら最初の例外を投げる（外側のトランザクションごと rollback。何も書かない）。
   * - ADR 0451: 本体が失敗したあとの `ROLLBACK TO SAVEPOINT` 自体が失敗したとき（接続切れ・キャンセルなど）は、続けず、`dropped` にも
   *   積まず、**本体の元のエラー**を投げる（外側ごと rollback）。巻き戻しの失敗は元のエラーの `cause`（空いていれば）か
   *   `rollbackError` に残す（ADR 0444 と同じ作法）。`RELEASE SAVEPOINT` の失敗も、候補を落とさずその失敗を投げる。
   *   巻き戻しが成功する悪い候補は、従来どおり `dropped` に積んで他を書く。
   * - 全候補の成否が確定したあと、書けた候補のうち `created: true` のものだけ、`buildCreatedEvent(memory, dropped)` の
   *   イベントを **同じトランザクションで** `memory_events` へ INSERT する（`EventStore.append` は経由しない——
   *   `supersedeWithNewMemories` と同じ形）。この INSERT が失敗したら、Memory も outbox も含めて全部巻き戻る。
   * - `status: "contested"` で `contestedWithId` が無い入力は、その候補だけ
   *   {@link ContestedWithoutCompanionError} で落とす（今の経路で候補ごとに `createMemoryWithOutbox` が投げて
   *   落とされていたのと同じ）。
   * - ADR 0416: `opts.abortIfForgotten` が非空なら、どの候補の書き込みより前に同じトランザクションで
   *   `SELECT … FOR UPDATE` し、forgotten が1件でもあれば {@link SourceMemoryForgottenError} を投げる
   *   （`dropped` に積まずそのまま投げる。何も書かない）。`reflect` がこの口を使う。
   * - ADR 0435: claim key が索引の上限（SQLSTATE 54000）で落ちた候補は、他の保存できない候補と同じく巻き戻して `dropped` に積む。
   *   `dropped[].error` は {@link ClaimKeyIndexLimitError}（以前は生の drizzle の例外）。ほかの候補は書く。全候補が落ちたときは
   *   最初の例外（これかもしれない）をそのまま投げ、何も書かない。この残り方は例外を型付きにする前と変えていない。
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
    // Issue #1237: 省略時は1回だけ壁時計を読み、積む outbox 行すべてに使う。
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;
    const result = await this.db.transaction(async (tx) => {
      // ADR 0416: どの候補の INSERT より前に見直す（`assertNotForgottenForUpdate` の doc コメント参照）。
      // 候補ごとの SAVEPOINT の外で呼ぶので、この例外は `dropped` に積まれずそのまま投げられる
      // （外側のトランザクションごと rollback。何も書かない）。
      await assertNotForgottenForUpdate(
        tx,
        ctx,
        abortIfForgotten,
        "createMemoriesWithOutboxAndEvents",
      );
      // ADR 0420: forgotten の見直しに続けて superseded も見直す。
      await assertNotSupersededForUpdate(
        tx,
        ctx,
        opts?.abortIfSuperseded,
        "createMemoriesWithOutboxAndEvents",
      );
      const written: Array<{
        index: number;
        memory: Memory;
        created: boolean;
        jobs: OutboxJobRecord[];
      }> = [];
      const dropped: Array<{ index: number; error: unknown }> = [];
      for (const [index, { input, jobKinds }] of news.entries()) {
        // ADR 0451: drizzle の入れ子の `transaction` は、本体が投げたあとの `rollback to savepoint` が
        // 失敗すると、元のエラーを捨ててその失敗を投げる（`release savepoint` の失敗も同じ形）。
        // 本体が投げたエラーを控えておき、外へ出てきたものと見比べて「巻き戻しそのものが失敗した」を見分ける。
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
            // 本体は成功したのに投げられた: `release savepoint`（または、その後の `rollback to savepoint`）の失敗。
            // この savepoint の中の書き込みが残るか戻るか分からないので、候補を落とさずに投げる。
            throw error;
          }
          if (error !== bodyError.error) {
            // 本体の失敗のあと、`rollback to savepoint` 自体が失敗した（接続切れ・キャンセルなど）。
            // トランザクションの状態が分からないので、続けず、`dropped` にも積まず、元のエラーを投げる。
            // 失敗は `cause`（空いていれば）か `rollbackError` に残す（ADR 0444 と同じ作法。新しい型は作らない）。
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
      // `createMemoryWithOutbox` と同じ理由・同じ位置（トランザクションの外側）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    assertWellFormedCtx(ctx);
    // id 列は uuid 型。この口の契約は「無い == null」なので、形式が壊れた入力も
    // クエリを投げる前に同じ null へ寄せる（mapping.ts の isUuidLike の doc参照）。
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
    // この口の契約は「無い id は静かに落とす」（D9）。形式が壊れた id も同じ扱いにする
    // ため、クエリを投げる前に取り除く——呼び出し全体を弾かない
    // （mapping.ts の isUuidLike の doc参照）。
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
   * ADR 0028: `reextract` が「今回作られた content_hash の集合に含まれない既存 Memory」を
   * 判定するための列挙。**SELECT のみ**——索引は 0001_init.sql の一意索引
   * `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)`
   * が `(tenant_id, source_observation_id, extractor_version)` の前方一致で使える。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // source_observation_id 列は uuid 型。この口の契約は「無い == []」なので、
    // 形式が壊れた observationId もクエリを投げる前に空配列へ寄せる
    // （mapping.ts の isUuidLike の doc参照）。
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
   * ADR 0380: `reextract` が「版を跨いで退けた記憶」を判定するための列挙。**SELECT のみ**
   * ——`uq_memories_extraction (tenant_id, source_observation_id, extractor_version,
   * content_hash)` が `(tenant_id, source_observation_id)` の前方一致でも Index Scan に使える
   * （ADR 0380 の EXPLAIN 実測）。`extractor_version`・`status` のどちらでも絞らない。
   */
  async listBySourceObservationAllVersions(
    ctx: Ctx,
    observationId: ObservationId,
  ): Promise<Memory[]> {
    assertWellFormedCtx(ctx);
    // source_observation_id 列は uuid 型。この口の契約は「無い == []」なので、
    // 形式が壊れた observationId もクエリを投げる前に空配列へ寄せる
    // （mapping.ts の isUuidLike の doc参照）。
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
   * ADR 0030（安全弁3）: `opts.expectedStatus` を渡すと `AND status = ${expectedStatus}` を
   * 足した条件付き UPDATE になる（compare-and-swap）。**`expectedStatus` が無いときは
   * 今日と一字も変えない**——このメソッドの大半の呼び出し元（`archived`/`forgotten` への
   * 遷移等）は無条件更新のままでよい。
   *
   * 条件付き UPDATE が0行だった場合、それが「対象の id がそもそも無い」のか
   * 「id はあるが status が期待と違う」のかを、追加の `SELECT` で読み直して区別する
   * ——前者は今日と同じ「memory not found」の `Error`、後者は
   * {@link MemoryStatusConflictError}。**この読み直しは弾かれた後に行うため、
   * `observedStatus` は弾かれた瞬間の値ではない**（`MemoryStatusConflictError` の
   * doc コメント参照）。
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
    // ADR 0140: この口には contestedWithId を渡す引数が無いため、status: 'contested' への
    // 書き込みは常に単独になる。UPDATE を投げる前に落とす。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    // ADR 0503: `superseded` は置き換えた側を伴い、自分自身ではない（書く前・対象の存在確認より前に断る）。
    assertSupersededByShape("updateStatus", "opts", id, status, opts?.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる——ドライバの
    // invalid input syntax for type uuid を呼び出し側に漏らさない
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    // ADR 0439: `supersededById` は `ctx` のテナントの記憶を指すこと。形が壊れていれば DB へ投げる前に弾く。
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

    // 0行だった理由を切り分けるための読み直し（上記 doc コメント参照）。
    throw await explainEmptyStatusUpdate(this.db, ctx, id, supersededById, expectedStatus);
  }

  /**
   * ADR 0031: `updateStatus` の UPDATE と `EventStore.append`（`packages/postgres/src/
   * event-store.ts`）の INSERT を**同一トランザクション**で行う。この2つが別コミット
   * だったこと自体が直された不具合——前者だけ成功し後者が失敗すると、行は永久に
   * 新しい status のまま、対応するイベントは永久に存在しないという永続化された
   * 不整合が残っていた（PR「supersede-status-and-event-in-one-transaction」）。
   *
   * `db.transaction()` のコールバック内で throw すると自動的にロールバックされる
   * （`createObservationWithOutbox`/`createMemoryWithOutbox` と同じ形——ADR 0012
   * D-ingest-1）。CAS に弾かれた場合・対象が存在しない場合は、UPDATE が0行のまま
   * この関数を抜けて例外を投げるだけなので、`memory_events` への INSERT は実行されない
   * ——ロールバックを待つまでもなく、そもそも書き込みコマンド自体を発行しない。
   *
   * 投げるもの: `"contested"` への遷移は {@link ContestedWithoutCompanionError}、CAS に弾かれたら
   * {@link MemoryStatusConflictError}（どちらも status もイベントも書かない）。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // ADR 0140: updateStatus と同じ理由（contestedWithId を渡す引数が無い）。
    // トランザクションを開く前に落とす。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    // ADR 0503: updateStatus と同じ。
    assertSupersededByShape("updateStatusWithEvent", "opts", id, status, opts.supersededById, {
      forbidWhenNotSuperseded: true,
    });
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力は
    // トランザクションを開く前に同じ「memory not found」の Error へ寄せる——
    // トランザクション内で投げても結果（イベントが積まれない）は同じだが、そもそも
    // 開かないほうが意図が明確（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    // ADR 0439: `updateStatus` と同じ（`supersededById` は `ctx` のテナントの記憶を指すこと）。
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
        // 0行だった理由を切り分けるための読み直し（`updateStatus` の doc コメント参照）。
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
   * Issue #134 / ADR 0100: `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の
   * supersede、複数可）を1つの `db.transaction()` にまとめる——docs/memory-model.md §11 行5
   * 「旧行の status 更新と新 Memory の作成を1トランザクションで完結させる」を満たす。
   *
   * 中身は `createMemoryWithOutbox`（INSERT ... ON CONFLICT ... DO NOTHING / outbox INSERT）と
   * `updateStatusWithEvent`（条件付き UPDATE + `memory_events` INSERT）と同じ形——**この2つの
   * 既存メソッドは変更していない**。`news` を先に処理し、`supersede` を後に処理する
   * （書く順序で被害を最小にする。ADR 0089 決定5 と同じ理由——途中で落ちても、統合先が
   * 無いのに旧行だけ `superseded_by_id` が指す先を失う、という最悪の状態を避ける）。
   *
   * `supersede[].id` が存在しなければトランザクション内で throw し、`news` の INSERT も
   * 含めてロールバックされる。`supersededById` は `memories.superseded_by_id` の実 FK
   * （`0001_init.sql`）がそのまま検査する——`news` の INSERT は同一トランザクション内で
   * 先に実行されているため、`supersededById` が同じ呼び出しの `news` を指していても
   * FK 違反にはならない（Postgres は同一トランザクション内の自分の書き込みを見る）。
   * CAS に弾かれた場合（0行 UPDATE、かつ対象は存在する）は `conflicted` に積んで
   * トランザクションはそのまま commit する——ここで throw しない。
   *
   * ⚠ 新しい行に `status: "contested"` で `contestedWithId` が無いものがあれば、何も書かずに
   * {@link ContestedWithoutCompanionError} を投げる（これは CAS の弾きとは別で、例外になる）。
   *
   * ADR 0416（穴 D-3 の続き）: `opts.buildCreatedEvent` が渡されたら、`created: true` の `news` の Memory ごとに
   * `created` イベントを**同じトランザクションで** `memory_events` へ INSERT し（`supersede` の処理の前）、
   * 戻り値に `createdEventsWritten: true` を付けて名乗る。INSERT が失敗したら `news`・`supersede` ごと全部巻き戻る。
   *
   * ADR 0435: `news` の claim key が claim key の索引の上限（SQLSTATE 54000）で落ちたら {@link ClaimKeyIndexLimitError} を投げる。
   * トランザクションごと戻る——`news` も `supersede` も何も残らず、`supersede` の対象だった旧い行は `active` のまま残る。
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
    // Issue #1237: 省略時は1回だけ壁時計を読み、news に積む outbox 行すべてに使う。
    const outboxNow = opts?.now ?? new Date();
    const abortIfForgotten = opts?.abortIfForgotten;
    const buildCreatedEvent = opts?.buildCreatedEvent;
    // 呼び手が壊れた索引を渡した場合は、トランザクションを開く前に落とす（ADR 0100）。
    // ⛔ `conflicted` にも「memory not found」にも混ぜない——3つとも別の失敗である。
    // 開く前に落とすので、`news` の作成も当然起きない。
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
    // ADR 0140: createMemory と同じ制約を `news` の各要素にも課す。1件でも違反があれば
    // トランザクションを開く前に落とす（`news`/`supersede` どちらの書き込みも起きない）。
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
      assertNewMemoryHalfLivesFitFloat4("PostgresMemoryStore", input);
      // 穴 O-6-3（ADR 0424）: contentHash の NUL も、トランザクションを開く前に落とす。
      assertNoNulInNewMemory("PostgresMemoryStore", input);
    }

    const result = await this.db.transaction(async (tx) => {
      // Issue #1226 / ADR 0375 決定7: `news`/`supersede` どちらの書き込みより前に見直す
      // （`assertNotForgottenForUpdate` の doc コメント参照）。`abortIfForgotten` が
      // 空・省略なら何もしない——既存の `conflicted`（CAS に弾かれた対象だけ飛ばして
      // 他は commit する部分成功）はこの見直しの対象外のまま、今日どおり働く。
      await assertNotForgottenForUpdate(tx, ctx, abortIfForgotten, "supersedeWithNewMemories");
      // ADR 0420: forgotten の見直しに続けて superseded も見直す（同じ行ロックの下）。
      await assertNotSupersededForUpdate(
        tx,
        ctx,
        opts?.abortIfSuperseded,
        "supersedeWithNewMemories",
      );
      const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];

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
        // Issue #201 / ADR 0318: `news` の各要素について、同一トランザクションで
        // proposed ラベルを作る（`createMemory`/`createMemoryWithOutbox` と同じ判断
        // ——冪等衝突〔上の `inserted.rows.length === 0`〕では呼ばない）。
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

      // ADR 0416（穴 D-3 の続き）: `created: true` の新しい Memory の `created` イベントを、同じトランザクションで積む
      // （`supersede` の処理の前。fixture と同じ順）。投げたら `news` も `supersede` も含めて全部巻き戻る。
      // `buildCreatedEvent` が無ければ何もしない。
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

      // ADR 0420: `supersede` の対象がすべて CAS に弾かれたら、`news`・`created` イベントごと巻き戻す
      // （tx の中で投げる）。1件でも通ったなら今までどおりの部分成功。
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
      // Issue #269（2026-09-17 コメント）: `createMemory` / `createMemoryWithOutbox` と
      // 同じ理由で ANALYZE の要否を判定する。`news` は複数件渡せるため、`created` 配列の
      // どれか1件でも実際に新しい行を書いていれば呼ぶ——`ON CONFLICT` で既存行を
      // 返しただけの要素（`created: false`）だけの呼び出しでは数えない
      // （`createMemory` の doc コメントと同じ判定。詳細は ./memories-statistics.ts の
      // ファイル doc）。
      //
      // トランザクションの**外側**で呼ぶ——`createMemoryWithOutbox` と同じ理由
      // （上のコメント参照）: `ANALYZE` はトランザクション内でも実行できるが、
      // 上のトランザクションが保持する行ロックと `ShareUpdateExclusiveLock`
      // （ADR 0143 決定3）を無用に重ねないため。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    // ADR 0416: 積んだことを名乗る（渡していない呼び出しでは付けない）。
    return buildCreatedEvent === undefined ? result : { ...result, createdEventsWritten: true };
  }

  /**
   * Issue #210 / ADR 0115: `memory_events` から期限切れ行を消す本体。`purgeExpiredEvents`
   * （`this.db` を渡し、自前でトランザクションの要否を決める）と
   * `purgeExpiredEventsByRetention`（Issue #1232、ADR 0354。保持期間を読む `tx` をそのまま渡し、
   * 同じトランザクションの中で削除まで行う）が共有する——**書き写さない**。
   *
   * 🔴 **`PostgresEventStore` を一切呼ばない。**`memory_events` へ直接 SQL を発行する
   * ——`updateStatusWithEvent`/`supersedeWithNewMemories` が append を `PostgresEventStore`
   * 経由にせず直接 INSERT しているのと同じ形（`EventStore` interface はこの経路を
   * 経由しない、という `docs/memory-model.md` §9・§11 の要求を型だけでなく実装でも守る）。
   *
   * 対象の選定は {@link buildPurgeExpiredEventsTargetSelect} に切り出してある——
   * `packages/postgres/src/__tests__/memory-events-retention-index.test.ts` の `EXPLAIN`
   * がこの関数の返り値をそのまま測る（`buildRequeueEmbedTargetSelect` と同じ理由）。
   */
  private async purgeExpiredEventsBody(
    exec: SqlExecutor,
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    const dryRun = opts.dryRun ?? false;
    // cutoff が timestamptz の下限（4714-11-24 BC）より前なら、それより古い行は存在しえない。
    // 問い合わせると `timestamp out of range` で落ちるので、0件の削除として返す
    // （保持日数が約247万日を超えると `computeEventRetentionCutoff` がこの cutoff を作る）。
    if (opts.olderThan.getTime() < PG_TIMESTAMPTZ_MIN_MS) {
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
    // 対象の SELECT は行を掴まないので、同時に走った掃除は同じ行を選ぶ。先に消した側が
    // commit した後、こちらの DELETE はその行を消さない——名乗る件数・期間は、選んだ行では
    // なく実際に消した行（RETURNING）から取る（`purged` は「実際に削除された行数」）。
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

    // ADR 0427: `at` は SQL の `now()`（マイクロ秒）ではなく、他の書き込みの口と同じく JS の
    // 壁時計を `toPgTimestamp` で渡す——読み戻すとミリ秒になる値のまま列に入れないと、
    // 読み戻した `at` を `EventStore.list` の `until` に渡したときにその行自身が当たらない。
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
   * Issue #210 / ADR 0115: `memory_events` から期限切れ行を消す保守ジョブ本体（本体は
   * {@link PostgresMemoryStore.purgeExpiredEventsBody} を共有する）。
   *
   * `dryRun` のときは対象を数えるだけで `db.transaction` を開かない——削除も INSERT も
   * 実行しないので、トランザクションで包む対象が無い。
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
   * Issue #1232 / [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * `MemoryStore.purgeExpiredEventsByRetention?`（`@mnemora/core`）の Postgres 実装。保持期間の
   * 読みと削除を1つのトランザクションにする——`tenant_settings.event_retention_days` を
   * `SELECT ... FOR SHARE` で読み（`setEventRetention` の `UPDATE`/`INSERT` と行ロックで
   * 競合する。歯は `purge-expired-events-by-retention-concurrency.postgres.test.ts`）、
   * `days` のときだけ {@link PostgresMemoryStore.purgeExpiredEventsBody} を**同じトランザクションの
   * 中で**呼ぶ。`dryRun` のときも `FOR SHARE` の読みは同じトランザクションで行う——
   * `purgeExpiredEvents`（上）と違い、ここではトランザクションを省略しない。
   *
   * `TenantSettingsStore` を経由しない——別 adapter を呼ぶとその呼び出し自体がこの
   * トランザクションの外に出てしまう（`MemoryStore.purgeExpiredEventsByRetention` の
   * interface doc「契約」参照）。
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
   * [ADR 0404](../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `MemoryStore.purgeExpiredRecalls?` の実装。対象の `recalls` を先に確定し（古い順に
   * `limit + 1` 件、`FOR UPDATE` で行を掴む）、**同じトランザクションで**その子の
   * `recall_usages` → `recalls` の順に消す（`recall_usages.recall_id` は `ON DELETE` 無しの
   * 外部キー）。`limit` は recalls の行数で数える。掴んだ行に並行の `recordUsage`（外部キー検査が
   * 行ロックを取る）が割り込むと、そちらが待たされ、こちらの commit 後に外部キー違反になる。
   *
   * `dryRun` のときはトランザクションを開かず、行も掴まない。
   */
  async purgeExpiredRecalls(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun ?? false;
    if (opts.olderThan.getTime() < PG_TIMESTAMPTZ_MIN_MS) {
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

    // 子（recall_usages）が先。親の recalls は、その後に消す。
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
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // 🔴 `ready` を `failed` へ巻き戻さない（ADR 0053）。`ready` は VectorStore.upsert が
    // 返った*後*にしか書かれない＝「ベクトル行が在る」の主張であり、リースを失った古い
    // ワーカーの catch から来る `failed`（ADR 0032 の at-least-once）に負けてはならない。
    //
    // 書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよい。
    // WHERE に入れなければならないのは *読んだ状態* のほう（現在の embedding_status）だけ
    // ——アプリ側で現在値を読んで比べてから書くと、読みと書きの間に入った別の書き込みを
    // 上書きしうる（ADR 0048 の reinforce と同じ形。updateStatus の compare-and-swap
    // （ADR 0030）と同じ条件片の組み立て方をここでも使う）。
    //
    // ⚠ **共有述語 `isEmbeddingStatusRollback` はここでは呼べない。**比較そのものを DB の
    // 1文へ入れる必要があるため、値（`from`/`to`）だけを EMBEDDING_STATUS_ROLLBACK から
    // 取り、比較の形は SQL 側にもう一度書かれる（ADR 0053「引き受けた負債」）。
    const rollbackGuard =
      status === EMBEDDING_STATUS_ROLLBACK.to
        ? sql` AND embedding_status <> ${EMBEDDING_STATUS_ROLLBACK.from}`
        : sql``;

    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**1文なら、更新できた場合も
    // できなかった場合も同じスナップショットを通る（`reinforce`（ADR 0048）と同じ形）。
    //
    // 🔴 **⚠ 「1文であること」自体は歯で守られている**（Issue #766・ADR 0053 追記）。
    // `packages/postgres/src/__tests__/set-embedding-status-single-statement.postgres.test.ts`
    // が DB へ送られる文の数を数え、巻き戻しが弾かれる経路（`ready` の行へ `failed` を
    // 書こうとして0行更新→読み戻し）で1文であることを断言する。**実測: この1文を
    // 「`UPDATE ... RETURNING *` → 0 行なら別の `SELECT`」の2文へ割る変異（ADR 0053 の
    // Mu5a）は、この歯を追加する前は `test:db` 182 件のどれも赤くしなかったが、
    // 追加後は上記の歯1本が赤くなる**——Mu5a は今日は死ぬ。
    //
    // ⚠ ただし**その歯が断言しているのは「1文である」という形だけ**であり、下で
    // 実測したとおり「並行時にどちらのスナップショットを返すべきか」は断言していない
    // ——その判断はまだされていない（すぐ下）。
    //
    // ⚠ `reinforce` から借りた理由づけ（「上で読んだ古い値をそのまま返す」実装との差が
    // 外から観測できなくなる）は、**そのままでは当たらない**——`reinforce` は本体の手前で
    // `SELECT` を打つが、**`setEmbeddingStatus` には手前の `SELECT` が無い**（存在検査は
    // `isUuidLike` だけ）ので、その取り違えは今日のコードからは書けない。
    //
    // 実測した限りでは、並行時にどちらのスナップショットを返すかという判断そのものは
    // 今の口では置けない: 1文と2文の差は**並行時にだけ**出る（2文のあいだに他の接続の
    // コミットが landing すると、2文の側は新しいスナップショットの行を返す——実測した）が、
    // **ガードで弾かれる `UPDATE` は行ロックを取らない**（これも実測した。他の接続が
    // 未コミットで同じ行のロックを保持していても 0 行で即座に返る）ので、外からこの実装を
    // その窓で止める手段が無く、窓は sub-millisecond である。
    // ⟹ **その判断を塞ぐには、この実装の中に待ちを差し込める口が要る。**ADR 0053
    // 「引き受けた負債」・2026-09-25 追記。
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

  /**
   * ADR 0394: `ReinforceOptions.addOwnSubjectSeq` を読める（`reinforce`/`reinforceMany`/
   * `recordUsageAndReinforce` が、行ごとに Memory 自身の subject の `S_x` を UPDATE の中で足す）。
   */
  supportsAddOwnSubjectSeq(): boolean {
    return true;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    assertWellFormedCtx(ctx);
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
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

    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
    // `opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときに限り、
    // 活動時計側の起点・床（decay_base_seq/decay_floor_seq）も同じ強化イベントとして
    // 進める。`halfLifeRecalls` が無い（'wall' のテナントで作られた、あるいは
    // 活動時計を一度も使っていない）Memory はそもそも活動時計では沈まないので、
    // ここで列を作らない（`ReinforceOptions.nowSeq` の doc コメント参照）。
    //
    // ⚠ **壁時計側の SET 句・WHERE 句は1バイトも変えない**——この条件片は同じ SET の
    // 末尾に追記するだけであり、`opts.nowSeq` が無い呼び出し（既存の全呼び出し）では
    // 空文字列になって従来の SQL とバイト単位で同じ文になる。
    //
    // [ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md):
    // `opts.addOwnSubjectSeq === true` のときは、`opts.nowSeq`（= `T`）にこの行自身の subject の
    // `S_x`（読む側と同じ相関サブクエリ）を UPDATE の中で足して起点にする。
    // 床は `起点 + ceil(offset)`（`defaultActivityDecayStrategy.floorAt` と同じ式。`baseSeq: 0` で
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

    // 🔴 減衰の起点を巻き戻さない（ADR 0048）。**この条件は WHERE 句に置く**——
    // 上の SELECT で読んだ値をアプリ側で比べて書くかどうか決めると、読みと書きの間に
    // 入った別の強化を上書きしうる（同じ形を `updateStatus` は ADR 0030 の
    // compare-and-swap で塞いでいる）。ここは比較そのものを DB の1文へ入れる。
    //
    // ⚠ 古い `at` は**失敗にしない。**呼び出し側から見れば「すでにもっと新しい強化が
    // 入っている」だけであり、例外にすると `runtime.observe` の使用報告ループが
    // 途中で止まる（`updateStatus` の CAS とはここが違う——あちらは status の
    // 取り違えなので呼び出し側の次の一手が変わる）。
    //
    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、
    // 「上で読んだ古い値をそのまま返す」実装との差が**外から観測できない枝**になる
    // （実際に変異を撃って確かめた。PR 本文参照）。1文なら、更新できた場合も
    // できなかった場合も同じ経路を通るので、その取り違えは歯で捕まる。
    //
    // ⚠ 活動時計側の3列も、壁時計側と**同じ WHERE 句**（同じ `at` の比較）で守る——
    // 両方とも「同じ強化イベント」の一部であり（ADR 0165 文脈節「起点は両方の時計で
    // 同じく『最後の書き込み』に置く」）、片方だけ別の条件で進むと2軸の起点がずれる。
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
   * [Issue #874](https://github.com/takecchi/mnemora/issues/874) / ADR 0303 追記節:
   * `reinforce` を `ids` の各要素について呼んだのと同じ結果になる一括版（契約は
   * `MemoryStore.reinforceMany` の doc コメント参照）。`reinforce` が呼び出し1回に
   * つき2往復（現在値の SELECT → CAS 付き UPDATE）だったのに対し、この口は
   * `ids` の件数によらず**定数2往復**——
   * 1. **SELECT**: 単調性・活動時計の判定に使う不変の列（`recorded_at`/`strength`/
   *    `half_life_hours`/`half_life_recalls`——いずれも `reinforce` 自身も書き換えない
   *    列）を、対象 id 全件ぶん1回でまとめて読む。
   * 2. **UPDATE**: 行ごとに計算した `decay_floor_at`/活動時計側の値を
   *    `VALUES (...)` で持ち込み、`WHERE ... AND COALESCE(last_reinforced_at, recorded_at)
   *    < at` という**同じ CAS 条件**で1回の文にまとめて書く。
   *    更新できなかった行（no-op）は、同じ文の中で現在値を読み直して返す
   *    ——`reinforce` の `UNION ALL` と同じ理由（読みと書きの間に別の強化が
   *    割り込んでも、その行の返り値は常にその時点の実際の値になる）。
   *
   * ⚠ **単調性の比較そのもの（`last_reinforced_at` と `at`）は、1件ずつのときと
   * 同じく UPDATE の WHERE 句の中で行う**——上のSELECTで読んだ値を比較には使わない
   * （使うのは `decayFloorAt`/活動時計側の値を計算するための不変の入力だけ）。
   *
   * `ids` に重複がある場合は1回だけ処理する（`Set` で去重）——`reinforce` を同じ
   * `id`・同じ `at` で複数回呼んでも2回目以降が no-op になり最終状態が変わらないのと
   * 同じ理由。戻り値は元の `ids`（重複・順序とも）に合わせて組み直す。
   *
   * 入口で uuid の形の id を小文字にそろえてから（`normalizeUuidCase`）去重・突き合わせる。DB は uuid を
   * 大文字小文字を区別せずに比べて小文字で返すので、`reinforce` は大文字の id でも同じ行を書く。渡された id の
   * まま突き合わせると、大文字の id だけで「memory not found」になり `reinforce` と結果が割れていた
   * （`uppercase-uuid-lookup.postgres.test.ts`）。同じ記憶を小文字と大文字で渡したときも1回だけ処理する。
   *
   * `ids` に存在しない・adapter の期待する形式でない id が含まれる場合:
   * **書ける対象（存在する well-formed な id）へは書き込みを済ませてから**、
   * `reinforce` と同じ「memory not found」の `Error` を投げる。⚠ **これは1件ずつの
   * ループと厳密には一致しない**——ループは `ids` の先頭から順に呼び、最初に
   * 見つからない id で例外を投げて**それ以降の id には一切触れない**のに対し、
   * この一括版は「見つからない id が1件でもあるかどうか」と「見つかった id への
   * 書き込み」を切り離しており、見つからない id が配列のどの位置にあっても、
   * 見つかった id はすべて書き込む。**interface 側の doc コメント（`reinforceMany`）
   * が明記するとおり、この分岐は runtime の唯一の呼び出し元（`handleMemoryUsage`）
   * では実際には起こらない**——`recall_usages.memory_id` が `memories(id)` への
   * 外部キーを持つため、`recordUsage` が返す `insertedMemoryIds` は常に実在する行を
   * 指す（挿入が成功した時点で参照先が存在した証拠）。1件ずつのループとの
   * 「どこまで書いてから投げるか」の違いを厳密に揃えるには、見つからない id の
   * 手前で処理を打ち切る必要があり、それは「定数回の往復で束ねる」という
   * この口の目的そのものと衝突する——**到達しないと確かめた分岐のために往復を
   * 増やすのは筋が違うと判断し、揃えなかった。**
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

    // 入口の正規化（上の doc）。形の合わない id はそのまま——どの行とも一致しない。
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

    // `ids` の元の順で最初に見つからない id（`reinforce` 単体を呼んだときに
    // 「memory not found」になる id）。上のコメントのとおり、書き込みは
    // これとは独立に「見つかった id 全部」へ行う。
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
      // ADR 0165 決めたこと16: 行ごとに判定する——`halfLifeRecalls` を持つ行だけ
      // 活動時計側の列に触れる（`PostgresMemoryStore.reinforce` と同じ分岐）。
      const hasActivity = opts?.nowSeq !== undefined && memory.halfLifeRecalls != null;
      // ADR 0394: `addOwnSubjectSeq` のときは、入力の列に「起点」ではなく `T`（`activityBaseSeq`）と
      // 床までの相対（offset。`baseSeq: 0` の `floorAt`）を持ち込み、起点と床は UPDATE の中で
      // その行自身の subject の `S_x` を足して作る。そうでなければ従来どおり起点と床を持ち込む。
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

    // ADR 0443: 行ごとに 5 個のバインドパラメータを `VALUES` に並べると、13107 件目で PG の上限（65535）を超える。
    // 列ごとの配列 5 個（`unnest`）で渡し、件数によらずパラメータを 5 個に固定する。
    const inputIds = sql.param(rows.map((r) => r.id));
    const inputDecayFloorAts = sql.param(rows.map((r) => toPgTimestamp(r.decayFloorAt)));
    const inputHasActivities = sql.param(rows.map((r) => r.hasActivity));
    const inputActivityBaseSeqs = sql.param(rows.map((r) => r.activityBaseSeq));
    const inputActivityFloorSeqs = sql.param(rows.map((r) => r.activityFloorSeq));

    // ADR 0394: `addOwnSubjectSeq` のときだけ、起点・床を行ごとに UPDATE の中で組む
    // （`input.activity_base_seq` は `T`、`input.activity_floor_seq` は床までの相対 offset）。
    // そうでなければ従来の文のまま（`tenant_subject_activity` を参照しない）。
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
   * Issue #961: `recordUsage` と、それが返した `insertedMemoryIds` への強化
   * （`reinforceMany` と同じ SQL）を1トランザクションで撃つ。強化の UPDATE が失敗すれば
   * `recall_usages` の INSERT も巻き戻るので、同じ使用報告の再送がそのまま両方をやり直す
   * （interface の doc コメント参照）。
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
    // ADR 0439: recall も memory も `ctx` のテナントの行であること。DB へ投げる前に、形の壊れた id を同じ message で弾く。
    const checkedRecallId = checkedRef("recall", recallId)!;
    const ids = memoryIds.map((id) => checkedRef("memory", id)!);
    // 確かめと書き込みを1つの SQL 文にする。外部キーは `recalls(id)`・`memories(id)` だけでテナントを含まないので、
    // 検査が無いと別テナントの recall・memory を指す行が `ctx` の行として書け、その行が相手のテナントの
    // `purgeExpiredRecalls`（外部キー違反）と `eraseTenant` を止めた。どれか1件でも違えば、全体を書かない。
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
   * roadmap.md 段階4/5・docs/recall.md §5「スコープの外延」（マネージャー決定、
   * packages/core の recall.ts の `ScopeAggregate` doc コメント参照）。
   *
   * **単一の集約クエリ**で、群カウント（第3階）・スコープ内総数・スコープを定義する
   * フィルタ（status/period）で落ちた件数・not_indexed 件数のすべてを返す。
   * ADR 0011 が段1から締め出した `count(*) OVER ()` と同じ理由——**別々のクエリから
   * 出すと、その間の書き込みで総和が一致しなくなる**——を、段5でも同じ形で守る。
   *
   * **本 PR（ADR 0073 決定7）で目次帯（`digests`/`digestEligible`）を同じクエリに
   * 相乗りさせた。** `opts.digestBand` を渡すと、同じ SQL 文の中に追加のスカラー
   * サブクエリを足し、全体を1つの SQL 文・1回の往復で返す
   * （`packages/postgres/src/__tests__/recall.postgres.test.ts` の
   * 「aggregateScope は単一の SQL 往復で完結する」がこれを構造的に検査している）。
   * 別クエリにすると群カウントと帯が別スナップショットになり、並行する書き込みの下で
   * 被覆不変条件が構造的に崩れる。
   *
   * **⭐ Issue #329 / [ADR 0173](../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md)
   * で忘却ゲートの件数（`decayed_filtered`）を同じ CTE に相乗りさせた。**
   * **別クエリで数えない。** 別クエリにすると (a) 往復が増え、(b) 別スナップショットに
   * なって `totalInScope` と食い違いうる。ここは `digestBand` を相乗りさせたのと
   * 同じ判断である。
   *
   * `status` の4分岐（scope 内 / archived / superseded / forgotten）と period の内外は、
   * すべて `FILTER (WHERE ...)` による条件付き集約として1回のスキャンで計算する。
   * **superseded と forgotten は別々の列として数える**（ADR 0027）——前者は
   * 機構の都合（より良い抽出への置き換え、または統合）、後者は製品の振る舞い（利用者が意図して
   * 忘れさせた）であり、束ねると呼び出し側がどちらだったか判定できない。
   *
   * ## 単一パス書き換え（Issue #355、[ADR 0307](../../../docs/decisions/0307-aggregate-scope-single-pass.md)）
   *
   * **旧実装は `WITH scoped AS (SELECT ... FROM memories WHERE tenant_id = $1 ...)` を
   * 3回参照していた**（本体の `count(*) FILTER` 群・`groups` の `GROUP BY` サブクエリ・
   * `digestBand` のサブクエリ）。3回参照される CTE は Postgres が実体化し（1回だけ実行して
   * tuplestore に積み、以後はそこから読む）、しかも `scoped` の projection には `digest`
   * （テキスト列）が含まれていたため、テナント全件（100k 行）の digest 本文ごと
   * tuplestore に積まれ、`work_mem` を超えてディスクへ溢れていた（【実測】
   * 100k 行で `temp read=2736 written=1368`、ADR 0307「測ったこと」）。
   * 加えて `groups` は独立した `Sort` + `GroupAggregate` で `scoped` を再スキャンしており、
   * `${'${x}'}::timestamptz IS NULL OR ...` 形の述語（`inPeriod`/`isValid` 等）を
   * `count(*) FILTER` の本数（最大10本強）だけ重複して評価していた。
   *
   * **新実装は各行の述語（`live`/`in_period`/`is_valid`/`is_expired`/`is_not_yet_valid`/
   * `is_decayed`）を `flags` CTE（`scoped` の素の射影の上に載る層）で1回だけ boolean として計算し、`GROUP BY subject_id`
   * で subject ごとの各カウンタ（`in_scope`・`not_indexed_*`・`archived`・`superseded`・
   * `forgotten`・`period_filtered`・`expired_filtered`・`not_yet_valid_filtered`・
   * `decayed_filtered`）を1パスで出す（`agg` CTE）。**
   *
   * `scoped` は `flags` から、`flags` は `agg` から、`agg` は外側の集約から各1回だけ参照されるので、
   * Postgres は既定でどちらも実体化せずインライン化する（PG12+ の「1回しか参照されない
   * 非再帰 CTE は自動的にインライン化される」という規則。`MATERIALIZED` を明示していない
   * ——実際に試したが採らなかった。理由は「単一パス書き換え」の実装コメント、ADR
   * 0307「採らなかった案」参照。要点だけ書くと、`scoped` を `MATERIALIZED`
   * すると、digest を持たない狭い行でも 100k 行では `work_mem`（既定 4MB。GUC は
   * アプリの既定を変えるので変えない）を超えてディスクへ溢れ、インライン化のまま
   * 述語を複数回再評価するより**遅くなった**（【実測】237ms 台 vs 254ms 台）。
   * 述語自体は単純な比較演算であり、行数分の重複評価より、たとえ狭くてもディスクへの
   * 実体化のほうが高くつく）。外側では `groups`（`in_scope > 0` の
   * subject のみ、`json_agg(...) FILTER (WHERE in_scope > 0)`）と各合計
   * （`coalesce(sum(...), 0)`——空テナントで `agg` が0行になっても `NULL` ではなく現物と
   * 同じ `0` を返す）を1回の `Aggregate` ノードで取る。
   *
   * **`digestBand` は `scoped`/`agg` を経由せず、`memories` を直接（同じ `tenant_id`/
   * `subjectFilter` の WHERE で）引くサブクエリにした。** `digests`（top-N の
   * `ORDER BY eff_time DESC, id DESC LIMIT`）は digest 本文が要るので `memories` を
   * 直接スキャンする——`scoped` に digest 列を持たせて共有する必要が無くなった。
   * `digest_eligible_count` は `scoped`/`memories` を再スキャンせず、**集計側
   * （`agg` の `in_scope` 合計）から、`excludeMemoryIds`（高々 digestBand.limit 件、
   * テナント規模に応じて増えない）に該当する行のうち in_scope 条件を満たす件数を
   * 引き算**して出す（`id = ANY(...)` は主キーに乗るので、この補正クエリはテナント規模に
   * 依存しない定数コストである）。
   *
   * **`groups` の出現順序は契約ではない**（`packages/core/src/recall.ts` の
   * `ScopeAggregate.groups` doc・`GroupCount` doc、いずれも順序に触れていない。
   * `IndexBand.groups` へそのまま代入する `recall-runtime.ts` もソートしない。
   * `packages/testkit` の適合テストも `Map`/`toContainEqual` で集合として比較しており、
   * 配列全体を順序込みで比較していない——ADR 0307「確かめたこと」で
   * 実際に確認した）。旧実装は `json_agg` に `ORDER BY` を持たず、`GroupAggregate` の
   * 実行順（Postgres が選ぶプラン依存）に従っていた。新実装も同様に `ORDER BY` を
   * 持たない——**返り値の意味は変わっていない**（呼び出し側は今日も順序に依存できない）。
   *
   * **等価性の歯**: `packages/postgres/src/__tests__/aggregate-scope-single-pass.postgres.test.ts`
   * が、旧実装の SQL をテスト内に参照オラクルとして写し、新実装の `aggregateScope` と
   * 完全一致することを、各 FILTER 枝・subject 有無・includeSubjectless・NULL subject・
   * period/validAt/decayFloor* の組合せ・digestBand 有無・除外 id・空テナント・
   * digest 同時刻 tie（id DESC）を踏むデータで検査する。
   */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    assertWellFormedCtx(ctx);
    assertWellFormedIdentifier(scope.subjectId, "scope.subjectId");
    // testkit のインメモリ実装と同じ条件（ADR 0434）: `scopeAggregate: "skip"` で `digestBand` も無いとき、
    // Postgres は集計も目次帯も引かずにクエリを1本も発行しない。その入力は、今までどおり NUL を見ない。
    if (!(opts?.scopeAggregate === "skip" && opts.digestBand === undefined)) {
      assertNoNulInScopeFilter("PostgresMemoryStore.aggregateScope", scope, "scope");
    }
    // Issue #608 項目③(b) / ADR 0286: 段1（ANN・語彙）の押し下げと同じ opt-in。
    // `scope.subjectId` が無ければこの欄自体を見ない——「テナント全体」は定義上すでに
    // 主題なしを含む上位集合であり、広げる余地が無い。
    const subjectFilter =
      scope.subjectId !== undefined
        ? scope.includeSubjectless === true
          ? sql`AND (subject_id = ${scope.subjectId} OR subject_id IS NULL)`
          : sql`AND subject_id = ${scope.subjectId}`
        : sql``;
    // Issue #152/#153（ADR 0312）: `attributes` も `subjectId` と同じくスコープの外側の
    // 境界——`scoped` CTE の WHERE に足すことで、この絞り込みの外は `totalInScope` は
    // もちろん `filtered*` のどの列にも数えない（`recall.ts` の `ScopeAggregate` doc
    // 「2026-09 追記」参照）。`@>`（containment）は `idx_memories_attributes` の GIN 索引
    // （`jsonb_path_ops`）が効く述語。
    const attributesFilter =
      scope.attributes !== undefined
        ? sql`AND attributes @> ${JSON.stringify(scope.attributes)}::jsonb`
        : sql``;
    // Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
    // taxonomy は `attributes`/`subjectId` とは違う側——「スコープを定義する識別子の境界」
    // ではなく「period/validity と同じ、filtered として報告されるゲート」である
    // （`FILTERED_CONDITION_SCOPE_RELATION.taxonomy === 'outside_scope'` は ADR 0318 より
    // 前から固定済み）。⟹ `scoped` の WHERE には入れず、`flags`/`agg` の中で boolean と
    // して持つ（`isDecayed` と同じパターン）——`period_filtered`/`expired_filtered` と
    // 同じ「直前までのゲートを通過し、このゲートだけで落ちた」件数を数えるため。
    // `labels.name` は書き込み経路が `tags` からしか作らないため1対1で一致する
    // （ADR 0323「決定1」）——`memory_labels`/`labels` を JOIN せず `tags` の配列の重なり
    // だけで判定できる。
    const hasQualifyingLabel =
      scope.labels !== undefined ? sql`(tags && ${sql.param(scope.labels)}::text[])` : sql`true`;
    const occurredAfter = toPgTimestamp(scope.occurredAfter);
    const occurredBefore = toPgTimestamp(scope.occurredBefore);

    // period 条件: 未指定側は常に真になる（フィルタなしを表す）。
    // occurred_at が NULL の Memory は recorded_at を代替の実効時刻として扱う
    // （docs/recall.md §7 の freshness 計算が occurred_at ?? recorded_at を使うのと同じ規約）。
    const inPeriod = sql`(
      ${occurredAfter}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) >= ${occurredAfter}::timestamptz
    ) AND (
      ${occurredBefore}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) <= ${occurredBefore}::timestamptz
    )`;

    // Issue #280（Issue #202 第2弾）: validAt ゲート。`scope.validAt` が無ければ常に真
    // （`RecallQuery.includeOutsideValidity: true` のときと同じ「絞りなし」）。
    // 両端とも NULL は「いつでも真」（`RecallQuery.validAt` の doc 参照）。
    const validAt = toPgTimestamp(scope.validAt);
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

    // ⭐ Issue #329 / ADR 0173: 忘却ゲート（`decay_floor_at` / `decay_floor_seq`）が
    // 落とした件数を、**段1の押し下げとまったく同じ述語**で厳密に数える。
    //
    // 押し下げ側は `PostgresVectorStore.search`（`vector-store.ts`）の
    // `decayFloorAtCondition` / `decayFloorSeqCondition` / `decayFloorAnyAxis` の3本である。
    // **ここはその否定（NOT）を組む**——生き残る側の述語を書いて否定することで、
    // 「押し下げが通したもの」と「ここが数えないもの」が定義上一致する。
    // ⚠ **`NOT` を分配して書き直さないこと。** 'either' は OR なので
    // `NOT (wall OR seq)` = `NOT wall AND NOT seq` であり、AND/OR を取り違えると
    // 「段1で落ちた数」と「集約が数えた数」が黙って食い違う（それがこの ADR の眼目である）。
    //
    // `decay_floor_at` は NOT NULL（`memories` の列定義）なので `NOT (x > p)` に
    // 三値論理の穴は無い。`decay_floor_seq` は NULL を取りうるが、生き残る側の述語が
    // `IS NULL OR ...` の形なので、その否定は `IS NOT NULL AND ... <= p` になり、
    // やはり NULL が UNKNOWN で漏れることは無い（ADR 0165 決めたこと4）。
    const decayFloorAtAfter = scope.decayFloorAtAfter;
    const decayFloorSeqAfter = scope.decayFloorSeqAfter;
    const wallAxisAlive =
      decayFloorAtAfter !== undefined
        ? sql`(decay_floor_at > ${toPgTimestamp(decayFloorAtAfter)}::timestamptz)`
        : undefined;
    // ADR 0353（Issue #338）: `scope.decayFloorSeqUsesSubjectCounters` が true の
    // ときだけ相関サブクエリで subject 単位のカウンタを足す（段1の `buildFilterConditions`
    // と同じ述語、`activityFloorSeqAliveCondition` の doc コメント参照）。
    // ⚠ この述語は `flags` CTE（`FROM scoped`）の中で評価される。相関サブクエリの中の修飾の無い
    // `tenant_id`/`subject_id` は内側の `tenant_subject_activity` の列に解決されて恒真になる（ADR 0438）ので、
    // テナントは `scoped` の行が全部 `ctx.tenantId` であることを使って値で渡し、subject は `scoped.` で修飾する。
    const activityAxisAlive = activityFloorSeqAliveCondition({
      decayFloorSeqAfter,
      usesSubjectCounters: scope.decayFloorSeqUsesSubjectCounters === true,
      floorSeqExpr: sql`decay_floor_seq`,
      tenantIdExpr: sql`${ctx.tenantId}`,
      subjectIdExpr: sql`scoped.subject_id`,
    });
    let isDecayed: SQL;
    if (wallAxisAlive === undefined && activityAxisAlive === undefined) {
      // ゲート無効（`RecallQuery.includeFullyDecayed: true`）。**0件と数える**
      // ——「ゲートを外した」ことと「0件落ちた」ことは呼び出し側から見て同じである
      // （`omitted` に `decayed` が積まれない。`validAt` 未指定のときの
      // `expired_filtered` が常に 0 になるのと同じ形）。
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

    // ADR 0390: 段1の ANN から除外した kind（非空のときだけ）。除外される kind で **索引済み**
    // （`embedding_status = 'ready'`＝ `not_indexed_*` の補集合）の行を、`in_scope` と同じ絞りの上で
    // 数える列を足す——`recall()` が `eligible`（`in_scope` − `not_indexed`）から引くため。
    // **未指定・空配列のときは、列も欄も足さない**（SQL テキストが今日と1バイトも変わらない。
    // `digestBandColumns`/`taxonomyGroupColumns` と同じパターン）。
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
    // Issue #1262: uuid の形でない除外の id は、どの記憶とも一致しないので「無いもの」として扱い、SQL へは
    // 渡さない（`get`・`getMany` などほかの読みの口と同じ扱い。mapping.ts の isUuidLike の doc 参照）。
    // 渡すと `::uuid[]` への変換で DB の例外になっていた。形の正しい id の結果は変わらない。
    const excludeMemoryIds = digestBand ? digestBand.excludeMemoryIds.filter(isUuidLike) : [];
    // `digestBand` が無ければ余計な仕事をしない（doc コメント・PR 指示のとおり）——
    // このサブクエリ群自体を SQL テキストに載せない。
    //
    // Issue #355 / ADR 0307: `digestBand` は `scoped`/`agg` を経由せず、
    // `memories` を直接（同じ tenant_id/subjectFilter の WHERE で）引く。digest 本文が
    // 要る `digests` は仕方なく `memories` を再スキャンするが、`digest_eligible_count` は
    // 再スキャンしない——`in_scope`（`agg` の合計）から、除外 id のうち in_scope 条件を
    // 満たす件数（高々 `excludeMemoryIds.length` 件、主キー相当の `id` に乗るので
    // テナント規模に依存しない）を引き算するだけで出す。
    //
    // [ADR 0384](../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)（案A）:
    // `digests` の `ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC LIMIT n` は
    // `migrations/0028_digest_band_index.sql` の部分索引
    // `idx_memories_digest_band (tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC)
    // WHERE status IN ('active', 'contested')` に支えられる——ADR 0307「引き受けた負債」
    // 2番が残した「in-scope 件数ぶんの Seq Scan + top-N Sort」の穴を塞ぐ。
    // `occurredAfter`/`occurredBefore`/`validAt`/`labels` を指定しない既定の呼び出しでは
    // `in_period`/`is_valid`/`has_qualifying_label` はすべて定数 `true` になるため、
    // 索引だけで `LIMIT` まで打ち切れる（`Index Scan Backward` + `Limit`）。指定した
    // 呼び出しではこれらが Filter として残るが、`tenant_id` の絞り込み自体は索引が効く。
    // SQL 文自体（このクエリの書き方）は変えていない——索引を追加しただけであり、
    // 返す digest の中身・順序・件数は1バイトも変わらない。
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

    // Issue #201 PR-B（ADR 0323「決定5」）: `RecallQuery.taxonomyGroups: true` のときだけ
    // 追加する——`scope.taxonomyGroupCandidates` が `undefined` なら SQL テキストにも
    // 実行計画にも一切現れない（`digestBandColumns` と同じパターン）。`scoped`/`flags`/`agg`
    // を経由せず、`memories` を直接（同じ WHERE で）再スキャンする——`unnest(tags)` を伴う
    // `GROUP BY` は `agg` の `GROUP BY subject_id` と粒度が違うため、単一パスに混ぜない
    // （ADR 0307 が `digestBand` について下した判断と同じ理由）。**`hasQualifyingLabel`
    // （`RecallQuery.labels` による絞り込み、指定されていれば）の内側を数える**——
    // グルーピングは「絞り込み済みの現在のスコープ」をテナントの語彙全体で内訳する。
    //
    // ⚠ **1件の Memory は、1つのラベル群に1回だけ数える**（`GroupCount.count` は Memory の件数）。
    // `tags` は作成時の値をそのまま持つので、同じ名前が重なりうる（LLM の `tags` は重複を除かずに
    // 書かれる）。以前は `unnest(tags)` をそのまま数えていて、重なった名前の群を多く数えていた
    // （testkit の fixture は `Set` で1回に数える）。`array_position(tags, tag) = position` で、その名前が
    // `tags` の中で最初に現れた位置だけを残す——並べ替え（`DISTINCT`）を足さずに済む形を選んだ。
    // 【実測 2026-09-28】10万行（`tags` に重複を含む行 6,482）の aggregateScope で、中央値は直す前
    // 94〜98ms、この形 98〜107ms、`LATERAL (SELECT DISTINCT unnest(tags))` 106〜115ms、
    // `count(DISTINCT id)` 213〜228ms（PR 本文）。
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

    // [ADR 0384](../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)
    // 案C: `opts.scopeAggregate === "skip"` のときは、下の `scoped`/`flags`/`agg` の
    // 集計クエリ（この関数の支配項、ADR 0307「引き受けた負債」1番）を**まったく実行しない**
    // ——`AggregateScopeOptions.scopeAggregate` の doc コメントが定める「値だけ受け取って
    // 計算は今までどおり行う実装は禁止する」を、ここで実際に満たす。`digestBand` が
    // 指定されていれば、それだけ独立した `SELECT`（ADR 0384 案A の索引
    // `idx_memories_digest_band` が支える）で digest を引く——集計とは別の経路なので、
    // "skip" でも目次帯自体は今日どおり出る（`digestEligible` だけは件数の一種なので
    // `unknown` にする）。`taxonomyGroupCandidates` が同時に指定されていても、
    // taxonomy 群カウントも同じ理由で計算しない（`groups` は空のまま）。
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
        // digestBand を渡していなければ「集計」自体そもそも起きないので、既存の
        // 「digestBand を渡さない呼び出しは digestEligible: { count: 0, countKind: 'exact' }」
        // という契約（AggregateScopeOptions.digestBand の doc コメント）を "skip" でも保つ。
        digestEligible: digestBand ? unknownCount : { count: 0, countKind: "exact" },
      };
    }

    // Issue #355 / ADR 0307: 各行の述語を `scoped` の中で1回だけ boolean として
    // 計算し（`live`/`in_period`/`is_valid`/`is_expired`/`is_not_yet_valid`/`is_decayed`）、
    // `agg` で `GROUP BY subject_id` して subject ごとの各カウンタを1パスで出す。
    // `scoped`・`agg` はどちらも1回しか参照されないので、Postgres は既定でどちらも
    // インライン化する（`MATERIALIZED` を明示していない）。
    //
    // ⚠ **`MATERIALIZED` を試したが、採らなかった**（ADR 0307「採らなかった案」）。
    // `scoped` は digest を持たない狭い行だが、`work_mem`（既定 4MB、GUC を変えない前提の
    // もとでは動かせない）を100k行で超え、実体化そのものがディスクへ溢れる
    // （`temp written` が実測で再発した）。**インライン化のままだと、`in_period`/`is_valid`
    // 等の式は `agg` 側の複数の `FILTER` から参照されるたびに再評価されるが、
    // これは単純な比較演算であり、`work_mem` を超えて生じるディスク書き込みより安い**
    // ——【実測】インライン化 237ms 台 vs `MATERIALIZED` 254ms 台（ADR「測ったこと」）。
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

    // Issue #201 PR-B（ADR 0323「決定5」）: `taxonomyGroupCandidates` が渡されたときだけ
    // `axis: 'taxonomy'` の群を足す。カウント0のラベルは載らない（`GROUP BY` が自然に
    // そうなる、`axis: 'subject'` の `in_scope > 0` フィルタと同じ規約）。残差
    // （`key: null`）もカウントが0なら載せない（同じ規約をここにも揃える）。
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
      // ADR 0390: 除外指定（非空）のときだけ欄を返す。
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
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5:
   * `record.advanceActivityClock === true` のとき、`recalls` への INSERT と**同一
   * トランザクションで**（[ADR 0395](../../../docs/decisions/0395-create-recall-activity-clock-single-statement.md)
   * 以後は**同一の1文で**）`tenant_activity.activity_seq` を `+1` する（UPSERT——行が
   * 無ければ `activity_seq = 1` の行を作る。`ON CONFLICT DO UPDATE` の `EXCLUDED` は
   * 使わない——`+1` は既存値に依存するため）。**`false`/未指定なら `UPDATE` を1本も
   * 撃たない**（既定 `'wall'` のテナントでは、この行を一度も触らない、という ADR の
   * 意味論をそのまま満たす）。
   *
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `record.advanceActivityClock` が `{ scope: "subject", subjectId }`
   * のときは、`tenant_activity`（`T`）ではなく `tenant_subject_activity`
   * （`subjectId` の行、`S_x`）を同じトランザクションで `+1` する——**`T` には触れない。**
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
    // ADR 0505: NUL は DB の生の例外でなく、名指しの例外で断る（INSERT の前。活動時計も進めない）。
    assertNoNulInNewRecall(record);
    // Issue #298 / ADR 0155: 新しく書く行は常に breakdownCaptured: true。「内訳を持たない
    // 新規行」は無い（recall-runtime.ts が finalMemories から毎回内訳を計算しているため）。
    const returnedMemories: RecallRecordReturnedMemories = {
      breakdownCaptured: true,
      memories: record.returnedMemories,
    };
    // Issue #1237: 省略時は1回だけ壁時計を読む（`advanceActivityClock` の分岐によらず
    // 同じ値を使う——下の3分岐はどれもこの1つの `insertRecall` を実行するだけである）。
    const createdAt = record.createdAt ?? new Date();
    // recalls の INSERT（3分岐で共通）。advance ありの分岐は、これを `WITH r AS (...)` の中へ入れる。
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

    // ADR 0395: advance ありの2分岐は、`recalls` の INSERT とカウンタの UPSERT を**1つの SQL 文**
    // （data-modifying CTE）で撃つ。1文は1トランザクションで走るので、明示的な
    // `BEGIN`/`COMMIT` は要らず（`requeueEmbedJobs` と同じ形）、どちらかが失敗すれば
    // 両方が戻る（意味は「2文＋`db.transaction`」だったときと同じ）。
    // 狙いはカウンタの行ロックを持つ時間を縮めること: 旧形は INSERT・UPSERT・COMMIT の
    // 3往復のあいだロックを持ち、同じテナントへの同時 createRecall がそこで直列になっていた。
    // 1文なら、ロックを取ってから解くまでにクライアントとの往復が挟まらない。
    // `u`（UPSERT）は外側の SELECT から参照されないが、data-modifying CTE は参照の有無に
    // よらず最後まで実行される（PostgreSQL の仕様）。
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

  /**
   * Issue #298 / [ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
   * `createRecall` が書いた `recalls` 行1件を、`recallId` から読み戻す。
   * 契約は `get`/`getObservation` と同じ——見つからなければ `null`（例外にしない）。
   */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    assertWellFormedCtx(ctx);
    // id 列は uuid 型。形式が壊れた入力も「無い」と同じ扱いにする
    // （`get`/`getObservation` と同じ規律。mapping.ts の isUuidLike の doc参照）。
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
   * ADR 0079: 索引に載っていない Memory を選んで `pending` へ戻し、**同じ1文の中で**
   * `embed` の outbox 行を積み直す。
   *
   * 🔴 **`memories` の更新と `outbox` の INSERT は、同一トランザクションでなければ
   * ならない。**片方だけ起きると次のどちらかになる:
   * - 更新だけ起きた: `pending` に戻ったのに運ぶジョブが無い。**その行は永久に
   *   `pending` のまま**で、`recall` は「待て」と案内し続ける——直すつもりが、
   *   直せない状態を一つ増やしたことになる。
   * - INSERT だけ起きた: `failed` のまま `embed` ジョブが積まれる。処理そのものは
   *   走るので致命的ではないが、`aggregateScope` の `notIndexed.failed` は
   *   ジョブが成功するまで減らない。
   *
   * **ここでは単一の `WITH ... INSERT ... SELECT` 文にしてある**——1文なら、
   * 明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る
   * （`createMemoryWithOutbox` は複数文なので `db.transaction` で包む必要がある。
   * こちらは1文で済むので包まない）。**この選択には歯が在る**: 適合スイートの
   * 「更新と INSERT は片方だけ起きない」の検査（`memory-store-conformance.ts`）。
   *
   * `FOR UPDATE SKIP LOCKED` は `claimBatch`（`./outbox-store.ts`）と同じ理由で使う——
   * 2つの呼び出しが同時に走っても、同じ Memory を二重に積み直さない（取ろうとして
   * いる行はスキップして次へ行く）。
   */
  async requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult> {
    assertWellFormedCtx(ctx);
    const target = buildRequeueEmbedTargetSelect(ctx, opts);
    // Issue #1237: 積み直す embed ジョブの時刻。省略時は壁時計。
    const outboxNow = writeOpts?.now ?? new Date();
    // `memoryIds` を渡されたのに well-formed な id が1つも残らなかった場合
    // （空集合との積）。問い合わせる意味が無い。
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
   * ADR 0114: `docs/memory-model.md` §11 行8 の掃引。doc コメントの契約そのものは
   * `MemoryStore.archiveDecayed`（`@mnemora/core`）側にある——ここはクエリの実装のみ。
   *
   * 🔴 `memories` の UPDATE と `memory_events` への INSERT は、`requeueEmbedJobs`
   * （ADR 0079、直上のメソッド）と同じ理由で**単一の `WITH ... UPDATE ... INSERT ...
   * SELECT` 文**にまとめてある——1文なら、明示的な `BEGIN`/`COMMIT` を書かなくても
   * 両方が同じトランザクションに入る（`片方だけ起きる」を構造的に作れない）。
   *
   * `digest_snapshot` には archived にする直前の `digest` を入れる
   * （`docs/memory-model.md` §9「記録時点の digest」）——`updateStatusWithEvent` を
   * 経由する `forget` が `digestSnapshot: current.digest` を渡すのと同じ規約を、
   * 1文の SQL の中で `RETURNING`/`SELECT` を通じて再現する。
   *
   * 最終 `SELECT` に `ORDER BY` を付けているのは、`archived`（返り値）の並びを
   * ターゲット選択の並び（`decay_floor_at` 昇順）と一致させるため——`UPDATE ...
   * FROM target` の `RETURNING` はターゲットの行順を保証しないので、返り値としての
   * 順序契約はここで別途つけ直す必要がある。
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
   * Issue #198 / ADR 0124 / [ADR 0375](../../../docs/decisions/0375-purge-scope-widened.md):
   * `forgotten` かつ未 purge（`purged_at IS NULL`）の Memory だけを対象にした CAS。
   * `updateStatusWithEvent`（本ファイル上部）と同じ形——条件付き `UPDATE` が0行なら、
   * 対象がそもそも存在しないのか（`isUuidLike` の事前チェックで弾く、または読み直しで
   * 0行）、条件を満たさなかったのか（読み直して {@link MemoryPurgeConflictError} を
   * 投げる）を切り分ける。`status` は更新しない——`purged` は `memories.status` の値
   * ではない（docs/memory-model.md §11 行10）。
   *
   * 🔴 ADR 0375 決定1: `content`/`digest`/`purged_at` に加えて、`tags`・`attributes`・
   * `claim_key_subject`/`claim_key_predicate` もこの UPDATE で空にする——「その記憶の
   * 本文から直接たどれる派生物」を一緒に消す（CAS が弾かれれば、これらも一切書かない）。
   *
   * CAS が通った後、同じトランザクションで2つの派生的な書き込みを追加する
   * （ADR 0375 決定2・決定3）:
   * 1. `memory_labels` からこの Memory の行を削除し、`status = 'proposed'` のまま残る
   *    `labels.proposed_count` を、外した本数だけ減らす（`GREATEST(…, 0)` で床を敷く。
   *    `upsertProposedLabels` の increment と対称。ADR 0318「引き受けた負債」1 が
   *    `proposed_count` を近似値と既に引き受けている——この減算も同じ近似の中にいる）。
   * 2. このテナントの `recalls.index_band` の `digestBand` に、この `memoryId` を持つ
   *    エントリがあれば `digest` をトゥームストーンへ書き換える（`truncated` は落とす
   *    ——もう「長さで切った」わけではないため）。`recalls.query`（`consolidate`/`reflect`
   *    が種の digest を `text` にして撃った recall の分）はここでは触らない
   *    ——`memoryId` で特定できないため（ADR 0375 決定4、Issue #994 のコメント）。
   *
   * この `recalls` の UPDATE の `@>` は、`migrations/0030_recalls_digest_band_index.sql` の
   * 式 GIN 索引 `idx_recalls_digest_band`（`(index_band->'digestBand') jsonb_path_ops`）で
   * 引ける（ADR 0389）。**索引の式と `WHERE` の式が一致していることに依存する**——この
   * 述語を書き換えるときは、`recalls-digest-band-index.postgres.test.ts` が縛る。
   * 索引が無かった時代の費用（テナント全体の実質フルスキャン）は ADR 0375 決定6、
   * 索引の前後の実測は ADR 0389 を見ること。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // ADR 0438: 大文字の uuid でも `recalls.index_band` の目次帯（文字列で比べる）に当たるよう、入口でそろえる。
    id = normalizeUuidCase(id);
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    // ADR 0499: 墓石の NUL は、UPDATE（対象の状態によらず、パラメータの時点で DB が拒む）の前に名指しで断る。
    assertNoNul("PostgresMemoryStore", "tombstone.content", tombstone.content);
    assertNoNul("PostgresMemoryStore", "tombstone.digest", tombstone.digest);

    // Issue #1237: `purged_at` と `memory_events.at` を同じ値にする——省略時も1つの壁時計を
    // 2回読んで別の値になることがないよう、ここで一度だけ決める。
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
        // 0行だった理由を切り分けるための読み直し（`updateStatusWithEvent` と同じ作法）。
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

      // ADR 0375 決定2: memory_labels を外し、proposed な labels.proposed_count を減らす。
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

      // ADR 0375 決定3: このテナントの recalls.index_band の digestBand から、この
      // memoryId のエントリを見つけてトゥームストーンへ書き換える（他のエントリ・
      // 他テナントの行は変えない）。
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
   * [ADR 0437](../../../docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定3:
   * v1.1.0（ADR 0375）より前の `purgeMemory` が残した、`tags`・`attributes`・
   * `claim_key_subject`/`claim_key_predicate`・`memory_labels` を、**既に purge 済みの行**
   * （`status = 'forgotten' AND purged_at IS NOT NULL`）について消し、`labels.proposed_count`
   * （`status = 'proposed'` のもの）を外した紐付けの本数だけ減らす（`GREATEST(…, 0)`）。
   *
   * - **1トランザクション。**3文とも（ADR 0512 で `recalls.index_band` の1文を足した）`purged_at IS NOT NULL` の行だけを対象にするので、
   *   未 purge の行・他テナントの行は、渡された id に含まれていても触らない。
   * - **べき等。**`memories` の UPDATE は「残骸が在る行」だけを更新する（`updated_at` も、残骸の無い行では
   *   動かさない）。`memory_labels` の DELETE は `RETURNING` した本数だけ `proposed_count` を減らすので、
   *   2回目以降（または今のコードで purge した行）は外す行が無く、減算は0件になる。同時に2本が
   *   同じ行を消しにきても、後から来た DELETE は先の DELETE の確定後に行を見直すので、二重には数えない
   *   （`READ COMMITTED`）。
   * - 形式不正な id は、`deleteAcrossSpaces` と同じく「無い」として落とす（クエリを投げる前に）。
   * - [ADR 0512](../../../docs/decisions/0512-scrub-purged-index-band.md): このテナントの `recalls.index_band` の
   *   `digestBand` のうち、purge 済みの行のエントリの `digest` を、その行の `digest`（トゥームストーン）へ伏せる。
   *   `recalls.query`・`explain` は書かない。
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
      // ADR 0512: v1.0.x の purge は recalls.index_band を書き換えなかった。このテナントの
      // digestBand から、渡された id のうち purge 済みの行のエントリだけを、その行の
      // memories.digest（purge が書いたトゥームストーン）へ書き換える（ADR 0375 決定3 と同じ形。
      // truncated は落とす）。既に同じ digest のエントリしか無い行は更新しない（べき等）。
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
   * Issue #197 / ADR 0134: 両側とも `status = 'active'` の CAS を課したうえで、
   * `status='contested'`・`contested_with_id` を相互に設定する——1トランザクションで
   * 完結し、`updateStatusWithEvent`/`purgeMemory` と同じ「条件付き UPDATE が0行なら
   * 読み直して切り分ける」作法を、対象2件それぞれについて行う。**どちらか一方が
   * 失敗したら、その場で throw してロールバックする**（もう一方が先に成功していても
   * 巻き戻る）——対向ペアは本質的に結合しており、部分成功を許さない。
   */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    assertWellFormedCtx(ctx);
    // 入口の正規化（`normalizeUuidCase`）。同じ行を小文字と大文字で渡したときも、下の検査で TSDoc どおり
    // `RangeError` になる（そろえる前は、この検査を通り抜けて「memory not found」になっていた）。
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
      // 事前検証——存在確認。**両方の UPDATE を撃つ前に済ませる**（先に第1の UPDATE で
      // `contested_with_id = second.id` を書こうとすると、`second.id` がそもそも
      // 存在しない場合に外部キー違反という別種の失敗になり、「memory not found」に
      // 揃わない。`supersedeWithNewMemories` が `supersededByIndex` の範囲検査を
      // 書き込み前に済ませるのと同じ理由）。
      //
      // ⚠ **`ORDER BY id ASC FOR UPDATE` で、両側の行ロックを呼び出し順ではなく
      // 常に id 昇順で取る。** `markContestedPair(A, B)` と `markContestedPair(B, A)`
      // （対を逆順で呼ぶ2つの並行呼び出し）が、もしそれぞれ「渡された引数の順」に
      // 行ロックを取っていたら、片方が A→B、もう片方が B→A の順で行を掴み合い、
      // 40P01（`deadlock detected`）で片方が落ちる——契約が約束する
      // {@link MemoryStatusConflictError} ではなく、生の Postgres 例外が漏れる形になる
      // （2接続での実測: `restore-superseded-concurrent-forget.postgres.test.ts` と同じ
      // 構えの歯 `contested-pair-lock-order-concurrency.postgres.test.ts` 参照）。
      // ロックを常に id 昇順で取れば、どちらの呼び出しも同じ順序でしか行を掴めないため
      // 循環待ちが構造的に起きない——後から来たほうは先着の行ロックの解放待ちでブロック
      // されるだけになり、解放後に読み直した `status` が `'active'` でなければ
      // 下の CAS がそのまま {@link MemoryStatusConflictError} を投げる。
      const existing = await tx.execute(sql`
        SELECT id, status FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param([first.id, second.id])}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      // id は入口で小文字にそろえてあるので、DB が返す id とそのまま突き合わせられる。
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
          // 事前検証を通った直後にここへ来るとすれば TOCTOU（事前検証と UPDATE の間に
          // 別の書き込みが割り込んだ）——読み直して切り分ける（`updateStatusWithEvent`
          // と同じ作法）。
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
   * Issue #372（(B) 第2段）: `MemoryStore.findActiveByClaimKey?` の実装（interface 側の
   * doc コメントに契約全体がある。ここはクエリの組み立てだけ）。
   * `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject,
   * claim_key_predicate)`、`migrations/0021_memories_claim_key.sql`）に載る4列の等値比較で
   * 絞り込み、`status`/`content_hash`/有効期間の重なりを追加の `WHERE` で絞る。
   * **LLM を一度も呼ばない**——列の等値比較・範囲比較・索引アクセスだけで完結する
   * （北極星 問い5）。
   *
   * `subject_id` は NULL 同士も一致として扱う（`IS NOT DISTINCT FROM` と同じ意味）——
   * Postgres の `=` は `NULL = NULL` を（真ではなく）`NULL` に評価するため、素の `=` では
   * `subjectId: null` の Memory 同士が一致しない（`docs/memory-model.md` の
   * 「`NULLS NOT DISTINCT` が要る理由」と同じ配慮を、索引ではなく述語の側でやっている）。
   * ⚠ **`IS NOT DISTINCT FROM` そのものは書かない**——索引で引けない形なので、以前は
   * `subject_id` が Index Cond に入らず Filter に落ちていた（同じ claim key を持つテナント中の
   * 全 subject の行を読んでから捨てていた）。同じ意味を、索引で引ける `subject_id = $n` /
   * `subject_id IS NULL` に分けて書く（{@link subjectIdMatches}。歯は
   * `__tests__/claim-key-index.postgres.test.ts`）。
   *
   * `excludeMemoryId` はここでは SQL の条件にしない——`id` は `uuid` 型の列であり、
   * 呼び出し側から壊れた形式の文字列が渡ると `<>` の暗黙キャストでクエリ全体が
   * 例外を投げる（`get`/`reinforce` が `isUuidLike` で入口で弾いているのと同じ問題）。
   * この口は「渡された id を除いた行を返す」という契約であって「壊れた id を拒否する」
   * 契約ではないため、**返ってきた行を JS 側で除く**——`getMany` が壊れた id を
   * クエリの前に取り除くのと対称の位置（クエリの後）で同じ頑健性を買う。
   *
   * 有効期間の重なりは半開区間 `[valid_from, valid_until)` の標準的な判定
   * （`a1 < b2 AND a2 < b1`）を、`NULL` を `-∞`/`+∞` として読み替えて書く
   * （`aggregateScope` の `validAt` ゲートは「1点」を判定するのに対し、こちらは
   * 「区間の重なり」を判定する——同じ NULL の読み方を区間判定に拡張しただけである）。
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
    // 入口の正規化（`normalizeUuidCase`）。下の除外は JS で比べるので、DB が返す小文字の id に揃える
    // ——以前は大文字の UUID を渡すと自分自身が返っていた（`get` は同じ行を返すのに）。
    const excludeMemoryId = normalizeUuidCase(query.excludeMemoryId);
    const validFrom = toPgTimestamp(query.validFrom);
    const validUntil = toPgTimestamp(query.validUntil);
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
        AND (${validFrom}::timestamptz IS NULL OR ${validUntil}::timestamptz IS NULL
          OR ${validFrom}::timestamptz < ${validUntil}::timestamptz)
        AND (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
    `);
    return result.rows
      .map((row) => rowToMemory(row as unknown as MemoryRow))
      .filter((memory) => memory.id !== excludeMemoryId);
  }

  /**
   * Issue #933（案2、`docs/decisions/0378-*.md`）: `MemoryStore.findContestedByClaimKey?`
   * の実装（interface 側の doc コメントに契約全体がある）。`findActiveByClaimKey` と
   * 完全に同じクエリで、`status = 'active'` の代わりに `status = 'contested'` を見るだけ
   * ——`idx_memories_claim_key` は `status` を索引の条件に含めていない汎用索引なので
   * （`migrations/0021_memories_claim_key.sql` の doc コメント「status を索引に含めない
   * 理由」）、この口のために新しい索引・新しい migration は要らない。索引が実際に
   * 使われることは `__tests__/claim-key-index.postgres.test.ts` が EXPLAIN で縛る。
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
    const validFrom = toPgTimestamp(query.validFrom);
    const validUntil = toPgTimestamp(query.validUntil);
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
        AND (${validFrom}::timestamptz IS NULL OR ${validUntil}::timestamptz IS NULL
          OR ${validFrom}::timestamptz < ${validUntil}::timestamptz)
        AND (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
    `);
    return result.rows
      .map((row) => rowToMemory(row as unknown as MemoryRow))
      .filter((memory) => memory.id !== excludeMemoryId);
  }

  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` の実装
   * （interface 側の doc コメントに契約全体がある。ここはクエリの組み立てだけ）。
   * `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject,
   * claim_key_predicate)`、`migrations/0021_memories_claim_key.sql`）の先頭2列
   * （`tenant_id`, `subject_id`）で絞り込み、`status`/`claim_key_predicate IS NOT NULL`
   * を追加の `WHERE` で絞ったうえで `GROUP BY claim_key_predicate` して
   * `MAX(created_at)` で新しい順に並べる。当初は「新しい索引は足さない」（ADR 0329 決定4）だったが、**専用の部分索引
   * `idx_memories_claim_predicates`（`migrations/0029_memories_claim_predicates_index.sql`）を足した**
   * ——ADR 0329 の 2026-09-30 追記。SQL は変えていない。
   *
   * `subject_id` は `findActiveByClaimKey` と同じく NULL 同士も一致として扱う
   * （{@link subjectIdMatches}）。
   *
   * ⚠ **以前はこの SQL が索引を使っていなかった**（上の「先頭2列で絞り込み」は意図であって
   * 実態ではなかった）。【実測 2026-09-27、1テナント 20,000 行 + 別テナント 5,000 行】
   * **Seq Scan**（別テナントを含む表全体）だった——`subject_id IS NOT DISTINCT FROM` が
   * 索引で引けない形であることに加え、`idx_memories_claim_key` は部分索引
   * （`WHERE claim_key_subject IS NOT NULL`）なのに、WHERE が `claim_key_predicate IS NOT NULL`
   * だけでは部分索引の述語を導けないため。⟹ `claim_key_subject IS NOT NULL` を足す——
   * claim key は2列とも NULL か2列とも非 NULL（`0021_memories_claim_key.sql` の「NULL の意味」）
   * なので、書き込みの口から作られる行について結果は変わらない。
   *
   * **同着の副キーは `claim_key_predicate COLLATE "C" ASC`**（コードポイント順の昇順。interface の契約参照）。
   * `COLLATE "C"` は UTF-8 のバイト順で、DB の既定の照合順序に依らずコードポイント順になる。
   *
   * `GROUP BY claim_key_predicate ORDER BY MAX(created_at) DESC` は「同じ predicate を
   * 持つ行のうち最も新しい `created_at` で代表させ、その代表値で降順に並べる」という
   * interface 側の契約をそのまま SQL に落としたもの——`DISTINCT ON` ではなく
   * `GROUP BY` にしたのは、`DISTINCT ON` が「先頭1行を残す」ことしかせず、複数行にまたがる
   * 集約（`MAX`）を表現できないため。
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
   * Issue #197 / ADR 0150: `markContestedPair` の解決側。両側とも `status = 'contested'`
   * かつ相互参照が成立していることを CAS で課したうえで、`contested_with_id` を両側とも
   * `NULL` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する
   * ——1トランザクションで完結し、`markContestedPair`/`updateStatusWithEvent`/`purgeMemory`
   * と同じ「条件付き UPDATE が0行なら読み直して切り分ける」作法を、対象2件それぞれについて
   * 行う。**どちらか一方が失敗したら、その場で throw してロールバックする**（もう一方が
   * 先に成功していても巻き戻る）——対向ペアは本質的に結合しており、部分成功を許さない
   * （`markContestedPair` と同じ理由）。
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
    // 入口の正規化（`normalizeUuidCase`）。下の `rowById` の引き当てと `contested_with_id` との比較は JS で行う
    // ので、そろえないと大文字の id だけで「memory not found」か `MemoryStatusConflictError` になっていた。
    // 同じ行を小文字と大文字で渡したときも、次の検査で TSDoc どおり `RangeError` になる。
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
    // ADR 0499: 型の外の status は、書く前に断る。
    assertResolvedStatus("resolveContestedPair", "first", first.status);
    assertResolvedStatus("resolveContestedPair", "second", second.status);
    // ADR 0503: 置き換えた側を伴わない superseded・自己置換・active への supersededById・互いを指す循環は、書く前に断る。
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
    // ADR 0439: `supersededById` の形が壊れていれば、DB へ投げる前に弾く（`ctx` のテナントの記憶かは、UPDATE の中で確かめる）。
    checkedRef("memory", first.supersededById);
    checkedRef("memory", second.supersededById);

    return this.db.transaction(async (tx) => {
      // 事前検証——存在確認。両方の UPDATE を撃つ前に済ませる（`markContestedPair` と
      // 同じ理由: 相手 id が存在しない場合を、外部キー違反ではなく「memory not found」に
      // 揃えるため）。ここで `contested_with_id` も読み、CAS（相互参照の成立）を判定する。
      //
      // ⚠ `markContestedPair` と同じ理由で `ORDER BY id ASC FOR UPDATE`——
      // `resolveContestedPair(A, B)` と `resolveContestedPair(B, A)`（同じ対を逆順で
      // 呼ぶ2つの並行呼び出し）が引数の順に行ロックを取ると、40P01（deadlock detected）
      // で片方が落ち、契約が約束する {@link MemoryStatusConflictError} ではなく生の
      // Postgres 例外が漏れる。常に id 昇順でロックを取れば循環待ちが構造的に起きない
      // （`markContestedPair` の同じコメント、`contested-pair-lock-order-concurrency.postgres.test.ts`
      // 参照）。
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

      // ADR 0515: 対の外の `forgotten` な記憶を置き換えた側にしない（`resolveContestedGroup` と同じ。ADR 0503 の負債の解消）。
      // 対の相手を指すのは断らない（ここまでで両方 contested と確かめ済み）。別テナント・実在しない id は、下の UPDATE の切り分け（ADR 0439）に任せる。
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
          // 事前検証を通った直後にここへ来るとすれば、（ADR 0439）`supersededById` が `ctx` のテナントの記憶でなかった、
          // または TOCTOU（事前検証と UPDATE の間に別の書き込みが割り込んだ）——読み直して切り分ける
          // （`markContestedPair` と同じ作法）。
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
   * [Issue #825](https://github.com/takecchi/mnemora/issues/825)（ADR 0150 追記）:
   * `resolveContestedPair`（上）の解決側 CAS を満たせなくなった生存側1件だけを対象にした
   * 別の任意メソッド。契約は `MemoryStore.resolveOrphanedContested`（`@mnemora/core`）側に
   * ある——ここはクエリの組み立てのみ。`resolveContestedPair` と違い、対象は1件だけであり
   * 対向の行には一切触れないため、`ORDER BY ... FOR UPDATE` の行ロック順序調整は不要
   * （ロックする行がそもそも1件しかない）。
   */
  async resolveOrphanedContested(
    ctx: Ctx,
    survivor: { id: MemoryId; contestedWithId: MemoryId; event: NewMemoryEvent },
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    assertWellFormedCtx(ctx);
    // 入口の正規化（`normalizeUuidCase`）。
    survivor = {
      ...survivor,
      id: normalizeUuidCase(survivor.id),
      contestedWithId: normalizeUuidCase(survivor.contestedWithId),
    };
    if (!isUuidLike(survivor.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${survivor.id}`);
    }

    return this.db.transaction(async (tx) => {
      // 形の合わない `contestedWithId` は、どの行の `contested_with_id` とも一致しない——UPDATE を撃たず
      // （撃つと uuid への型変換で DB の例外が漏れる）、下の読み直しで TSDoc どおり `MemoryStatusConflictError`
      // （行が無ければ「memory not found」）に落とす。core の Fake と同じ結果になる
      // （`uppercase-uuid-store-entry.postgres.test.ts`）。
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
        // 事前検証を通った直後にここへ来るとすれば TOCTOU——読み直して切り分ける
        // (`resolveContestedPair` と同じ作法)。
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
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.markContestedGroup?` の実装（契約は
   * interface 側の doc コメントにある）。`memories`・`memory_relations`・
   * `memory_events` を1トランザクションで書く——`memory_relations` への書き込みは
   * `PostgresRelationStore` を経由せず、ここで直接 SQL を発行する
   * （`createMemoryWithOutbox` が `outbox_jobs` へ直接書くのと同じ作法。
   * `relation-store.ts` の doc コメント参照）。
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
      // `ORDER BY id ASC FOR UPDATE`——`markContestedPair`/`resolveContestedPair` と
      // 同じ理由（並行呼び出しどうしが常に同じ順でロックを取り、デッドロックを
      // 構造的に避ける）を N 件へ一般化する。
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
      // CAS（interface 側の doc コメントの3条件）。1件でも満たさなければ、
      // 書き込みを一切行わずに投げる。
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

      // Issue #1449 PR1（ADR 0401）: メンバーごとの UPDATE をやめ、全員を1文で更新する
      // （文の数を N に依らず一定にする）。SET も WHERE の3条件も全員で同じ式なので、
      // `id = ANY(...)` に畳んでも、1件ずつ打った結果と更新される行の集合は同じ。
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
      // RETURNING の順序には依存しない——id で引き、以降は入力順（`ids`）で使う。
      const updatedById = new Map<MemoryId, Memory>(
        result.rows.map((row) => {
          const memory = rowToMemory(row as unknown as MemoryRow);
          return [memory.id, memory] as const;
        }),
      );
      if (updatedById.size !== ids.length) {
        // FOR UPDATE で既にロックを保持しているため、通常はここへ来ない
        // （`markContestedPair`/`resolveOrphanedContested` と同じ防御的な二重チェック）。
        // 旧実装は入力順に1件ずつ打ち、最初に0行だった id を名指しした——同じ id を指す。
        const failedId = ids.find((id) => !updatedById.has(id))!;
        throw await conflictAfterEmptyUpdate(tx, ctx, failedId, "active");
      }

      // ADR 0381 決定1: 「完全グラフ」は「一致した全員を結ぶ」ではなく「その中で
      // 実際に有効期間が重なる組を結ぶ」と読み替える（ADR 0324 決定4——重なりが
      // 矛盾の必要条件——との整合）。重なりの判定は `findActiveByClaimKey`/
      // `findContestedByClaimKey` と**文字どおり同じ SQL の半開区間の式**——JS 側に
      // 同じ式を二重に持たない（2026-09-30 の直し、ADR 0381 追記）。`memories a` ×
      // `memories b`（どちらも `members` の集合、`a.id <> b.id`）の自己結合1本で、
      // 重なる**順序対**（a→b と b→a の両方）を一度に生成する——`WHERE` が対称なので、
      // 一致する各無向対について2行（両方向）が自然に出る。穴A・合併で既に存在する行は
      // `ON CONFLICT DO NOTHING` で冪等に無視する。
      //
      // Issue #1449 PR1（ADR 0401）: 旧実装は実表 `memories a` × `memories b` を直接結合し、
      // N² の組それぞれで b 側の実表を引いていた（鎖1000で結合だけ1.7秒）。対象の memories を
      // `MATERIALIZED` の CTE で**1回だけ**読み、その N 行どうしを結合する。述語（半開区間の式。
      // `timestamptz` のマイクロ秒精度の比較）は1文字も変えていない——作る行の集合は同じ。
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

      // ADR 0431: 呼び出し時点で既に contested かつ contestedWithId が無いメンバーは、UPDATE しても
      // 状態が変わらない（既存の群のメンバーを吸収する場合）。そのメンバーには `updated` を積まない。
      // 判定は FOR UPDATE で読んだ行（`rowById`）から——UPDATE の前の状態である。
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

  /**
   * Issue #207/#933 PR2（ADR 0381）: `MemoryStore.resolveContestedGroup?` の実装
   * （契約は interface 側の doc コメントにある）。`markContestedGroup` と対称——
   * `memories`・`memory_relations`（削除）・`memory_events` を1トランザクションで書く。
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
    // ADR 0499: 型の外の status は、書く前に断る。
    normalized.forEach((m, i) =>
      assertResolvedStatus("resolveContestedGroup", `members[${i}]`, m.status),
    );
    // ADR 0503: 2者版と同じ（置き換えた側の欠落・自己置換・active への supersededById・循環）。
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
    // ADR 0439: `supersededById` の形が壊れていれば、DB へ投げる前に弾く（`ctx` のテナントの記憶かは、UPDATE の中で確かめる）。
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

      // 2026-09-30 の直し（ADR 0381 追記、段階Bの穴埋め）: 渡された members が、
      // 関係の行でつながった群の「今も contested な」全員と一致することを CAS で
      // 課す——一部だけを渡した解消（部分解消）を拒む。`WITH RECURSIVE` で
      // `members` から `memory_relations`（双方向2行が既に張られているので、
      // `from_memory_id` の向きだけ辿れば足りる）を辿り、`status = 'contested'` の
      // ものだけに絞った到達集合を求める——決定10（抜けたメンバーの行は残す）と
      // 矛盾しない形: forget/supersede/purge/archive で抜けたメンバーは
      // `status <> 'contested'` になっているので、この到達集合には入らない
      // （行は残るが「今の群」には数えない）。
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
        // 群の一部だけを渡した——足りない側（まだ contested のまま群に残っているのに
        // 渡されなかったメンバー）を名指しして、何も書かずに専用のエラーとして扱う
        // （2026-09-30 のさらなる直し、ADR 0381 §7 解消——
        // MemoryStatusConflictError の再利用をやめた）。
        throw new ContestedGroupMembershipMismatchError(missing[0] as MemoryId);
      }

      // ADR 0503: 群の外の `forgotten` な記憶を置き換えた側にしない。群の中を指すのは、メンバーの status に関わらず断らない
      // （メンバーはここまでで全員 contested と確かめ済み）。別テナント・実在しない id は、下の UPDATE の切り分け（ADR 0439）に任せる。
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

      // Issue #1449 PR1（ADR 0401）: メンバーごとの UPDATE を `UPDATE ... FROM unnest(...)` の1文に
      // まとめる。`supersededById` の COALESCE も、メンバーごとの値を配列で渡して同じ式のまま。
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
      // RETURNING の順序には依存しない（id で引く）。
      const updatedById = new Map<MemoryId, Memory>(
        result.rows.map((row) => {
          const memory = rowToMemory(row as unknown as MemoryRow);
          return [memory.id, memory] as const;
        }),
      );
      if (updatedById.size !== ids.length) {
        // ADR 0439: 全員が contested であることは上で確かめて行ロックも掴んでいるので、0行になる理由は
        // `supersededById` が `ctx` のテナントの記憶でないこと。先にそれを名指しする。
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
        // 旧実装は入力順に1件ずつ打ち、最初に0行だった id を名指しした——同じ id を指す。
        const failedId = ids.find((id) => !updatedById.has(id))!;
        throw await conflictAfterEmptyUpdate(tx, ctx, failedId, "contested");
      }

      // ADR 0381 決定3: `both_active`/`supersede` のどちらでも、このメンバー全員を
      // 結んでいた関係の行を双方向とも削除する——2者版 `resolveContestedPair` が
      // 決着の種類に関わらず常に `contested_with_id = NULL` へ戻すのと同じ扱いに
      // 揃える。「一度解消したら再び争わせない」印は作らない。
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
   * `docs/memory-model.md` §11 行15「`superseded → active`」。契約は
   * `MemoryStore.restoreSupersededBy`（`@mnemora/core`）側にある——ここはクエリの
   * 実装のみ。
   *
   * `archiveDecayed`（ADR 0114、本ファイル上部）と同じ理由で、UPDATE と INSERT を
   * 単一の `WITH ... UPDATE ... INSERT ... SELECT` 文にまとめてある——1文なら、
   * 明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る
   * （「片方だけ起きる」を構造的に作れない）。
   *
   * `target` の `WHERE` は既存の部分索引 `idx_memories_superseded_by`
   * （`tenant_id, superseded_by_id`、`migrations/0001_init.sql`）がそのまま担う——
   * 新しい索引は足していない。`AND status = 'superseded'` を等値条件として含めている。
   *
   * ⚠ **`restored` の `UPDATE ... FROM target t WHERE m.id = t.id` に、`m.status =
   * 'superseded' AND m.superseded_by_id = ${supersededById}` を明示的に重ねている
   * （`t` ではなく `m`——生きている行に対する条件）。** `target` はこの文の先頭で1度
   * 読んだスナップショットであり、READ COMMITTED の下では「`target` を読んでから
   * `restored` の UPDATE が実際にその行をロックするまでの間」に、別のトランザクションが
   * 同じ行を `superseded → forgotten`（`updateStatusWithEvent` 経由の forget 等）へ
   * 進めてコミットしうる。`m.id = t.id` だけを条件にすると、Postgres は EvalPlanQual で
   * 最新版の行を再取得したうえで**この UPDATE 自身の WHERE**を再評価するが、`target` の
   * 条件（`status = 'superseded'`）はその再評価に含まれない——`t.id` は既に確定した
   * 値の集合でしかないため。**その結果、直前に forget/purge でコミットされた行を
   * `active` へ巻き戻し、`unsuperseded` イベントを誤って積みうる（2接続での実測は
   * `packages/postgres/src/__tests__/restore-superseded-concurrent-forget.postgres.test.ts`）。**
   * `m.status`/`m.superseded_by_id` を UPDATE 自身の WHERE に重ねることで、EvalPlanQual が
   * 再評価する対象にこの2条件が入り、最新版の行が既に条件を満たさなくなっていれば
   * その行は `restored` から自然に落ちる（`archiveDecayed`/`requeueEmbedJobs` の
   * `FOR UPDATE SKIP LOCKED` とは別の形だが、狙いは同じ——「読んだ後に承知の外で
   * 状態が変わった行を、確認せずに書き換えない」）。
   *
   * `digest_snapshot` には（変更しない）現在の `digest` を入れる——`archiveDecayed`/
   * `forget` と同じ規約。`meta` は `{ reason, supersededById }`——`reason` は
   * 呼び出し側が渡した値、省略時は固定タグ `'unsuperseded'`（`updateStatusWithEvent`
   * を経由する操作の「省略時はキー自体を持たせない」規律とはここだけ意図的に違う。
   * interface 側の契約節参照）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: 指定すると `target` CTE に
   * `AND id = ANY(...)::uuid[]` を1行足すだけ——`digestBand.excludeMemoryIds`
   * （本ファイル上部、除外方向の同型パターン）を包含方向に転用しただけであり、
   * **新しい索引は要らない**（`memories.id` は既に `PRIMARY KEY`。
   * `idx_memories_superseded_by` による絞り込みの上に PK 条件を重ねるだけ）。
   */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string | undefined; actor?: EventActor | undefined; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ restored: Memory[] }> {
    assertWellFormedCtx(ctx);
    // 入口の正規化（`normalizeUuidCase`）。`meta.supersededById` に写す値を、列（`superseded_by_id`）の値と揃える。
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

    // Issue #1229 の行3: `at` が Invalid Date のとき、下の1文は対象が無くても `at` を `timestamptz` に変えて例外になる。
    // 戻す対象が無いなら、書くものが無いので testkit の fixture と同じく空で返す（例外の少ない側に揃えた。
    // クローン miku の判断であり、オーナーの判断ではない）。対象が在るときは、下の1文をそのまま流すので、
    // 今どおり同じ種類の例外になり、1件も戻さない。
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

    // ADR 0499: 下の1文が走る直前（Invalid Date の早期 return のあと）。`reason`・`actor` の NUL を名指しで断る。
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
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口
   * （Issue #515、ADR 0237。契約は `MemoryStore.previewRestoreSupersededBy`（`@mnemora/core`）
   * 側にある——ここはクエリの実装のみ）。
   *
   * `target` の `WHERE` は `restoreSupersededBy` の `target` CTE と**1文字も違わない**
   * ——同じ部分索引 `idx_memories_superseded_by` をそのまま使う。`UPDATE`/`INSERT` を
   * 一切持たない `SELECT` のみの文であり、`restoreSupersededBy` と違って
   * トランザクションを開始する必要も無い（読み取りが1文で完結する）。
   *
   * `latest_superseded_event` は、対象ごとに直近の `kind = 'superseded'` の
   * `memory_events` 行を1件選ぶ（`DISTINCT ON (memory_id) ... ORDER BY memory_id,
   * at DESC`）。**新しい索引を足していない**——`idx_memory_events_by_memory`
   * （`tenant_id, memory_id, at`）が `memory_id = 対象` を絞る側をそのまま担い、
   * `kind = 'superseded'` は結果に対する追加のフィルタ（この列だけを絞る索引は無いが、
   * 対象がまず `target` で絞られているため、走査量は「群のサイズ」に比例する——
   * テナント全体の `memory_events` を走査しない）。`meta->>'reason'` が無い
   * （行はあるが `reason` キーが無い）場合は SQL の `->>` が `NULL` を返し、
   * 対象について一致する行が1件も無い場合は `LEFT JOIN` により `NULL` になる——
   * この2つを呼び出し側から区別する必要は無い（`MemoryStore.previewRestoreSupersededBy`
   * の doc コメント「取れないことを正直に返す」参照。どちらも「取れない」の一種）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy` と
   * **1文字も違わない** `AND id = ANY(...)::uuid[]` を `target` CTE に足す——
   * 「対象の選び方を完全に一致させる」という既存の契約をここでも守る。
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
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * `listLabels?`（`@mnemora/core` の interface doc 参照）。
   *
   * Issue #881 / ADR 0318 追記（2026-09-26、クローン miku の判断）: `name` の並び順は
   * **コードポイント順**（バイト順）と決めた。`ORDER BY name`（COLLATE 指定なし）は
   * DB の既定の照合順序に従うため、既定が `C` でない DB（例: `en_US.utf8`）では
   * ロケール依存の自然順になりコードポイント順とずれる——`COLLATE "C"` を明示して
   * DB の既定ロケールに関わらず常にコードポイント順（バイト順）で返す。
   */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT * FROM labels WHERE tenant_id = ${ctx.tenantId} ORDER BY name COLLATE "C" ASC
    `);
    return result.rows.map((row) => rowToLabel(row as unknown as LabelRow));
  }

  /**
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * `registerLabel?`（`@mnemora/core` の interface doc 参照）。行が無ければ
   * `proposed_count: 0` の `registered` 行を作る。既に `proposed` なら `registered` へ
   * 更新し `registered_at` を今にする。既に `registered` なら `registered_at` を
   * 変えない——`COALESCE(labels.registered_at, now())` が「既存の値があればそれを保つ、
   * 無ければ今にする」を1つの UPSERT で表す。
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
   * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
   * `MemoryStore.eraseTenant?` の Postgres 実装。契約の全文は `@mnemora/core` の
   * interface doc（`packages/core/src/interfaces/memory-store.ts`）を見ること。
   *
   * ## 検査（`blocked_by_foreign_reference`）
   *
   * 削除と**同じトランザクションの先頭で**、他テナントの行がこのテナントの行を外部キーで
   * 参照していないかを数える（{@link countForeignReferences}）。参照の経路は表名を
   * 焼き込まず、`pg_constraint` から `current_schema()` の単一列の外部キーのうち、
   * 参照する側・される側の両方に `tenant_id` 列がある全部を数え上げる——
   * `memories` の自己参照（`superseded_by_id`/`contested_with_id`）・
   * `memories.source_observation_id`・`memory_events`/`recall_usages`/`memory_labels`
   * の参照に加え、**埋め込み空間の表（`memory_embeddings_<space>`、`ON DELETE CASCADE`）
   * も入る**。CASCADE の表を入れないと、他テナントの埋め込みの行が `memories` の削除に
   * 巻き込まれて黙って消える（「他テナントの行は書き換えない」に反する）。後から表が
   * 増えても（例: `memory_relations`）、外部キーを張っていれば自動で入る。
   *
   * 1件でもあれば、**1行も消さずに** `{ kind: "blocked_by_foreign_reference", count }`
   * を返す——`dryRun` でも同じ検査をする。検査と削除の間に他テナントが参照を作って
   * 外部キー違反（SQLSTATE 23503）になった場合は、トランザクションごとロールバック
   * されたうえで数え直し、`blocked_by_foreign_reference` を返す（数え直して0件なら、
   * 他テナント由来ではないので元の例外をそのまま投げる）。
   *
   * 数える問い合わせは、参照される側を `tenant_id = $1` で絞り、参照する側を外部キーの
   * 列で引く——`migrations/0027_erase_tenant_fk_indexes.sql` の単一列索引が効く向きである。
   *
   * ## 本体
   *
   * `dryRun` の有無に関わらず `db.transaction` で包む——複数の表にまたがる
   * budget（`opts.limit`）の消費を、1つの一貫したスナップショットの上で数えるため
   * （`purgeExpiredEventsByRetention` と同じ判断）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult> {
    assertWellFormedCtx(ctx);
    const dryRun = opts.dryRun === true;
    try {
      return await this.db.transaction(async (tx) => {
        // ADR 0430 決定2: 同じテナントへの同時呼び出しを直列にする。
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
   * {@link PostgresMemoryStore.eraseTenant} の本体。表ごとに budget（残りの削除可能数）を
   * 消費しながら、子→親の順（クラス外の interface doc「契約」の並びと同じ）で処理する。
   *
   * `dryRun` のときは `DELETE`/`UPDATE` を一切発行せず、`SELECT count(*)` で
   * 「削除していたら消えていたであろう件数」だけを数える——自己参照の `NULL` 化
   * （`memories` の手前）も dryRun では行わない（カウントには影響しないため）。
   *
   * `reachedLimit` は「ある表でちょうど budget 分だけ削除/カウントできた」ときに
   * `true` にする保守的な近似——実際にはその表にもう行が残っていなくても `true` に
   * なることがある。呼び直しても安全（次の呼び出しは0件で通過するだけ）。
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

    // 単一列 PK（id）の表向けの汎用ステップ。`table` はこの関数の呼び出し元がすべて
    // ハードコードした文字列リテラルであり、利用者入力ではない——`sql.identifier` は
    // ここでは「同じ形の文を表ごとに書き写さない」ための道具として使うだけである。
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

    // 1. memory_labels（memories・labels 両方の子。先に消す）
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

    // 2. recall_usages（recalls・memories 両方の子）
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

    // 3. memory_events（memories の子）
    await runStep(() => drainById("memory_events", remaining));

    // 3b. memory_relations（memories の子——`from_memory_id`/`to_memory_id` の両方が
    // `memories(id)` を参照する。Issue #207/#933 PR2、migration 0026）。`purgeMemory` は
    // この表に触れない（ADR 0381 決定10）が、テナントを丸ごと消すときは消す（ADR 0383）。
    await runStep(() => drainById("memory_relations", remaining));

    // 4. memories——削除の前に、このテナントの自己参照（superseded_by_id/contested_with_id）
    // を丸ごと NULL 化する。理由: `limit` で区切ったバッチをまたいで自己参照が残っていると
    // （このバッチで消す行を、まだ消していない別バッチの行が指している場合）、
    // `memories(id)` への FK（`ON DELETE` 指定なし＝既定の `NO ACTION`）が違反になる
    // （`MemoryStore.eraseTenant` interface doc の契約節を参照。CHECK 制約との整合は
    // `migrations/0001_init.sql` を読んで確認済み——`superseded_by_id`/`contested_with_id`
    // を含む CHECK は無い）。budget には数えない（削除ではないため）。dryRun では行わない
    // （カウントに影響しない）。
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

    // 5. observations（memories の親——source_observation_id の参照元である memories 行が
    // このテナントに1件でも残っていると、その行を消せば FK 違反になる。上のステップで
    // このテナントの memories が budget 不足で残っていれば、このステップの budget は
    // 既に0になっているため、`runStep` の冒頭チェックで何もしない）。
    await runStep(() => drainById("observations", remaining));

    // 6. recalls（recall_usages は既にステップ2で消えている）
    await runStep(() => drainById("recalls", remaining));

    // 7. labels（memory_labels は既にステップ1で消えている）
    await runStep(() => drainById("labels", remaining));

    // 8. tenant_activity（tenant_id が PK。高々1行）
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

    // 9. tenant_subject_activity（(tenant_id, subject_id) が PK。テナントあたり複数行ありうる）
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
 * ADR 0114 / [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15:
 * `archiveDecayed` が「どの行を archived にするか」を選ぶ `SELECT`。
 *
 * **本体と `EXPLAIN` の歯（`packages/postgres/src/__tests__/archive-decayed-index.test.ts`）
 * が、同じものを使うために切り出してある**——`buildRequeueEmbedTargetSelect`
 * （ADR 0079、直上）と同じ理由。テスト側に述語を書き写すと、本体の述語を直したときに
 * 歯だけが古い述語を測り続ける。
 *
 * `opts.clock` で述語を切り替える（省略時は `'wall'`、本 ADR 以前と1バイトも変わらない）:
 * - `'wall'`: `decay_floor_at <= opts.now`（既存索引 `idx_memories_recall_gate`
 *   `(tenant_id, status, decay_floor_at)` を使う——**新しい索引は追加しない**。
 *   `status = 'active'` は部分索引の述語 `status IN ('active','contested')` を含意する）。
 * - `'activity'`: `decay_floor_seq IS NOT NULL AND decay_floor_seq <= opts.nowSeq`
 *   （`idx_memories_recall_gate_seq` を使う。`opts.nowSeq` 必須）。
 * - `'either'`: **AND**（両方の軸で沈んでいるものだけ掃く。ゲートの `'either'` が OR
 *   なのとは逆——`ArchiveDecayedOptions.clock` の doc コメント「⭐」参照）。
 *
 * ⚠ **`decay_floor_at <= opts.now`・`decay_floor_seq <= opts.nowSeq`（どちらも境界を含む）。**
 * `VectorFilter.decayFloorAtAfter`/`decayFloorSeqAfter`
 * （`packages/core/src/interfaces/vector-store.ts`）は狭義の `>`（境界を含まない）——
 * この非対称は意図である（`ArchiveDecayedOptions.clock` の doc コメント「境界の非対称」参照）。
 *
 * ⚠ **`ORDER BY decay_floor_at ASC` は `'activity'`/`'either'` でもそのまま使う。**
 * `MemoryStore.archiveDecayed`/`ArchiveDecayedResult.archived` の doc コメントは
 * ADR 0165 導入後も「`decay_floor_at` 昇順」としか書いておらず（`decay_floor_seq` 順の
 * 契約は無い）、返り値の型 `{ memoryId; decayFloorAt: Date }` も `decayFloorSeq` を
 * 持たない——`decay_floor_at` は常に non-null なので、この列で安定した順序を作れる。
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
    // ADR 0353（Issue #338）: `usesSubjectActivityCounters` が true のときだけ、
    // `tenant_subject_activity` を相関サブクエリで足す。
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
    // 'either': 掃引は AND（両方の軸で沈んでいるものだけ掃く。ゲートの OR とは逆向き）。
    clockCondition = sql`(${wallCondition} AND ${activityCondition()})`;
  }

  // ⭐ [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと8:
  // **並べる軸は、掃く軸に合わせる。** `clock: 'activity'` のときに `decay_floor_at` で
  // 並べると、`idx_memories_recall_gate_seq`（`(tenant_id, status, decay_floor_seq)`）は
  // **並び替えを満たせないので選ばれず**、プランナは壁時計側の索引を走査して
  // `decay_floor_seq` を Filter に落とす——【実測】2026-09-16、CI の
  // `archive-decayed-index.test.ts`「適用可能性（活動時計）」が実際にこれで赤くなった
  // （EXPLAIN 逐語: `Filter: ((decay_floor_seq IS NOT NULL) AND (decay_floor_seq <= '20000'::bigint))`）。
  // ⟹ 活動軸で沈んだ行が疎なテナントでは、`limit` 件を見つけるまで壁時計順に大量の行を
  // 走査することになる。**正しさではなく処理量の問題である。**
  //
  // 意味論の上でも、活動時計のテナントで「いちばん沈んだものから掃く」なら、
  // 並べるべきは活動軸である。
  //
  // ⚠ **これは `ArchiveDecayedResult.archived` の並び順の契約を変えない。**
  // 呼び出し元（`archiveDecayed`）の外側のクエリが、返す行を常に
  // `ORDER BY decay_floor_at ASC, id ASC` に並べ直している。ここで変わるのは
  // 「`limit` が効くときに *どの行を選ぶか*」だけである。
  //
  // `'either'` は壁時計のまま——掃引の条件が AND（両方の軸で沈んだものだけ）であり、
  // どちらの索引も単独では述語を満たしきれない。ADR 決めたこと9 が `'either'` について
  // 「1本の btree で範囲スキャンできるとは主張しない」と書いているのと同じ理由である。
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
 * ADR 0079: `requeueEmbedJobs` が「どの行を積み直すか」を選ぶ `SELECT`。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**
 * `packages/postgres/src/__tests__/memories-requeue-embed-index.test.ts` がこの関数の
 * 返り値をそのまま `EXPLAIN` する——**テスト側に SQL を書き写すと、本体の述語を
 * 直したときに歯だけが古い述語を測り続ける**（`outbox-claim-lease-index.test.ts` が
 * DDL をマイグレーションファイルから読むのと同じ理由。AGENTS.md が北極星の要約を
 * 置かないのと同じ理由でもある）。
 *
 * ⚠ **`statuses` のどれにも当たる行が無い（全 status が0件の）ときは、0007 の索引を最後まで読み、
 * `ready` 以外の行を Filter で捨てて0行を返す**（走査の量はそのテナントの `ready` 以外の行数に比例する。
 * 100万行・約4%が `ready` 以外で温 約30 ms）。**測って、直さないと判断した**（ADR 0413。
 * 呼び出し元は手動の保守操作 `Runtime.reembed` だけ。第一候補の案 D と、覆る条件は同 ADR）。
 *
 * `memoryIds` を渡されたのに well-formed な id が1つも残らなかったときは `null` を返す
 * ——形式が壊れた id は `getMany` と同じく静かに落とす（uuid 列への cast で文全体が
 * 例外になるのを避ける。`mapping.ts` の `isUuidLike` の doc 参照）が、**絞り込みを
 * 渡されたのに残りが0件なら、それは空集合との積**であり、問い合わせる意味が無い。
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
 * Issue #210 / ADR 0115: `PostgresMemoryStore.purgeExpiredEvents` が「どの行を消すか」を
 * 選ぶ `SELECT`。**本体と `EXPLAIN` の歯が、同じものを使うために切り出してある**
 * （`buildRequeueEmbedTargetSelect` と同じ理由——テスト側に述語を書き写すと、本体の
 * 述語を直したときにその歯だけが古い述語を測り続ける）。
 *
 * `LIMIT opts.limit + 1` で1件多く取る——`reachedLimit`（「1回で消しきれなかった」）を
 * `purged === opts.limit` からの推測に頼らず、専用の信号として立てるため
 * （`packages/core/src/interfaces/memory-store.ts` の契約節参照）。
 *
 * ⚠ **`opts.limit` は0以上の整数を渡す前提であり、負数を渡したときの結果は未定義**
 * （`PurgeExpiredEventsOptions.limit` の doc 参照、Issue #876）。**この `+1` の算術ゆえに
 * `opts.limit === -1` だけは `LIMIT 0` になり例外にならない**——2026-09-26 実測
 * （PostgreSQL 17.11 + pgvector 0.8.0、`main` cb6d1db）で `purgeExpiredEvents(ctx,
 * { limit: -1, olderThan })` は `{ purged: 0, reachedLimit: true, oldestPurgedAt: null,
 * newestPurgedAt: null, dryRun }` を返した（`dryRun: true`/`false` とも同じ形）。
 * `reachedLimit: true` になるのは、この関数が返す0行に対して呼び出し側が
 * `rows.length > opts.limit`（`0 > -1`）で判定するため——**「1回で消しきれなかった」を
 * 意味する信号のはずが、ここでは取り違いを起こす**。`opts.limit <= -2` では
 * `LIMIT` に負数が渡り Postgres 自身が例外を投げる。**この `-1` の折れ方は狙って設計した
 * ものではなく、`+1` の算術が生んだ偶然である**——契約として真似る理由は無い
 * （採らなかった案は [ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)
 * の2026-09-26追記を参照）。
 *
 * `kind <> 'events_purged'` は `memory_events` に `(tenant_id, at)` の索引
 * （`migrations/0010_memory_events_retention_index.sql`）を張ったうえで Filter として
 * 残す——`kind` を索引に含めない（無限後退を避けるための除外は「対象の絞り込み」で
 * あり、行数の大半を削る述語ではないため、部分索引にする動機が薄い。実測は
 * `memory-events-retention-index.test.ts` 参照）。
 */
/** PostgreSQL の timestamptz の下限（4714-11-24 BC 00:00:00 UTC。天文学的年 -4713）。 */
const PG_TIMESTAMPTZ_MIN_MS = Date.UTC(-4713, 10, 24);

/**
 * `purgeExpiredEvents` が消す対象の `memory_events` の行を選ぶ SELECT を組み立てる（`kind <> 'events_purged'`、
 * `at < opts.olderThan`、古い順に `opts.limit + 1` 件——上限に届いたかを判定するために1件多く取る）。詳しい理由は、すぐ上の `PG_TIMESTAMPTZ_MIN_MS` の直前にある説明を見ること。
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
 * `purgeExpiredRecalls` が消す対象の `recalls` の行を選ぶ SELECT
 * （`created_at < opts.olderThan`、古い順に `opts.limit + 1` 件——上限に届いたかを判定するために1件多く取る）。
 * `lock` が真なら `FOR UPDATE` で行を掴む（削除するとき）。EXPLAIN の歯がこの関数の返り値を測る。
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

/**
 * 例外から SQLSTATE を取り出す。drizzle は pg のエラーを `cause` に包むことがあるため、
 * `cause` を辿る（`__tests__/foreign-key-violation.postgres.test.ts` の `sqlStateOf` と同じ形）。
 */
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
 * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
 * 他テナントの行が、テナント `tenantId` の行を外部キーで参照している件数を数える。
 *
 * 経路は `pg_constraint` から数え上げる（表名を焼き込まない）: `current_schema()` の中の
 * 単一列の外部キーで、参照する側・される側の両方に `tenant_id` 列があるもの全部。
 * 複数列の外部キー（`tenant_id` を含めればテナントを跨げない）と、`tenant_id` を持たない
 * 表からの参照は対象外（ADR 0383）。
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
