import type { ClaimKey } from "../claim-key.js";
import { matchesStoreErrorKind } from "../store-error-kind.js";
import type { Ctx } from "../ctx.js";
import type { EventActor, MemoryEvent, NewMemoryEvent } from "../event.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { ProvenanceKind } from "../provenance.js";
import type { OutboxJobRecord } from "../outbox.js";
import type {
  NewRecallRecord,
  NotIndexedReason,
  RecallRecord,
  RecallScope,
  ScopeAggregate,
} from "../recall.js";
import type { OutboxJobKind } from "./scheduler.js";
import type { DecayClock } from "./tenant-settings-store.js";

/**
 * `updateStatus` に `opts.expectedStatus` を渡したとき、書き込み時点の実際の status が
 * それと一致しなかったことを表す（ADR 0030）。呼び出し側が「対象が無かった」と区別できる専用の型。
 * 判定は `instanceof` ではなく {@link isMemoryStatusConflictError} で行う（ADR 0418）。
 *
 * **`observedStatus` は「弾かれた後に読み直した値」であり、弾かれた瞬間の値とは限らない。**
 * 読み直しと条件が破れた瞬間の間に別の書き込みが割り込みうる。「衝突があったこと」は確実だが、
 * 「衝突した相手が何だったか」の正確な値としては読まないこと。
 *
 * **purge 済みの記憶（`status` が `"forgotten"` のまま `purgedAt` が入った行）への、`expectedStatus` 付きの
 * 更新は、この例外で断られる**（ADR 0499）。そのとき `observedStatus` は `"forgotten"` であり、
 * `expectedStatus: "forgotten"` なら両方が `"forgotten"` になる。**例外を見ただけでは「purge 済みだから
 * 断られた」とは分からない**。purge 済みかどうかは、記憶を読み直して `Memory.purgedAt` を見ること。
 * （`purge` 自身の CAS 違反は別の型 {@link MemoryPurgeConflictError} である。）
 */
export class MemoryStatusConflictError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isMemoryStatusConflictError} で行う。 */
  readonly kind = "memory_status_conflict" as const;
  constructor(
    readonly memoryId: MemoryId,
    readonly expectedStatus: MemoryStatus,
    readonly observedStatus: MemoryStatus | null,
  ) {
    super(
      `MemoryStore: expected status "${expectedStatus}" for memory ${memoryId}, ` +
        `but observed ${observedStatus === null ? "(memory disappeared)" : `"${observedStatus}"`}` +
        " — the write was rejected because the memory was not in the expected status" +
        " (for example, another write changed it first). Re-read the memory and decide again" +
        " instead of retrying blindly.",
    );
    this.name = "MemoryStatusConflictError";
  }
}

/**
 * 受け取ったものが {@link MemoryStatusConflictError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isMemoryStatusConflictError(value: unknown): value is MemoryStatusConflictError {
  return matchesStoreErrorKind(value, "memory_status_conflict", "MemoryStatusConflictError");
}

/**
 * `MemoryStore.resolveContestedGroup?` の CAS のうち、「渡された `members` が、`memory_relations` で
 * つながった今も `contested` な群の全員と一致すること」が破れたときに投げる（ADR 0381）。
 *
 * 🔴 **`MemoryStatusConflictError` を再利用しない。**「この id 自身の状態は問題ないが、群の全員として
 * 含まれていなかった」は、`MemoryStatusConflictError` の意味（期待と違う値を観測した）とは異なる
 * （`MemoryPurgeConflictError` も同じ理由で専用の型）。
 *
 * `missingMemberId` は、`members` から `kind: 'contradicts'` を辿った到達集合のうち `status === 'contested'`
 * なのに `members` に無かった id を1件だけ名指しする（複数欠けていても最初の1件）。
 *
 * `Runtime.resolveContestedGroup?` はこの例外を `{ kind: "ineligible", ... }` に写す
 * （`MemoryStatusConflictError` の `conflict` とは別の分岐）。
 */
export class ContestedGroupMembershipMismatchError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isContestedGroupMembershipMismatchError} で行う。 */
  readonly kind = "contested_group_membership_mismatch" as const;
  constructor(readonly missingMemberId: MemoryId) {
    super(
      `MemoryStore.resolveContestedGroup: the members passed do not match the full set of ` +
        `the memory_relations-connected group that is still status="contested" ` +
        `(missing member: ${missingMemberId}). Nothing was written — pass the complete group ` +
        "(use RelationStore.listRelated to discover the rest, then filter to status='contested').",
    );
    this.name = "ContestedGroupMembershipMismatchError";
  }
}

/**
 * 受け取ったものが {@link ContestedGroupMembershipMismatchError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isContestedGroupMembershipMismatchError(
  value: unknown,
): value is ContestedGroupMembershipMismatchError {
  return matchesStoreErrorKind(
    value,
    "contested_group_membership_mismatch",
    "ContestedGroupMembershipMismatchError",
  );
}

/**
 * `createMemoryWithOutbox`/`supersedeWithNewMemories`/`createMemoriesWithOutboxAndEvents` の
 * `opts.abortIfForgotten` に渡した id のうち、書き込みの直前に見直して1件でも `status === "forgotten"`
 * （`forget()` のみ・`forget()` の後 `purge()` のどちらも含む）だったときに投げる（ADR 0375 決定7、ADR 0416）。
 *
 * **投げられた時点で、この呼び出しは一切何も書いていない**——`news` も `supersede` も rollback される。
 * `opts.abortIfForgotten` を渡さなかった呼び出しでは、この例外は投げられない。
 *
 * `forgottenIds` は「見直した時点で forgotten だった id」の一覧。`abortIfForgotten` の部分集合であり、
 * 渡した順序を保つ保証は無い。
 *
 * 🔴 **`opts.abortIfForgotten` を実装するかは adapter ごとに違う。**`@mnemora/postgres` は見直しを書き込みと
 * 同一トランザクションで行う。`InMemoryMemoryStore`（`@mnemora/testkit`）と core のテスト用 `FakeMemoryStore` は
 * 受け取らず（実装せず）、呼び出し側（`runtime.consolidate`/`runtime.reflect`）が書き込みの直前に行う
 * `getMany` の見直しだけが保護になる。この2つの見直しの間には小さな窓が残る
 * （`Runtime.consolidate`/`Runtime.reflect` の doc、`docs/memory-model.md`）。
 */
export class SourceMemoryForgottenError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isSourceMemoryForgottenError} で行う。 */
  readonly kind = "source_memory_forgotten" as const;
  constructor(
    readonly method:
      "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents" | "supersedeWithNewMemories",
    readonly forgottenIds: MemoryId[],
  ) {
    super(
      `MemoryStore.${method}: aborted — ${forgottenIds.length} of the memories listed in ` +
        `opts.abortIfForgotten were forgotten (forgottenIds: ${forgottenIds.join(", ")}). ` +
        "Nothing was written (news and supersede both rolled back).",
    );
    this.name = "SourceMemoryForgottenError";
  }
}

/**
 * 受け取ったものが {@link SourceMemoryForgottenError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isSourceMemoryForgottenError(value: unknown): value is SourceMemoryForgottenError {
  return matchesStoreErrorKind(value, "source_memory_forgotten", "SourceMemoryForgottenError");
}

/**
 * ADR 0420: `createMemoryWithOutbox`/`supersedeWithNewMemories`/`createMemoriesWithOutboxAndEvents` の
 * `opts.abortIfSuperseded`（に渡した id の1件以上が、書き込みの直前に見直したら `status === "superseded"`
 * だった）、または `supersedeWithNewMemories` の `opts.abortIfAllConflicted`（`supersede` の対象が
 * **すべて** CAS に弾かれた）のときに投げる。{@link SourceMemoryForgottenError} の superseded・全件 CAS 弾かれ版。
 *
 * **投げられた時点で、この呼び出しは一切何も書いていない**——`news`・`supersede`・`created` イベントも
 * rollback される。どちらの欄も渡さなかった呼び出しでは、この例外は投げられない。
 *
 * `changed` は「見直した時点で `active` でなかった（弾いた）id と、そのとき見えた `status`」の一覧。
 * `abortIfSuperseded` の場合は superseded だったものだけ、`abortIfAllConflicted` の場合は
 * 弾かれた全件が入る。渡した順序を保つ保証は無い。
 *
 * 🔴 この欄を実装しない adapter は渡されても無視する。そのとき保護になるのは呼び出し側（runtime）の
 * 「LLM 呼び出しの直後の読み直し」だけである（残る窓あり）。`@mnemora/postgres` と testkit の
 * `InMemoryMemoryStore` は実装する。
 */
export class SourceMemoryStatusChangedError extends Error {
  /** 判別子。分岐は `instanceof` ではなく {@link isSourceMemoryStatusChangedError} で行う（ADR 0418）。 */
  readonly kind = "source_memory_status_changed" as const;
  constructor(
    readonly method:
      "createMemoryWithOutbox" | "createMemoriesWithOutboxAndEvents" | "supersedeWithNewMemories",
    readonly changed: Array<{ id: MemoryId; observedStatus: MemoryStatus }>,
  ) {
    super(
      `MemoryStore.${method}: aborted — ${changed.length} source memories were no longer active ` +
        `(${changed.map((c) => `${c.id}:${c.observedStatus}`).join(", ")}) under ` +
        "opts.abortIfSuperseded / opts.abortIfAllConflicted. " +
        "Nothing was written (news and supersede both rolled back).",
    );
    this.name = "SourceMemoryStatusChangedError";
  }
}

/**
 * 受け取ったものが {@link SourceMemoryStatusChangedError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 */
export function isSourceMemoryStatusChangedError(
  value: unknown,
): value is SourceMemoryStatusChangedError {
  return matchesStoreErrorKind(
    value,
    "source_memory_status_changed",
    "SourceMemoryStatusChangedError",
  );
}

/**
 * `status: 'contested'` を**対向（`contestedWithId`）無しで**書き込もうとしたときに、`updateStatus` /
 * `updateStatusWithEvent` / `createMemory` / `createMemoryWithOutbox` /
 * `supersedeWithNewMemories`（`news` 側）が投げる（[ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)）。
 *
 * `updateStatus`/`updateStatusWithEvent` には `contestedWithId` を渡す引数が無いため、この2メソッドで
 * `status: 'contested'` を対象にした呼び出しは**常に**この例外になる。`createMemory` 系は
 * `input.contestedWithId` が `null`/`undefined` のときにだけこの例外になる。**対向を明示した作成
 * （既存の Memory を指す `contestedWithId` 付き）は許される**——相互ペアの構成までは保証しない
 * （ADR 0046）。
 *
 * **`status: 'contested'` を正しく（両側 CAS・相互参照・同一トランザクション）書く唯一の口は
 * `markContestedPair`（任意メソッド、ADR 0134）である。**この例外を受け取った呼び出し元は、
 * `markContestedPair` の実装有無を確認して使うこと。
 */
export class ContestedWithoutCompanionError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。判定は `instanceof` ではなく {@link isContestedWithoutCompanionError} で行う。 */
  readonly kind = "contested_without_companion" as const;
  constructor(
    readonly method:
      | "updateStatus"
      | "updateStatusWithEvent"
      | "createMemory"
      | "createMemoryWithOutbox"
      | "createMemoriesWithOutboxAndEvents"
      | "supersedeWithNewMemories",
    readonly memoryId: MemoryId | null,
  ) {
    super(
      `MemoryStore.${method}: writing status "contested" without a companion ` +
        `(contestedWithId) is rejected` +
        (memoryId !== null ? ` (memoryId: ${memoryId})` : " (at creation time)") +
        `. Use markContestedPair to create a mutually-contested pair (ADR 0134 / ADR 0140).`,
    );
    this.name = "ContestedWithoutCompanionError";
  }
}

/**
 * 受け取ったものが {@link ContestedWithoutCompanionError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isContestedWithoutCompanionError(
  value: unknown,
): value is ContestedWithoutCompanionError {
  return matchesStoreErrorKind(
    value,
    "contested_without_companion",
    "ContestedWithoutCompanionError",
  );
}

/**
 * ADR 0435: `@mnemora/postgres` が、claim key（`claimKey.subject`・`claimKey.predicate`）を入れる btree 索引の
 * 1行の上限（SQLSTATE 54000）を超えたときに投げる。`createMemory`・`createMemoryWithOutbox`・
 * `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の INSERT が対象である。
 *
 * 🔴 **断る入力は変えていない。**今通る入力（圧縮で索引の1行に収まる長い文字列を含む）は今も通り、
 * 今 54000 で落ちる入力だけがこの例外になる。長さの上限を入口に置いたものではない
 * （{@link Ctx} の「識別子の長さに上限は約束しない」はそのまま）。`@mnemora/testkit` のインメモリ実装は
 * どの長さも受け入れ、この例外を投げない。
 *
 * 🔴 **message にも `cause` にも入力の値を残さない**（ADR 0423）。`cause` は Postgres のエラーから
 * `code`・`schema`・`table`・`constraint`（索引名）と、値を含まない決まった形の message だけを写した新しい `Error` である。
 *
 * **書きかけの残り方:**
 * - `createMemory`・`createMemoryWithOutbox`: トランザクションごと戻る（何も残らない）。
 * - `supersedeWithNewMemories`: トランザクションごと戻る。`supersede` の対象だった旧い行は `active` のまま残る。
 * - `createMemoriesWithOutboxAndEvents`: 候補ごとに書きを区切り、この例外になった候補だけを戻して
 *   `dropped` に積む（`error` がこの例外）。ほかの候補は書く。全候補が落ちたときは、最初の例外
 *   （この例外かもしれない）をそのまま投げ、何も書かない。
 *
 * 判定は `instanceof` ではなく {@link isClaimKeyIndexLimitError} で行う（ADR 0418）。
 * 直し方は、`claimKey` の主語・述語を短くする（または縮めた表現・ハッシュにする）こと。
 */
export class ClaimKeyIndexLimitError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は {@link isClaimKeyIndexLimitError} で行う。 */
  readonly kind = "claim_key_index_limit" as const;
  constructor(
    readonly method:
      | "createMemory"
      | "createMemoryWithOutbox"
      | "createMemoriesWithOutboxAndEvents"
      | "supersedeWithNewMemories",
    options?: ErrorOptions,
  ) {
    super(
      `MemoryStore.${method}: the claim key is too large for the claim key index ` +
        "(the index row exceeds the btree limit, SQLSTATE 54000). " +
        "Shorten claimKey.subject / claimKey.predicate.",
      options,
    );
    this.name = "ClaimKeyIndexLimitError";
  }
}

/**
 * 受け取ったものが {@link ClaimKeyIndexLimitError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、`kind` が無ければ `name` を見る。
 */
export function isClaimKeyIndexLimitError(value: unknown): value is ClaimKeyIndexLimitError {
  return matchesStoreErrorKind(value, "claim_key_index_limit", "ClaimKeyIndexLimitError");
}

/**
 * `ContestedWithoutCompanionError` を投げるべきかの判定（[ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)）。
 * adapter ごとに書き写さず、ここ1箇所に置く（ADR 0053 の `isEmbeddingStatusRollback` と同じ形）。
 *
 * ⚠ **この判定は「対向が無いこと」だけを見る。`contestedWithId` が指す先が呼び出し元と同じ
 * テナントの行かは見ない。**テナントの一致は書き込み口が検査する（
 * [ADR 0439](../../../../docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）:
 * `contestedWithId`・`supersededById`・`sourceObservationId`・`recordUsage` の `recallId`/`memoryIds` が
 * `ctx.tenantId` の行を指していなければ、どの口も何も書かずに `… not found for tenant: <id>` の `Error` を投げる
 * （実在しない id・別テナントの id・uuid の形でない id を区別しない）。
 */
export function isContestedWithoutCompanion(
  status: MemoryStatus | undefined,
  contestedWithId: MemoryId | null | undefined,
): boolean {
  return status === "contested" && (contestedWithId ?? null) === null;
}

/**
 * `MemoryStore.purgeMemory` の CAS 条件（`status = 'forgotten' AND purged_at IS NULL`）が
 * 破れたときに投げる（[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)）。
 *
 * 🔴 **`MemoryStatusConflictError` を再利用しない。**`purge` は `status` を動かさない
 * （purge 済みは `purged_at IS NOT NULL` で表す。docs/memory-model.md §11 行10）ため、CAS が破れても
 * `observedStatus` が `expectedStatus`（常に `'forgotten'`）と**同じ値になりうる**。この型は
 * `status` に加えて `purgedAt` も運ぶ。
 *
 * **`observedStatus`/`observedPurgedAt` は「弾かれた後に読み直した値」であり、弾かれた瞬間の値とは
 * 限らない**（`MemoryStatusConflictError` と同じ注意）。呼び出し側（`Runtime.purge`）はこの値を信用せず、
 * 自分でもう一度 `get` を呼んで分類する。
 */
export class MemoryPurgeConflictError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isMemoryPurgeConflictError} で行う。 */
  readonly kind = "memory_purge_conflict" as const;
  constructor(
    readonly memoryId: MemoryId,
    readonly observedStatus: MemoryStatus | null,
    readonly observedPurgedAt: Date | null,
  ) {
    super(
      `MemoryStore.purgeMemory: memory ${memoryId} is not purgeable ` +
        `(expected status "forgotten" with purgedAt null, observed ` +
        `${
          observedStatus === null
            ? "(memory disappeared)"
            : `status="${observedStatus}", purgedAt=${observedPurgedAt === null ? "null" : observedPurgedAt.toISOString()}`
        })`,
    );
    this.name = "MemoryPurgeConflictError";
  }
}

/**
 * 受け取ったものが {@link MemoryPurgeConflictError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isMemoryPurgeConflictError(value: unknown): value is MemoryPurgeConflictError {
  return matchesStoreErrorKind(value, "memory_purge_conflict", "MemoryPurgeConflictError");
}

/**
 * `MemoryStore.purgeMemory` が `content`/`digest` を上書きする固定の文字列
 * （[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)、docs/memory-model.md §9）。
 *
 * 🔴 **「purge されたか」の判定にこの文字列を使わない。**常に `Memory.purgedAt !== null` で判定する
 * （この文字列を変えたときに判定まで壊れる）。
 */
export const PURGE_TOMBSTONE_CONTENT = "[purged]";
/** purge した Memory の `digest` に書く値。⚠ purge されたかの判定には使わない——`Memory.purgedAt !== null` で判定する。 */
export const PURGE_TOMBSTONE_DIGEST = "[purged]";

