import {
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
} from "@mnemora/core";
import type { IdempotentCreateResult, NotIndexedReason } from "@mnemora/core";
import type {
  AggregateScopeOptions,
  ArchiveDecayedOptions,
  ArchiveDecayedResult,
  ClaimKey,
  Ctx,
  EmbeddingStatus,
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
  PurgeExpiredEventsOptions,
  PurgeExpiredEventsResult,
  RecallId,
  RecallRecord,
  RecallScope,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
  ScopeAggregate,
} from "@mnemora/core";
import { buildStoredMemoryEvent } from "./in-memory-event-store.js";
import { assertQueryDate, assertQueryInteger } from "./query-check.js";
import { assertCloneableMemoryEvent, assertStorableMemoryEvent } from "./memory-event-check.js";
import { assertStorableMemoryColumn } from "./memory-enum-check.js";
import { nextId } from "./id.js";

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
  memory: Pick<Memory, "decayFloorAt" | "decayFloorSeq">,
  scope: RecallScope,
): boolean {
  const { decayFloorAtAfter, decayFloorSeqAfter } = scope;
  if (decayFloorAtAfter === undefined && decayFloorSeqAfter === undefined) return false;
  const wallAlive =
    decayFloorAtAfter === undefined ? undefined : memory.decayFloorAt > decayFloorAtAfter;
  const activityAlive =
    decayFloorSeqAfter === undefined
      ? undefined
      : memory.decayFloorSeq === undefined ||
        memory.decayFloorSeq === null ||
        memory.decayFloorSeq > decayFloorSeqAfter;
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
  for (const [field, value] of [
    ["occurredAt", input.occurredAt],
    ["validFrom", input.validFrom],
    ["validUntil", input.validUntil],
  ] as const) {
    if (value != null && Number.isNaN(value.getTime())) {
      throw new Error(`InMemoryMemoryStore: ${field} must be a valid Date (got Invalid Date)`);
    }
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
  // 孤立サロゲート（Issue #816、実測）: この関数は検査しない。入力をそのまま
  // 保持する——`PostgresMemoryStore.createMemory` は node-postgres が静かに U+FFFD へ
  // 置換するため異なる値になる。この非対称は現状の契約として
  // `MemoryStore.createMemory` の interface doc コメントに記録してある
  // （`packages/core/src/interfaces/memory-store.ts`）。挙動は変えない。
}

/**
 * `MemoryStore` のインメモリ実装（`@mnemora/testkit/fixtures`）。適合スイートと単体テストの入力に使う。
 * 契約は `@mnemora/core` の `MemoryStore` の各メソッドの doc が正で、Postgres が拒む値はこの fixture も拒む
 * （列挙に無い値・NUL・値域の外の数など）。拒むときは何も書かない。
 *
 * status を書く口が投げる名前の付いたエラー（`MemoryStatusConflictError`・`ContestedWithoutCompanionError`）は、
 * 各メソッドの doc に書いてある。
 */
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
   * Issue #201 / ADR 0318: `labels` 相当のインメモリ表。key は {@link labelKey}。
   * `PostgresMemoryStore.upsertProposedLabels`/`listLabels`/`registerLabel` と同じ意味論
   * （`docs/memory-model.md` §8）を、`Map` の上でそのまま再現する。
   */
  private readonly labels = new Map<string, LabelSummary>();

  /**
   * `(tenantId, name)` を区切り文字で繋がず、`JSON.stringify` の配列で表す。`tenantId` は不透明な
   * 文字列で `::` を含んでよい（`Ctx` の doc）。以前の `${tenantId}::${name}` は、テナント `a::b` の
   * `x` とテナント `a` の `b::x` を同じキーに潰していた（`labels-tenant-key.postgres.test.ts`）。
   */
  private labelKey(tenantId: string, name: string): string {
    return JSON.stringify([tenantId, name]);
  }

  /**
   * Issue #201 / ADR 0318: `PostgresMemoryStore.upsertProposedLabels` と同じ契約——
   * 新しく作った Memory の `tags`（重複は `Set` で潰す）から `proposed` ラベルを作り・
   * `proposedCount` を数える。`status === 'registered'` のラベルは件数を進めない。
   * `createMemoryIdempotent` の「新しい行を実際に作った」分岐からだけ呼ぶ
   * （冪等衝突では呼ばない——postgres 実装と同じ判断）。
   */
  private upsertProposedLabels(ctx: Ctx, tags: readonly string[]): void {
    const uniqueNames = Array.from(new Set(tags));
    for (const name of uniqueNames) {
      const key = this.labelKey(ctx.tenantId, name);
      const existing = this.labels.get(key);
      if (existing === undefined) {
        this.labels.set(key, { name, status: "proposed", proposedCount: 1, registeredAt: null });
        continue;
      }
      if (existing.status === "proposed") {
        this.labels.set(key, { ...existing, proposedCount: existing.proposedCount + 1 });
      }
      // status === 'registered' の場合は件数を進めない（postgres 実装と同じ）。
    }
  }

  /**
   * ADR 0054: 「既存を引く」と「挿入する」を1つの同期区間に閉じ、`created` をその判定
   * そのものから出す。**`await` を挟まない**——挟むと判定と挿入の間に他の呼び出しの
   * 同期区間が入り、`created` が別の書き込みの影響を受ける。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
  ): IdempotentCreateResult<Observation> {
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
      // Issue #1108: 呼び手の入力（payload・attributes・Date）と切り離して保存する。
      const stored = snapshot(observation);
      this.observations.set(stored.id, stored);
      return stored;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    return snapshot(this.createObservationIdempotent(ctx, input).value);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    const observation = this.observations.get(id);
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return snapshot(observation);
  }

  private enqueueOutboxJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
  ): OutboxJobRecord {
    const job: OutboxJobRecord = {
      id: nextId("job"),
      tenantId: ctx.tenantId,
      kind,
      payload,
      availableAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      attempts: 0,
      completedAt: null,
      failedAt: null,
      lastError: null,
      createdAt: new Date(),
    };
    this.outboxJobs.push(job);
    return job;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const { value: observation, created } = this.createObservationIdempotent(ctx, input);
    if (!created) {
      return { observation: snapshot(observation), created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueOutboxJob(ctx, kind, { observationId: observation.id }),
    );
    return snapshot({ observation, created: true, jobs });
  }

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから
   * 出す（`createObservationIdempotent` と同じ理由）。
   */
  private createMemoryIdempotent(
    ctx: Ctx,
    input: NewMemory,
    method: "createMemory" | "createMemoryWithOutbox" = "createMemory",
  ): IdempotentCreateResult<Memory> {
    // ADR 0140: createMemory/createMemoryWithOutbox 共通の入口。PostgresMemoryStore の
    // createMemory と同じ位置（何も書く前）で落とす——冪等衝突の判定より前に見る。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError(method, null);
    }
    // 書ける値かの検査は、冪等の衝突の判定より前に置く。Postgres の `INSERT ... ON CONFLICT DO NOTHING`
    // は、衝突を見る前に行の値を型に変換し CHECK 制約を当てるので、同じ鍵の既存の行が在っても拒む（実測）。
    // 外部キー相当の検査（下の `resolveIdempotentCreate` の中）は、行を実際に書くときにだけ当たるので中に残す。
    assertStorableNewMemory(input);
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
      // 外部キー相当（0001_init.sql）: `memories.source_observation_id` /
      // `superseded_by_id` / `contested_with_id` は、非 null なら実在する行を指さなければ
      // ならない。`packages/postgres` は実際の外部キー制約でこれを強制するが、この
      // in-memory 実装は `Map` の生成物にすぎず、参照整合性を放置すると「本番では起きない
      // 書き込みが手元では黙って成功する」（ADR 0047）。**「存在」だけを見る——一対一等の
      // 整合までは踏み込まない（`contested_with_id` が双方向かどうかはここでは見ない）。**
      // 空文字も参照として扱う（`null`/`undefined` だけが「参照しない」）——Postgres は空文字を uuid として読めずに拒む。
      if (input.sourceObservationId != null && !this.observations.has(input.sourceObservationId)) {
        throw new Error(
          `InMemoryMemoryStore: source observation not found: ${input.sourceObservationId}`,
        );
      }
      if (input.supersededById != null && !this.memories.has(input.supersededById)) {
        throw new Error(
          `InMemoryMemoryStore: superseded-by memory not found: ${input.supersededById}`,
        );
      }
      if (input.contestedWithId != null && !this.memories.has(input.contestedWithId)) {
        throw new Error(
          `InMemoryMemoryStore: contested-with memory not found: ${input.contestedWithId}`,
        );
      }

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
        supersededById: input.supersededById ?? null,
        contestedWithId: input.contestedWithId ?? null,
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
        strength: input.strength,
        halfLifeHours: input.halfLifeHours,
        decayFloorAt: input.decayFloorAt,
        // ADR 0165（Issue #305）: 活動時計の3つ組。省略可能なフィールドなので `?? null` で
        // 転記しないと `undefined` のまま消える——これが前任の作業者が実際に踏んだ漏れ1
        // （core commit 5e37afb の doc 参照）。ここで同じ漏れを作らない。
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
      this.upsertProposedLabels(ctx, stored.tags);
      return stored;
    });
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    return snapshot(this.createMemoryIdempotent(ctx, input).value);
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const { value: memory, created } = this.createMemoryIdempotent(
      ctx,
      input,
      "createMemoryWithOutbox",
    );
    if (!created) {
      return { memory: snapshot(memory), created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) => this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }));
    return { memory: snapshot(memory), created: true, jobs: snapshot(jobs) };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
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
    const memory = this.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    // `PostgresMemoryStore.getMany` は `WHERE id = ANY(...)` という集合演算で引く
    // （実測）。同じ id が `ids` に複数回含まれていても、一致する行は主キーの性質上
    // 1回しか無いため、返る件数は**一意な id の数**にしかならない。ここで検査せず
    // 単純にループで push すると、同じ id の Memory オブジェクトを重複して返して
    // しまう（実測: Postgres は `getMany([x,x,y])` に対し2件、素朴なループ実装は
    // 3件を返す）。呼び出し済みの id は2回目以降スキップし、Postgres の集合演算と
    // 同じ「一意な id の集合」に揃える。
    const seen = new Set<MemoryId>();
    const results: Memory[] = [];
    for (const id of ids) {
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
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== observationId) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
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
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    // ADR 0140: この口には contestedWithId を渡す引数が無いため、status: 'contested' への
    // 書き込みは常に単独になる。PostgresMemoryStore と同じ位置（対象の存在確認より前）で
    // 落とす。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない（`memories.superseded_by_id → memories(id)`）。
    if (opts?.supersededById !== undefined && !this.memories.has(opts.supersededById)) {
      throw new Error(
        `InMemoryMemoryStore: superseded-by memory not found: ${opts.supersededById}`,
      );
    }
    assertStorableMemoryColumn("status", status);
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
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
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    // ADR 0140: updateStatus と同じ理由・同じ位置。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: updateStatus と同じ理由・同じ検査。
    if (opts.supersededById !== undefined && !this.memories.has(opts.supersededById)) {
      throw new Error(
        `InMemoryMemoryStore: superseded-by memory not found: ${opts.supersededById}`,
      );
    }
    assertStorableMemoryColumn("status", status);
    assertStorableMemoryEvent(event);
    assertCloneableMemoryEvent(event);
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
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
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }> {
    // 1. 事前検証——まだ何も書いていないうちに投げる（news の作成も含め、何も起きな
    //    かったのと同じに見せる）。⛔ 3種類の失敗を1つに潰さない（ADR 0100）。
    for (const target of supersede) {
      assertStorableMemoryEvent(target.event);
      // 1a. 呼び手が壊れた索引を渡した（RangeError。conflicted にも not found にも混ぜない）。
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `InMemoryMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
      // 1b. 対象の行がそもそも無い。
      const memory = this.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${target.id}`);
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
    const willSupersede = new Set<MemoryId>();
    for (const target of supersede) {
      const status = willSupersede.has(target.id)
        ? "superseded"
        : this.memories.get(target.id)!.status;
      if (target.expectedStatus !== undefined && status !== target.expectedStatus) {
        continue;
      }
      assertCloneableMemoryEvent(target.event);
      willSupersede.add(target.id);
    }

    // 2. news を作る（`createMemoryWithOutbox` と同じ経路）。
    //    ⚠ 書ける値か・外部キー相当の検査は `createMemoryIdempotent` の中にあり、2件目以降で投げうる
    //    ——そのときは、この呼び出しで先に作った Memory・冪等キー・outbox・ラベルを取り消して、
    //    何も起きなかったのと同じに見せる（Postgres は1トランザクションで巻き戻る）。
    const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];
    const outboxLengthBefore = this.outboxJobs.length;
    const labelsBefore = new Map(this.labels);
    const extractionIndexBefore = new Map(this.extractionIndex);
    try {
      for (const { input, jobKinds } of news) {
        const { value: memory, created: wasCreated } = this.createMemoryIdempotent(ctx, input);
        if (!wasCreated) {
          created.push({ memory, created: false, jobs: [] });
          continue;
        }
        const jobs = jobKinds.map((kind) =>
          this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }),
        );
        created.push({ memory, created: true, jobs });
      }
    } catch (err) {
      for (const entry of created) {
        if (entry.created) {
          this.memories.delete(entry.memory.id);
        }
      }
      this.outboxJobs.splice(outboxLengthBefore);
      this.labels.clear();
      for (const [key, value] of labelsBefore) this.labels.set(key, value);
      this.extractionIndex.clear();
      for (const [key, value] of extractionIndexBefore) this.extractionIndex.set(key, value);
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
      if (target.expectedStatus !== undefined && memory.status !== target.expectedStatus) {
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

    return snapshot({ created, superseded, conflicted });
  }

  /**
   * Issue #210 / ADR 0115: `events` 配列（`InMemoryEventStore` と共有、ADR 0031）から
   * 期限切れの行を消す。`EventStore`（`InMemoryEventStore`）のメソッドは一切呼ばない
   * ——append-only の型に触れず、`events` 配列を直接操作する
   * （`PostgresMemoryStore.purgeExpiredEvents` が `PostgresEventStore` を経由せず
   * `memory_events` へ直接 SQL を発行するのと同じ形）。
   *
   * `kind = 'events_purged'` の行は対象から除外する（無限後退を避ける、interface doc
   * 参照）。`at` 昇順に並べ替えてから `opts.limit` 件（+1件、`reachedLimit` 判定用）を
   * 見る。`dryRun` のときは `this.events` を一切変更しない。
   */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
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
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
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
  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
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
    // 起点（lastReinforcedAt ?? recordedAt）より新しい at のときだけ書く（Issue #1093）。未強化の
    // 記憶では作成時刻が起点なので、それより前・ちょうどの at は、活動時計の欄も含めて何も書かない。
    if ((memory.lastReinforcedAt ?? memory.recordedAt).getTime() >= at.getTime()) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return snapshot(memory);
    }
    memory.lastReinforcedAt = new Date(at);
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      memory.decayBaseSeq = opts.nowSeq;
      memory.decayFloorSeq = defaultActivityDecayStrategy.floorAt({
        baseSeq: opts.nowSeq,
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
    if (!this.recalls.has(recallId)) {
      throw new Error(`InMemoryMemoryStore: recall not found: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      if (!this.memories.has(memoryId)) {
        throw new Error(`InMemoryMemoryStore: memory not found: ${memoryId}`);
      }
    }

    const insertedMemoryIds: MemoryId[] = [];
    for (const memoryId of memoryIds) {
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
    // 条件の日時・通し番号は Postgres の型へ変換できなければならない（query-check.ts）。
    assertQueryDate("aggregateScope", "occurredAfter", scope.occurredAfter);
    assertQueryDate("aggregateScope", "occurredBefore", scope.occurredBefore);
    assertQueryDate("aggregateScope", "validAt", scope.validAt);
    assertQueryDate("aggregateScope", "decayFloorAtAfter", scope.decayFloorAtAfter);
    assertQueryInteger("aggregateScope", "decayFloorSeqAfter", scope.decayFloorSeqAfter);
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
    // 目次帯の候補（ADR 0073）: totalInScope に数える条件と**同じ条件**で in-scope の
    // Memory を集める。`digestBand` が要求されなかった場合はこの配列を使わない。
    const inScopeMemories: Memory[] = [];

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
      // ここに来るのは status IN ('active','contested') のみ。

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        filteredPeriod += 1;
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
      // Issue #201 PR-B（[ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
      // taxonomy ゲート。`attributes`（上）とは違い `period`/`validity` と同じ側
      // ——`totalInScope` から除かれ、かつ `filtered*` に数えられる
      // （`PostgresMemoryStore.aggregateScope` の `has_qualifying_label` と同じ意味論）。
      if (scope.labels !== undefined) {
        const labels = scope.labels;
        const hasQualifyingLabel = memory.tags.some((tag) => labels.includes(tag));
        if (!hasQualifyingLabel) {
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
      if (isDecayedForScope(memory, scope)) {
        filteredDecayed += 1;
      }
      const key = memory.subjectId ?? null;
      inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
      if (memory.embeddingStatus !== "ready") {
        notIndexed[memory.embeddingStatus] += 1;
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

    // Issue #201 PR-B（ADR 0323「決定5」）: `scope.taxonomyGroupCandidates` が渡された
    // ときだけ `axis: 'taxonomy'` の群を足す——`PostgresMemoryStore.aggregateScope` の
    // `taxonomy_label_groups`/`taxonomy_residual_count` と同じ意味論（`inScopeMemories` は
    // 既に `has_qualifying_label` を含む最終スコープなので、`hasQualifyingLabel`
    // フィルタと同じ内側を数える）。カウント0のラベル・残差は載せない
    // （`axis: 'subject'` の `in_scope > 0` と同じ規約）。
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
      const exclude = new Set(opts.digestBand.excludeMemoryIds);
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順
      // （ADR 0073、`FakeMemoryStore.aggregateScope` と同じ規則）。
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
    const id = nextId("rcl");
    this.recalls.set(id, { ...snapshot(record), tenantId: ctx.tenantId, createdAt: new Date() });
    if (record.advanceActivityClock === true) {
      const current = this.activitySeq.get(ctx.tenantId) ?? 0;
      this.activitySeq.set(ctx.tenantId, current + 1);
    }
    return id;
  }

  /**
   * Issue #298 / [ADR 0155](../../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
   * `createRecall` が書いた行を `recallId` から読み戻す。`PostgresMemoryStore.getRecall` と
   * 同じ契約——テナントが一致しない、または見つからなければ `null`。
   */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
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
  async requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
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
    const idFilter = opts.memoryIds === undefined ? null : new Set<string>(opts.memoryIds);
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

    const memoryIds: MemoryId[] = [];
    for (const memory of targets) {
      memory.embeddingStatus = "pending";
      memory.updatedAt = new Date();
      this.enqueueOutboxJob(ctx, "embed", { memoryId: memory.id });
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
    // 条件の日時・通し番号は Postgres の型へ変換できなければならない（query-check.ts）。
    assertQueryDate("archiveDecayed", "now", opts.now);
    assertQueryInteger("archiveDecayed", "nowSeq", opts.nowSeq);
    // `PostgresMemoryStore.archiveDecayed`（`buildArchiveDecayedTargetSelect`）は
    // `opts.limit` を生 SQL の `LIMIT`（bigint パラメータ）にそのまま渡すため、負数・
    // `NaN`・`Infinity`・非整数を渡すと Postgres 自身が例外を投げる（実測:
    // `LIMIT must not be negative` / `invalid input syntax for type bigint: "NaN"` 等。
    // Issue #880）。ここで検査せず `.slice(0, Math.max(0, opts.limit))` へ渡すと、
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
    const passesActivity = (m: Memory): boolean => {
      if (opts.nowSeq === undefined) {
        throw new Error(
          `InMemoryMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
        );
      }
      const decayFloorSeq = m.decayFloorSeq ?? null;
      return decayFloorSeq !== null && decayFloorSeq <= opts.nowSeq;
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
    return { archived, reachedLimit: archived.length === opts.limit };
  }

  /**
   * Issue #198 / ADR 0124: `forgotten` かつ未 purge（`purgedAt === null`）の Memory だけを
   * 対象にした CAS——`content`/`digest` をトゥームストーンで上書きし `purgedAt` を設定した上で
   * `kind: 'purged'` のイベントを積む。`status` は動かさない（`purged` は `status` の値では
   * ない）。条件を満たさなければ {@link MemoryPurgeConflictError} を投げる（`updateStatus`/
   * `updateStatusWithEvent` と同じ「まだ何も書いていないうちに判定する」作法）。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    const memory = this.rawGet(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (memory.status !== "forgotten" || (memory.purgedAt ?? null) !== null) {
      throw new MemoryPurgeConflictError(id, memory.status, memory.purgedAt ?? null);
    }
    assertStorableMemoryEvent(event);
    assertCloneableMemoryEvent(event);
    memory.content = tombstone.content;
    memory.digest = tombstone.digest;
    memory.purgedAt = new Date();
    memory.updatedAt = new Date();
    const storedEvent = buildStoredMemoryEvent(ctx, event);
    this.events.push(storedEvent);
    return snapshot({ memory, event: storedEvent });
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
    if (firstMemory.status !== "contested" || firstMemory.contestedWithId !== second.id) {
      throw new MemoryStatusConflictError(first.id, "contested", firstMemory.status);
    }
    if (secondMemory.status !== "contested" || secondMemory.contestedWithId !== first.id) {
      throw new MemoryStatusConflictError(second.id, "contested", secondMemory.status);
    }

    assertStorableMemoryColumn("status", first.status);
    assertStorableMemoryColumn("status", second.status);
    assertStorableMemoryEvent(first.event);
    assertStorableMemoryEvent(second.event);
    assertCloneableMemoryEvent(first.event);
    assertCloneableMemoryEvent(second.event);
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
    const memory = this.rawGet(ctx, survivor.id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${survivor.id}`);
    }
    if (memory.status !== "contested" || memory.contestedWithId !== survivor.contestedWithId) {
      throw new MemoryStatusConflictError(survivor.id, "contested", memory.status);
    }

    assertStorableMemoryEvent(survivor.event);
    assertCloneableMemoryEvent(survivor.event);
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
    // 条件の日時は Postgres の timestamptz へ変換できなければならない（query-check.ts）。
    assertQueryDate("findActiveByClaimKey", "validFrom", query.validFrom);
    assertQueryDate("findActiveByClaimKey", "validUntil", query.validUntil);
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    const matches = [...this.memories.values()].filter((m) => {
      if (m.tenantId !== ctx.tenantId) return false;
      if (m.id === query.excludeMemoryId) return false;
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
      // 半開区間 [validFrom, validUntil) の重なり判定。`null` は -∞/+∞ として扱う
      // （`packages/postgres` の実装と同じ規約）。
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      const overlaps =
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
    return [...latestByPredicate.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, query.limit)
      .map(([predicate]) => predicate);
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
    event: { reason?: string; actor?: EventActor; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ restored: Memory[] }> {
    const onlyMemoryIds = filter?.onlyMemoryIds;
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
    // 確かめない（投げる入力を増やさない。Postgres は対象が無くても Invalid Date の `at` を拒む——
    // 投げるかどうかの違いとして残る）。
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
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    const onlyMemoryIds = filter?.onlyMemoryIds;
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
    if (name.includes("\u0000")) {
      throw new Error(`InMemoryMemoryStore: label name must not contain NUL characters (U+0000)`);
    }
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