/**
 * `setEmbeddingStatus` が**唯一禁じる遷移**（`docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md`）。
 * `ready` は「ベクトル行が在る」という主張なので、`failed` で上書きすると `recall` がその Memory を
 * `notIndexed.failed` に計上して利用者に「埋め込みを疑え」と出してしまう。
 *
 * ⚠ **禁じるのはこの1本だけである。**遷移表を全面的に固定したわけではない（ADR 0053「採らなかった案」）。
 */
export const EMBEDDING_STATUS_ROLLBACK = { from: "ready", to: "failed" } as const satisfies {
  from: EmbeddingStatus;
  to: EmbeddingStatus;
};

/**
 * 現在の状態 `current` に `next` を書くことが {@link EMBEDDING_STATUS_ROLLBACK} の巻き戻しに当たるかを判定する。
 * `packages/testkit` の in-memory 実装と `packages/core` の Fake がこの関数を呼び、禁じる遷移を1箇所に固定する
 * （`assertValidEventRetentionDays`（`./tenant-settings-store.js`）と同じ形）。
 *
 * ⚠ **`PostgresMemoryStore` はこの関数を呼べない。**比較を SQL の1文の `WHERE` の中に置かないと、
 * 読みと書きの間が空く（ADR 0048）。`from`/`to` の値だけを {@link EMBEDDING_STATUS_ROLLBACK} から取り、
 * 比較の形は SQL 側にもう一度書かれる。
 */
export function isEmbeddingStatusRollback(
  current: EmbeddingStatus,
  next: EmbeddingStatus,
): boolean {
  return current === EMBEDDING_STATUS_ROLLBACK.from && next === EMBEDDING_STATUS_ROLLBACK.to;
}

/**
 * `aggregateScope` の第3引数（任意）。目次帯（`IndexBand.digestBand`）を組むための帯候補を、群カウント等と
 * **同一の集約クエリから**取得したい場合に渡す（[ADR 0073](../../../../docs/decisions/0073-digest-band-bounded-without-taxonomy.md)、
 * docs/recall.md §5）。
 *
 * **渡さないことが「帯を組まない」という意味を持つ。**省略時は `digests: []`・
 * `digestEligible: { count: 0, countKind: 'exact' }` を返し、実装は帯のための追加の仕事をしない。
 *
 * ⚠ **この引数を必須にしない。**`MemoryStore` は第三者が adapter を実装する公開 API なので、必須にすると
 * この repo の外の呼び出し元が `aggregateScope(ctx, scope)` と2引数で呼べなくなる（`TS2554`）。
 */
export interface AggregateScopeOptions {
  /** 目次帯（段5）の digest も集めるときに渡す。省けば digest を集めない。 */
  digestBand?:
    | {
        /** 取得する上限件数。 */
        limit: number;
        /**
         * 帯から除外する memoryId。adapter の期待する形式でない id（`@mnemora/postgres` なら uuid の形でないもの・
         * 空文字）はどの Memory とも一致しないものとして扱い、例外にしない（`get`・`getMany` と同じ）。
         */
        excludeMemoryIds: readonly MemoryId[];
      }
    | undefined;
  /**
   * 段1の ANN から除外した `provenance.kind`（`RecallQuery.excludeProvenanceKinds`）。
   * 渡すと、`ScopeAggregate.excludedProvenanceIndexedCount`（除外される kind で、スコープ内の索引済みの行の数）を
   * 返してよい。`totalInScope`・`groups`・`filtered*`・`digests` の意味は変えない（除外行もそれらには数えたまま）。
   *
   * **`undefined` と空配列 `[]` はどちらも no-op**（欄を返さない）。この口を知らない adapter は無視してよい。
   */
  excludeProvenanceKinds?: readonly ProvenanceKind[] | undefined;
  /**
   * 件数集計（群カウント・`totalInScope`・`filtered*`・`notIndexed`）を止めるかどうか
   * （[ADR 0384](../../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)、`RecallQuery.scopeAggregate` の値）。
   *
   * **既定・省略時は `"exact"`**（厳密集計）。`"skip"` を渡された実装は、**実際に集計をしない**（SQL を発行しない・
   * ループを回さない等）。計算を行って返り値だけを差し替える実装は禁止する。
   *
   * **この欄を実装しない adapter は、常に厳密集計し `countKind: 'exact'` を返さなければならない。**
   * 未集計の値に `countKind: 'exact'` を付けて返してはならない。
   *
   * **⚠ `"skip"` では `recall()` は ANN の到達（`ann_unreached`）を判定できない。**返り値の `countKind` が
   * `'unknown'` のとき、`recall()` は ANN の stage detail に `annReachability: "unknown"` を足す（ADR 0390）。
   */
  scopeAggregate?: "exact" | "skip" | undefined;
}

/**
 * MemoryStore（docs/architecture.md §5.1）。実装は adapter 側（`packages/postgres` 等）に置く。ここは型のみ。
 *
 * 契約（型からは読み取れない振る舞い）:
 * - `createMemory` は `(tenant_id, source_observation_id, extractor_version, content_hash)` の
 *   一意制約により冪等（docs/architecture.md §3.5）。
 * - `reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` を更新し、`decay_floor_at` を再計算する。
 *   **`strength` は動かさない**（[ADR 0041](../../../../docs/decisions/0041-reinforce-does-not-change-strength.md)。
 *   増分の式はどこにも決まっていない）。
 * - `status = 'contested'` の Memory を単独で返してはならない。対向する Memory をスコアに関係なく
 *   必ず一緒に取得できなければならない（mandatory companion retrieval）。
 * - `aggregateScope` の返り値は近似を許すが、`countKind` を必ず伴う。`opts.scopeAggregate` を渡さない・`"exact"` を渡した
 *   呼び出しは厳密で、`"skip"` を渡した呼び出しは `countKind: 'unknown'` を返す（ADR 0384）。**`axis: 'subject'` の
 *   `groups` の総和は必ず `totalInScope` と一致する**（`"skip"` でも `groups: []`・`totalInScope: 0` として一致する）。
 *   `axis: 'taxonomy'`（[ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）はラベルの多対多により
 *   総和が一致しない（`GroupCount` の doc の別の被覆保証を持つ）。
 * - テナント分離: すべてのメソッドは `ctx.tenantId` に一致しない行を返してはならない。
 */
export interface MemoryStore {
  /**
   * ⚠ **孤立サロゲート（`\uD800` 単体など、対をなさない UTF-16 サロゲートコードユニット）を
   * 含む文字列を渡したときの挙動は、adapter によって、Postgres では欄の列の型によっても異なる**
   * （現状の記録であり、どれに揃えるかは決めていない。`createMemory` の同じ節と同じ形）。
   * - `PostgresMemoryStore`、`jsonb` 列の欄（`payload`/`attributes`）: **例外を投げる**
   *   （`invalid input syntax for type json`）。**`runtime.observe` の `text`・`content`・`speaker`・`data` などは
   *   全部 `payload` に入る**ので、サロゲートペアの間で切った文字列を渡すと Observation を1件も書かずに例外になる。
   * - ⭐ **識別子の欄（`subjectId`・`externalId`、`ctx.tenantId`・`ctx.subjectId`）は、孤立サロゲートも NUL も書く前に断る**
   *   （[ADR 0423](../../../../docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)。
   *   `MalformedIdentifierError`、`kind: "malformed_identifier"`。正規化はしない）。
   *   `PostgresMemoryStore`・`InMemoryMemoryStore`・`FakeMemoryStore` は同じ判定（`assertWellFormedIdentifier`）を入口で掛ける。
   * - `InMemoryMemoryStore`（`packages/testkit`）と `FakeMemoryStore`（`packages/core`）、`jsonb` 列の欄（`payload`・`attributes`）:
   *   例外を投げず、入力をそのまま保持する。`text` 列の欄（`kind` など）は U+FFFD に置き換える
   *   （[ADR 0543](../../../../docs/decisions/0543-inmemory-lone-surrogate-replaced-with-fffd.md)。`PostgresMemoryStore` と同じ）。
   *
   * `createObservationWithOutbox` も同じである。
   *
   * ⚠ **`input` の欄の中身は、ほとんど検査しない**（`createObservationWithOutbox` も同じ）:
   * - 空文字の `kind`・`subjectId`・`externalId`、文字列でない値を持つ `attributes`（例: `{ a: 1 }`）も、そのまま書いて返す。
   *   **返った Observation は `ObservationSchema` を通らないことがある。**
   * - `input.tenantId` が `ctx.tenantId` と違っても拒まず、**`ctx.tenantId` のテナントとして書く**。
   * - `payload` が `undefined` のとき、**`@mnemora/postgres` だけが**例外を投げる（`payload` 列が NOT NULL）。fixture は受け付けて返す。
   * - 拒むのは、列の型が受けない値——Invalid Date の日時、NUL を含む `kind`・`payload`、JSON にできない値
   *   （BigInt は `TypeError`）——である。
   */
  createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
  /** roadmap.md 段階3: `observationId` から本文を取り直す読み出し。 */
  getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
  /**
   * Observation の作成と outbox ジョブ書き込みを同一トランザクションで行う。`jobKinds` の各要素につき1件のジョブを作る。
   * ジョブの `payload` は `{ observationId: <作成された Observation の id> }` に固定される。
   * 冪等な再送（`externalId` が既存行と衝突）の場合は `created: false` を返し、ジョブは一切作らない（`jobs` は空配列）。
   *
   * ⭐ **`opts` は省略可能な第4引数である。**
   * **`opts.now` を渡すと、積む outbox 行の `availableAt`/`createdAt` にその値を使う。省略時は実装が壁時計（`new Date()`）を使う。**
   *
   * ⭐ **`opts.claimedBy` も省略可能で、非破壊である**（[ADR 0407](../../../../docs/decisions/0407-sync-observe-extract-job-lease.md)）。
   * **渡すと、積む outbox 行を「その名前で claim 済み」の状態で作る**——`claimedAt` は `opts.now`（省略時は
   * 壁時計）、`claimedBy` はこの値、`attempts` は `1`（`claimBatch` が初回の claim で付ける値と同じ）。
   * 他のワーカーの `claimBatch` からは、リース（`ClaimOutboxJobsOptions.leaseMs`）が切れるまで claim されない。
   * **返る `jobs` の `attempts` をそのまま `complete`/`fail` の `expectedAttempts` に渡せば、CAS（ADR 0142）のフェンシングトークンになる。**
   * 省略時は `attempts: 0`・未 claim・すぐ claim できる。
   */
  createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date | undefined; claimedBy?: string | undefined },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }>;
  /**
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `input.status === 'contested'` かつ `input.contestedWithId` が `null`/`undefined` の
   * 呼び出しは {@link ContestedWithoutCompanionError} を投げる（`isContestedWithoutCompanion` が判定する）。
   * 対向を明示した作成（`contestedWithId` に既存 Memory の id を渡す）は許される。
   *
   * 🔴 [ADR 0439](../../../../docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md):
   * `input.sourceObservationId`（observation）・`input.supersededById`・`input.contestedWithId`（memory）は、
   * `ctx.tenantId` の行を指していなければ、行を書かずに `observation not found for tenant: <id>`／
   * `memory not found for tenant: <id>` の `Error` を投げる。実在しない id・別テナントの id・uuid の形でない id を
   * 区別しない。`null`・`undefined` は「参照しない」。冪等の衝突で既存の行を返す呼び出しにも検査は当たる。
   *
   * ⚠ **孤立サロゲート（`\uD800` 単体など、対をなさない UTF-16 サロゲートコードユニット）を含む文字列を渡したときの
   * 挙動は、adapter によって、Postgres では欄の列の型によっても異なる**（現状の記録）。
   * - ⭐ `subjectId`（識別子）は、孤立サロゲートも NUL も書く前に断る（ADR 0423。`createObservation` の節と同じ）。
   *   以下は `subjectId` 以外の欄の話である。
   * - `PostgresMemoryStore`、`text` 列の欄（`content`/`tags`/`digest`）: 例外を投げず、`pg` ドライバが
   *   孤立サロゲートを U+FFFD に置換する。読み返した値は入力と一致しない。
   * - `PostgresMemoryStore`、`jsonb` 列の欄（`attributes`/`provenance`）: **例外を投げる**（`invalid input syntax for type json`）。
   * - ⭐ `InMemoryMemoryStore`（`packages/testkit`）と `FakeMemoryStore`（`packages/core`）、`text` 列に当たる欄
   *   （`content`/`digest`/`tags`/`contentHash`/`extractorVersion`/`claimKey` の主語と述語）: **Postgres と同じく U+FFFD に置き換えて保存する**
   *   （[ADR 0543](../../../../docs/decisions/0543-inmemory-lone-surrogate-replaced-with-fffd.md)）。
   *   読み取りの引数（`findActiveByClaimKey` の `claimKey`、`listBySourceObservation` の `extractorVersion`、`labels` の絞りなど）も同じく置き換わって比べられる。
   * - 同じ2つの実装の `jsonb` 列の欄（`attributes`/`provenance`）: 例外を投げず、入力をそのまま保持する（Postgres は例外。この差は残っている）。
   *
   * ⟹ 呼び出し側は「成功した」ことだけでは、書き込んだ値と読み返した値が一致するとは限らない。
   *
   * 🔴 **[ADR 0630](../../../../docs/decisions/0630-store-rejects-new-memory-that-fails-memory-schema-on-read-back.md):
   * 書いたら読み戻したときに {@link MemorySchema} を通らなくなる値は、入口で拒む。**
   * 判定は `MemorySchema` の同じ欄の schema と同じである（{@link assertWellFormedNewMemory}。3つの実装が共有する）。拒む欄:
   * - `digest`・`contentHash`・`extractorVersion` が空文字。`null`・省略を通すのは `extractorVersion` だけで、`digest` の
   *   `null`・省略と `contentHash` の省略は拒む（例外の種類は下の「ADR 0630 の前から拒む入力」の節）
   * - `claimKey`（`null`・省略は可）の `subject`・`predicate` が空文字、または片側だけ・欠けている
   * - `attributes` の値が文字列でない（数・入れ子・`null`。空のオブジェクト・省略・`null` は可）
   * - `provenance` の中身の欠け・値域外（例: `stated` の `sourceObservationId`・`at` が無い／`at` が空文字、`consolidated` の
   *   `sources` が空、`imported` の `batchId` が無い／空、`inferred` の `confidence` が `[0, 1]` の外・`model` が無い）
   *
   * 例外は `Error`（`<実装名>: <欄> is malformed (<理由>); …`。欄の名前は `claimKey.subject`・`provenance.confidence` のように
   * 入れ子を `.` でつなぐ。値は message に載せない）。**何も書かない**（Memory・ラベル・outbox・イベントのどれも進めない）。
   * **冪等の既存の行が在っても拒む**（既存の行を返さない）。外部の adapter も、これを守ること。
   *
   * ⛔ この検査の範囲外: `subjectId`（空文字を含む）・`content`・`tags` の中身・日時・`strength`・`halfLifeHours`・
   * 列挙の欄、`validFrom > validUntil`。`provenance.sourceObservationId` と `input.sourceObservationId` が
   * 食い違っていても検査しない。Observation・Event・`createRecall` の書き込みにもこの検査は掛からない。
   *
   * ADR 0630 の前から拒む入力は、どちらの adapter でも例外になる（投げる例外の種類は adapter で違う）:
   * - `provenance.kind` が列挙（`stated`・`inferred`・`consolidated`・`reflected`・`imported`）に無い
   *   ——Postgres は DB の CHECK の例外（drizzle が包んだ `Failed query`）、fixture は
   *   `memories.provenance_kind must be one of …` を投げる。
   * - `provenance.kind` が `stated`・`inferred` なのに `input.sourceObservationId` が `null`
   *   ——Postgres は DB の CHECK の例外、fixture は `provenance.kind "…" requires sourceObservationId` を投げる。
   * - `provenance` が `null`——どちらも `TypeError`。
   * - `digest` が `null`・省略、`contentHash` が省略: Postgres と core の Fake は `Error`（`… digest is malformed …`）、
   *   testkit の fixture は `TypeError`（`Cannot read properties of … (reading 'includes')`）。
   */
  createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
  /**
   * Memory の作成と outbox ジョブ書き込み（主に `embed`）を同一トランザクションで行う。
   * 抽出の冪等性（`(tenant_id, source_observation_id, extractor_version, content_hash)`）で既存行に衝突した場合は
   * `created: false` を返し、ジョブは作らない。
   * ⚠ **既存行に衝突する入力でも、書けない値は拒む**（`createMemory` も同じ）——列挙に無い値・NUL・
   * Invalid Date・値域の外の数は、既存行を返さずに例外になる。
   *
   * 🔴 `createMemory` と同じ [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
   * の制約と、`input.sourceObservationId`・`supersededById`・`contestedWithId` のテナント一致の検査（ADR 0439）を受ける。
   *
   * 🔴 [ADR 0630](../../../../docs/decisions/0630-store-rejects-new-memory-that-fails-memory-schema-on-read-back.md):
   * `createMemory` と同じく、読み戻すと `MemorySchema` を通らない `input` は、何も書かずに拒む。冪等の既存の行が在っても拒む
   * （範囲と例外は `createMemory` の doc 参照）。
   *
   * ⭐ **`opts` は省略可能な第4引数である**（`createObservationWithOutbox` の同じ欄と同じ）。**`opts.now` を渡すと、積む outbox 行の `availableAt`/`createdAt` に
   * その値を使う。省略時は実装が壁時計を使う。**
   *
   * ⭐ **`opts.abortIfForgotten`**（ADR 0375 決定7）: 非空の配列を渡すと、**書き込みの直前に、その id の現在の `status` を見直し、
   * 1件でも `"forgotten"` だったら何も書かずに {@link SourceMemoryForgottenError} を投げる**——
   * `input` の INSERT も outbox ジョブの積み込みも一切起きない。空配列・省略時は見直しを行わない。
   *
   * 🔴 **この欄を実装するかは adapter ごとに違う。**`@mnemora/postgres` は見直しを INSERT と同一トランザクションで行う
   * （見直しと書き込みの間に窓が無い）。`InMemoryMemoryStore`（`packages/testkit`）と `FakeMemoryStore`（`packages/core`）は
   * 実装せず、渡しても無視され、例外は投げられない。これらでは `runtime.reflect` 自身が書き込みの直前に行う
   * `getMany` の見直し（残る窓あり）だけが保護になる。第三者の adapter が実装するかは任意（しなくても型は壊れない）。
   *
   * ⭐ **ADR 0420: `opts.abortIfSuperseded`**（`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents` にも同じ欄）。
   * `abortIfForgotten` を superseded にも広げたもの。非空の配列を渡すと、書き込みの前にその id の `status` を見直し、
   * 1件でも `"superseded"` なら何も書かずに {@link SourceMemoryStatusChangedError} を投げる。空配列・省略時は見直しを行わない。
   * **`abortIfForgotten` の見直しが先**（forgotten を含めば {@link SourceMemoryForgottenError}）。
   * `@mnemora/postgres` と `InMemoryMemoryStore` は実装し、実装しない adapter は無視する（任意）。
   */
  createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
    opts?: {
      now?: Date | undefined;
      abortIfForgotten?: ReadonlyArray<MemoryId> | undefined;
      abortIfSuperseded?: ReadonlyArray<MemoryId> | undefined;
    },
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
  /**
   * `id` が adapter の期待する形式でない場合も「存在しない」と同じ `null` を返す（例外を投げない）。
   * 他のメソッドの「adapter の期待する形式でない id」も同じ扱い（`packages/postgres/src/mapping.ts` の `isUuidLike`）。
   */
  get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
  /**
   * 一括取得。**呼び出し全体を弾かない**——`ids` のうち adapter の期待する形式でないものは、無い id と同じく
   * 静かに結果から落とす。全件が形式に合わなければ空配列を返す。
   *
   * ⚠ **返す順序は規定しない**（`@mnemora/postgres` は `ids` の順を保たず、testkit の fixture は保つ）。
   * `ids` に同じ id が2回以上あっても、結果には1回だけ現れる（両実装とも）。呼び出し側は id で引き当てること。
   *
   * UUID 形式の `id` は大文字小文字を区別しない——大文字で渡しても同じ Memory を返す。
   * UUID 形式でない `id` の大文字小文字の扱いは約束しない。
   */
  getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
  /**
   * ある Observation から、ある版の抽出器で作られた Memory を列挙する（ADR 0028）。`extractorVersion` は
   * `NULLS NOT DISTINCT` と同じ規約で `null` を1つの値として扱う——`extractorVersion: null` を渡すと
   * `extractor_version IS NULL` の行を返す。`observationId` が adapter の期待する形式でない場合は
   * 「存在しない」と同じ空配列を返す（例外を投げない）。
   *
   * ⚠ **`extractorVersion` は絞り込み条件であり、指定した版と違う Memory はこの口には一切現れない**。
   * **版を問わず同じ Observation 由来の Memory が要る場合は
   * {@link MemoryStore.listBySourceObservationAllVersions} を使うこと**（ADR 0380）。
   *
   * ⚠ **返す順序は規定しない**（`@mnemora/postgres` と testkit の fixture で並びが違う）。
   * 件数の上限・続きから読む口も無く、該当する行を全部返す。
   */
  listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]>;
  /**
   * ある Observation から作られた Memory を、`extractorVersion` を**問わず**列挙する
   * （[ADR 0380](../../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)）。
   * `status` でも絞らない——`active`/`forgotten`/`contested`/`superseded`/`archived` のどれも返す。
   * `listBySourceObservation` との違いは `extractorVersion` で絞り込まないことだけである。
   *
   * `observationId` が adapter の期待する形式でない場合は「存在しない」と同じ空配列を返す（例外を投げない）。
   * ⚠ **返す順序は規定しない**。件数の上限・続きから読む口も無く、該当する行を全部返す。
   *
   * ⚠ **必須メソッドである**（自前の `MemoryStore` 実装はこのメソッドが無いとコンパイルできない）。
   * `extractorVersion` に `undefined` を渡すと絞り込まない sentinel にする案・任意メソッドにする案は採らなかった
   * （ADR 0380「採らなかった案」）。
   */
  listBySourceObservationAllVersions(ctx: Ctx, observationId: ObservationId): Promise<Memory[]>;
  /**
   * `opts.expectedStatus` を渡すと、書き込み時点で対象 Memory の `status` がその値と一致するときだけ更新する
   * （compare-and-swap。docs/decisions/0030-*.md）。**省略時は status を条件にせず常に更新する。**
   *
   * `expectedStatus` と実際の status が食い違っていた場合は {@link MemoryStatusConflictError} を投げる。
   * 対象の Memory がそもそも存在しない場合は（`expectedStatus` の有無に関わらず）「memory not found」の例外のまま。
   * `id` が adapter の期待する形式でない場合も、この「memory not found」と同じ結果になる。
   *
   * `expectedStatus` は**単数**である（1回の呼び出しが条件にする status は1つ。採らなかった案は ADR 0030）。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `status === 'contested'` を対象にした呼び出しは**常に** {@link ContestedWithoutCompanionError} を投げる
   * （対向を渡す引数が無いため）。`contested` を正しく書くには `markContestedPair`（ADR 0134）を使うこと。
   *
   * 🔴 [ADR 0439](../../../../docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md):
   * `opts.supersededById` が `ctx.tenantId` の記憶を指していなければ、何も書かずに
   * `memory not found for tenant: <supersededById>` の `Error` を投げる（実在しない・別テナント・uuid の形でない、を区別しない）。
   * 対象の `id` が無いとき、`supersededById` が無いとき、`expectedStatus` が違うとき（{@link MemoryStatusConflictError}）は、
   * この順で判定する。
   *
   * 🔴 **ADR 0499: purge 済みの Memory（`purgedAt` が非 `null`。`status` は `"forgotten"` のまま）は、どの `expectedStatus`
   * にも一致しない**として扱い、{@link MemoryStatusConflictError} を投げる（墓石を `updateStatus(id, "active", { expectedStatus: "forgotten" })` で
   * active に戻すことはできない）。`expectedStatus` を渡さない呼び出しは無条件の書き込みのまま（purge 済みでも通る）。
   * `updateStatusWithEvent`・`supersedeWithNewMemories` の `supersede[].expectedStatus`（弾かれた対象は `conflicted` に載る）も同じ。
   *
   * 🔴 **ADR 0503: `status === "superseded"` の更新は、置き換えた側を伴い、それは自分自身でないこと。** `opts.supersededById` が
   * 無い（省略・`opts` 無し・`expectedStatus` だけ）、または `id` と同じ（自己置換）なら、何も書かずに `RangeError`
   * （メッセージ: `updateStatus: opts.supersededById is required when status is "superseded"`・
   * `updateStatus: opts.supersededById must not be the memory itself`。値は message に入れない）を投げる。
   * `contested` の検査のあと、対象の存在確認・`supersededById` のテナント照合・`expectedStatus` の判定より前に判定する。
   * 🔴 **ADR 0515: `superseded` 以外の status（`active`・`archived`・`forgotten`）に `opts.supersededById` を付けるのも、何も書かずに `RangeError`**
   * （`updateStatus: opts.supersededById must not be set unless status is "superseded"`）。同じ位置で判定する。
   */
  updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
  ): Promise<Memory>;
  /**
   * `updateStatus` と同じ status 更新を行い、**同一トランザクションで** `event` を `memory_events` へ追記する（ADR 0031）。
   *
   * 🔴 **`memories.status` の更新が永続化されたことと、対応するイベントが永続化されたことは、同値である。**
   * 一方だけが起きて他方が起きない状態を作らない。
   *
   * 契約（`updateStatus` と共通の部分は同じ意味論）:
   * - `opts.expectedStatus` を渡すと compare-and-swap になる。書き込み時点の実際の status が一致しなければ
   *   {@link MemoryStatusConflictError} を投げ、**status の更新もイベントの追記も一切起きない**。
   * - 🔴 ADR 0499: purge 済みの Memory（`purgedAt` が非 `null`）は、どの `expectedStatus` にも一致しない
   *   （`updateStatus` の doc 参照）。{@link MemoryStatusConflictError} を投げ、status もイベントも動かない。
   * - `opts.expectedStatus` を省略すると、status を条件にせず常に更新し、イベントを追記する。
   * - 対象の Memory がそもそも存在しない場合（`id` が adapter の期待する形式でない場合を含む）は、
   *   `expectedStatus` の有無に関わらず「memory not found」の `Error` を投げる（イベントは積まれない）。
   *
   * 🔴 `opts.supersededById` のテナント一致は `updateStatus` と同じく検査する（ADR 0439。`ctx.tenantId` の記憶でなければ、
   * 状態もイベントも書かずに `memory not found for tenant`）。
   *
   * 🔴 **ADR 0503: `status === "superseded"` の更新は、`opts.supersededById` を伴い、それは `id` 自身でないこと**（`updateStatus` と同じ。
   * 満たさなければ、状態もイベントも書かずに `RangeError`。メッセージの接頭辞は `updateStatusWithEvent:`）。
   * 🔴 **ADR 0515: `superseded` 以外の status に `opts.supersededById` を付けるのも、状態もイベントも書かずに `RangeError`**（`updateStatus` と同じ）。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `status === 'contested'` を対象にした呼び出しは**常に** {@link ContestedWithoutCompanionError} を投げる
   * （status もイベントも一切書かれない）。
   *
   * ⚠ **保証するのは単一の Memory 1件・イベント1件の原子性だけである。**複数の Memory にまたがる操作全体の原子性は
   * 呼び出し側の責務で、旧行の status 更新と新 Memory の作成を1トランザクションにすることも、このメソッドの範囲外
   * （ADR 0031「採らなかった案」）。
   */
  updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId | undefined; expectedStatus?: MemoryStatus | undefined },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * `embeddingStatus` の `pending → ready | failed` 遷移を書き込む。
   * 対象の Memory が存在しない場合（`id` が adapter の期待する形式でない場合を含む）は「memory not found」の `Error` を投げる。
   *
   * 🔴 **`ready` を `failed` へ巻き戻さない**
   * （[ADR 0053](../../../../docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md)。
   * 判定は {@link isEmbeddingStatusRollback}）。現在の `embeddingStatus` が `ready` のときに `failed` を書く呼び出しは **no-op** である:
   *
   * - **例外を投げない。**投げると、呼び出し側（`runtime.tick`）の `catch` の中で元の埋め込みエラーが別の例外にすり替わる。
   * - **返すのは、更新されなかった現在の行そのもの**である（`embeddingStatus` は `ready` のまま）。
   * - **`updatedAt` も動かない。**「行を触らない」の意味で固定する。
   *
   * それ以外の遷移は無条件である。**`failed → ready` は許す。**
   */
  setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
  /**
   * `last_reinforced_at`/`decay_floor_at` を更新する（docs/memory-model.md §7、ADR 0010）。
   * 対象の Memory が存在しない場合（`id` が adapter の期待する形式でない場合を含む）は「memory not found」の `Error` を投げる。
   *
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   * `opts.nowSeq` を渡すと、活動時計側の起点・床（`decayBaseSeq`/`decayFloorSeq`）も同じ強化イベントとして進める——
   * **対象の Memory が `halfLifeRecalls` を持つ場合に限る**（`ReinforceOptions.nowSeq` の doc 参照）。
   * `opts` を渡さない、または `opts.nowSeq` を省略した場合: **活動時計側の3列（`decayBaseSeq`/`decayFloorSeq`/
   * `halfLifeRecalls`）には一切触れない**（黙って `0` として扱わない）。壁時計側の更新は `opts` の有無に関わらず行う。
   *
   * ⭐ **`opts` は省略可能な第4引数であり、この変更は非破壊である。**3引数の既存実装
   * （`reinforce(ctx, id, at): Promise<Memory>`）は直さずにこの interface を満たす。
   *
   * **減衰の起点を巻き戻さない**（[ADR 0048](../../../../docs/decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)/
   * [ADR 0049](../../../../docs/decisions/0049-reinforce-monotonicity-in-pseudo-implementations.md)）。規則は1つである:
   * - **`at` が現在の起点（`lastReinforcedAt ?? recordedAt`）より狭義に新しいときだけ書く。**
   *   未強化の記憶では、作成時刻（`recordedAt`）が起点である。
   * - **起点と等しい `at`・古い `at` は no-op である**——例外にしない。何も書かず（`updatedAt` も動かさず）、
   *   更新されなかった現在の行をそのまま返す。書いたかどうかは戻り値の `lastReinforcedAt` を見ないと分からない。
   * - ⚠ **この比較は壁時計の `at` だけで行い、活動時計側の3列も同じ条件で守る**。⟹ **等しい `at` の2回目は、
   *   `opts.nowSeq` が1回目より進んでいても `decayBaseSeq`/`decayFloorSeq` を動かさない。**
   *   等しい `at` を書く側へ倒す・活動時計側だけ seq で比べる変更は、適合テストの契約を変える破壊的変更になる。
   *
   * ⚠ **このメソッドは `status` を見ずに書く。**
   * 対象 Memory がどの `status` であっても、上の単調性・活動時計の規則だけを適用して書き込む——
   * `status` に応じた no-op・拒否は無い。`runtime.observe({ kind: 'memory_usage' })` は、`recordUsage` が返した
   * `insertedMemoryIds` を `status` を確かめずに渡すので、古い id の使用報告は `archived`/`superseded`/`forgotten` にも届きうる。
   * 届いたときの帰結（[ADR 0303](../../../../docs/decisions/0303-superseded-contested-decay-floor-owner.md)）:
   * - **`contested`**: 正規の経路であり、害ではない（ADR 0303 決定2）。
   * - **`archived`/`superseded`**: 復帰（`restoreArchived`/`restoreSuperseded`）が復帰の直後に `reinforce` を呼ぶため、
   *   時計が前にしか進まない通常の順序では単調性ガードにより上書きされ、効き目は残らない。**`reinforce` 自身が
   *   status を見て守っているわけではない**（時計を逆行させた場合、不正な値が復帰後の行に残りうる）。
   * - **`forgotten`**: 戻る経路が無いため、書かれた値は残る。**`recall()` の結果には影響しない**
   *   （値が見えるのは `get()` で直接読んだときだけ）。
   * - **purged**（`status` は `forgotten` のまま、`purgedAt` が入り、`content` はトゥームストーン）: `forgotten` と同じ形で、
   *   `reinforce`・`reinforceMany`・`recordUsageAndReinforce`・`Runtime.observe({ kind: 'memory_usage' })` のどの口でも
   *   `lastReinforcedAt`（と `decayFloorAt`）が書き換わる。`status`・`purgedAt`・`content` は動かず、`memory_events` も書かない。
   *   **`recall()` の結果には影響しない**。弾く・拒否する経路は無い（[ADR 0453](../../../../docs/decisions/0453-embed-job-and-reinforce-state-matrix-round27.md)
   *   負債3、[ADR 0501](../../../../docs/decisions/0501-doc-debts-usage-env-analyze-per-process-reinforce-purged.md)、
   *   [ADR 0519](../../../../docs/decisions/0519-inmemory-reinforce-purged-matches-postgres.md)。`Runtime.observe` 経由は InMemory では確かめていない）。
   *
   * `reinforce` の対象は `active`/`contested` に**絞らない**。`runtime.observe` に渡す `usedMemoryIds` の
   * 出どころを正しく保つのは呼び出し側の責務である。
   */
  reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory>;

  /**
   * この store の `reinforce`/`reinforceMany`/`recordUsageAndReinforce` が {@link ReinforceOptions.addOwnSubjectSeq} を
   * 読めること（`true` のとき、強化される Memory 自身の subject の `S_x` を行ごとに足すこと）の**宣言**。
   * 読めるなら `true` を返す（[ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)）。
   *
   * ⭐ **任意メソッドである。宣言が無い（未実装・`false`）store には、runtime は `T + S_ctx` をそのまま `nowSeq` に入れ、
   * `addOwnSubjectSeq` は付けない。**`true` を宣言する store にだけ、runtime は `nowSeq` に `T` だけを入れ、
   * `addOwnSubjectSeq: true` を付ける。
   *
   * ⚠ `true` を宣言するなら、`reinforce` だけでなく `reinforceMany?`・`recordUsageAndReinforce?`（実装しているなら）も読むこと。
   */
  supportsAddOwnSubjectSeq?(): boolean;
  /**
   * `reinforce` を `ids` の各要素について呼んだのと同じ結果になる、任意（省略可能）の一括版
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。この口を実装しない adapter に対しては、
   * `handleMemoryUsage` が1件ずつ `reinforce` を呼ぶループにフォールバックする。
   *
   * 契約: **`ids` の各要素 `ids[i]` について、`i = 0, 1, ..., ids.length - 1` の順に
   * `reinforce(ctx, ids[i], at, opts)` を呼んだのと同じ結果になる。**戻り値は `ids` と同じ長さ・同じ順序の配列であり、
   * `results[i]` は `reinforce(ctx, ids[i], at, opts)` の返り値と同じ `Memory` になる（`ids` に重複がある場合、
   * 重複したどの要素も同じ最終状態の行を返す）。`at`/`opts` は呼び出し全体で1つだけ渡す。
   *
   * `reinforce` の doc の規律は、この一括版の**各要素**にもそのまま当たる:
   * - **減衰の起点を巻き戻さない**（[ADR 0048](../../../../docs/decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)/
   *   ADR 0049）: 書き込むのは、`at` が現在の起点（`lastReinforcedAt ?? recordedAt`）より狭義に新しい行だけ。
   *   **この単調性の比較は、1件ずつのときと同じく WHERE 句（CAS）の中で行う**——アプリ側で読んだ古い値を条件にしない。
   *   等しい/古い `at` は no-op（例外にしない。`updatedAt` も動かさない）。
   * - [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   *   `opts.nowSeq` を渡すと、活動時計側の起点・床も同じ強化イベントとして進める——**`halfLifeRecalls` を持つ行に限る**。
   *   この判定は**行ごと**に行う（持たない行は活動時計側の3列に一切触れない）。
   * - **`status` を見ない**。`reinforce` と同じ。
   * - **`memory_events` は書かない。**
   *
   * `ids` に存在しない id・adapter の期待する形式でない id が含まれる場合は、`reinforce` 単体と同じ
   * 「memory not found」の `Error` を投げるが、**「どこまで書いてから投げるか」は 1件ずつのループと厳密には一致しない**
   * （`PostgresMemoryStore.reinforceMany` の doc）。
   */
  reinforceMany?(ctx: Ctx, ids: MemoryId[], at: Date, opts?: ReinforceOptions): Promise<Memory[]>;
  /**
   * 使用報告を記録する。`(recall_id, memory_id)` の挿入が実際に起きたものだけを `insertedMemoryIds` として返す
   * （再送は空配列になりうる）。
   *
   * 🔴 [ADR 0439](../../../../docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md):
   * **`recallId` が `ctx.tenantId` の recall でなければ `recall not found for tenant: <id>`、`memoryIds` のどれかが
   * `ctx.tenantId` の記憶でなければ `memory not found for tenant: <id>` の `Error` を投げ、1件も書かない**
   * （1件でも違えば全体を書かない。実在しない id・別テナントの id・uuid の形でない id を区別しない。`memoryIds` が
   * 空配列のときは、何も検査せず空の結果を返す）。
   */
  recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * `recordUsage` と、それが返した `insertedMemoryIds` への強化（`reinforceMany(ctx, insertedMemoryIds, at, opts)` と同じ結果）を
   * **1トランザクションで**行う、任意（省略可能）の口。
   * 戻り値は `recordUsage` と同じ——実際に挿入が起きた id だけを返し、強化もその id にだけ掛ける（再送では空配列になり、強化もしない）。
   *
   * 契約: 強化の規律は `reinforceMany` の doc のとおり。**例外を投げたときは、使用の記録も強化も1件も残さない。**
   * `recallId`・`memoryIds` のテナント一致の検査は `recordUsage` と同じ（ADR 0439）。
   *
   * 🔴 **任意メソッドである**（`reinforceMany?` と同じ）。この口を持たない adapter では `handleMemoryUsage` が
   * `recordUsage` → 強化の2段で行い、**その間で落ちると、同じ `externalId` の再送でも強化が二度と呼ばれず恒久に失われる窓が残る**
   * （ADR 0009）。
   */
  recordUsageAndReinforce?(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * 群カウント・スコープ内総数・スコープを定義するフィルタ（status/period/taxonomy）で落ちた件数・not_indexed 件数を
   * 単一の集約クエリから返す（`ScopeAggregate` の doc、docs/recall.md §5）。
   * 契約: 返り値の `axis: 'subject'` の `groups` の総和は必ず `totalInScope` と一致する。
   * **`axis: 'taxonomy'`（`scope.taxonomyGroupCandidates` が在るときだけ生成、
   * [ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）はこの契約の対象外**（`GroupCount` の doc）。
   *
   * `opts.digestBand` を渡すと、`ScopeAggregate.digests`/`digestEligible` も**同じ集約クエリから**埋めて返す。
   * 渡さない場合は `digests: []`・`digestEligible: { count: 0, countKind: 'exact' }`。
   *
   * `opts.scopeAggregate: "skip"`（[ADR 0384](../../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)）を渡すと、
   * 群カウント・`totalInScope`・`filtered*`・`notIndexed` の集計を止める——`groups: []`・`totalInScope: 0`・
   * これらの `countKind` は `'unknown'` になる。`digestBand` は独立した経路なので、同時に渡しても `digests` は返る
   * （`digestEligible` だけは `count: 0`・`countKind: 'unknown'`）。`AggregateScopeOptions.scopeAggregate` の doc 参照。
   */
  aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate>;
  /**
   * recall 段6（記録）。`recalls` へ1行書き込み、発行した recallId を返す。
   *
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5:
   * `record.advanceActivityClock === true` のとき、実装は `recalls` への INSERT と
   * **同一トランザクションで** `tenant_activity.activity_seq` を `+1` しなければならない
   * （`NewRecallRecord.advanceActivityClock` の doc）。
   *
   * ⚠ **戻り値は `RecallId` のままで、進めた後の `activity_seq` は載せない。**公開 API の戻り値の形を変えるのは破壊的変更になる。
   * 進めた後の値が要る呼び出し側は `TenantSettingsStore.getActivitySeq` を別途読むこと。
   *
   * ⚠ **`record` の中身の形は検査しない。**拒むのは、列の型が受け付けない値——NUL を含む値と、JSON にできない必須の欄——だけである。
   * `omitted`・`usage`・`indexBand`・`explain`・`returnedMemories`（その `score` など）がそれぞれの型
   * （`OmissionSchema`・`RecallUsageSchema`・`IndexBandSchema`・`StageTraceSchema`・`ScoreBreakdownSchema`）に合わなくても、そのまま書く。
   * ⟹ **`getRecall` が返す `RecallRecord` は、それらの schema を通らないことがある。**
   */
  createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
  /**
   * `createRecall` が書いた `recalls` 行1件を、`recallId` から読み戻す
   * （[ADR 0155](../../../../docs/decisions/0155-recall-score-breakdown-persisted.md)）。
   *
   * 🔴 **必須メソッドである。**`recalls` を読む形は既存のどのメソッドにも収まらず、`get`/`getMany`/`getObservation` と同じ
   * 「単純な1行読み出し」の族に属する（任意にしない理由は ADR 0155）。
   *
   * 契約:
   * - 対象の行が存在しない、または `tenant_id` が `ctx.tenantId` と一致しない場合は `null` を返す（例外にしない）。
   *   `id` が adapter の期待する形式でない場合も同じく `null`。
   * - `returnedMemories.breakdownCaptured` は、マイグレーション以前に書かれた行では `false` になる
   *   （`RecallRecordReturnedMemories`（`../recall.js`）の doc）。呼び出し側はこれを見て「内訳を記録しそこねた」行と
   *   「記録したが0件だった」行を区別すること。
   */
  getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
  /**
   * 索引に載っていない Memory を**列挙して、同時に `embed` ジョブを積み直す**（ADR 0079）。
   *
   * 契約:
   * - 対象は `status IN ('active','contested')` かつ `embeddingStatus` が `opts.statuses` のいずれかである Memory に限る。
   *   **`aggregateScope` が `notIndexed` に数える集合と同じ条件**である。
   * - `opts.memoryIds` を渡すと、その id の集合との積を取る（`opts.statuses` の条件は外れない——
   *   `ready` の行を `memoryIds` で名指ししても対象にならない）。
   * - 選ばれた行は `embeddingStatus` を `'pending'` へ戻し、**同一トランザクションで**
   *   `kind: 'embed'`・`payload: { memoryId }` の outbox 行を1件ずつ新規に積む。**片方だけ起きることはない。**
   * - 返すのは実際に積み直した件数と、その `memoryId`（`opts.limit` で切られた後の集合）。
   * - 対象が0件なら `{ requeued: 0, memoryIds: [] }` を返す（例外を投げない）。
   * - **べき等ではない。**同じ Memory に対して2回呼べば outbox 行は2件積まれる（「呼んだ回数だけ積む」ことが契約）。
   *
   * 🔴 **既に `failed_at` が付いた古い outbox 行は触らない。**積み直しは**新しい行**であり、古い行は失敗の履歴として残る。
   * 新しい行の `attempts` は 0 から数え直される（ADR 0032）。
   *
   * ⚠ **`ready` は `opts.statuses` に指定できない**（型が `NotIndexedReason` であり `ready` を含まない）。
   * `ready` は「ベクトル行が在る」という主張であり（ADR 0053）、`pending` へ戻すと索引済みの Memory が `notIndexed.pending` に数えられる。
   *
   * 対象が `opts.limit` より多いときは **`updatedAt` の古い順、同着は `id` の昇順**で選ぶ。積み直した行は `updatedAt` が動くので、
   * 繰り返し呼ぶと対象が一巡する（同じ行だけを取り続けて他が飢えることがない）。
   *
   * ⭐ **`writeOpts` は省略可能な第3引数である。**
   * **`writeOpts.now` を渡すと、積み直す embed ジョブの `availableAt`/`createdAt` にその値を使う。省略時は実装が壁時計を使う。**
   * 時刻を第2引数 `opts`（{@link RequeueEmbedJobsOptions}）に足さないのは、`opts` が `Runtime.reembed` の公開の入力と同じ型だから。
   */
  requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date | undefined },
  ): Promise<RequeueEmbedJobsResult>;
  /**
   * 旧行の `status`/`superseded_by_id` 更新と**新 Memory の作成**を1回の呼び出し・1トランザクションで行う
   * （[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md)、docs/memory-model.md §11 行5）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。実装しない adapter は
   * `updateStatusWithEvent` + 別呼び出しの `createMemoryWithOutbox` の2段のままでよい。
   *
   * 意味論:
   * - `news` の各要素は {@link MemoryStore.createMemoryWithOutbox} と**同じ冪等経路**
   *   （既存行と衝突したら `created: false` を返し、ジョブは一切積まない）。
   * - `supersede` の各要素は {@link MemoryStore.updateStatusWithEvent} と**同じ CAS 意味論**
   *   （`status` は常に `"superseded"` に固定。任意の status への更新は `updateStatus`/`updateStatusWithEvent` を使う）。
   * - 🔴 **CAS に弾かれた対象は例外にしない。** `conflicted` に `{ id, observedStatus }` として積み、
   *   **トランザクションはそのまま commit する**（「1件の競合」を「全部やらなかった」に化けさせない。ADR 0031「採らなかった案」）。
   * - 🔴 **`supersede[].id` の行がそもそも存在しない場合は、`updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。**
   *   トランザクション全体がロールバックされ、**`news` の作成も巻き戻る**。⛔ **`conflicted` には混ぜない**
   *   （「CAS で弾かれた」と「行が無い」は別の失敗）。
   * - 🔴 **`supersededByIndex` は `news` への索引である**（`MemoryId` ではない。指す先の id は store が採番するまで存在しない。
   *   ADR 0100「採らなかった案」）。`supersededById` の外部キー違反は構造的に起こりえず、ADR 0047 の「存在」検査は
   *   下の範囲検査が引き継ぐ。
   * - 🔴 **`event.meta.supersededById` は、実装が解決したアンカーの id で埋める**（呼び出し側が渡した値があれば上書きする。
   *   `event` の他の欄は変えない）。⛔ 同じ論理操作が adapter ごとに別の監査記録を残す形にしない。
   * - ⚠ **`supersededByIndex` が指すのは `news[i]` に対応する Memory であって、今回作られたか既に在ったかは問わない**
   *   （`created[i].created` がどちらかを名乗る）。
   * - 🔴 **`created` は `news` と同じ順序・同じ長さで返す。**⚠ 並びがずれても型は何も言わず、`superseded_by_id` に別の記憶の id が
   *   書かれる。
   * - 🔴 **範囲外の `supersededByIndex` は専用の失敗として落とす**（`RangeError`。メッセージは `supersededByIndex out of range`）。
   *   ⛔ **黙って無視しない。⛔ `conflicted` にも「memory not found」にも混ぜない。**何も書かれない（`news` の作成も巻き戻る）。
   *
   * ⚠ **`updateStatusWithEvent` を単独で呼ぶ経路との違い:** 対象が存在しない場合、単独経路では直前に別途呼んだ
   * `createMemoryWithOutbox` の作成は commit 済みで残るが、このメソッドを経由するとその作成も巻き戻る（ADR 0100）。
   *
   * 🔴 **この口が在ることは原子性の証拠ではない。**`InMemoryMemoryStore` のように、実装していてもトランザクションを
   * 模していない adapter がありうる。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `news[i].input` にも `createMemory` と同じ制約が掛かる——`status === 'contested'` かつ `contestedWithId` が
   * `null`/`undefined` の要素が1件でもあれば、`news`/`supersede` どちらの書き込みも行わずに
   * {@link ContestedWithoutCompanionError} を投げる。
   * 🔴 `news[i].input` の `sourceObservationId`・`supersededById`・`contestedWithId` のテナント一致も `createMemory` と同じく検査する
   * （ADR 0439。`ctx.tenantId` の行でなければ、どちらも書かずに `… not found for tenant`）。
   *
   * 🔴 [ADR 0630](../../../../docs/decisions/0630-store-rejects-new-memory-that-fails-memory-schema-on-read-back.md):
   * `news[i].input` にも `createMemory` と同じ検査が掛かる——読み戻すと `MemorySchema` を通らない要素が1件でもあれば、
   * どちらの書き込みも行わずに拒む（先の要素・outbox・ラベル・イベントも残さない。範囲と例外は `createMemory` の doc）。
   *
   * ⭐ **`opts` は省略可能な第4引数である**（`createMemoryWithOutbox` の同じ欄と同じ）。**`opts.now` を渡すと、`news` に積む outbox 行の `availableAt`/`createdAt` に
   * その値を使う。省略時は実装が壁時計を使う。**
   *
   * ⭐ **`opts.abortIfForgotten`**（ADR 0375 決定7）: `createMemoryWithOutbox` の同じ欄と**同じ意味論**。非空の配列を渡すと、
   * **`news`/`supersede` どちらの書き込みより前に**、その id の現在の `status` を見直し、1件でも `"forgotten"` だったら
   * 何も書かずに {@link SourceMemoryForgottenError} を投げる。**この見直しは `conflicted` の部分成功より優先する。**
   * `abortIfForgotten` の id が `supersede[].id` の部分集合である必要はなく、この口は `supersede` との関係を検査しない。
   * 空配列・省略時は見直しを行わない。
   *
   * 🔴 **実装するかは adapter ごとに違う**（`createMemoryWithOutbox` の同じ欄と同じ）。`@mnemora/postgres` は同一トランザクションで見直し、
   * `InMemoryMemoryStore` と `FakeMemoryStore` は実装せず、渡しても無視される。
   *
   * ⭐ **`opts.buildCreatedEvent` と戻り値の `createdEventsWritten`**（[ADR 0416](../../../../docs/decisions/0416-created-event-same-tx-remaining-paths.md)）:
   * `news` の Memory の `created` イベントを、同じトランザクションで積む欄。
   * - `opts.buildCreatedEvent(memory, index)` は、`created: true` になった `news[index]` の Memory ごとに、store が
   *   **同じトランザクションの中で**呼び、返った {@link NewMemoryEvent} を `memory_events` へ INSERT する
   *   （`EventStore.append` は経由しない）。**同期・副作用なし**の関数で、`created: false` の要素には呼ばない。
   *   `supersede[].event` と違い `meta.supersededById` のような追記は行わず、返り値をそのまま書く。
   *   この INSERT が失敗したら**トランザクション全体が巻き戻る**。
   * - 🔴 **積んだことは戻り値の `createdEventsWritten: true` で名乗る。**この欄を知らない（黙って無視する）adapter はありうるので、
   *   呼び出し側は**名乗られたときだけ**別の `EventStore.append` を省く。⛔ 引数の有無だけで「積まれた」と決めない。
   *   ⚠ `buildCreatedEvent` を渡していない呼び出しでは、`createdEventsWritten` は付けない。
   * - 🔴 **名乗りは原子性の証拠ではない。**
   *
   * ⭐ **ADR 0420: `opts.abortIfSuperseded`**（`createMemoryWithOutbox` の同じ欄と同じ）。非空の配列を渡すと、書き込みの前に
   * その id の `status` を見直し、1件でも `"superseded"` なら何も書かずに {@link SourceMemoryStatusChangedError} を投げる。
   * **`abortIfForgotten` の見直しが先**。空配列・省略時は見直しを行わない。
   * `@mnemora/postgres` と `InMemoryMemoryStore` は実装し、実装しない adapter は無視する（任意）。
   *
   * ⭐ **ADR 0420: `opts.abortIfAllConflicted: true`**——`supersede` の対象が**すべて** CAS に弾かれた
   * （`conflicted.length === supersede.length`、かつ `supersede` が空でない）ときは、`news`・`created` イベントごと
   * トランザクションを巻き戻し、弾かれた全件を載せた {@link SourceMemoryStatusChangedError} を投げる。
   * **1件でも CAS を通れば部分成功**（`conflicted` に積んで commit）。省略・`false` は部分成功のまま。
   */
  supersedeWithNewMemories?(
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
  }>;
  /**
   * 抽出が書く「候補ごとの Memory」と、その `created` イベントを**1つのトランザクション**で書く
   * （[ADR 0410](../../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。実装しない adapter は `createMemoryWithOutbox` の
   * 候補ごとのループ＋別の `EventStore.append` のままでよい——**その adapter では `created` の取りこぼしが残る**（ADR 0410「引き受けた負債」）。
   * runtime は、この口が**在るかどうか**だけで経路を選ぶ。**撃って投げられたときに、旧経路で撃ち直さない**（二重に書きうる。
   * `supersedeWithNewMemories` と同じ規律）。
   *
   * 意味論（ADR 0347 決定2〜4 を、1トランザクションの中で守る）:
   * - `news` の各要素は {@link MemoryStore.createMemoryWithOutbox} と**同じ冪等経路**（既存行と衝突したら `created: false`、ジョブは積まない）。
   * - 🔴 **候補ごとに書きを区切り（Postgres は SAVEPOINT）、保存できない候補（store が拒む値。本文の NUL など）だけを巻き戻して
   *   `dropped` に積む。**残りの候補は書く。
   * - 🔴 **全候補が落ちたら、最初の例外をそのまま投げ、何も書かない**（ADR 0347 決定2）。
   * - 🔴 **`created` は、書けた候補（`created: true` のものだけ）について、全候補の成否が確定してから同じトランザクションで積む。**
   *   `buildCreatedEvent(memory, dropped)` が返す {@link NewMemoryEvent} を、この store がそのまま `memory_events` へ INSERT する。
   *   `dropped` は store が確定した「落とした候補」（`index` は `news` の索引、`error` は store が投げた例外そのもの）。
   *   `meta.droppedCandidates` の組み立ては core 側が行い、store は例外を返すだけである。
   *   `buildCreatedEvent` は**同期・副作用なし**の関数で、トランザクションの中で呼ばれる。
   * - 🔴 **`created` の INSERT が失敗したら、トランザクション全体を巻き戻す**。この例外は `dropped` に混ぜず、そのまま投げる。
   * - 戻り値の `written` は書けた候補（`created: false` の既存行を含む）を `news` の順に並べたもので、`index` が `news` の索引である。
   *   `dropped` は落とした候補を `news` の順に並べたもの。
   * - claim key の衝突検出（`detectContested`）はこの口の外。
   *
   * ⚠ **範囲**: 抽出に加えて、`reflect` の内省の `created`（1件）もこの口で積む（ADR 0416）。
   * `reextract`・`consolidate` の口あり経路は `supersedeWithNewMemories` の `opts.buildCreatedEvent` で積む。
   *
   * 🔴 **この口が在ることは原子性の証拠ではない**（`supersedeWithNewMemories` と同じ）。
   *
   * ⭐ `opts.now` は `createMemoryWithOutbox` の同じ欄と同じ意味（積む outbox 行の `availableAt`/`createdAt`）。
   *
   * ⭐ **`opts.abortIfForgotten`**（ADR 0416。抽出は渡さない）。`createMemoryWithOutbox`・`supersedeWithNewMemories` の同じ欄と
   * **同じ意味論**: 非空の配列を渡すと、**どの候補の書き込みより前に**その id の現在の `status` を見直し、1件でも
   * `"forgotten"` なら何も書かずに {@link SourceMemoryForgottenError}（`method: "createMemoriesWithOutboxAndEvents"`）を投げる。
   * この例外は候補ごとの巻き戻し・`dropped` の対象ではなく、**そのまま投げる**。空配列・省略時は見直しを行わない。
   * `InMemoryMemoryStore` は `createMemoryWithOutbox` と同じく**実装しない**（渡しても無視）。
   *
   * ⭐ **ADR 0420: `opts.abortIfSuperseded`**（`createMemoryWithOutbox` の同じ欄と同じ）。非空の配列を渡すと、書き込みの前に
   * その id の `status` を見直し、1件でも `"superseded"` なら何も書かずに {@link SourceMemoryStatusChangedError} を投げる。
   * **`abortIfForgotten` の見直しが先**。空配列・省略時は見直しを行わない。
   * `@mnemora/postgres` と `InMemoryMemoryStore` は実装し、実装しない adapter は無視する（任意）。
   */
  createMemoriesWithOutboxAndEvents?(
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
  }>;
  /**
   * 期限切れの `memory_events` 行を消す（テナント単位の保持期間 `TenantSettingsStore.setEventRetention`、ADR 0050 に対応する削除側。
   * docs/memory-model.md §11）。**`EventStore` interface（`append`/`list`/`get`）はこの口を経由しない**
   * （append-only の型に `update`/`delete` を持たせない。docs/memory-model.md §9）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。この口を実装しない adapter は、
   * 保持期間を「設定できるが、実際には縮まない」ままにする（[ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)「守れないもの」）。
   *
   * 契約:
   * - 対象は `tenant_id = ctx.tenantId AND at < opts.olderThan AND kind <> 'events_purged'` の行に限る。
   *   **`kind = 'events_purged'` 自身は対象から除外する**——含めると、ある回の掃除が積んだ `events_purged` が次回の
   *   掃除対象になる無限後退を生む（ADR 0115）。代償として `events_purged` 行は単調に増えるが、増分は呼び出し1回につき高々1行。
   * - **`opts.limit` は必須・既定値を持たない**（取り消せない削除の上限を `packages/core` が決めない。`ClaimOutboxJobsOptions.leaseMs`、ADR 0032 と同じ）。
   * - 並び順は `at` 昇順（最も古い行から消す）。対象が `opts.limit` を超える場合は `reachedLimit: true` を返す
   *   ——**これが「1回で消しきれなかった」ことを知る唯一の信号であり、`purged === opts.limit` からの推測に頼らせない**。
   * - **`opts.dryRun` を必ず持つ。**`true` のときは対象を数えるだけで、`memory_events` を1行も DELETE せず、`events_purged` も
   *   1行も INSERT しない。返り値の `purged`/`reachedLimit`/`oldestPurgedAt`/`newestPurgedAt` は「実行していたら何が起きたか」の
   *   プレビューである。
   * - **削除と `events_purged` イベントの追記は同一トランザクション。**`purged === 0` のときは、削除も追記も一切発生しない。
   * - 積む `events_purged` イベントの `meta` は `{ purgedCount, oldestPurgedAt, newestPurgedAt, olderThan }` の4欄のみ
   *   （docs/memory-model.md §9「件数と期間のみ」）。
   *
   * ⚠ **上記の `WHERE`（`kind <> 'events_purged'`）は
   * `kind = 'superseded'` の行を除外しない——保持期間を過ぎればそれらも削除の対象になる。**ただし `superseded` 行は
   * `MemoryStore.previewRestoreSupersededBy?` が `supersededReason` を読む唯一の情報源でもあるため、保持期間を過ぎたテナントでは
   * `previewRestoreSupersededBy?`/`groupSupersededCandidatesByOperation` が由来を「分からない」としてまとめる
   * （[ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)）。
   *
   * ⚠ **`purgeExpiredEventsForTenant`（`packages/core/src/event-retention-purge.ts`）は、このメソッドを直接呼ばない**
   * （[ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）。保持期間を読んでから `olderThan` を渡す呼び方は、
   * 読みと削除の間に保持期間が変わる race を防げない。それを閉じるのが {@link MemoryStore.purgeExpiredEventsByRetention} であり、
   * このメソッドは、その実装が内部で呼ぶ下請け（`olderThan`/`limit`/`dryRun` を受け取って消すだけ）である。
   */
  purgeExpiredEvents?(ctx: Ctx, opts: PurgeExpiredEventsOptions): Promise<PurgeExpiredEventsResult>;
  /**
   * `createdAt < opts.olderThan` の `recalls` 行を、その `recall_usages` ごと消す
   * （[ADR 0404](../../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)）。
   *
   * 🔴 **任意メソッドである。**理由は {@link MemoryStore.purgeExpiredEvents} と同じ。
   *
   * 契約:
   * - **`opts.olderThan` は必須・既定の保持期間を持たない。**何日残すかは呼び出し側が決める。
   * - 対象は `tenant_id = ctx.tenantId` かつ `created_at < opts.olderThan`（境界 `createdAt === olderThan` は対象外。
   *   {@link PurgeExpiredEventsOptions.olderThan} と同じ）。並びは `created_at` 昇順。
   * - **`recall_usages` は同一トランザクションで先に消える**（`recall_usages.recall_id` は `recalls(id)` への外部キーで、親だけを消せない）。
   *   ⟹ **消えた recall の使用記録も消える。**消した後にその `recallId` で {@link MemoryStore.recordUsage} を呼ぶと、
   *   `recall not found for tenant` の `Error` になる（ADR 0439）。
   * - `memory_events.meta` に `recallId` の文字列が載っていても、外部キーではないので残る。
   * - **`recalls.query` の中身（約束の範囲）には触れていない**——行ごと消えるだけで、どこまでを消すと約束するかは決めていない（ADR 0404）。
   * - `opts.limit` は必須・既定値なし（{@link PurgeExpiredEventsOptions.limit} と同じ）。対象が `limit` を超えれば `reachedLimit: true`。
   *   `limit` は **recalls の行数**であり、同時に消える `recall_usages` の行数は数えない（`result.purgedUsages` に別に返す）。
   * - `opts.dryRun === true` は1行も消さず、消していたら何が起きたかを返す。
   * - `events_purged` のような監査行は積まない。
   */
  purgeExpiredRecalls?(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult>;
  /**
   * 保持期間を読むことと、実際に削除することを、**1つの原子的な操作にする**口
   * （[ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）。
   *
   * 🔴 **任意メソッドである。**理由は {@link MemoryStore.purgeExpiredEvents} と同じ。
   * この口を実装しない adapter では、`purgeExpiredEventsForTenant` は `{ kind: "store_unsupported" }` を返す——
   * **{@link MemoryStore.purgeExpiredEvents} を実装していても、そちらへは自動的に落ちない**
   * （読みと削除を同じ操作にできるという宣言そのものがこの口の意味で、自動でフォールバックすると race を再導入する）。
   *
   * 契約:
   * - **`opts.now`・`opts.limit` は必須・既定値を持たない。**
   * - `opts.dryRun` は省略可能（省略時 `false`）。`true` のときも、保持期間の読みは実際の削除と同じ場所・同じ原子性で行う。
   * - **保持期間の読みは、呼び出しのたびにこのメソッドの内部で行う**——引数に `retention`/`olderThan` は無い。
   *   `ctx.tenantId` の `TenantSettingsStore.getEventRetention` 相当の状態を、実装が直接読む
   *   （`TenantSettingsStore` interface は経由しない。別 adapter を呼ぶと原子的な操作の外に出る）。
   * - 戻り値は3種:
   *   - `{ kind: "unset" }` — 読んだ時点でそのテナントの保持期間の設定行が無い。1行も削除しない。
   *   - `{ kind: "unlimited" }` — 読んだ時点で無期限。1行も削除しない。
   *   - `{ kind: "executed"; result }` — 読んだ時点で有限日数だった。`result` は {@link MemoryStore.purgeExpiredEvents} と同じ形の
   *     {@link PurgeExpiredEventsResult}。cutoff は `opts.now` からその日数ぶん遡った時刻（`computeEventRetentionCutoff` で計算する）。
   * - **同じ `ctx.tenantId` の保持期間を書き換える別の呼び出しが同時に走っていても、この呼び出しが見る保持期間は
   *   「読んだ時点の値で固定され、削除まで変わらない」**ことを、adapter 自身の同時実行制御で保証する。
   * - **`kind <> 'events_purged'` の除外・`events_purged` イベントの追記・`superseded` 行も含めて消す判断は、すべて
   *   {@link MemoryStore.purgeExpiredEvents} と同じ**——この口は「保持期間の読み方」だけを変え、「何を消すか」は変えない。
   */
  purgeExpiredEventsByRetention?(
    ctx: Ctx,
    opts: PurgeExpiredEventsByRetentionOptions,
  ): Promise<PurgeExpiredEventsByRetentionOutcome>;
  /**
   * `decay_floor_at` を割った `active` の Memory を `status='archived'` へ倒す掃引
   * （[ADR 0114](../../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md)、docs/memory-model.md §11 行8）。
   * `status='archived'` にする唯一の書き込み口である。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。この口を実装しない adapter では、`Runtime.sweepArchive` が
   * `{ supported: false, archived: [], reachedLimit: false }` を返して「対応していない」と名乗る（黙って0件を返さない。ADR 0082）。
   *
   * 契約:
   * - 対象は **`status = 'active'` のみ**（`superseded`/`contested` は触らない。ADR 0114「採らなかった案」）。
   * - `tenant_id = ctx.tenantId` かつ `decay_floor_at <= opts.now`（**`<=`、境界を含む**）。⚠ **`VectorFilter.decayFloorAtAfter`
   *   （`./vector-store.js`）は狭義の `>`（境界を含まない）であり、この非対称は意図である**——recall 側の下限境界と
   *   掃引側の上限境界は別の関心であり、揃えると境界上の行の扱いが壊れる。
   * - **「どの行を選ぶか」と「どの順で返すか」は別の契約である**（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと8・15）:
   *   - **選び方**: `opts.limit` 件を切り出す順序は、**掃く軸に合わせる**。`clock: 'activity'` は `decay_floor_seq` 昇順、
   *     `'wall'` と `'either'` は `decay_floor_at` 昇順（どちらも同着は `id` 昇順）。⭐ `'activity'` をこうしないと、
   *     `idx_memories_recall_gate_seq` が並び替えを担えず、掃引で索引が引けない（正しさではなく処理量の問題）。
   *   - **返し方**: {@link ArchiveDecayedResult.archived} は、`clock` によらず常に **`decay_floor_at` 昇順**（同着は `id` 昇順）。
   *   ⟹ `'activity'` では「選んだ順」と「返す順」が一致しないことがある。**これは意図した仕様である。**
   * - 選ばれた各行について `status='archived'` への更新と `memory_events` への `kind='archived'` の追記を行う。
   *   **この2つは同一トランザクション**（ADR 0031）。
   * - 対象が0件なら `{ archived: [], reachedLimit: false }` を返す（例外を投げない）。`opts.limit` が `0` のときも（対象が在っても）
   *   `{ archived: [], reachedLimit: false }`——`limit: 0` は断らず、何も掃かない（ADR 0432 AL-4。`ArchiveDecayedResult.reachedLimit`）。
   * - **一度 `archived` になった行は `status = 'active'` の条件に合わなくなるため、同じ範囲を繰り返し掃引しても同じ行が二度
   *   archived になることはない。**
   * - **同じ範囲の掃引が同時に走っても、同じ行が二度 archived にならず、`archived` のイベントも1件だけである**（ADR 0114 の追記）。
   *
   * ⚠ **既存索引 `idx_memories_recall_gate` をそのまま使い、新しい索引は追加しない**
   * （`status = 'active'` の等値条件がこの部分索引の述語を含意するため、プランナは選べる）。
   *
   * 🔴 **この掃引は自動では一度も走らない。**`Runtime.tick`/`Runtime.observe` に相乗りさせない——呼び出し側が明示的に
   * `Runtime.sweepArchive` を呼んだときだけ走る。
   */
  archiveDecayed?(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult>;
  /**
   * `forgotten` な Memory を物理削除する（[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)、
   * docs/memory-model.md「forget() と purge() を分ける」・§11 行10）——`content`/`digest` を固定のトゥームストーン文字列
   * （{@link PURGE_TOMBSTONE_CONTENT}/{@link PURGE_TOMBSTONE_DIGEST}）で上書きし、`purgedAt` を設定する。
   * **行そのものは消さない**（`memory_events` の外部キー、`superseded_by_id`/`contested_with_id` の参照先として残す）。
   *
   * 🔴 **[ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md): `content`/`digest` だけでなく、本文から直接
   * たどれる派生物も一緒に消す。**この呼び出しの中で、同じ書き込みとして:
   * - `tags` を空配列に、`attributes` を空オブジェクトに、`claimKey` を `null` にする（決定1）。
   * - この Memory に紐づく label の紐付けをすべて外し、`status: 'proposed'` のまま残る label の `proposedCount` を、
   *   外した本数だけ減らす（床は0。`registered` に昇格済みの label は触らない。**近似値のままである**。ADR 0318）（決定2）。
   * - このテナントの `recalls` の目次帯（`IndexBand.digestBand`）に、この `memoryId` を持つエントリがあれば、その `digest` を
   *   トゥームストーンへ書き換える（`truncated` は落とす。`recalls.query` は `memoryId` で特定できないため触らない）（決定3・4）。
   *
   * 🔴 **この呼び出しの後も残るもの**（ADR 0375「(b) 残る」表、docs/memory-model.md §9）: `recalls.query`
   * （`consolidate`/`reflect` が種の digest を `text` にして撃った recall の分を含む）、`contentHash`、元の Observation の `payload`、
   * `memory_events.digestSnapshot`（監査ログ）、`provenance.speaker`、`recall_usages`・完了した outbox の行、
   * **今の `embeddingProvider.space` 以外の embedding**（決定5）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。この口を実装しない adapter では `Runtime.purge` が
   * `{ supported: false, outcomes: [...すべて not_attempted] }` を返す（`content`/`digest`/`purgedAt` を書く経路はこの口以外に無く、
   * フォールバックを持たない。`archiveDecayed`/`purgeExpiredEvents` と同じ）。
   *
   * ⚠ **`updateStatusWithEvent` を再利用しない:** `purge` は `status` を動かさず、`content`/`digest`/`purgedAt` という
   * `updateStatusWithEvent` のシグネチャに無い列を書く（ADR 0122 の `restoreArchived` とは違い、既存の口に収まらない）。
   *
   * 契約:
   * - 対象の行が存在しなければ「memory not found」の `Error` を投げる（`id` が adapter の期待する形式でない場合も同じ）。
   * - 🔴 **CAS の条件は `status = 'forgotten' AND purged_at IS NULL` の両方。**`purge` は `status` を動かさないため、
   *   `status` だけを条件にすると2回目の呼び出しも条件を満たし、`purged` イベントが2件目積まれる
   *   ——**`purged_at IS NULL` がこの操作固有のべき等性を買う。**
   * - 条件を満たさない場合（対象は存在するが `status !== 'forgotten'` または `purgedAt` が既に非 `null`）は
   *   {@link MemoryPurgeConflictError} を投げる。
   * - 条件を満たす場合、`content`/`digest` を `tombstone.content`/`tombstone.digest` へ上書きし、`purgedAt` に書き込み時刻を設定し、
   *   同一トランザクションで `event`（`kind: 'purged'`）を追記する。**片方だけ起きることはない。**
   * - `status`/`contentHash`/`digestSource` は変更しない。**`status` は `'forgotten'` のままである。**
   * - `event.digestSnapshot` は呼び出し側が上書き**前**の digest を渡すこと（このメソッド自身は snapshot を作らない）。
   *   **purge の後、`memories` の行には元の `content`・`digest`・`tags`・`attributes`・`claimKey` は残らない。**
   *   元の digest は、監査ログのほかに `recalls.query` の分と Observation の `payload` にも残る。
   */
  purgeMemory?(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * **既に purge 済みの行**（`status = 'forgotten'` かつ `purgedAt` が非 `null`）に、ADR 0375 より前の `purgeMemory`
   * （`content`/`digest`/`purgedAt` しか書き換えなかった）が残した `tags`・`attributes`・`claimKey`・label の紐付けを消し、
   * `status: 'proposed'` の label の `proposedCount` を外した本数だけ減らす（床は0）
   * （[ADR 0437](../../../../docs/decisions/0437-helpers-params-subject-ids-repurge.md) 決定3）。
   * `Runtime.purge` が `already_purged` の対象（`dryRun` でないとき）に、ベストエフォートで呼ぶ。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。実装しない adapter では、`Runtime.purge` はこの後始末を飛ばす
   * （`already_purged` の意味は変わらない）。
   *
   * 契約:
   * - **`status = 'forgotten'` かつ `purgedAt` が非 `null` の行だけを対象にする。**未 purge の行・他テナントの行は、
   *   渡された id に含まれていても触らない。
   * - **べき等。**残骸の無い行に対しては何も書かない（`updatedAt` も動かさない）。**`proposedCount` は、実際に外した紐付けの本数だけ
   *   減らす**——2回目以降は外す紐付けが無いので減らない。
   * - 存在しない・形式不正な id は「無い」の一種として扱い、例外を投げない（`VectorStore.deleteAcrossSpaces` と同じ）。空配列は何もしない。
   * - [ADR 0512](../../../../docs/decisions/0512-scrub-purged-index-band.md): **このテナントの `recalls` の目次帯
   *   （`IndexBand.digestBand`）のうち、対象の行のエントリの `digest` を、その行の `digest`（トゥームストーン）へ伏せる**
   *   （エントリは残し、`truncated` は落とす）。他のエントリ・未 purge の行・他テナントの帯は触らない。
   *   `recalls.query`・`explain` は書かない（ADR 0375 決定4）。
   * - `content`/`digest`/`purgedAt`/`status`・`memory_events` は書かない。**監査イベントは積まない。**
   * - 返り値は無い（`void`）。
   */
  scrubPurged?(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void>;
  /**
   * 両側の `status='contested'`・`contested_with_id` の相互設定を書き込む口
   * （ADR 0134、docs/memory-model.md §11 行6）。
   * `contested_with_id` を作成後に書ける唯一の口である（`updateStatus`/`updateStatusWithEvent` は `status` と
   * `superseded_by_id` しか書かず、`createMemory` 系は相互参照を作成時に構成できない。ADR 0046）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。
   *
   * ⚠ **フォールバック経路を持たない。**`supersedeWithNewMemories?` のような既存メソッドの2段呼び出しでの代替は**意図的に作らない**
   * ——既存メソッドは `contestedWithId` を書けず、代替で作れるのは ADR 0046 が名指しした壊れた状態（片方だけ
   * `status='contested'` で `contestedWithId` が空）だけである。この口を実装しない adapter に対しては、`Runtime.markContested` は
   * 「対応していない」とだけ返す（`docs/decisions/0134-*.md`）。
   *
   * 契約:
   * - **両側とも呼び出し時点で `status === 'active'` であること**（CAS。この口は `active → contested`（lifecycle 行6）専用。
   *   他の遷移は `updateStatus`/`updateStatusWithEvent` を使う）。
   * - 🔴 **`first.id === second.id` は呼び出し前の programmer error として扱う。**実装は `RangeError`
   *   （メッセージ: `<実装のクラス名>: first.id and second.id must differ`。例: `PostgresMemoryStore: …`・`InMemoryMemoryStore: …`）を、
   *   書き込みを一切行う前に投げる。
   * - **両側どちらかの id がそのテナントに存在しない場合、`updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。**
   *   書き込みは一切行われない（もう一方が存在してもロールバックする）。
   * - **CAS が破れた場合（存在はするが `status !== 'active'`）は {@link MemoryStatusConflictError} を投げる。**`expectedStatus` は常に `'active'`。
   *   `supersedeWithNewMemories` の `conflicted`（部分成功）とは違い、**この口は全部成功するか全部失敗するかのどちらかである**
   *   （片方だけ contested になった状態が防ぐべき対象。ADR 0046）。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: 両側の `status='contested'`・`contestedWithId` を相手の id に相互設定、
   *   `memory_events` へそれぞれ1件ずつ追記（`event.kind` は呼び出し側が渡した値をそのまま使い、この口は値を強制しない）。
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`supersedeWithNewMemories` と同じ）。
   */
  markContestedPair?(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }>;
  /**
   * `contested` → `active | superseded` を書き込む口（`markContestedPair` の解決側。
   * ADR 0150、docs/memory-model.md §11 行7）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。
   *
   * ⚠ **フォールバック経路を持たない**（`markContestedPair?` と同じ）。`updateStatus`/`updateStatusWithEvent` には `contestedWithId` を
   * 書く引数が無く、`status` だけ動かすと `contestedWithId` が相手を指したままの行ができ、ADR 0046 の不変条件を破る。
   * この口を実装しない adapter に対しては、`Runtime.resolveContested` は「対応していない」とだけ返す。
   *
   * 契約（`markContestedPair` と対称。差分だけを述べる）:
   * - **両側とも呼び出し時点で `status === 'contested'` かつ、相手の `contested_with_id` が互いを指していること**（CAS）。
   *   この口は `contested → active | superseded`（lifecycle 行7）専用であり、他の遷移は `updateStatus`/`updateStatusWithEvent` を使う。
   * - 🔴 **`first.id === second.id` は呼び出し前の programmer error として扱う。**実装は `RangeError`
   *   （メッセージ: `<実装のクラス名>: first.id and second.id must differ`）を、書き込みを一切行う前に投げる。
   * - 🔴 **ADR 0503: `supersededById` の約束を壊す入力は、何も書かずに `RangeError`**（値は message に入れない。`first.status`/`second.status`
   *   の検査〔ADR 0499〕のあと、id の存在確認より前）。(1) `status: "superseded"` なのに `supersededById` が無い
   *   （`resolveContestedPair: first.supersededById is required when status is "superseded"`）。(2) 自己置換
   *   （`… must not be the memory itself`）。(3) `status: "active"` に `supersededById` を付ける（`… must not be set unless status is "superseded"`）。
   *   (4) 互いを指す循環（`resolveContestedPair: supersededById must not form a cycle among the members`）。勝者を指す `superseded`・
   *   `both_active`・対の外の（`forgotten` でない）記憶を指す `superseded` は断らない（`forgotten` は下の (5)）。
   *   (5) 🔴 **ADR 0515: 対の外の `forgotten` な記憶を指す**（`resolveContestedPair: <first|second>.supersededById must not be a forgotten memory outside the pair`。
   *   対の相手を指すのは断らない。対の外の `archived`・`superseded`・`active` も断らない）。テナントの照合（ADR 0439）のあと、書く前。
   * - 🔴 **ADR 0499: `first.status`/`second.status` が型の外（`"active"`・`"superseded"` 以外）なら、何も書かずに `RangeError`**
   *   （メッセージ: `resolveContestedPair: first.status must be "active" or "superseded"`〔`second` も同じ形〕。値は message に入れない）を
   *   投げる。`first.id === second.id` の検査のあと、id の存在確認より前。
   * - **両側どちらかの id がそのテナントに存在しない場合、`updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。**
   *   書き込みは一切行われない。
   * - **CAS が破れた場合（存在はするが `status !== 'contested'`、または `contested` ではあるが相互参照が成立していない）は
   *   {@link MemoryStatusConflictError} を投げる。**`expectedStatus` は常に `'contested'`。**この口も全部成功するか全部失敗するかのどちらかである。**
   * - 🔴 **`first.supersededById`/`second.supersededById` が `ctx.tenantId` の記憶を指していなければ、何も書かずに
   *   `memory not found for tenant: <id>` の `Error` を投げる**（ADR 0439。CAS の判定（{@link MemoryStatusConflictError}）のあとに当たる）。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: 両側とも `contestedWithId` を `null` にし、
   *   `first.status`/`second.status`（それぞれ `'active'` か `'superseded'`）へ更新し（`superseded` の側は `supersededById` も書く）、
   *   `memory_events` へそれぞれ1件ずつ追記する（`event.kind` は呼び出し側が渡した値をそのまま使い、この口は値を強制しない）。
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`markContestedPair` と同じ）。
   */
  resolveContestedPair?(
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
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }>;
  /**
   * 対向を `forget()` した後の対の**生存側1件だけ**を `active` に戻す口
   * （ADR 0150）。`resolveContestedPair` の CAS
   * （両側とも `contested` かつ相互参照が成立）は、対向を `forget()` した後の対では満たせないため、別の口にした
   * （**`resolveContestedPair` の CAS 自体は変えない**）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。**フォールバック経路は無い**——この口を実装しない adapter に対しては、
   * `Runtime.resolveOrphanedContested` は「対応していない」とだけ返す。
   *
   * ⚠ **「対向が forgotten/見つからない」という適格性の判定はこの口自身は行わない**（`Runtime.resolveOrphanedContested` が読み側で行う）。
   * この口は「呼び出し側が既に適格と判定した1件を、CAS を課して書く」だけである。
   *
   * 契約:
   * - **`survivor.id` 側は呼び出し時点で `status === 'contested'` かつ `contestedWithId === survivor.contestedWithId`
   *   （呼び出し側が読んだ時点の値）であること**（CAS）。**対向（`survivor.contestedWithId` が指す行）の現在の状態はこの口自身は検査しない。**
   * - `survivor.id` が `isUuidLike` でない、またはそのテナントに存在しなければ `updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。
   * - CAS が破れた場合（存在するが `status !== 'contested'`、または `contestedWithId` が渡された値と一致しない）は
   *   {@link MemoryStatusConflictError} を投げる。`expectedStatus` は常に `'contested'`。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: `survivor.id` の `status` を `'active'` に、`contestedWithId` を `null` に
   *   更新し、`memory_events` へ1件追記する（`event.kind` は呼び出し側が渡した値をそのまま使う）。**対向の行には一切触れない。**
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`markContestedPair`/`resolveContestedPair` と同じ）。
   */
  resolveOrphanedContested?(
    ctx: Ctx,
    survivor: { id: MemoryId; contestedWithId: MemoryId; event: NewMemoryEvent },
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * `active → contested` を**3件以上**（群）へ書く口（`markContestedPair`（2者専用）の N者版。ADR 0292 決定1、ADR 0327、ADR 0378 決定1〜4、
   * ADR 0381、docs/memory-model.md §11 行6）。呼び出し側（`Runtime`）が「誰を群に含めるか」（既存の対の吸収・複数の既存群の合併を含む）を
   * 決め、この口は渡された集合を**1トランザクションで**そのまま書くだけである（判定はしない）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。
   *
   * ⚠ **フォールバック経路を持たない**（`markContestedPair?` と同じ）。この口を実装しない adapter に対しては、`Runtime.markContestedGroup` は
   * 「対応していない」とだけ返し、状態を動かさず evidence だけ積む経路（ADR 0378 決定5）のままになる。
   *
   * 契約:
   * - **`members.length < 3` は呼び出し前の programmer error として扱う**（`RangeError`。
   *   メッセージ: `markContestedGroup: members must have at least 3 entries`）。2者は `markContestedPair` の領分（ADR 0378 決定1 の (ii)）。
   * - 🔴 **`members` に同じ `id` が2回以上現れるのは programmer error として扱う。**実装は `RangeError`
   *   （メッセージ: `markContestedGroup: member ids must be unique`）を、書き込みを一切行う前に投げる。
   * - **各メンバーが呼び出し時点で次のいずれかであること**（CAS。行ごとに判定する）:
   *   1. `status === 'active'`（新しく群に加わる）。
   *   2. `status === 'contested'` かつ `contestedWithId` が **他の** `members` のいずれかの `id` と一致する（既存の2者間の対を吸収する。
   *      対の相方も同じ `members` に含めるのは呼び出し側の責務で、片方だけ渡すとその片方は次の3の条件に落ちて `MemoryStatusConflictError` になる）。
   *   3. `status === 'contested'` かつ `contestedWithId === null`（既存の3件以上の群のメンバーを吸収する〔合併〕。その群が本当に `members` の
   *      他の誰かとつながっているかは、この口自身は検査しない。呼び出し側が `RelationStore.listRelated` で確かめてから渡す前提）。
   *   どれにも当てはまらない場合は CAS 違反として扱う。
   * - **どちらの id もそのテナントに存在しない場合、`updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。**書き込みは一切行われない。
   * - **CAS が破れた場合は {@link MemoryStatusConflictError} を投げる。**`expectedStatus` は常に `'active'`。
   *   **全部成功するか全部失敗するかのどちらかである**（`markContestedPair` と同じ）。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う:
   *   1. 全メンバーの `status = 'contested'`・`contestedWithId = NULL` に更新する（群のメンバーは `contestedWithId` を持たない。ADR 0378 決定1）。
   *   2. `memory_relations` へ、**有効期間が重なるメンバーの組だけ**（ADR 0381 決定1）、双方向2行ずつ `kind: 'contradicts'` で追記する。
   *      **既に同じ行が存在する場合は無視する**（`ON CONFLICT DO NOTHING` 相当）。
   *   3. `memory_events` へ、`members[].event` を1件ずつ追記する（`event.kind` は呼び出し側が渡した値をそのまま使う）。**ただし、呼び出し時点で既に
   *      `status === 'contested'` かつ `contestedWithId` が無いメンバー（既存の群の一員）の event は積まない**（ADR 0431。`@mnemora/postgres` と
   *      `@mnemora/testkit` の InMemory の実装）。戻り値の `events` は積んだ分だけで、`members` より短くなりうる。
   *      この点は適合の要件ではない——渡された event を全部積む adapter も適合する。
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`markContestedPair` と同じ）。
   */
  markContestedGroup?(
    ctx: Ctx,
    members: ReadonlyArray<{ id: MemoryId; event: NewMemoryEvent }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }>;
  /**
   * `markContestedGroup` の解決側（`resolveContestedPair` の N者版。ADR 0327 §4-c、ADR 0378 決定3、ADR 0381）。
   * `ContestedResolution`（`{kind:"supersede",winnerId}` | `{kind:"both_active"}`）の意味を、2者からそのまま群へ広げる。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。
   *
   * ⚠ **フォールバック経路を持たない**（`resolveContestedPair?` と同じ）。
   *
   * 契約（`markContestedGroup`・`resolveContestedPair` と対称。差分だけを述べる）:
   * - **`members.length < 3` は呼び出し前の programmer error**（`RangeError`。メッセージ: `resolveContestedGroup: members must have at least 3 entries`）。
   * - 🔴 **重複 `id` も programmer error**（`RangeError`。メッセージ: `resolveContestedGroup: member ids must be unique`）。
   * - 🔴 **ADR 0499: `members[i].status` が型の外（`"active"`・`"superseded"` 以外）も programmer error**
   *   （`RangeError`。メッセージ: `resolveContestedGroup: members[<i>].status must be "active" or "superseded"`。値は message に入れない）。
   *   何も書かない。重複 `id` の検査のあと、id の存在確認より前。
   * - **各メンバーが呼び出し時点で `status === 'contested'` であること**（CAS）。群のメンバーは `contestedWithId` を持たないので、
   *   相互参照の検査は無く、`status` だけを見る。
   * - ⚠ **（ADR 0381 追記）`members` は、`memory_relations` でつながった「今も `contested` な」群の全員と一致しなければならない（CAS）。**
   *   一部だけを渡した解消（部分解消）は拒む——`members` から `memory_relations`（`kind: 'contradicts'`）を辿って求めた到達集合のうち、
   *   `status === 'contested'` のものが `members` の id 集合と完全に一致することを要求する。**forget・supersede・purge・archive で群から
   *   抜けたメンバー（関係の行は残すが `status` はもう `'contested'` ではない。決定10）は、この到達集合に含めない**（「今の群」を行の有無ではなく
   *   `status` で判定する）。足りないメンバーが見つかった場合、その1件を名指しして {@link ContestedGroupMembershipMismatchError}
   *   （`MemoryStatusConflictError` は使わない）を投げ、何も書き込まない。
   * - 🔴 **ADR 0503: `supersededById` の約束を壊す入力は、何も書かずに `RangeError`**（値は message に入れない。status の検査〔ADR 0499〕のあと、
   *   id の存在確認より前）。(1) `status: "superseded"` のメンバーに `supersededById` が無い
   *   （`resolveContestedGroup: members[<i>].supersededById is required when status is "superseded"`）。(2) 自己置換。
   *   (3) `status: "active"` のメンバーに `supersededById` を付ける。(4) メンバー同士で輪になる `supersededById`
   *   （`resolveContestedGroup: supersededById must not form a cycle among the members`）。(5) **群の外の `forgotten` な記憶を指す**
   *   （`… must not be a forgotten memory outside the group`。テナントの照合のあと、書く前に判定する。群の外の `active` などを指す
   *   `superseded`、群のメンバーを指す `superseded` は断らない）。
   * - 存在しない id は「memory not found」の `Error`。それ以外の CAS 違反は {@link MemoryStatusConflictError}（`expectedStatus` は常に `'contested'`）。
   *   全部成功するか全部失敗するかのどちらか。
   * - 🔴 **`members[].supersededById` が `ctx.tenantId` の記憶を指していなければ、何も書かずに `memory not found for tenant: <id>` の `Error` を投げる**
   *   （[ADR 0439](../../../../docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)。メンバー・到達集合の判定（上の CAS）のあとに当たる）。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う:
   *   1. 各メンバーを `members[].status`（`'active'` か `'superseded'`）へ更新し、`'superseded'` の側は `members[].supersededById` も書く。
   *   2. **`both_active`・`supersede` のどちらでも**、この `members` 全員を結んでいた `memory_relations` の行を**双方向とも削除する**
   *      （2者版が決着の種類に関わらず `contestedWithId = NULL` へ戻すのと同じ。ADR 0381 決定3）。「再び争わせない」印は作らない。
   *   3. `memory_events` へ、`members[].event` をそれぞれ1件ずつ追記する。
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`markContestedGroup`/`resolveContestedPair` と同じ）。
   */
  resolveContestedGroup?(
    ctx: Ctx,
    members: ReadonlyArray<{
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId | undefined;
      event: NewMemoryEvent;
    }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }>;
  /**
   * 「同じ tenant・同じ `subjectId`・同じ claim key（`claimKey.subject`/`claimKey.predicate`）・有効期間が重なる・`contentHash` が違う、
   * 他の `active` Memory」を**列と索引だけで**（LLM を一度も呼ばずに）見つける読み取り専用の口
   * （ADR 0320 決定7・決定8。`idx_memories_claim_key` を使う）。`status`/`contentHash`/有効期間の重なりはこの口が絞る
   * （ADR 0320 決定8）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。**フォールバック経路は無い**——この口が無い adapter に対しては、
   * `Runtime` 側の検出（`claimKey.detectContested: true`）は何もしない。判定を近似で代替する擬似フォールバックは意図的に作らない
   * （近似は「説明できるか」を壊しうる）。
   *
   * 契約:
   * - **`subjectId` は NULL 同士も一致として扱う**（`IS NOT DISTINCT FROM`）。`subjectId` を持たない Memory 同士も「同じ主題」として扱う。
   *   ⚠ **recall 側の `RecallScope.subjectId`（既定は厳密一致、`includeSubjectless` で明示的に緩める）とは異なる規約である。**
   * - **`query.claimKey.subject`/`.predicate` は正規化済みの文字列として、そのまま等値比較する**（呼び出し側が `normalizeClaimKey` を通した値を渡す前提。
   *   この口自体は正規化しない）。
   * - **`status = 'active'` の行だけを返す。**
   * - **`query.excludeMemoryId` に一致する行は返さない。**
   * - **`query.contentHash` と一致する行は返さない**——内容が同じなら矛盾ではない。
   * - **有効期間が重ならない行は返さない。**半開区間 `[validFrom, validUntil)` として扱い、`validFrom` が `null` なら `-∞`、
   *   `validUntil` が `null` なら `+∞` として扱う（「1点」ではなく「区間の重なり」を判定する）。**空の区間（`validFrom === validUntil`）と
   *   逆転した区間（`validFrom > validUntil`）は点を1つも含まないので、何とも重ならない**——問い合わせ側でも、保存済みの行の側でも（ADR 0473）。
   * - **返す順序は規定しない。**
   * - **LLM を一度も呼ばない。**列の等値比較・範囲比較・索引アクセスだけで完結する。
   *
   * ⚠ **（ADR 0377）この口自体は `sourceObservationId` で絞らない**——同じ observation から抽出された兄弟 Memory どうしも、他の契約を満たせば
   * 返り値に含めてよい。呼び出し側（`Runtime.detectClaimKeyContested`）が、返り値から検出中の memory と同じ `sourceObservationId` を持つ行を
   * 件数を数える前に除く（`memory.sourceObservationId` が `null` のときは除かない）。adapter が独自に結果件数を `LIMIT` で絞ると、
   * core 側の除外が効かないことがある（interface は `LIMIT` を禁じていない。ADR 0377）。
   */
  findActiveByClaimKey?(
    ctx: Ctx,
    query: {
      subjectId: string | null;
      claimKey: ClaimKey;
      excludeMemoryId: MemoryId;
      contentHash: string;
      validFrom: Date | null;
      validUntil: Date | null;
    },
  ): Promise<Memory[]>;
  /**
   * `findActiveByClaimKey?` と**同じ絞り込み**を、`status = 'contested'` の行に対して行う読み取り専用の口
   * （ADR 0378）。同じ鍵に3件目が届いたとき、1件目・2件目は既に `contested` で `findActiveByClaimKey?` の一致から消えているため、
   * 「もう `active` ではないが、同じ鍵で争われている」相手を見つけるために要る。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。**フォールバック経路は無い**——この口が無い adapter に対しては、
   * `Runtime` 側の検出は `findActiveByClaimKey?` の一致（`active` のみ）だけで判定する。
   *
   * 契約は `findActiveByClaimKey?` と同一で、`status` の絞り込みだけが異なる:
   * - **`subjectId` は NULL 同士も一致として扱う**（`IS NOT DISTINCT FROM`）。
   * - **`query.claimKey.subject`/`.predicate` は正規化済みの文字列として、そのまま等値比較する。**
   * - **`status = 'contested'` の行だけを返す。**
   * - **`query.excludeMemoryId` に一致する行は返さない。**
   * - **`query.contentHash` と一致する行は返さない。**
   * - **有効期間が重ならない行は返さない**（半開区間 `[validFrom, validUntil)`、`NULL` は `-∞`/`+∞`。空の区間・逆転した区間は何とも重ならない）。
   * - **返す順序は規定しない。**
   * - **LLM を一度も呼ばない。**
   *
   * ⚠ **この口自体は `sourceObservationId` で絞らない**（ADR 0377 と同じ）。呼び出し側（`Runtime.detectClaimKeyContested`）が、
   * 両方の返り値を合わせた上で、同じ `sourceObservationId` を持つ兄弟を件数を数える前に除く（ADR 0378）。
   *
   * ⚠ **この口の一致は `markContested` の対にはしない。**`detectClaimKeyContested` は、合わせた一致が2件以上のとき、または
   * ちょうど1件でもその1件がこの口由来（既に `contested`）のときは `markContested` を呼ばず、状態を動かさずに `memory_events` へ
   * evidence（`meta.reason: 'claim_key_conflict_unresolved'`）を積むだけにする（ADR 0324 決定6、ADR 0378 決定2・決定7-d）。
   * 多者間グループを `contested` として束ねる書き込みはこの口の範囲外（`markContestedGroup`）。
   */
  findContestedByClaimKey?(
    ctx: Ctx,
    query: {
      subjectId: string | null;
      claimKey: ClaimKey;
      excludeMemoryId: MemoryId;
      contentHash: string;
      validFrom: Date | null;
      validUntil: Date | null;
    },
  ): Promise<Memory[]>;
  /**
   * 同じ tenant・同じ `subjectId` で claim key を持つ `active` な Memory から、`claim_key_predicate` を**新しい順・重複なく**列挙する
   * 読み取り専用の口（ADR 0327）。`deriveClaimKeys` の `knownPredicates` 語彙ヒントを store から集めるために使う
   * （`ClaimKeyOptions.knownPredicatesFromStore`）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。**フォールバック経路は無い**——この口が無い adapter に対しては、
   * `knownPredicatesFromStore` は黙って効かない（渡した `knownPredicates` だけが使われる。ADR 0324 決定1）。
   *
   * 契約:
   * - **`subjectId` は NULL 同士も一致として扱う**（`IS NOT DISTINCT FROM`。`findActiveByClaimKey?` と同じ）。
   * - **`status = 'active'` の行だけを対象にする。**
   * - **`claim_key_predicate` が非 `null` の行だけを対象にする。**
   * - 返す `string[]` は `claim_key_predicate` の**重複を除いた**一覧。同じ predicate を持つ行が複数あれば、そのうち最も新しい行
   *   （`created_at` が最大のもの）で代表させる。
   * - **新しい順**（代表行の `created_at` 降順）に並べる。呼び出し側は「利用者の一覧を先に、この一覧を後に、重複除去」という
   *   順序に依存するため、順序は契約である（`findActiveByClaimKey?` の「順序は規定しない」とは異なる）。
   * - **同着は、predicate のコードポイント順の昇順**で並べる。同着の順が実装ごとに変わると、`limit` で切った先頭の集合と語彙ヒントの
   *   優先順位が変わり、同じ入力に別のプロンプトが出る。DB の照合順序にも、書いた順にも、UTF-16 コード単位順（JS の `<`。
   *   BMP の U+E000〜U+FFFF と補助面の文字で、コードポイント順と食い違う）にも依らない。`PostgresMemoryStore` は `COLLATE "C"`、
   *   `packages/testkit` の in-memory 実装は UTF-8 のバイト列の比較で、これに揃える。
   * - **`query.limit` を超えない件数を返す。**`limit` は呼び出し側が決め、この口自身は既定値を持たない。
   * - **`claim_key_subject` の値は返り値に出ない。**この口が集めるのは predicate の語彙だけである。
   * - **LLM を一度も呼ばない。**
   *
   * ⚠ **`subject` 側の対（`listActiveClaimSubjects?` のような口）は意図的に作っていない**（ADR 0334「採らなかった案」）。
   * store が自己蓄積した `claim_key_subject`（LLM が自由記述で作った曖昧な値になりがち）を語彙ヒントとして横流しすると、
   * 別人の claim key `subject` を取り違えて同一視しうる汚染が起きる。`ClaimKeyOptions.knownSubjects` は呼び出し側が明示的に渡す
   * 静的な語彙だけをサポートする。
   */
  listActiveClaimPredicates?(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]>;
  /**
   * `superseded → active` を書き込む口（docs/memory-model.md §11 行15。設計全体は `Runtime.restoreSuperseded` の doc）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。この口を実装しない adapter に対しては、`Runtime.restoreSuperseded` が
   * `{ supported: false, supersedingMemoryId, outcomes: [] }` を返す（対応していないと名指しする。ADR 0082）。
   *
   * ⚠ **フォールバック経路を持たない。**既存の必須メソッドにはこの操作を表現する形が無い。
   *
   * 🔴 **`updateStatusWithEvent` を再利用しない**（`restoreArchived`（ADR 0122）との分岐点）。(1) `restoreSuperseded` は「置き換えた側の id」から
   * **群**を選ぶ範囲走査であり、id 単位の CAS ではない。(2) **`superseded_by_id` を `NULL` へ戻す経路が、型にも SQL にも無い**
   * （`opts.supersededById` を省略すると現在の値を保持するだけで、明示的に `NULL` を書く引数の形が無い）。
   *
   * 契約:
   * - 対象は **`tenant_id = ctx.tenantId AND superseded_by_id = supersededById AND status = 'superseded'` の行に限る。**
   * - 🔴 **`status = 'superseded'` を条件に必ず含める。**`superseded_by_id` が非 `null` のまま `status` が `'archived'`/`'forgotten'` へ
   *   さらに進んだ行を巻き込まない——この口が動かしてよい遷移は lifecycle 表行15の `superseded → active` 一本だけである。
   * - すべての条件を満たす行について、**1トランザクションで**次を行う: `status='active'`・`superseded_by_id=NULL`・`updated_at=now()` へ更新し、
   *   行ごとに `memory_events` へ `kind: 'unsuperseded'` を1件追記する。`digestSnapshot` にはその Memory の（変更しない）現在の `digest` を入れる
   *   ——`content`/`digest` はこの操作では書き換えない。
   * - `meta` には最低限 `{ reason, supersededById }` を入れる。`reason` は `event.reason` を渡された値、省略時は固定タグ `"unsuperseded"`
   *   （`ForgetOptions.reason`/`RestoreArchivedOptions.reason` の「省略時はキー自体を持たせない」とはここだけ意図的に違う）。
   *   `supersededById` には**外した相手の id**（この呼び出しの `supersededById` 引数）をそのまま入れる
   *   ——個々の `memory_events` 行だけを見ても「どの群の一部として戻ったか」が分かる。
   * - `event.actor` を省略した場合は `{ type: 'system' }`。
   * - 対象が0件なら `{ restored: [] }` を返す（**例外にしない**）。`supersededById` に実在しない・形式不正な id を渡した場合も同じ
   *   （範囲に何件あるか分からない問い合わせであり、0件は正常な結果。`archiveDecayed?` と同じ）。
   *   ⚠ **`event.at` が Invalid Date のときも、対象が0件なら
   *   `{ restored: [] }` を返す（例外にしない）。**2実装で同じ。対象が在るときは、どちらも例外で、1件も戻さない
   *   （`@mnemora/postgres` は `invalid input syntax for type timestamp with time zone` が drizzle の `Failed query` に包まれ、`cause` に入る）。
   * - 返す `restored` の順序は adapter に委ねる。
   * - 🔴 **この口が在ることは原子性の証拠ではない**（`markContestedPair`/`supersedeWithNewMemories` と同じ）。
   *
   * ⭐ **`filter?.onlyMemoryIds`**（[ADR 0258](../../../../docs/decisions/0258-restore-superseded-operation-scope.md)）: 指定すると、上記の対象の3条件に加えて
   * **`id` がこの配列に含まれること**を条件に足す（積集合）。**省略時は絞らない。**空配列を渡すと対象0件（例外にしない）。
   * adapter が `filter`（またはその中の `onlyMemoryIds`）を実装するかは、適合フラグ `MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?`
   * （`@mnemora/testkit`）で検査する。**未指定なら「検査していない」と名乗る**（このフラグは任意）。
   */
  restoreSupersededBy?(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string | undefined; actor?: EventActor | undefined; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ restored: Memory[] }>;
  /**
   * `restoreSupersededBy?` を実際に呼ぶ**前**に、その群に何が入っているかを見るための読み取り専用の口
   * （ADR 0237。`Runtime.restoreSuperseded` の `opts.dryRun` から呼ばれる）。
   *
   * 🔴 **`restoreSupersededBy?` の既存の振る舞いは変えない。**この口は別に足す任意メソッドである（[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md) 決定1）。
   *
   * **対象の選び方は `restoreSupersededBy?` の `WHERE` と完全に一致させる**——`tenant_id = ctx.tenantId AND superseded_by_id = supersededById AND
   * status = 'superseded'`。ずれると、「戻る前に見たものと、実際に戻ったものが違う」ことになる。
   *
   * **書き込みは一切行わない**（`SELECT` だけで完結する）。
   *
   * **`supersededReason`**: 対象の Memory について、`status` を `'superseded'` にした直近の `memory_events` 行
   * （`kind = 'superseded'`、`memory_id` が一致する行のうち `at` が最大のもの）の `meta.reason` をそのまま運ぶ。
   * ⚠ **これは「なぜその群に入っているか」を厳密に型付けした分類ではない**——`meta.reason` は `Runtime` の3つの書き手
   * （`reextract` は `"reextract_superseded"`、`consolidate` は `"consolidated"`、`resolveContested` は `"contested_resolved"`）が
   * 自由文として積んだ値をそのまま読むだけで、この口は解釈も変換もしない。一致する `memory_events` 行が無い場合は `null`。
   *
   * ⚠ **「一致する行が無い」は、`MemoryStore.purgeExpiredEvents?`
   * （[ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)）が保持期間に従ってその `kind: 'superseded'` 行を既に削除した場合にも
   * 起きる。**どの理由も `supersededReason: null` という同じ値になり、呼び出し側からは区別できない
   * （[ADR 0258](../../../../docs/decisions/0258-restore-superseded-operation-scope.md)）。
   *
   * - 対象が0件なら `{ candidates: [] }`（例外にしない）。
   * - 返す順序は adapter に委ねる。
   *
   * ⭐ **`filter?.onlyMemoryIds`（ADR 0258）: `restoreSupersededBy?` の同名パラメータと完全に同じ意味・同じ `WHERE` 条件を追加する。**
   * 両方の口で対象の選び方が一致する契約を守るため、`filter` の扱いも両者で一致させる。
   */
  previewRestoreSupersededBy?(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] | undefined },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }>;

  /**
   * このテナントの taxonomy 語彙を一覧する（`labels` テーブル、docs/memory-model.md §8、
   * [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md)）。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。
   *
   * 契約:
   * - `name` の**コードポイント順**（Postgres の `COLLATE "C"` と同じ、バイト順）の昇順で返す。並び順の保証はこの1点のみ
   *   （ロケール依存の自然順は実装や実行環境によってずれるため、契約に含めない）。
   * - `status` は `'registered'` か `'proposed'` のいずれか。
   * - `proposedCount` は「この名前を `tags` に含む Memory が新規作成された回数」の近似値である——**厳密な『いまこの名前を持つ生きた Memory の数』
   *   ではない**（対象の Memory が後から `forgotten`/`archived`/`superseded` になっても減らない。ADR 0318。減らすのは `purge` と、
   *   purge 済みの行の後始末（`scrubPurged`。ADR 0437）だけで、どちらも、その Memory の紐付けを外した本数だけ、`status: 'proposed'` の行の
   *   `proposedCount` を減らす。0 が床で、`registered` の行は減らさない。ADR 0375）。
   * - `registeredAt` は `status: 'registered'` のときだけ非 null。
   * - テナントに1件も無ければ空配列。例外にしない。
   *
   * ⚠ 今の振る舞い:
   * - **テナントの全ラベルを1回で返す。**ページング（件数の上限・続きから読む口）は無い。
   * - **ラベルの行は消えない。**`tags` にその名前を持つ Memory が全部 `forgotten`・`archived`・`superseded` になっても、行は残り、
   *   `proposedCount` も減らない。⟹ 誰も使わなくなった `proposed` のラベルも一覧に出続ける。消す口・却下する口は無い。
   *   `purge` した Memory のラベルも、行は残る（`proposedCount` だけが上の規則で減る）。
   */
  listLabels?(ctx: Ctx): Promise<LabelSummary[]>;

  /**
   * 語彙を `registered` へ昇格する（docs/memory-model.md §8、[ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md)）。
   *
   * 🔴 **任意メソッドである。**理由は `listLabels?` と同じ。
   *
   * 契約:
   * - 対象の `name` が `labels` にまだ存在しなければ、`proposedCount: 0` の新しい行を `registered` として作る。
   * - 既に `proposed` として存在すれば、`status` を `registered` に更新し `registeredAt` を現在時刻にする。`proposedCount` は変えない。
   * - 既に `registered` であれば、`registeredAt` を変えずに現在の行をそのまま返す（冪等）。
   * - 戻り値は更新後の `LabelSummary`。
   *
   * ⚠ **状態は `proposed` → `registered` の一方向だけである**。`registered` を `proposed` へ戻す口も、ラベルを却下・削除する口も無い。
   * `name` の形は検査しない——`""`・空白だけの名前もそのまま `registered` の行になる（`@mnemora/postgres`・testkit とも。
   * `tags` の要素と同じく完全一致の語彙で、正規化もしない。docs/memory-model.md §8）。`@mnemora/postgres` では、NUL を含む名前は
   * 例外になり、孤立サロゲートは U+FFFD に置き換わり、索引の1行の上限を超える長い名前は例外になる（`Ctx` の doc）。
   * testkit は長さの上限を持たず、そのまま受け入れる。孤立サロゲートの U+FFFD への置き換えは、testkit も同じである
   * （[ADR 0543](../../../../docs/decisions/0543-inmemory-lone-surrogate-replaced-with-fffd.md)）。
   */
  registerLabel?(ctx: Ctx, name: string): Promise<LabelSummary>;

  /**
   * このテナントに属する行を**跡形なく**消す——`purgeMemory?` と違い、行そのものを物理削除する（tombstone を書き残さない）
   * （[ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）。**このメソッド単体は orchestrator ではない**——
   * 呼び出し順・他 port との整合は `eraseTenant`（`packages/core/src/erase-tenant.ts` の独立関数）側の責務で、このメソッドは
   * 「自分が持つ表からこのテナントの行を消す」ことだけを行う。
   *
   * 🔴 **任意メソッドである。**必須にすると第三者の adapter を壊す。{@link EraseTenantStoreResult} の `store_unsupported`
   * （独立関数側で組み立てる）が port を名指しで区別するため、任意のままでも「口が無い」を「失敗した」と取り違えない（ADR 0383「検討した代替案」）。
   *
   * **消す表**: `memories`・`observations`・`memory_events`・`recalls`・`recall_usages`・`labels`・`memory_labels`・`memory_relations`・
   * `tenant_activity`・`tenant_subject_activity`（計10表。`@mnemora/postgres` の `eraseTenantBody` が消す表と同じ）。
   * **消去の記録は何も残さない**——`memory_events` に `events_purged` 相当の行を積んだりしない（ADR 0115 決定4は保持期間の掃除だけの話）。
   * 呼び出し側に返すのは戻り値だけである。
   *
   * 契約:
   * - `opts.limit` 個を目安に、子→親の順（`memory_labels`・`recall_usages`・`memory_events`・`memory_relations` → `memories` → `observations` →
   *   `recalls` → `labels` → `tenant_activity`・`tenant_subject_activity`）で削除する。**1回の呼び出しで全部消し切れるとは限らない**
   *   ——`result.reachedLimit === true` なら、呼び出し側は同じ `opts`（`limit` はそのまま）で呼び直すこと。**この口は何度呼んでも安全**
   *   （既に空になった表は0件を返すだけ）。
   * - 🔴 **同じテナント内の自己参照（`memories.superseded_by_id`/`contested_with_id`）は、`memories` を削除する前に、このテナントの行**全体**について
   *   `NULL` へ書き換えてから削除する。**`limit` で区切ったバッチをまたいで自己参照が残ると、`memories(id)` への FK（`ON DELETE` 指定なし）が違反になる。
   * - 🔴 **他テナントの行がこのテナントの行を参照している場合（外部キーのどの経路でも。埋め込み空間の表のように、このテナントの行を消すと
   *   巻き込まれて消える行も含む）、`{ kind: "blocked_by_foreign_reference"; count }` を返し、1行も消さない**（他テナントの行は書き換えない）。
   *   `count` は参照している他テナントの行数。ADR 0439 以降、`MemoryStore` の書き込み口は別テナントの行を指す参照を書かないので、
   *   この結果は、ADR 0439 より前に書かれた行が残っているときにだけ起こりうる（見つける SQL は ADR 0439 の「引き受けた負債」）。
   *   **この検査・削除は1つのトランザクションの中で行う。**`eraseTenant`（独立関数）はこの口を4つの port の中で最初に呼ぶので、
   *   これが返ったときほかの port にはまだ触れていない（ADR 0383 決定5・決定8）。
   * - `opts.dryRun === true` のときは、削除もこの自己参照の書き換えも一切行わず、削除していたら消えていたであろう件数だけを返す。
   * - 戻り値の `deleted` は、この呼び出しで実際に削除した行数の合計（上の10表すべての合計。`dryRun` のときはプレビューの合計）。
   *
   * ⚠ **`recalls` の保持方針は決めていない**（[ADR 0290](../../../../docs/decisions/0290-activity-seq-read-path-documented-not-implemented.md)）。
   * この口は「テナントを丸ごと消す」操作の一部として `recalls` も消すが、生きているテナントの `recalls` を今後どう保持するかには答えていない。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult>;
}

/**
 * {@link MemoryStore.eraseTenant}・`VectorStore.eraseTenant`・`OutboxStore.eraseTenant`・`TenantSettingsStore.eraseTenant` が
 * 共通して受け取る引数（[ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）。
 * `eraseTenant`（独立関数）の `opts` のうち `confirmTenantId` は port には渡さない（検査は独立関数の側で書き込み前に行う。
 * port 側は `Ctx` の `tenantId` を信じてよい）。
 */
export interface EraseTenantStoreOptions {
  /** 1回の呼び出しで削除する目安の上限。**必須・既定値なし**（取り消せない削除の上限を `packages/core` が決めない。`PurgeExpiredEventsOptions.limit` と同じ）。 */
  limit: number;
  /** `true` なら削除を一切行わず、削除していたら消えていたであろう件数だけを返す。省略時は `false`。 */
  dryRun?: boolean | undefined;
}

/**
 * `VectorStore.eraseTenant`・`OutboxStore.eraseTenant`・`TenantSettingsStore.eraseTenant` の戻り値（ADR 0383）。
 * `MemoryStore.eraseTenant` は {@link EraseTenantStoreResult}（`blocked_by_foreign_reference` を含む）を使う。
 */
export interface EraseTenantResult {
  /** この呼び出しで実際に削除した行数（`dryRun` のときはプレビューの件数）。 */
  deleted: number;
  /**
   * `true` なら、この store にまだ削除しきれていない行が残っている可能性がある（`opts.limit` で打ち切った）ことを示す。
   * 呼び出し側は同じ `opts` で呼び直すこと。
   * ⚠ **`deleted === opts.limit` ちょうどで削除しきれていた場合も `true` を返すことがある**（保守的な近似）。
   * 呼び直しても安全（その場合は次の呼び出しが0件で返るだけ）。
   */
  reachedLimit: boolean;
}

/**
 * {@link MemoryStore.eraseTenant} の戻り値（ADR 0383）。`{ kind: "executed", ... }` は {@link EraseTenantResult} と同じ形に `kind` を足しただけ。
 */
export type EraseTenantStoreResult =
  | { kind: "executed"; deleted: number; reachedLimit: boolean }
  | {
      kind: "blocked_by_foreign_reference";
      /** 他テナントの行のうち、このテナントの行を（外部キーのいずれかの経路で）参照している件数。 */
      count: number;
    };

/**
 * taxonomy 語彙1件（`labels` テーブル1行、docs/memory-model.md §8、[ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md)）。
 *
 * ⚠ **`attributes`（呼び手専用の別列）とは別物である。**`LabelSummary` が指す「ラベル」は `memories.tags` に語彙の状態
 * （`registered`/`proposed`）を持たせたもの——mnemora 自身が解釈する語彙である。`attributes` は mnemora が解釈しない呼び手専用の値で、
 * ラベルの語彙登録の対象にはならない。
 */
export interface LabelSummary {
  /** ラベルの名前（`tags` の要素と同じ語彙。正規化せず、完全一致で比べる）。 */
  name: string;
  /** `"registered"` は `registerLabel` で登録した名前、`"proposed"` は記憶の `tags` に現れただけで未登録の名前。 */
  status: "registered" | "proposed";
  /** この名前を `tags` に含む Memory が新規作成された回数の近似値。正確な現在数の契約ではない（`listLabels?`）。 */
  proposedCount: number;
  /** `status === 'registered'` のときだけ非 null。 */
  registeredAt: Date | null;
}

/**
 * {@link MemoryStore.reinforce} の省略可能な第4引数（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16）。
 * 活動時計の「いま」を渡す口である。
 *
 * ⭐ **非破壊である**——`opts` を省略すれば3引数の `reinforce(ctx, id, at)` がそのまま動き、既存の3引数の実装も直さずにこの interface を満たす。
 */
export interface ReinforceOptions {
  /**
   * 強化する時点の活動時計の「いま」（`tenant_activity.activity_seq`）。`ArchiveDecayedOptions.nowSeq` と同じ規律（ADR 0037）
   * ——**store が自分で `tenant_activity` を読みに行かない。**
   *
   * **省略した場合の契約: 活動時計側の3列（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は据え置く。黙って `0` として扱わない**
   * （省略と `0` は別の指示）。壁時計側（`lastReinforcedAt`/`decayFloorAt`）の更新には影響しない。
   *
   * 対象の Memory が `halfLifeRecalls` を持たない（活動時計では沈まない Memory）場合は、`nowSeq` を渡しても活動時計側の列には触れない
   * （`Memory.decayBaseSeq` の doc、ADR 0165 決めたこと4）。
   */
  nowSeq?: number | undefined;

  /**
   * `true` のとき、`nowSeq` は**テナントのカウンタ `T` だけ**を意味し、store は**強化する Memory 自身の `subjectId` の `S_x`**
   * （`tenant_subject_activity.activity_seq`。行が無い・`subjectId` が `null` なら `0`）を**行ごとに**足した `T + S_x` を、
   * その Memory の活動時計の「いま」（`decayBaseSeq` に書く値。`decayFloorSeq` の計算の起点）として使う
   * （[ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)）。
   *
   * `nowSeq` が省略されたときは何もしない。省略、または `false` のときは、`nowSeq` をそのまま起点として使う。
   *
   * ⭐ **非破壊である。**この項目を知らない adapter は `nowSeq` を「そのまま起点」として読み続ける。**runtime は、
   * `MemoryStore.supportsAddOwnSubjectSeq?()` が `true` を返す store にだけこの項目を渡す**（宣言が無い store には、`T + S_ctx` を
   * フラグなしの `nowSeq` として渡す）。宣言する store は、`tenant_subject_activity` に行が無い subject・主題なしの Memory には
   * `S_x = 0` として扱うこと。`hasSubjectActivityCounters` が `false` のテナントでは `S_x` はどの行でも `0` なので、runtime はこの項目を渡さない。
   */
  addOwnSubjectSeq?: boolean | undefined;
}

/**
 * {@link MemoryStore.archiveDecayed} の引数（ADR 0114）。
 *
 * **`now` は呼び出し側が渡す**（ADR 0037。`packages/core` 内部の `Clock` を経由させず、この口の引数として明示的に要求する）。
 *
 * **`limit` には既定値を置かない**（`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）・`RequeueEmbedJobsOptions.limit`（ADR 0079）と同じ）。
 * この口は範囲走査（`decay_floor_at` の昇順）の打ち切り位置を決めるので、既定値を置くとその影響範囲を core が黙って決めることになる。
 */
export interface ArchiveDecayedOptions {
  /** この時刻以前に `decay_floor_at` を迎えた Memory を対象にする（`<=`、境界を含む）。 */
  now: Date;
  /** 1回の呼び出しで archived にする上限。**既定値なし**。 */
  limit: number;
  /**
   * 「いまの `activity_seq`」を呼び出し側から受け取る（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15）。
   * **store が自分で `tenant_activity` を読みに行かない**（ADR 0037）。`clock` が `'activity'`/`'either'` のときに必須になる。
   */
  nowSeq?: number | undefined;
  /**
   * どの軸で掃くかを選ぶ（ADR 0165 決めたこと1・12・15）。省略時は `'wall'`。
   *
   * ⚠ **この既定は `MemoryStore.archiveDecayed` そのものの既定であり、`Runtime.sweepArchive` はこれを踏襲しない**
   * （[ADR 0186](../../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。`Runtime.sweepArchive` は `opts.clock` を省略されたとき
   * `tenant_settings.decay_clock` を読んでから、この口へ明示的な `clock`/`nowSeq` を渡す。**この口を直接呼ぶ経路にはその解決が乗らない。**
   *
   * - `'wall'`（省略時と同じ）: `decay_floor_at <= now`（境界を含む）。
   * - `'activity'`: `decay_floor_seq IS NOT NULL AND decay_floor_seq <= nowSeq`（`nowSeq` は必須。境界を含む）。
   * - `'either'`: **AND**（両方の軸で沈んでいるものだけ掃く）。
   *
   * **⭐ `'either'` が段1のゲートでは OR なのに、ここでは AND である**: 掃引の条件はゲートの条件の**論理否定**と一致していなければならない
   * （ゲートが通すのに掃引が掃く、という矛盾を避ける）。`NOT (A OR B) = (NOT A) AND (NOT B)` により AND になる。
   *
   * **境界の非対称（ADR 0165 決めたこと14）**: ゲートは狭義の `>`、掃引は `<=`（`now` 側の非対称〔`VectorFilter.decayFloorAtAfter`〕と同じで意図的）。
   * `decay_floor_seq` 側にもそのまま写す。片方だけ `>=` にすると、境界1件のズレとして紛れ込む。
   */
  clock?: DecayClock | undefined;
  /**
   * `true` のときだけ、`nowSeq`（`T`）に、行の subject に対応する `tenant_subject_activity` の値（`S_x`）を足した値と比較する
   * （[ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)。段1の `VectorFilter.decayFloorSeqUsesSubjectCounters` と同じ意味）。既定 `false`。
   */
  usesSubjectActivityCounters?: boolean | undefined;
}

/** {@link MemoryStore.archiveDecayed} の返り値（ADR 0114）。 */
export interface ArchiveDecayedResult {
  /**
   * 実際に archived にした Memory。`decay_floor_at` 昇順。
   * ⚠ `opts.clock` が `'activity'`/`'either'` のときも同じ——`decay_floor_seq` 順の契約は無い。
   */
  archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }>;
  /**
   * 🔴 **`true` は「`limit` 件ちょうど返した＝まだ在るかもしれない」を意味する。**
   * `opts.limit > 0 && archived.length === opts.limit` のときに `true`（`countKind` の `'unknown'`/`'lower_bound'` と同じ。
   * `docs/recall.md` §4「推定値を実測値の顔で出さない」）。
   *
   * ⚠ **「残り何件か」は返さない。**数えるには別のクエリが要り、掃引を範囲走査のみで安価に済ませる設計
   * （`docs/memory-model.md` §11）と衝突する。「もう無い」（`false`）と「分からない」（`true`）を区別するところまでが契約である。
   *
   * **`limit: 0` のときは、対象が何件在っても `false`**（ADR 0432 AL-4）。`limit: 0` は断らず、何も掃かず
   * `{ archived: [], reachedLimit: false }` を返す。⚠ 裏返しとして、`limit: 0` の `false` は「もう無い」とは読めない。
   * 残りを知りたければ `limit` を1以上にして呼ぶこと。
   */
  reachedLimit: boolean;
}

/** {@link MemoryStore.purgeExpiredEvents} の引数（ADR 0115）。 */
export interface PurgeExpiredEventsOptions {
  /** この日時より古い（`at < olderThan`）行だけが対象。境界値の `at === olderThan` は対象外。 */
  olderThan: Date;
  /**
   * 1回の呼び出しで削除する上限。**必須・既定値なし**（`ClaimOutboxJobsOptions.leaseMs` と同じ）。
   *
   * **0以上の整数を渡す前提である。負数を渡したときの結果は未定義で、実装ごとに違う**。
   *
   * | 実装 | `limit: -1` | `limit <= -2` |
   * |---|---|---|
   * | `PostgresMemoryStore`（`packages/postgres`） | 例外にならず `{ purged: 0, reachedLimit: true }` を返す（狙った契約ではない） | 例外 |
   * | `InMemoryMemoryStore`（`@mnemora/testkit`）／`FakeMemoryStore`（`@mnemora/core`） | 例外（`purgeExpiredEvents: limit must not be negative`） | 例外（同上） |
   *
   * **どちらの実装でも「誤って削除する」ことは起きない。**`-1` の結果そのもの（例外か `purged: 0` か）は実装間で分かれたままで、
   * **揃える予定は無い**（採らなかった案は [ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)）。
   */
  limit: number;
  /** `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。省略時は `false`。 */
  dryRun?: boolean | undefined;
}

/** {@link MemoryStore.purgeExpiredRecalls} の引数（ADR 0404）。 */
export interface PurgeExpiredRecallsOptions {
  /** この日時より古い（`created_at < olderThan`）recall だけが対象。境界値は対象外。**既定値なし。** */
  olderThan: Date;
  /** 1回の呼び出しで消す `recalls` の行数の上限。**必須・既定値なし。**0以上の整数を渡す前提（負数の結果は未定義）。 */
  limit: number;
  /** `true` なら何も消さず、消していたら何が起きたかだけを返す。省略時 `false`。 */
  dryRun?: boolean | undefined;
}

/** {@link MemoryStore.purgeExpiredRecalls} の返り値（ADR 0404）。 */
export interface PurgeExpiredRecallsResult {
  /** 消した `recalls` の行数（`dryRun` のときは消していたであろう行数）。 */
  purged: number;
  /** 一緒に消えた（`dryRun` のときは消えていたであろう）`recall_usages` の行数。 */
  purgedUsages: number;
  /** 対象が `opts.limit` より多かった（この呼び出しだけでは消しきれなかった）ことを示す専用の信号。 */
  reachedLimit: boolean;
  /** 消した recall のうち最も古い `createdAt`。`purged === 0` なら `null`。 */
  oldestPurgedAt: Date | null;
  /** 消した recall のうち最も新しい `createdAt`。`purged === 0` なら `null`。 */
  newestPurgedAt: Date | null;
  /** `opts.dryRun` の写し。 */
  dryRun: boolean;
}

/** {@link MemoryStore.purgeExpiredEvents} の返り値（ADR 0115）。 */
export interface PurgeExpiredEventsResult {
  /** 実際に削除された行数。`opts.dryRun === true` のときは、削除していたら消えていたであろう件数（プレビュー）。 */
  purged: number;
  /** 対象が `opts.limit` より多かった（この呼び出しだけでは消しきれなかった）ことを示す。`purged === opts.limit` からの推測に頼らせない専用の信号。 */
  reachedLimit: boolean;
  /** 削除された（またはプレビューで数えられた）行のうち最も古い `at`。`purged === 0` なら `null`。 */
  oldestPurgedAt: Date | null;
  /** 削除された（またはプレビューで数えられた）行のうち最も新しい `at`。`purged === 0` なら `null`。 */
  newestPurgedAt: Date | null;
  /** `opts.dryRun` の写し。 */
  dryRun: boolean;
}

/**
 * {@link MemoryStore.purgeExpiredEventsByRetention} の引数（[ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）。
 * {@link PurgeExpiredEventsOptions} と違い `olderThan` を持たない——cutoff はこのメソッドの内部で、保持期間を読んだ直後に `opts.now` から計算する
 * （呼び出し側が計算して渡すと、保持期間を読んでから削除するまでの間に保持期間が変わる race が残る）。
 */
export interface PurgeExpiredEventsByRetentionOptions {
  /** 「いま」。**必須・既定値なし**（`PurgeExpiredEventsForTenantOptions.now` と同じ。`purgeExpiredEventsForTenant` は省略時に `new Date()` を補って渡す）。 */
  now: Date;
  /** 1回の呼び出しで削除する上限。**必須・既定値なし**（{@link PurgeExpiredEventsOptions.limit} と同じ）。 */
  limit: number;
  /** `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。省略時は `false`。保持期間の読みは `dryRun` によらず同じ原子性で行う。 */
  dryRun?: boolean | undefined;
}

/**
 * {@link MemoryStore.purgeExpiredEventsByRetention} の戻り値（ADR 0354）。`PurgeExpiredEventsForTenantOutcome` から、この口の内側からは
 * 返せない `store_unsupported` を除いた3種。
 */
export type PurgeExpiredEventsByRetentionOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };

/**
 * {@link MemoryStore.requeueEmbedJobs} の引数（ADR 0079）。
 * **`statuses` にも `limit` にも既定値を置かない**（`ClaimOutboxJobsOptions.leaseMs`、ADR 0032 と同じ）。この口は `memories` と `outbox` の両方へ書くので、
 * 既定値を置くとその影響範囲を core が黙って決めることになる。
 */
export interface RequeueEmbedJobsOptions {
  /**
   * 対象にする現在の `embeddingStatus`。型が `NotIndexedReason` なのは意図である——`recall` が `{ kind: 'not_indexed', reason }` として名乗った値を、
   * そのまま渡せる。
   *
   * ⚠ **`'pending'` も指定できる。**待っても解けない行が混ざりうるため（`runtime.tick` の `processEmbedJob` で outbox 行だけが終端になり、
   * Memory が `pending` のまま残りうる）。**これは構造から読める「起こりうる」であって、発生を観測したものではない**（ADR 0079「確かめていないこと」）。
   */
  statuses: NotIndexedReason[];
  /** 対象をこの id の集合との積に絞る（任意）。省略時は `statuses` の条件だけで選ぶ。 */
  memoryIds?: MemoryId[] | undefined;
  /** 1回の呼び出しで積み直す上限。**既定値なし**。 */
  limit: number;
}

/** {@link MemoryStore.requeueEmbedJobs} の返り値（ADR 0079）。 */
export interface RequeueEmbedJobsResult {
  /** 実際に積み直した件数。`memoryIds.length` と必ず一致する。 */
  requeued: number;
  /** 積み直した Memory の id。`opts.limit` で切られた後の集合。 */
  memoryIds: MemoryId[];
}
