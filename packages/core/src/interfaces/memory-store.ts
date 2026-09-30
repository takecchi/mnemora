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
 * それと一致しなかったことを表す（PR「update-status-compare-and-swap」、ADR 0030）。
 * `packages/postgres/src/advisory-lock.ts` の型付きエラー階層（`AdvisoryLockTimeoutError` /
 * `AdvisoryLockUnavailableError`）に倣い、`Error` を継承した専用の型として定義する
 * ——呼び出し側が `instanceof` で「対象が無かった」と区別できることが目的。
 *
 * **`observedStatus` は「弾かれた後に読み直した値」であり、弾かれた瞬間の値とは限らない。**
 * adapter（`packages/postgres`）は `UPDATE ... WHERE status = expectedStatus` が0行だった
 * ときに追加の `SELECT` で読み直して詰めるため、その `SELECT` と実際に条件が破れた瞬間の
 * 間にも別の書き込みが割り込む余地がある。「衝突があったこと」は確実だが、「衝突した
 * 相手が何だったか」の正確な値としては読まないこと。
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
 *
 * `kind` を見て、`kind` が無ければ `name` を見る。core が2つの版に分かれていても、
 * `kind` がまだ無い古い版の core が投げたものでも効く。
 */
export function isMemoryStatusConflictError(value: unknown): value is MemoryStatusConflictError {
  return matchesStoreErrorKind(value, "memory_status_conflict", "MemoryStatusConflictError");
}

/**
 * Issue #207/#933 PR2（ADR 0381、2026-09-30 の直し）: `MemoryStore.resolveContestedGroup?`
 * の CAS のうち、「渡された `members` が、`memory_relations` でつながった今も `contested`
 * な群の全員と一致すること」が破れたときに投げる。
 *
 * 🔴 **`MemoryStatusConflictError` を再利用しない。**当初は
 * `MemoryStatusConflictError(missingId, "contested", "contested")`（`expectedStatus`
 * と `observedStatus` が同じ値になる特別な使い方）で表していたが、「この id 自身の
 * 状態は問題ないが、群の全員としてこの呼び出しに含まれていなかった」という意味は
 * `MemoryStatusConflictError` の本来の意味（期待した値と違う値を観測した）とは異なる
 * ——`MemoryPurgeConflictError` が `MemoryStatusConflictError` を再利用しなかったのと
 * 同じ理由（このファイルの `MemoryPurgeConflictError` の doc コメント参照）で、専用の
 * 型を切った。
 *
 * `missingMemberId` は、到達集合（`members` から `kind: 'contradicts'` を辿って求めた
 * 集合のうち `status === 'contested'` のもの）にあるが `members` に含まれていなかった、
 * 欠けたメンバーの id を1件だけ名指しする（複数欠けていても最初の1件のみ）。
 *
 * `Runtime.resolveContestedGroup?` は、`deps.relationStore` の配線の有無に関わらず、
 * この例外を捕まえて `{ kind: "ineligible", ... }` に写す（`MemoryStatusConflictError`
 * を `conflict` に写すのとは別の分岐——「部分解消」は TOCTOU による競合ではなく、
 * 呼び出し側が最初から適格でない集合を渡したことを表すため）。
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
 *
 * `kind` を見て、`kind` が無ければ `name` を見る。core が2つの版に分かれていても、
 * `kind` がまだ無い古い版の core が投げたものでも効く。
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
 * Issue #1226（ADR 0375 決定7、クローン miku の判断）: `createMemoryWithOutbox`/
 * `supersedeWithNewMemories` の `opts.abortIfForgotten` に渡した id のうち、書き込みの
 * 直前に見直したら1件でも `status === "forgotten"`（`forget()` のみ・`forget()` の後
 * `purge()` のどちらも含む——`purge()` は `forgotten` でない Memory を拒むため、
 * `purgedAt` が付いた行は必ず `forgotten` でもある）だったときに投げる。
 *
 * `runtime.consolidate`/`runtime.reflect` が、LLM を待つ間に統合元・内省の材料が
 * `forget`/`purge` されても、その本文から作った新しい Memory を `active` で書いて
 * しまう競合（Issue #1226 本文）を閉じるための道具。**投げられた時点で、この呼び出しは
 * 一切何も書いていない**——`news`（新しい Memory）も `supersede`（既存行の更新）も
 * どちらも rollback される（`opts.abortIfForgotten` を渡さなかった呼び出しでは、この
 * 例外は絶対に投げられない——今日どおりの振る舞いのまま）。
 *
 * `forgottenIds` は「見直した時点で forgotten だった id」の一覧——`abortIfForgotten` の
 * 部分集合であり、渡した順序を保つ保証は無い。
 *
 * 🔴 **`@mnemora/postgres` は、この見直しを書き込みと同一トランザクションの中で
 * `SELECT … FOR UPDATE` として行う**（ADR 0375 決定7・[Issue #1035](https://github.com/takecchi/mnemora/issues/1035)
 * と同じ形）——見直しと書き込みの間に窓が無い。**`packages/testkit` の
 * `InMemoryMemoryStore` と `packages/core` のテスト用 `FakeMemoryStore` は、
 * `opts.abortIfForgotten` を受け取らない（実装しない）**——呼び出し側
 * （`runtime.consolidate`/`runtime.reflect`）が LLM 呼び出しの直後・書き込みの直前に
 * 行う `getMany` の見直しだけが、これらの adapter の保護になる。この2つの見直しの
 * 間には小さな窓が残る（`Runtime.consolidate`/`Runtime.reflect` の doc コメント、
 * `docs/memory-model.md` の該当箇所を参照）。
 */
export class SourceMemoryForgottenError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isSourceMemoryForgottenError} で行う。 */
  readonly kind = "source_memory_forgotten" as const;
  constructor(
    readonly method: "createMemoryWithOutbox" | "supersedeWithNewMemories",
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
 *
 * `kind` を見て、`kind` が無ければ `name` を見る。core が2つの版に分かれていても、
 * `kind` がまだ無い古い版の core が投げたものでも効く。
 */
export function isSourceMemoryForgottenError(value: unknown): value is SourceMemoryForgottenError {
  return matchesStoreErrorKind(value, "source_memory_forgotten", "SourceMemoryForgottenError");
}

/**
 * [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
 * （Issue #243 続き、ADR 0136 決定3の設計メモを実装した）: `status: 'contested'` を
 * **対向（`contestedWithId`）無しで**書き込もうとしたときに、`updateStatus` /
 * `updateStatusWithEvent` / `createMemory` / `createMemoryWithOutbox` /
 * `supersedeWithNewMemories`（`news` 側）が投げる。
 *
 * `updateStatus`/`updateStatusWithEvent` には `contestedWithId` を渡す引数がそもそも
 * 無いため、この2メソッドで `status: 'contested'` を対象にした呼び出しは**常に**この
 * 例外になる——「対向を渡し忘れた」ケースを区別する余地が構造的に無い。
 * `createMemory` 系は `input.contestedWithId` が `null`/`undefined` のときにだけ
 * この例外になる。**対向を明示した作成（既存の Memory を指す `contestedWithId` 付き）は
 * 引き続き許される**——これは相互ペアの構成を保証しないが（ADR 0046
 * 「一対一が要求する状態を、今日どの経路でも作れない」参照）、少なくとも「対向が
 * 一切無い」状態は作らせない、という決定3の範囲に一致させている。
 *
 * **`status: 'contested'` を正しく（両側 CAS・相互参照・同一トランザクション）書く
 * 唯一の口は `markContestedPair`（任意メソッド、ADR 0134）である。**この例外を
 * 受け取った呼び出し元は、`markContestedPair` の実装有無を確認して使うこと。
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
 *
 * `kind` を見て、`kind` が無ければ `name` を見る。core が2つの版に分かれていても、
 * `kind` がまだ無い古い版の core が投げたものでも効く。
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
 * [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
 * が使う判定そのもの。`ContestedWithoutCompanionError` を投げるべきかどうかを、
 * adapter（`packages/postgres`・`packages/testkit`）それぞれで書き写さず、ここ1箇所に
 * 置く——判定基準が adapter ごとにずれることを防ぐ（ADR 0053 の
 * `isEmbeddingStatusRollback` と同じ形の判断）。
 *
 * ⚠ **2026-09-26 追記（Issue #854）: この判定は「対向が無いこと」だけを見る——**
 * **`contestedWithId` が指す先が呼び出し元と同じテナントの行かは見ない。**
 * `contestedWithId`/`supersededById` はどちらも、書き手が同じテナントの id を渡す
 * 前提で設計された欄であり、`MemoryStore` 自身はテナントの一致を検査しない
 * （Postgres の FK は `memories(id)` への単純参照で `tenant_id` を見ない
 * ——`packages/postgres/migrations/0001_init.sql` の `superseded_by_id`/
 * `contested_with_id` 列。`packages/testkit` の Fake は FK すら持たない）。
 * **読み取りへの実害は無い**——`MemoryStore` の他の全ての口は
 * `tenant_id = ctx.tenantId` で読み書きを絞るため、他テナントの id を指す
 * ダングリング参照が行き先テナント自身の行に残るだけで、その参照先の本文が
 * 別テナントから読めるようになることはない（`get`/`getMany` はテナントが
 * 違えば `null`/`[]` を返す）。`Runtime` を経由する呼び出し
 * （`markContested`/`resolveContested`/`consolidate`/`reflect`/`reextract`）は、
 * いずれも同じ `ctx` で存在を確かめた id からしか `contestedWithId`/
 * `supersededById` を組み立てない——到達するのは `MemoryStore`（`@mnemora/core`
 * の公開 interface）を直接呼ぶ経路だけである。
 */
export function isContestedWithoutCompanion(
  status: MemoryStatus | undefined,
  contestedWithId: MemoryId | null | undefined,
): boolean {
  return status === "contested" && (contestedWithId ?? null) === null;
}

/**
 * `MemoryStore.purgeMemory` の CAS 条件（`status = 'forgotten' AND purged_at IS NULL`）が
 * 破れたときに投げる（Issue #198、[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)）。
 *
 * 🔴 **`MemoryStatusConflictError` を再利用しない。**`purge` は `status` を動かさない
 * （`purged` は `memories.status` の値ではなく `purged_at IS NOT NULL` で表される、
 * docs/memory-model.md §11 行10）ため、CAS が破れても `observedStatus` は
 * `expectedStatus`（常に `'forgotten'`）と**同じ値になりうる**——「期待した値と違う値を
 * 観測した」という `MemoryStatusConflictError` の前提そのものが成り立たない場面がある
 * （例: 既に purge 済みで `status` は依然 `'forgotten'` のまま）。この専用の型は
 * `status` に加えて `purgedAt` も運ぶことで、その区別を表現する。
 *
 * **`observedStatus`/`observedPurgedAt` は「弾かれた後に読み直した値」であり、弾かれた
 * 瞬間の値とは限らない**（`MemoryStatusConflictError` の doc コメントと同じ注意）。
 * 呼び出し側（`Runtime.purge`）はこの値を信用せず、自分でもう一度 `get` を呼んで
 * `not_found`/`already_purged`/`status_not_forgotten`/`conflicted` のどれかに分類する。
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
 *
 * `kind` を見て、`kind` が無ければ `name` を見る。core が2つの版に分かれていても、
 * `kind` がまだ無い古い版の core が投げたものでも効く。
 */
export function isMemoryPurgeConflictError(value: unknown): value is MemoryPurgeConflictError {
  return matchesStoreErrorKind(value, "memory_purge_conflict", "MemoryPurgeConflictError");
}

/**
 * `MemoryStore.purgeMemory` が `content`/`digest` を上書きする固定の文字列
 * （Issue #198、[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)）。
 * docs/memory-model.md §9「forget() と purge() を分ける」: 「`content` と `digest` を
 * 固定のトゥームストーン文字列で上書きする…『NULL にする』ではなく『消えたことを示す値で
 * 上書きする』ことで、NOT NULL と物理削除の両立を図る」。
 *
 * `content`/`digest` に同じ文字列を使う——別々の文字列を持つ利点が無い一方、値を1つに
 * 保つほうが「これが tombstone だ」という直感的な確認がしやすい。
 *
 * 🔴 **「purge されたか」の判定にこの文字列を使わない。**常に `Memory.purgedAt !== null`
 * で判定する（`memories.status` は動かないため、`content`/`digest` の値そのものを
 * 判定の根拠にすると、将来この文字列を変えたときに判定ロジックまで壊れる）。
 */
export const PURGE_TOMBSTONE_CONTENT = "[purged]";
/**
 * purge した Memory の `digest` に書く値（`PURGE_TOMBSTONE_CONTENT` と同じ文字列）。⚠ purge されたかの判定には使わない——`Memory.purgedAt !== null` で判定する（上の doc）。
 */
export const PURGE_TOMBSTONE_DIGEST = "[purged]";

/**
 * `setEmbeddingStatus` が**唯一禁じる遷移**
 * （`docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md`）。
 * `ready` は `VectorStore.upsert` が返った*後*にしか書かれない——すなわち
 * 「ベクトル行が在る」という主張である。それを `failed` で上書きすると、ベクトル行が
 * 在るのに `memories.embedding_status = 'failed'` になり、`recall` がその Memory を
 * `notIndexed.failed` に計上して利用者に「埋め込みを疑え」と出す。
 *
 * ⚠ **禁じるのはこの1本だけである。**遷移表を全面的に固定したわけではない
 * （`skipped` を含む他の遷移の意味を今日決める根拠が無い。ADR 0053「採らなかった案」参照）。
 */
export const EMBEDDING_STATUS_ROLLBACK = { from: "ready", to: "failed" } as const satisfies {
  from: EmbeddingStatus;
  to: EmbeddingStatus;
};

/**
 * 現在の状態 `current` に `next` を書くことが {@link EMBEDDING_STATUS_ROLLBACK} の
 * 巻き戻しに当たるかを判定する。`packages/testkit` の in-memory 実装と `packages/core` の
 * Fake がこの関数を呼ぶことで、**禁じる遷移を1箇所に固定する**——実装ごとに条件式を
 * 書き直すと、どの遷移を禁じるかが実装間でずれる余地を作る
 * （`assertValidEventRetentionDays`（`./tenant-settings-store.js`）と同じ形）。
 *
 * ⚠ **`PostgresMemoryStore` はこの関数を呼べない。**比較を SQL の1文の `WHERE` の中に
 * 置かないと、読みと書きの間が空く（ADR 0048 と同じ理由）。**そのため `from`/`to` の値だけを
 * {@link EMBEDDING_STATUS_ROLLBACK} から取り、比較の形だけが SQL 側にもう一度書かれる。**
 * この二重化は、適合スイート（`packages/testkit/src/memory-store-conformance.ts`）の歯が
 * 両実装に走ることで押さえる。
 */
export function isEmbeddingStatusRollback(
  current: EmbeddingStatus,
  next: EmbeddingStatus,
): boolean {
  return current === EMBEDDING_STATUS_ROLLBACK.from && next === EMBEDDING_STATUS_ROLLBACK.to;
}

/**
 * `aggregateScope` の第3引数（任意）。目次帯（`IndexBand.digestBand`）を組むための
 * 帯候補を、群カウント等と**同一の集約クエリから**取得したい場合に渡す
 * （[ADR 0073](../../../../docs/decisions/0073-digest-band-bounded-without-taxonomy.md)、
 * docs/recall.md §5）。
 *
 * **任意引数にしてある理由は2つある。**
 *
 * 1. **渡さないことが「帯を組まない」という意味を持つ。**省略時は `digests: []`・
 *    `digestEligible: { count: 0, countKind: 'exact' }` を返す契約であり、実装は帯のための
 *    追加の仕事をしない（`packages/postgres` は CTE に帯用の列を足さない）。つまり任意性は
 *    移行の都合ではなく、**呼び出し側が費用を選ぶための軸**である。
 * 2. **`MemoryStore` は公開 API である**（`@mnemora/core` の `index.ts` から export され、
 *    README は adapter の自作を前提に `@mnemora/testkit` の導入を案内している）。第3引数を
 *    必須にすると、**この repo の外の呼び出し元**が `aggregateScope(ctx, scope)` と2引数で
 *    呼べなくなり、`TS2554: Expected 3 arguments, but got 2` で全部コンパイルエラーになる。
 *    ⚠ **壊れるのは呼び出し元であって、実装側ではない**——TypeScript は引数の少ない実装を
 *    引数の多い署名へ代入できるため、必須にしても `aggregateScope(ctx, scope)` としか
 *    書いていない外部実装は `implements` を通り続ける（tsc 5.9.3 / strict で実測した）。
 *
 * ⚠ **かつてここには「既存の3実装が第3引数を無視してもコンパイルが通る形にし、`digestBand`
 * 対応を段階的に入れられるようにするため（`packages/postgres`/`packages/testkit` 側の実装は
 * 次段で別の作業者が行う）」と書いてあったが、これは偽である。**同じ PR (#95) が
 * `packages/postgres` と `packages/testkit` の両方を同じ diff で実装しており、
 * 「段階導入の途中」という状態は存在しない。さらに上の 2 のとおり、段階導入を可能にするのは
 * 任意引数ではない（実装側は必須引数でも壊れない）。
 */
export interface AggregateScopeOptions {
  /** 目次帯（段5）の digest も集めるときに渡す。省けば digest を集めない。 */
  digestBand?: {
    /** 取得する上限件数。 */
    limit: number;
    /**
     * 帯から除外する memoryId（`memories` として返したもの）。
     *
     * adapter の期待する形式でない id（`@mnemora/postgres` なら uuid の形でないもの・空文字）は、どの
     * Memory とも一致しないので「無いもの」として扱い、例外にしない——`get`・`getMany` と同じ扱い。ほかの
     * id の除外はそのまま効く（Issue #1262。`@mnemora/postgres` は以前、DB の例外で投げていた）。
     */
    excludeMemoryIds: readonly MemoryId[];
  };
  /**
   * ADR 0390: 段1の ANN から除外した `provenance.kind`（`RecallQuery.excludeProvenanceKinds`）。
   * 渡すと、`ScopeAggregate.excludedProvenanceIndexedCount`（除外される kind で、スコープ内の
   * 索引済みの行の数）を返してよい。**任意の口であり、`totalInScope`・`groups`・`filtered*`・
   * `digests` の意味は変えない**（除外行もそれらには数えたまま）。
   *
   * **`undefined` と空配列 `[]` はどちらも no-op**（欄を返さない）——
   * `VectorFilter.excludeProvenanceKinds` と同じ作法。この口を知らない adapter は無視してよく、
   * そのとき `recall()` は今日と同じ判定（除外指定では ANN の取りこぼしを判定しない）に倒れる。
   */
  excludeProvenanceKinds?: readonly ProvenanceKind[];
  /**
   * 件数集計（群カウント・`totalInScope`・`filtered*`・`notIndexed`）を止めるかどうか
   * （[ADR 0384](../../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)
   * 案C、`RecallQuery.scopeAggregate` のそのままの値）。
   *
   * **既定・省略時は `"exact"`**——今日どおり厳密集計する。`"skip"` を渡された実装は、
   * **実際に集計をしない**（SQL を発行しない・ループを回さない等、実装ごとの手段で
   * 費用そのものを払わないこと）。値だけ受け取って計算は今までどおり行い、返り値だけを
   * 差し替える実装は禁止する——`"skip"` の目的は「費用の掛かる集計を止めること」であり、
   * 費用を払ったまま値を隠す実装はその目的を満たさない（ADR 0024 の事故と同種の
   * 「頼んだのに黙って別のことをする」を繰り返さない）。
   *
   * **この欄を実装しない adapter（`scopeAggregate` を一切読まない）は、常に厳密集計し
   * `countKind: 'exact'` を返さなければならない**——`digestBand?`（上）と同じ「渡さない
   * ことが意味を持つ」設計とは違い、**この欄は「読まれなかったときの安全側が定義されている」
   * 設計である**: 無視されても `"exact"` のまま動くので、値の意味が壊れることは無い。
   * `"skip"` を頼んだのに `"exact"` が返ってきても、それは「この adapter は
   * `scopeAggregate` に対応していない」という事実を `countKind` がそのまま正直に
   * 名乗っている状態であり、`"skip"` を頼んだのに `countKind: 'exact'` の顔をした
   * 未集計の値が返ることは無い（ADR 0384「決めたこと」参照）。
   *
   * **⚠ `"skip"` では `recall()` は ANN の到達（`ann_unreached`）を判定できない。** 返り値の
   * `countKind` が `'unknown'` のとき、`recall()` は ANN の stage detail に
   * `annReachability: "unknown"` を足して、そう名乗る（ADR 0390）。
   */
  scopeAggregate?: "exact" | "skip";
}

/**
 * MemoryStore — Phase 1（docs/architecture.md §5.1）。
 *
 * 実装は adapter 側（`packages/postgres` 等）に置く。ここは型のみ。
 *
 * 契約（振る舞い。型からは読み取れないため、`packages/testkit` の適合テストで検査する）:
 * - `createMemory` は `(tenant_id, source_observation_id, extractor_version, content_hash)` の
 *   一意制約により冪等（docs/architecture.md §3.5）。
 * - `reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` を更新し、
 *   `decay_floor_at` を再計算する。**`strength` は動かさない**
 *   （[ADR 0041](../../../../docs/decisions/0041-reinforce-does-not-change-strength.md)。
 *   以前この行は `strength` も更新すると名乗っていたが、3つの実装のどれも更新しておらず、
 *   **増分の式はどこにも決まっていない**）。
 * - `status = 'contested'` の Memory を単独で返してはならない。対向する Memory を
 *   スコアに関係なく必ず一緒に取得できなければならない（mandatory companion retrieval）。
 * - `aggregateScope` の返り値は近似を許すが、`countKind` を必ず伴う（Phase 1 は常に厳密。
 *   PR 本文の「設計上の疑義」参照。**⚠ 2026-09-30 追記（ADR 0384 案C）**: これは
 *   `opts.scopeAggregate` を渡さない・`"exact"` を渡した呼び出しの話であり、`"skip"` を
 *   渡した呼び出しは `countKind: 'unknown'` を返す——「Phase 1 は常に厳密」という
 *   以前の書き方は、その opt-in が無かった時点のものである）。**`axis: 'subject'` の
 *   `groups` の総和は必ず `totalInScope` と一致する**（`"skip"` でも `groups: []`・
 *   `totalInScope: 0` として一致する）。`axis: 'taxonomy'`（Issue #201 PR-B、
 *   [ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）は
 *   ラベルの多対多により総和が一致しない——別の被覆保証（`GroupCount` の doc コメント）
 *   を持つ。
 * - テナント分離: すべてのメソッドは `ctx.tenantId` に一致しない行を返してはならない。
 *   `testkit` は2テナントを同時に投入し、クロステナントの取得が0件になることを検査する。
 *
 * D9（マネージャー決定）で以下2メソッドを追加した。理由は docs/architecture.md §5.1 に
 * 追記済み:
 * - `getMany` — recall 段3の mandatory companion retrieval が `get` の連続呼び出し
 *   （N+1）にならないようにするため。
 * - `recordUsage` — 「実際に挿入が起きたときだけ強化する」という契約
 *   （docs/memory-model.md §6）を呼び出し側が知るための戻り値
 *   （`insertedMemoryIds`）を持つ。`reinforce` 単体では「実際に挿入されたか」を
 *   呼び出し側は知れない。
 *
 * roadmap.md 段階3（取り込み）で以下4メソッドを追加した:
 * - `getObservation` — `runtime.tick`（`extract: 'deferred'` の消化・ADR 0005）が
 *   outbox ジョブの payload から `observationId` だけを受け取り、本文を取り直すために使う。
 * - `createObservationWithOutbox` / `createMemoryWithOutbox` — transactional outbox
 *   （docs/architecture.md §3.4）を実現するための書き込み口。`observe()` の DB コミットと
 *   「抽出/埋め込みジョブを outbox に積む」を同一トランザクションで行うには、
 *   Observation/Memory の作成そのものにジョブ書き込みを同居させる必要がある
 *   （PR 本文の「決めたこと」参照）。**新規に行を作成できたとき（`created: true`）だけ
 *   ジョブを積む**——冪等な再送（`created: false`）でジョブを重複させない。
 * - `setEmbeddingStatus` — `embeddingStatus` の `pending → ready | failed` 遷移
 *   （roadmap.md 段階3の完了条件）を書き込む。**ただし `ready → failed` の巻き戻しだけは
 *   起きない**（現在が `ready` のとき `failed` を書く呼び出しは no-op。例外にはしない。
 *   ADR 0053。下記 `setEmbeddingStatus` の doc 参照）。
 *
 * ADR 0028（`runtime.reextract`）で以下1メソッドを追加した:
 * - `listBySourceObservation` — ある Observation から、ある版の抽出器で作られた Memory を
 *   列挙する（**SELECT のみ**）。`reextract` が「今回作られた content_hash の集合に
 *   含まれない既存 Memory」を判定するために使う。マイグレーション・索引の追加は伴わない
 *   ——`(tenant_id, source_observation_id, extractor_version, content_hash)` の一意索引
 *   （0001_init.sql）は既に `source_observation_id` を先頭から使える形をしている。
 *
 * roadmap.md 段階4/5（想起・説明）で以下2メソッドを追加した（本 PR）:
 * - `aggregateScope` — `countByGroup` を置き換える。旧 `countByGroup` は群カウント
 *   （`GroupCount[]`）しか返さず、`totalInScope`・`filtered` 系の件数を別のクエリで
 *   取らざるを得なかった。マネージャー決定（docs/recall.md §5 の「スコープの外延」
 *   補完）により、群カウント・スコープ内総数・スコープを定義するフィルタ（period/status）
 *   で落ちた件数・`not_indexed` 件数を**単一の集約クエリ**から返す必要が生じたため、
 *   戻り値を `ScopeAggregate` に拡張した契約として置き換えた。
 * - `createRecall` — recall 段6（記録）の書き込み口。`recallId` を発行して `recalls`
 *   テーブルへ1行残す（docs/recall.md §2 段6、ADR 0008）。この段は省略可能な段ではない
 *   ——`recallId` が発行されないと `observe({kind:'memory_usage'})` が recall を
 *   参照できなくなる。
 *
 * PR「update-status-compare-and-swap」（ADR 0030）で `updateStatus` に `opts.expectedStatus`
 * を足した: `reextract` の「`status !== 'active'` なら触らない」という安全弁が、読み（
 * `listBySourceObservation`）と書き（`updateStatus`）の間に別の書き込みが割り込む
 * TOCTOU で破れる穴を塞ぐ。省略時の振る舞いは変えていない。
 *
 * ADR 0031 で `updateStatusWithEvent` を追加した: `updateStatus` の呼び出しと
 * `EventStore.append` の呼び出しを別々のコミットとして行うと、前者が成功し後者が失敗した
 * 場合に「行は `superseded` のまま、対応する `superseded` イベントは永久に存在しない」という
 * *永続化された*不整合が残る（docs/memory-model.md §11 行5・docs/architecture.md §3.2 が
 * 要求する「同一トランザクション」に実装が違反していた）。`updateStatusWithEvent` は
 * status の更新とイベントの追記を1回の呼び出し・1トランザクションにまとめる。
 * **`updateStatus` は変更していない**——status だけを更新したい呼び出し元
 * （`archived`/`forgotten` への遷移等、イベントを別の理由で別途書く場合）はそのまま使える。
 *
 * [ADR 0114](../../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md) で
 * `archiveDecayed`（任意メソッド）を追加した: docs/memory-model.md §11 行8「掃引 →
 * `status='archived'` + `archived` イベント」を満たす唯一の書き込み口。`Memory.decayFloorAt`
 * は書き込み時に計算されて列に持たれていた（ADR 0004・ADR 0011）が、それを読んで実際に
 * `archived` へ倒す経路がこれまで無かった——この掃引がその欠落を埋める。
 *
 * [Issue #874](https://github.com/takecchi/mnemora/issues/874) / ADR 0303 追記節
 * （2026-09-26、クローン miku）で `reinforceMany`（任意メソッド）を追加した:
 * `handleMemoryUsage` の `recordUsage` → `reinforce` ループが使用報告1件ごとに
 * 直列に往復していた N+1 を、この口があるときだけ束ねるための一括版。契約は
 * `reinforceMany` 自身の doc コメント参照。
 *
 * [Issue #1432](https://github.com/takecchi/mnemora/issues/1432) /
 * [ADR 0380](../../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)
 * （2026-09-30、クローン miku の委譲先）で **必須メソッド** `listBySourceObservationAllVersions`
 * を追加した: ある Observation から作られた Memory を、`extractorVersion` を問わず列挙する
 * （**SELECT のみ**）。`Runtime.reextract` が「版を跨いで退けた記憶」を判定するために使う
 * ——`listBySourceObservation` は `extractorVersion` の絞り込みが契約そのものであり
 * （Issue #873）、この判定にはそのまま使えないため、別の口を新設した。**破壊的変更**
 * （自前の `MemoryStore` 実装はこのメソッドが無いとコンパイルできなくなる）。省略可能な
 * sentinel（例: `extractorVersion` に `undefined` を渡すと絞り込まない）にする案・任意
 * メソッド（`?`）にする案は採らなかった——理由は ADR 0380「採らなかった案」参照。
 */
export interface MemoryStore {
  /**
   * ⚠ **孤立サロゲート（`\uD800` 単体など、対をなさない UTF-16 サロゲートコードユニット）を
   * 含む文字列を渡したときの挙動は、adapter によって、Postgres では欄の列の型によっても
   * 異なる**（Issue #1075、実測。`createMemory` の同じ節と同じ形。現状を記録するだけで、
   * どれに揃えるか——正規化・拒否・このまま——は決めていない）。
   * - `PostgresMemoryStore`、`jsonb` 列の欄（`payload`/`attributes`）: **例外を投げる**
   *   （`invalid input syntax for type json`）。`JSON.stringify` が孤立サロゲートを `\ud800` の
   *   エスケープにし、Postgres の `jsonb` がそれを受け付けないため。**`runtime.observe` の
   *   `text`・`content`・`speaker`・`data` などは全部 `payload` に入る**ので、
   *   `observe({ kind: "utterance", text: "…\uD83D" })`（サロゲートペアの間で切った文字列）は
   *   Observation を1件も書かずに例外になる。
   * - `PostgresMemoryStore`、`text` 列の欄（`subjectId`/`externalId`。実測したのはこの2つ）: 例外を投げず、
   *   U+FFFD（置換文字）に置き換えて保存する（node-postgres が UTF-8 へエンコードするときに
   *   置き換える。`createMemory` の `text` 列の欄と同じ）。
   * - `packages/testkit` の `InMemoryMemoryStore` と `packages/core` の `FakeMemoryStore`:
   *   どの欄でも例外を投げず、入力をそのまま保持する。
   *
   * `createObservationWithOutbox` も同じである。今の振る舞いは
   * `packages/postgres/src/__tests__/lone-surrogate-observation.postgres.test.ts` が縛っている。
   *
   * ⚠ **`input` の欄の中身は、ほとんど検査しない**（今の振る舞い。2026-09-28 に `@mnemora/postgres` と testkit の fixture へ
   * 同じ入力を当てて確かめた。`createObservationWithOutbox` も同じ）:
   * - 空文字の `kind`・`subjectId`・`externalId`、文字列でない値を持つ `attributes`（例: `{ a: 1 }`）も、そのまま書いて返す。
   *   **返った Observation は `ObservationSchema` を通らないことがある**（`kind` 等は `min(1)`、`attributes` の値は文字列）。
   * - `input.tenantId` が `ctx.tenantId` と違っても拒まず、**`ctx.tenantId` のテナントとして書く**（返る値の `tenantId` も
   *   `ctx.tenantId`。`input.tenantId` のテナントからは読めない）。
   * - `payload` が `undefined` のとき、**`@mnemora/postgres` だけが**例外を投げる（`payload` 列が NOT NULL）。fixture は受け付けて返す。
   * - 拒むのは、列の型が受けない値——Invalid Date の日時、NUL を含む `kind`・`payload`（上の NUL の節）、JSON にできない値
   *   （BigInt は `TypeError`）——である。
   */
  createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
  /** roadmap.md 段階3: outbox ジョブから observationId を渡された側が本文を取り直すための読み出し。 */
  getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
  /**
   * roadmap.md 段階3: Observation の作成と outbox ジョブ書き込みを同一トランザクションで行う。
   * `jobKinds` の各要素につき1件のジョブを作る。ジョブの `payload` は
   * `{ observationId: <作成された Observation の id> }` に固定される（adapter が作成後の
   * id を使って組み立てる。呼び出し側が id をまだ知らない時点で呼ぶための設計）。
   * 冪等な再送（`externalId` が既存行と衝突）の場合は `created: false` を返し、
   * ジョブは一切作らない（`jobs` は空配列）。
   *
   * ⭐ **`opts` は省略可能な第4引数であり、この変更は非破壊である**（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)、
   * `ReinforceOptions`/ADR 0165 決めたこと13 と同じ理由——構造的部分型の下では「呼び出し側が
   * 省略可能な引数を渡さない」ことと「実装がその引数を最初から受け取らない」ことは区別されない）。
   * **`opts.now` を渡すと、積む outbox 行の `availableAt`/`createdAt` にその値を使う。省略時は
   * 実装が壁時計（`new Date()`）を使う——今日と同じ挙動。** `Clock` の doc コメント（2026-09-27・
   * 2026-09-28 追記、2026-09-29 訂正）が「outbox の `createdAt`・`availableAt` は壁時計になる」と
   * 記録していた問題（過去の時計を注入すると `tick` がジョブを1本も取らない）への対応——
   * runtime はこの欄に `clock.now()` を渡す。
   *
   * ⭐ **`opts.claimedBy` も省略可能で、非破壊である**（[ADR 0407](../../../../docs/decisions/0407-sync-observe-extract-job-lease.md)）。
   * **渡すと、積む outbox 行を「その名前で claim 済み」の状態で作る**——`claimedAt` は `opts.now`（省略時は
   * 壁時計）、`claimedBy` はこの値、`attempts` は `1`（`claimBatch` が初回の claim で付ける値と同じ）。
   * 作った直後の行は、他のワーカーの `claimBatch` から見て「リースを持っている行」であり、
   * リース（`ClaimOutboxJobsOptions.leaseMs`）が切れるまで claim されない。**返る `jobs` の `attempts` を
   * そのまま `complete`/`fail` の `expectedAttempts` に渡せば、CAS（ADR 0142）のフェンシングトークンになる。**
   * 省略時は今日と同じ（`attempts: 0`・未 claim・すぐ claim できる）。`extract: "sync"` の `observe` は、
   * 自分が LLM を待っている間に tick が同じジョブを取り、二重に抽出する穴を塞ぐためにこれを渡す。
   */
  createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date; claimedBy?: string },
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }>;
  /**
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `input.status === 'contested'` かつ `input.contestedWithId` が `null`/`undefined` の
   * 呼び出しは {@link ContestedWithoutCompanionError} を投げる（`isContestedWithoutCompanion`
   * が判定する）。対向を明示した作成（`contestedWithId` に既存 Memory の id を渡す）は
   * 引き続き許される。
   *
   * ⚠ **`input.contestedWithId` が `ctx.tenantId` と同じテナントの行を指しているかは
   * 検査しない**（`isContestedWithoutCompanion` の doc コメント、Issue #854）。
   *
   * ⚠ **孤立サロゲート（`\uD800` 単体など、対をなさない UTF-16 サロゲートコード
   * ユニット）を含む文字列を渡したときの挙動は、adapter によって異なる。Postgres では、
   * 欄の列の型によっても異なる（Issue #816・#1075、実測。契約として現状を記録するだけで、
   * この非対称を無くす変更は本 doc コメントの対象外）。**
   * - `PostgresMemoryStore`、`text` 列の欄（`content`/`subjectId`/`tags`/`digest`）:
   *   例外を投げない。node-postgres（`pg`）ドライバが JS 文字列を UTF-8 バイト列へ
   *   エンコードする際、対をなさないサロゲートを静かに U+FFFD（置換文字）へ置換する
   *   ——クエリが Postgres へ届く前、クライアント側で値が変わる。読み返した値は入力と
   *   一致しない。
   * - `PostgresMemoryStore`、`jsonb` 列の欄（`attributes`/`provenance`）: **例外を投げる**
   *   （`invalid input syntax for type json`）。`JSON.stringify` が孤立サロゲートを
   *   `\ud800` のエスケープにし、Postgres の `jsonb` がそれを受け付けないため。
   * - `packages/testkit` の `InMemoryMemoryStore` と `packages/core` の
   *   `FakeMemoryStore`: どの欄でも例外を投げず、入力をそのまま保持する（JS の文字列は
   *   UTF-16 コードユニット列であり、孤立サロゲートを持つことに制約が無いため）。
   *
   * ⟹ 呼び出し側は「成功した」ことだけでは、書き込んだ値と読み返した値が一致するとは
   * 限らない——Postgres 経由では、`text` 列の欄の孤立サロゲートは静かに書き換わり、
   * `jsonb` 列の欄では書き込みそのものが失敗する。
   *
   * ⚠ **`input.provenance` の中身は検査しない**（今の振る舞い。2026-09-28 に `@mnemora/postgres` と
   * `@mnemora/testkit` の fixture へ同じ入力を当てて確かめた）。型（`Provenance`、`provenance.ts`）の欄が欠けている・
   * 値域の外にある（例: `stated` の `sourceObservationId`・`at` が無い、`consolidated` の `sources` が空、
   * `imported` の `batchId` が無い、`inferred` の `confidence` が `2`、`at` が空文字）ものも、そのまま書いて
   * 返す。**返った Memory は `MemorySchema` を通らないことがある。**`provenance.sourceObservationId` と
   * `input.sourceObservationId` が食い違っていても検査しない。
   * 拒むのは次の3つだけで、どちらの adapter でも例外になる（投げる例外の種類は adapter で違う）:
   * - `provenance.kind` が列挙（`stated`・`inferred`・`consolidated`・`reflected`・`imported`）に無い
   *   ——Postgres は DB の CHECK の例外（drizzle が包んだ `Failed query`）、fixture は
   *   `memories.provenance_kind must be one of …` を投げる。
   * - `provenance.kind` が `stated`・`inferred` なのに `input.sourceObservationId` が `null`
   *   ——Postgres は DB の CHECK の例外、fixture は `provenance.kind "…" requires sourceObservationId` を投げる。
   * - `provenance` が `null`——どちらも `TypeError`（`provenance.kind` を読めない）。
   * `Runtime` は `provenance` を自分で組み立てて渡すので、ここに届くのは store を直接呼ぶ側である。
   */
  createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
  /**
   * roadmap.md 段階3: Memory の作成と outbox ジョブ書き込み（主に `embed`）を
   * 同一トランザクションで行う。`createObservationWithOutbox` と対になる契約。
   * 抽出の冪等性（`(tenant_id, source_observation_id, extractor_version, content_hash)`）で
   * 既存行に衝突した場合は `created: false` を返し、ジョブは作らない
   * （同じ内容に対して埋め込みジョブを重複させない）。
   * ⚠ **既存行に衝突する入力でも、書けない値は拒む**（`createMemory` も同じ）——列挙に無い値・NUL・
   * Invalid Date・値域の外の数は、既存行を返さずに例外になる。Postgres の `INSERT ... ON CONFLICT DO NOTHING`
   * は、衝突を見る前に値を型に変換し CHECK 制約を当てるためで、testkit の fixture も同じく拒む（実測 2026-09-27）。
   *
   * 🔴 `createMemory` と同じ [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
   * の制約を受ける。⚠ `input.contestedWithId` のテナント一致も `createMemory` と同じく
   * 検査しない（`isContestedWithoutCompanion` の doc コメント、Issue #854）。
   *
   * ⚠ `input.provenance` の中身も `createMemory` と同じく検査しない（返った Memory は `MemorySchema` を
   * 通らないことがある。拒むのは列挙に無い `kind`・列の `sourceObservationId` が無い `stated`/`inferred`・
   * `null` の3つだけ。`createMemory` の doc 参照）。
   *
   * ⭐ **`opts` は省略可能な第4引数であり、この変更は非破壊である**（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)、
   * `createObservationWithOutbox` の同じ欄と同じ理由）。**`opts.now` を渡すと、積む outbox 行の
   * `availableAt`/`createdAt` にその値を使う。省略時は実装が壁時計を使う。** runtime はこの欄に
   * `clock.now()` を渡す。
   *
   * ⭐ **2026-09-29 追記（Issue #1226 / ADR 0375 決定7、クローン miku の判断）: `opts.abortIfForgotten`
   * を足した。**`runtime.reflect` が、材料にした Memory を LLM 呼び出しの間に `forget`（さらに
   * `purge`）されても、その本文から作った内省の Memory を書いてしまう競合を閉じるための欄。
   * 非空の配列を渡すと、**書き込み（この INSERT）の直前に、その id の現在の `status` を見直し、
   * 1件でも `"forgotten"` だったら何も書かずに {@link SourceMemoryForgottenError} を投げる**——
   * `input` の INSERT も outbox ジョブの積み込みも一切起きない。空配列・省略時は今日どおり
   * （見直しを一切行わない）。
   *
   * 🔴 **`@mnemora/postgres` はこの見直しを、INSERT と同一トランザクションの中で
   * `SELECT … FOR UPDATE` として行う**（{@link SourceMemoryForgottenError} の doc コメント参照。
   * 見直しと書き込みの間に窓が無い）。**`packages/testkit` の `InMemoryMemoryStore` と
   * `packages/core` のテスト用 `FakeMemoryStore` はこの欄を実装しない**——渡しても無視され、
   * 例外は投げられない。これらの adapter を使う呼び出し側は、`runtime.reflect` 自身が
   * LLM 呼び出しの直後・この呼び出しの直前に行う `getMany` の見直し（残る窓あり）だけで
   * 保護される。第三者の adapter がこの欄を実装するかどうかは任意——実装しなくても
   * 型は壊れない（無視されるだけ）。
   */
  createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
    opts?: { now?: Date; abortIfForgotten?: ReadonlyArray<MemoryId> },
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
  /**
   * `id` が adapter の期待する形式でない場合も「存在しない」と同じ `null` を返す
   * （例外を投げない）。core の `MemoryId` は単なる `string` であり形式を強制しないため、
   * ある adapter が主キーに特定の形式（例: UUID）を要求していても、その形式に合わない
   * `id` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   */
  get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
  /**
   * D9: recall 段3の mandatory companion retrieval のための一括取得。**呼び出し全体を
   * 弾かない**——`ids` のうち adapter の期待する形式でないものは、無い id と同じく
   * 静かに結果から落とす（該当する id 以外は通常どおり返す）。全件が形式に合わなければ
   * 空配列を返す。
   *
   * ⚠ **返す順序は規定しない**（今の振る舞い。2026-09-27 に実測）——`ids` の順と一致するとは
   * 限らない（`@mnemora/postgres` は `ids` の順を保たず、testkit の fixture は保つ）。`ids` に
   * 同じ id が2回以上あっても、結果には1回だけ現れる（両実装とも）。呼び出し側は id で引き当てること。
   */
  getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
  /**
   * ADR 0028: ある Observation から、ある版の抽出器で作られた Memory を列挙する
   * （**SELECT のみ**。マイグレーション・索引を追加しない）。`extractorVersion` は
   * `NULLS NOT DISTINCT`（0001_init.sql）と同じ規約で `null` を1つの値として扱う
   * ——`extractorVersion: null` を渡すと `extractor_version IS NULL` の行を返す。
   * `observationId` が adapter の期待する形式でない場合も「存在しない」と同じ空配列を
   * 返す（例外を投げない）。
   *
   * ⚠ **`extractorVersion` はここでの絞り込み条件であり、指定した版と違う Memory は
   * この口には一切現れない**（Issue #873）。`Runtime.reextract` はこの口を自分の
   * `extractorVersion` で呼ぶため、旧い版の Memory を見つけて退役させる手段にはならない
   * ——それは呼び出し側が別途行う責務である（`Runtime.reextract` の doc コメント参照）。
   * **版を問わず同じ Observation 由来の Memory が要る場合は
   * {@link MemoryStore.listBySourceObservationAllVersions} を使うこと**（ADR 0380）
   * ——この口自体の契約（版で絞り込む）は変えていない。
   *
   * ⚠ **返す順序は規定しない**（今の振る舞い。2026-09-27 に実測。`@mnemora/postgres` と
   * testkit の fixture で並びが違う）。件数の上限・続きから読む口も無く、該当する行を全部返す。
   */
  listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]>;
  /**
   * [ADR 0380](../../../../docs/decisions/0380-reextract-withdrawn-across-extractor-versions.md)
   * （Issue #1432）: ある Observation から作られた Memory を、`extractorVersion` を**問わず**
   * 列挙する（**SELECT のみ**。マイグレーション・索引を追加しない——既存の一意索引
   * `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)`
   * は `(tenant_id, source_observation_id)` の前方一致でも使える）。`status` でも絞らない
   * ——`active`/`forgotten`/`contested`/`superseded`/`archived` のどれも返す。
   *
   * `listBySourceObservation` との違いはただ1つ、`extractorVersion` で絞り込まないことだけ
   * である。`Runtime.reextract` は、`extractorVersion` を上げた runtime インスタンスでも
   * 「利用者の意思で退けた記憶」を見落とさないために、この口を使う（Issue #1432 本文）。
   *
   * `observationId` が adapter の期待する形式でない場合は「存在しない」と同じ空配列を返す
   * （例外を投げない。`listBySourceObservation` と同じ規律）。
   *
   * ⚠ **返す順序は規定しない**（`listBySourceObservation` と同じ規律）。件数の上限・
   * 続きから読む口も無く、該当する行を全部返す。
   */
  listBySourceObservationAllVersions(ctx: Ctx, observationId: ObservationId): Promise<Memory[]>;
  /**
   * PR「update-status-compare-and-swap」（安全弁3、docs/decisions/0030-*.md）:
   * `opts.expectedStatus` を渡すと、書き込み時点で対象 Memory の `status` が
   * その値と一致するときだけ更新する（compare-and-swap）。**省略時は今日と同じ振る舞い**
   * ——status を条件にせず常に更新する。
   *
   * `expectedStatus` と実際の status が食い違っていた場合は {@link MemoryStatusConflictError}
   * を投げる。対象の Memory がそもそも存在しない場合は（`expectedStatus` の有無に関わらず）
   * 今日と同じ「memory not found」の例外のまま——「対象が無い」と「status が期待と
   * 違った」は別の例外で区別できる。
   *
   * `id` が adapter の期待する形式でない場合も、この「memory not found」の例外と
   * 同じ結果になる。core の `MemoryId` は単なる `string` であり形式を強制しないため、
   * ある adapter が主キーに特定の形式（例: UUID）を要求していても、その形式に合わない
   * `id` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   *
   * `expectedStatus` を**単数**にしている理由: 現時点の唯一の呼び出し元
   * （`runtime.ts` の `reextract`）が要る条件は `"active"` の1つだけであり、
   * 集合（配列）にする理由が無い。採らなかった案は ADR 0030 参照。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `status === 'contested'` を対象にした呼び出しは**常に** {@link ContestedWithoutCompanionError}
   * を投げる——この口には対向（`contestedWithId`）を渡す引数がそもそも無いため、区別の
   * 余地なく単独の `contested` になる。`contested` を正しく書くには `markContestedPair`
   * （ADR 0134）を使うこと。
   *
   * ⚠ **`opts.supersededById` が `ctx.tenantId` と同じテナントの行を指しているかは
   * 検査しない**（`isContestedWithoutCompanion` の doc コメント、Issue #854。同じ注意は
   * `contestedWithId` にも当たるが、この口には `contestedWithId` を渡す引数が無い）。
   */
  updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory>;
  /**
   * ADR 0031: `updateStatus` と同じ status 更新を行い、**同一トランザクションで**
   * `event` を `memory_events` へ追記する。命名は `createObservationWithOutbox` /
   * `createMemoryWithOutbox`（ADR 0012 D-ingest-1: 「同一トランザクションで行う必要がある
   * 2つの書き込みを、その組み合わせに特化したメソッドとして `MemoryStore` に持たせる」）に
   * 揃えた。
   *
   * 🔴 守る不変条件: **`memories.status` の更新が永続化されたことと、対応するイベントが
   * 永続化されたことは、同値である。** 一方だけが起きて他方が起きない状態を作らない。
   *
   * 契約（`updateStatus` と共通の部分は同じ意味論）:
   * - `opts.expectedStatus` を渡すと compare-and-swap になる。書き込み時点の実際の status が
   *   一致しなければ {@link MemoryStatusConflictError} を投げ、**status の更新もイベントの
   *   追記も一切起きない**（両方とも起きないか、両方とも起きるかのどちらかであり、
   *   片方だけ起きることはない）。
   * - `opts.expectedStatus` を省略すると、`updateStatus` の省略時と同じく status を条件に
   *   せず常に更新し、イベントを追記する。
   * - 対象の Memory がそもそも存在しない場合は、`expectedStatus` の有無に関わらず今日と
   *   同じ「memory not found」の `Error` を投げる（イベントは積まれない）。
   * - `id` が adapter の期待する形式でない場合も、この「memory not found」の例外と
   *   同じ結果になる（イベントは積まれない）。core の `MemoryId` は単なる `string` で
   *   あり形式を強制しないため、adapter が主キーに要求する形式に合わない `id` は
   *   「存在しない」の一種として扱う（`updateStatus` の doc コメント・
   *   `packages/postgres/src/mapping.ts` の `isUuidLike` の doc コメント参照）。
   *
   * ⚠ **`opts.supersededById` のテナント一致は `updateStatus` と同じく検査しない**
   * （`isContestedWithoutCompanion` の doc コメント、Issue #854）。
   *
   * 🔴 **買わない不変条件**（呼び出し側の `reextract` ループが対象1件ごとにこのメソッドを
   * 呼ぶ場合）: 「複数回の呼び出しをまとめて全部成功させるか全部失敗させるか」は買わない。
   * このメソッド自体は単一の Memory 1件・イベント1件の原子性しか保証しない
   * ——複数の Memory にまたがる操作全体の原子性は呼び出し側の責務（ADR 0031「採らなかった案」
   * 参照）。
   *
   * また、docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
   * 1トランザクション」は**このメソッドの範囲外**——新しい Memory の作成（`createMemory`/
   * `createMemoryWithOutbox`）は別の呼び出しのままであり、このメソッドは既存 Memory の
   * status 更新とイベント追記の対だけを扱う（ADR 0031「これが覆るとしたら」参照）。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `updateStatus` と同じ理由で、`status === 'contested'` を対象にした呼び出しは**常に**
   * {@link ContestedWithoutCompanionError} を投げる（status もイベントも一切書かれない）。
   */
  updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * roadmap.md 段階3: `embeddingStatus` の `pending → ready | failed` 遷移を書き込む。
   * 対象の Memory が存在しない場合は「memory not found」の `Error` を投げる。`id` が
   * adapter の期待する形式でない場合も同じ結果になる——core の `MemoryId` は単なる
   * `string` であり形式を強制しないため、adapter が主キーに要求する形式に合わない `id`
   * は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   *
   * 🔴 **`ready` を `failed` へ巻き戻さない**
   * （[ADR 0053](../../../../docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md)。
   * 判定は {@link isEmbeddingStatusRollback}）。現在の `embeddingStatus` が `ready` の
   * ときに `failed` を書く呼び出しは **no-op** である:
   *
   * - **例外を投げない。**唯一の `failed` の呼び出し口は `runtime.tick` の
   *   `catch (err) { await setEmbeddingStatus(..., "failed"); throw err; }` の中であり、
   *   ここで投げると**元の埋め込みエラー `err` が握り潰されて別の例外にすり替わる**
   *   （呼び出し側の次の一手も無い。ADR 0048 の `reinforce` と同じ理由の形）。
   * - **返すのは、更新されなかった現在の行そのもの**である（`embeddingStatus` は
   *   `ready` のまま）。
   * - **`updatedAt` も動かない。**「べき等」を「同じ値になる」ではなく
   *   **「行を触らない」**の意味で固定する。
   *
   * それ以外の遷移は今日どおり無条件である。**`failed → ready` は許す**——片側だけの
   * 規則であり、後から成功した埋め込みは正しく反映される。
   */
  setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
  /**
   * docs/memory-model.md §7、ADR 0010: `last_reinforced_at`/`decay_floor_at` を更新する。
   * 対象の Memory が存在しない場合は「memory not found」の `Error` を投げる。`id` が
   * adapter の期待する形式でない場合も同じ結果になる（`setEmbeddingStatus` の doc
   * コメント・`packages/postgres/src/mapping.ts` の `isUuidLike` の doc コメント参照）。
   *
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   * `opts.nowSeq` を渡すと、活動時計側の起点・床（`decayBaseSeq`/`decayFloorSeq`）も
   * 同じ強化イベントとして進める——**対象の Memory が `halfLifeRecalls` を持つ場合に限る**
   * （`ReinforceOptions.nowSeq` の doc コメント参照）。`opts` を渡さない、または
   * `opts.nowSeq` を省略した場合の契約: **活動時計側の3列（`decayBaseSeq`/`decayFloorSeq`/
   * `halfLifeRecalls`）には一切触れない**（黙って `0` として扱わない）。壁時計側
   * （`last_reinforced_at`/`decay_floor_at`）の更新は `opts` の有無に関わらず今日どおり。
   *
   * ⭐ **`opts` は省略可能な第4引数であり、この変更は非破壊である。**この口を実装する
   * 既存の3引数実装（`reinforce(ctx, id, at): Promise<Memory>`）は、1行も直さずに
   * この4引数の interface をそのまま満たす——TypeScript の構造的部分型の下で、
   * 「呼び出し側が省略可能な引数を渡さない」ことと「実装がその引数を最初から
   * 持たない」ことは区別されない。ADR 0165 決めたこと13 が
   * `TenantSettingsStore` の新メソッドを省略可能にしたのと同じ規律をここでも守る。
   *
   * **減衰の起点を巻き戻さない**（[ADR 0048](../../../../docs/decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)/
   * [ADR 0049](../../../../docs/decisions/0049-reinforce-monotonicity-in-pseudo-implementations.md)。
   * ADR 0048「引き受けた負債」の、この doc への書き起こし）。規則は1つである:
   * - **`at` が現在の起点（`lastReinforcedAt ?? recordedAt`）より狭義に新しいときだけ書く。**
   *   未強化の記憶（`lastReinforcedAt` が `null`）では、作成時刻（`recordedAt`）が起点である
   *   （[Issue #1093](https://github.com/takecchi/mnemora/issues/1093)。以前は `null` なら `at` によらず
   *   書いていたので、作成時刻より前の `at` で起点が作成時刻より前へ戻っていた）。
   * - **起点と等しい `at`・古い `at` は no-op である**——例外にしない。何も書かず（`updatedAt` も
   *   動かさず）、更新されなかった現在の行をそのまま返す。呼び出し側からは、書いたか
   *   どうかは戻り値の `lastReinforcedAt` を見ないと分からない。
   * - ⚠ **この比較は壁時計の `at` だけで行い、活動時計側の3列も同じ条件で守る**
   *   （ADR 0165 決めたこと16「2軸とも同じ強化イベントの一部」）。⟹ **等しい `at` の
   *   2回目は、`opts.nowSeq` が1回目より進んでいても `decayBaseSeq`/`decayFloorSeq` を
   *   動かさない。**`runtime.observe` の使用報告は `at` を `clock.now()` から取るので、
   *   同じミリ秒に2回の使用報告が来たときに当たる（Issue #730。実運用での頻度は
   *   測っていない）。等しい `at` を書く側へ倒す・活動時計側だけ seq で比べる変更は、
   *   適合テストの契約を変える破壊的変更であり、ここでは採っていない。
   *
   * ⚠ **[Issue #840](https://github.com/takecchi/mnemora/issues/840): このメソッドは
   * `status` を見ずに書く。**対象 Memory がどの `status`（`active`/`contested`/
   * `archived`/`superseded`/`forgotten`）であっても、上の単調性・活動時計の規則だけを
   * 適用してそのまま書き込む——`status` に応じた no-op・拒否は無い。
   *
   * `runtime.observe({ kind: 'memory_usage' })` は、`recordUsage` が返した
   * `insertedMemoryIds` を `status` を確かめずにこのメソッドへ渡す。正規の
   * recall→使用報告の往復で届くのは `contested`（recall の段3が companion として返す
   * 行）だけだが、**呼び出し側が古い Memory の id を持ったまま後から使用報告を送った
   * 場合、`archived`/`superseded`/`forgotten` の行にも届きうる。**
   *
   * 届いたときの帰結（status ごと。[ADR 0303](../../../../docs/decisions/0303-superseded-contested-decay-floor-owner.md)
   * 追記節、Issue #840 で確かめた）:
   * - **`contested`**: 正規の経路であり、ADR 0303 決定2（`contested` は忘却ゲートで
   *   `active` と同格に扱う）どおりの挙動——害ではない。
   * - **`archived`/`superseded`**: 復帰（`restoreArchived`/`restoreSuperseded`）が
   *   復帰の直後に `reinforce` を呼ぶため、時計が前にしか進まない通常の順序では
   *   単調性ガードにより上書きされ、効き目は残らない。**ただしこれは時計が前にしか
   *   進まないことに頼った結果であり、`reinforce` 自身が status を見て守っているわけ
   *   ではない**（時計を逆行させた場合、不正な値が復帰後の行に残りうる）。
   * - **`forgotten`**: 戻る経路が無いため、書かれた値は消えずに残る。忘却ゲート・
   *   段1の索引・段5の集計はいずれも `forgotten` の `decayFloorAt`/`decayBaseSeq` を
   *   読まないため、**`recall()` の結果には影響しない**——値が見えるのは `get()` で
   *   直接読んだときだけ（監査・エクスポート時のノイズ）。
   *
   * `reinforce` の対象を `active`/`contested` に絞るかどうかは、Issue #840 と ADR 0303
   * 追記節で扱った——**この doc の時点では絞っていない**。呼び出し側が
   * `runtime.observe` に渡す `usedMemoryIds` の出どころを正しく保つ責務を負う。
   */
  reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory>;

  /**
   * [ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md):
   * この store の `reinforce`/`reinforceMany`/`recordUsageAndReinforce` が
   * {@link ReinforceOptions.addOwnSubjectSeq} を読めること（`true` のとき、強化される
   * Memory 自身の subject の `S_x` を行ごとに足すこと）の**宣言**。読めるなら `true` を返す。
   *
   * ⭐ **任意メソッドである**——`hasSubjectActivityCounters?`（`TenantSettingsStore`）と同じく、
   * 「口が在るか／`true` を返すか」を runtime が見て分岐する作法に揃えた。**宣言が無い（未実装・
   * `false`）store には、runtime は今までどおりの値**（`T + S_ctx` をそのまま `nowSeq` に入れ、
   * `addOwnSubjectSeq` は付けない）**を渡す**——`addOwnSubjectSeq` を知らない第三者の adapter の
   * 挙動は、この項目を足す以前より悪くならない。`true` を宣言する store にだけ、runtime は
   * `nowSeq` に `T` だけを入れ、`addOwnSubjectSeq: true` を付ける。
   *
   * ⚠ `true` を宣言するなら、`reinforce` だけでなく `reinforceMany?`・`recordUsageAndReinforce?`
   * （実装しているなら）も読むこと。`@mnemora/testkit` の適合テストが、宣言した store にだけ
   * この項目の歯を当てる。
   */
  supportsAddOwnSubjectSeq?(): boolean;
  /**
   * [Issue #874](https://github.com/takecchi/mnemora/issues/874) / ADR 0303 追記節
   * （2026-09-26、クローン miku）: `reinforce` を `ids` の各要素について呼んだのと
   * 同じ結果になる、任意（省略可能）の一括版。`runtime.ts` の `handleMemoryUsage`
   * （`observe({kind:'memory_usage'})`）が使用報告1件ごとに `reinforce` を直列に
   * 呼んでいたことによる N+1（往復数が件数に比例する）を、この口があるときだけ
   * 束ねるために追加した。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`archiveDecayed?` と
   * 同じ理由）。この口を実装しない adapter に対しては、`handleMemoryUsage` が
   * 1件ずつ `reinforce` を呼ぶ従来のループにそのままフォールバックする。
   *
   * 契約: **`ids` の各要素 `ids[i]` について、`i = 0, 1, ..., ids.length - 1` の順に
   * `reinforce(ctx, ids[i], at, opts)` を呼んだのと同じ結果になる。**戻り値は `ids` と
   * 同じ長さ・同じ順序の配列であり、`results[i]` は `reinforce(ctx, ids[i], at, opts)`
   * の返り値と同じ `Memory` になる（`ids` に重複がある場合、重複したどの要素も
   * 同じ最終状態の行を返す——`reinforce` を同じ `id`・同じ `at` で複数回呼んでも
   * 2回目以降が no-op になるのと同じ理由。`at`/`opts` は呼び出し全体で1つだけ渡す
   * ——`reinforce` のように呼び出しごとに違う `at` を渡す口ではない）。
   *
   * `reinforce` の doc コメントが定める規律は、この一括版の**各要素**にもそのまま
   * 当たる:
   * - **減衰の起点を巻き戻さない**（[ADR 0048](../../../../docs/decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)/
   *   ADR 0049）: 書き込むのは、`at` が現在の起点（`lastReinforcedAt ?? recordedAt`）より
   *   狭義に新しい行だけ（`reinforce` と同じ1つの規則。Issue #1093）。**この単調性の比較は、1件ずつのときと同じく WHERE 句
   *   （CAS）の中で行う**——アプリ側で読んだ古い値を条件にしない（読みと書きの間に
   *   別の強化が割り込んでも上書きしない）。等しい/古い `at` は no-op（例外にしない。
   *   `updatedAt` も動かさない。更新されなかった現在の行をそのまま返す）。
   * - [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   *   `opts.nowSeq` を渡すと、活動時計側の起点・床（`decayBaseSeq`/`decayFloorSeq`）も
   *   同じ強化イベントとして進める——**対象の Memory が `halfLifeRecalls` を持つ行に
   *   限る**。この判定は**行ごと**に行う（`ids` に `halfLifeRecalls` を持つ行と
   *   持たない行が混ざってもよい。持たない行は活動時計側の3列に一切触れない）。
   * - [Issue #840](https://github.com/takecchi/mnemora/issues/840) / ADR 0303 追記節:
   *   **`status` を見ない。**対象 Memory がどの `status`（`active`/`contested`/
   *   `archived`/`superseded`/`forgotten`）であっても、上の単調性・活動時計の規則
   *   だけを適用してそのまま書き込む——`status` に応じた no-op・拒否は無い
   *   （`reinforce` と1バイトも違わない）。
   * - **`memory_events` は書かない**（`reinforce` 自身が書かないのと同じ）。
   *
   * `ids` に存在しない id・adapter の期待する形式でない id が含まれる場合:
   * `reinforce` 単体を呼べば「memory not found」の `Error` を投げる。この一括版も
   * 同じ `Error` を投げるが、**「どこまで書いてから投げるか」は 1件ずつのループと
   * 厳密には一致しない**——実装の doc コメント（`packages/postgres/src/memory-store.ts`
   * の `PostgresMemoryStore.reinforceMany`）を参照。
   *
   * ⚠ **runtime 側の唯一の呼び出し元（`handleMemoryUsage`）が渡す `ids` は
   * `recordUsage` が返した `insertedMemoryIds` であり、実運用でこの分岐に実際に
   * 入ることは無い**——`recall_usages.memory_id` は `memories(id)` への外部キーを
   * 持つため、`recordUsage` の INSERT が成功した時点で参照先の行が存在したことの
   * 証明になっており、かつ Memory の行は `purgeMemory?`（ADR 0124）でも内容を
   * 上書きするだけで物理削除されない。**確かめたのは「（この経路では）入らない」
   * ことであり、「入り得ない」ことの証明ではない**——`purgeMemory?` を実装しない
   * adapter・`handleMemoryUsage` 以外の将来の呼び出し元まで見渡した保証ではない。
   */
  reinforceMany?(ctx: Ctx, ids: MemoryId[], at: Date, opts?: ReinforceOptions): Promise<Memory[]>;
  /**
   * D9: 使用報告を記録する。`(recall_id, memory_id)` の挿入が実際に起きたものだけを
   * `insertedMemoryIds` として返す（再送は空配列になりうる）。
   *
   * ⚠ **テナントの一致は検査しない**（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051)）。
   * `recallId`・`memoryIds` にほかのテナントの id を渡しても、`@mnemora/postgres` と
   * `@mnemora/testkit` の `InMemoryMemoryStore` のどちらも受け付け、`insertedMemoryIds` に
   * 入れる。ほかのテナントの行は変わらず、本文も読めない。`Runtime` の
   * `observe({ kind: "memory_usage" })` は、口が在れば {@link MemoryStore.recordUsageAndReinforce}
   * を通り、強化の段で「memory not found」になって記録ごと巻き戻る（口が無い adapter では
   * `recordUsage` → `reinforce` の2段になり、記録だけが残る）。
   * `docs/memory-model.md` §5 の 2026-09-27 追記を参照。
   */
  recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * [Issue #961](https://github.com/takecchi/mnemora/issues/961): `recordUsage` と、
   * それが返した `insertedMemoryIds` への強化（`reinforceMany(ctx, insertedMemoryIds, at, opts)`
   * と同じ結果）を**1トランザクションで**撃つ、任意（省略可能）の口。戻り値は `recordUsage`
   * と同じ——実際に挿入が起きた id だけを返し、強化もその id にだけ掛ける（再送では
   * 空配列になり、強化もしない）。
   *
   * **なぜ要るか**: `recordUsage` と強化を別々にコミットすると、その間で落ちたとき
   * `recall_usages` の行だけが残る。同じ `externalId` の再送では `recordUsage` が
   * `insertedMemoryIds: []` を返すため強化が二度と呼ばれず、強化は恒久に失われる
   * （docs/memory-model.md §11 行4「`observe()` と同一トランザクション」・ADR 0009
   * 「再送で完了させられる」と食い違う）。この口では、強化が失敗すれば使用の記録も
   * 巻き戻るので、再送がそのまま両方をやり直す。
   *
   * 契約: 強化の規律（減衰の起点を巻き戻さない・活動時計・`status` を見ない・
   * `memory_events` を書かない）は `reinforceMany` の doc コメントのとおり。
   * **例外を投げたときは、使用の記録も強化も1件も残さない。**
   *
   * 🔴 **任意メソッドである**（`reinforceMany?` と同じ理由——必須にすると第三者の
   * adapter を壊す）。この口を持たない adapter では `runtime.ts` の
   * `handleMemoryUsage` が従来どおり `recordUsage` → 強化の2段で撃つ——**その adapter
   * には上の「強化が恒久に失われる」窓が残る**（ADR 0009 の 2026-09-27 追記）。
   */
  recordUsageAndReinforce?(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
    at: Date,
    opts?: ReinforceOptions,
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * roadmap.md 段階4/5: 群カウント・スコープ内総数・スコープを定義するフィルタ
   * （status/period/taxonomy）で落ちた件数・not_indexed 件数を単一の集約クエリから返す
   * （`ScopeAggregate` の doc コメント、docs/recall.md §5 参照）。
   * 契約: 返り値の `axis: 'subject'` の `groups` の総和は必ず `totalInScope` と一致する
   * （同一クエリから導出するため、並行する書き込みがあっても構造的に崩れない）。
   * **`axis: 'taxonomy'`（`scope.taxonomyGroupCandidates` が在るときだけ生成、Issue #201
   * PR-B、[ADR 0323](../../../../docs/decisions/0323-taxonomy-recall-filter.md)）は
   * この契約の対象外**——`GroupCount` の doc コメント参照。
   *
   * `opts.digestBand` を渡すと、`ScopeAggregate.digests`/`digestEligible` も
   * **同じ集約クエリから**埋めて返す（`ScopeAggregate` の doc コメント参照）。
   * 渡さない場合は `digests: []`・`digestEligible: { count: 0, countKind: 'exact' }`。
   *
   * `opts.scopeAggregate: "skip"`（[ADR 0384](../../../../docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)
   * 案C）を渡すと、群カウント・`totalInScope`・`filtered*`・`notIndexed` の集計を止める
   * ——`groups: []`・`totalInScope: 0`・これらの `countKind` は `'unknown'` になる。
   * `digestBand` は独立した経路なので、`scopeAggregate: "skip"` と同時に渡しても
   * `digests` は今日どおり返る（`digestEligible` だけは件数の一種なので `count: 0`・
   * `countKind: 'unknown'`）。`AggregateScopeOptions.scopeAggregate` の doc コメント参照。
   */
  aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate>;
  /**
   * roadmap.md 段階4/5: recall 段6（記録）。`recalls` へ1行書き込み、発行した recallId を返す。
   *
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5:
   * `record.advanceActivityClock === true` のとき、実装は `recalls` への INSERT と
   * **同一トランザクションで** `tenant_activity.activity_seq` を `+1` しなければならない
   * （`NewRecallRecord.advanceActivityClock` の doc コメント参照）。
   *
   * ⚠ **戻り値の形はこの ADR で変えていない。**「進めた後の `activity_seq` を返り値に
   * 載せる」案も検討したが、この口は `@mnemora/core` の公開 API であり、戻り値を
   * `RecallId` から `{ recallId, activitySeq? }` のような形へ変えること自体が破壊的変更
   * になる（`docs/autonomy.md`「してはいけないこと」表）。進めた後の値が要る呼び出し側は
   * `TenantSettingsStore.getActivitySeq` を別途読むこと。
   *
   * ⚠ **`record` の中身の形は検査しない**（今の振る舞い。2026-09-28 に `@mnemora/postgres` と `@mnemora/testkit` の
   * fixture で確かめた）。拒むのは、列の型が受け付けない値——NUL を含む値と、JSON にできない必須の欄——だけである
   * （Postgres は `text`・`jsonb` 列が拒み、fixture はそれに合わせて先に投げる）。`omitted`・`usage`・`indexBand`・`explain`・`returnedMemories`（その `score` など）が
   * それぞれの型（`OmissionSchema`・`RecallUsageSchema`・`IndexBandSchema`・`StageTraceSchema`・`ScoreBreakdownSchema`）
   * に合わなくても、そのまま書く。⟹ **`getRecall` が返す `RecallRecord` は、それらの schema を通らないことがある**
   * （例: `returnedMemories` の要素の `score` が `{}` のまま読み戻る）。`Runtime` の `recall()` は検証した値だけを
   * 渡すので、ここに届くのは store を直接呼ぶ側である。
   */
  createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
  /**
   * Issue #298 / [ADR 0155](../../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
   * `createRecall` が書いた `recalls` 行1件を、`recallId` から読み戻す。
   *
   * **`recallId` だけを持って戻ってきた呼び出し側が、`recall()` の戻り値を捨てた後でも
   * 「どの記憶が・どの内訳で・どの経路で選ばれたか」を引ける**ようにするための、
   * 書く側（`createRecall`）と対になる読む口（Issue #298 の受け入れ条件1）。
   *
   * 🔴 **必須メソッドである。**[ADR 0122](../../../../docs/decisions/0122-restore-archived-memory.md)
   * の規律（「既存の必須メソッドの呼び方を1つ固定するだけで済むなら、新しい任意メソッドを
   * 足さない」）を先に問うたが、`recalls` を読む形は `MemoryStore` のどの既存メソッドにも
   * 無い——`restoreArchived` が `updateStatusWithEvent` にそのまま収まったのとは違い、
   * ここには収まる先が無い（`get`/`getObservation`/`getMany` はそれぞれ `memories`/
   * `observations` 専用であり `recalls` を読まない）。⟹ **新しいメソッドを足さずに済む
   * 形ではない。**そのうえで必須（任意ではない）にした理由は、`get`/`getMany`/
   * `getObservation`/`listBySourceObservation` と同じ「単純な1行読み出し」の族に属し、
   * `archiveDecayed?`/`purgeMemory?`/`markContestedPair?` のような「adapter に新しい
   * 書き込み形状を要求する」族（未実装でも既定の recall の振る舞いを壊さない）とは違う
   * ——`getRecall` を実装しない adapter は、この issue が問う「後から」を一切満たせない。
   * 詳細な検討は ADR 0155 を参照。
   *
   * 契約:
   * - 対象の行が存在しない、または `tenant_id` が `ctx.tenantId` と一致しない場合は
   *   `null` を返す（例外にしない。`get`/`getObservation` と同じ規律）。`id` が adapter の
   *   期待する形式でない場合も同じく `null`（`packages/postgres/src/mapping.ts` の
   *   `isUuidLike` の doc コメント参照）。
   * - `returnedMemories.breakdownCaptured` は、マイグレーション以前に書かれた行では
   *   `false` になる（`RecallRecordReturnedMemories`（`../recall.js`）の doc コメント
   *   参照）。呼び出し側はこれを見て「内訳を記録しそこねた」行と「記録したが0件だった」
   *   行を区別すること。
   */
  getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
  /**
   * ADR 0079: 索引に載っていない Memory を**列挙して、同時に `embed` ジョブを積み直す**。
   *
   * `recall` は `not_indexed` として「索引されていない N 件」を既に正しく名乗っている
   * （`packages/core/src/recall-runtime.ts` の `NOT_INDEXED_REASONS` ループ）。
   * docs/recall.md §4 はその `reason` ごとに利用側の次の一手まで案内している——
   * **`pending` は待つ・再試行する、`failed` は埋め込みパイプラインそのものを疑う。**
   * **このメソッドが足すのは、その「次の一手」を実際に打つ口である。**
   *
   * 契約:
   * - 対象は `status IN ('active','contested')` かつ `embeddingStatus` が
   *   `opts.statuses` のいずれかである Memory に限る。**`aggregateScope` が
   *   `notIndexed` に数える集合と同じ条件**であり、`recall` が「N 件ある」と言った
   *   ものをそのままこの口へ渡せる。
   * - `opts.memoryIds` を渡すと、その id の集合との積を取る（`opts.statuses` の条件は
   *   外れない——`ready` の行を `memoryIds` で名指ししても対象にならない）。
   * - 選ばれた行は `embeddingStatus` を `'pending'` へ戻し、**同一トランザクションで**
   *   `kind: 'embed'`・`payload: { memoryId }` の outbox 行を1件ずつ新規に積む。
   *   **片方だけ起きることはない。**
   * - 返すのは実際に積み直した件数と、その `memoryId`（`opts.limit` で切られた後の集合）。
   * - 対象が0件なら `{ requeued: 0, memoryIds: [] }` を返す（例外を投げない）。
   * - **べき等ではない。**同じ Memory に対して2回呼べば outbox 行は2件積まれる。
   *   処理そのものは at-least-once を前提に書かれている（ADR 0032）ので実害は無いが、
   *   「呼んだ回数だけ積む」ことは契約である。
   *
   * 🔴 **既に `failed_at` が付いた古い outbox 行は触らない。**`fail` は終端のままであり、
   * ADR 0032 の決定（Phase 1 では失敗したジョブの自動リトライを行わない）を覆さない。
   * 積み直しは**新しい行**であり、古い行は失敗の履歴として残る。これにより新しい行の
   * `attempts` は 0 から数え直される。
   *
   * ⚠ **`ready` は `opts.statuses` に指定できない**（型が `NotIndexedReason` であり
   * `ready` を含まない）。`ready` は「ベクトル行が在る」という主張であり（ADR 0053）、
   * それを `pending` へ戻すと `recall` が索引済みの Memory を `notIndexed.pending` に
   * 数え始める。埋め込みモデルを替えたときの再埋め込みは `VectorStore` の space が
   * 変わる別の問題であり、この口の主題ではない。
   *
   * 対象が `opts.limit` より多いときにどれが選ばれるかは
   * **`updatedAt` の古い順、同着は `id` の昇順**とする。積み直した行は `updatedAt` が
   * 動くので、繰り返し呼ぶと対象が一巡する（同じ行だけを取り続けて他が飢えることがない）。
   *
   * ⭐ **`writeOpts` は省略可能な第3引数である**（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)）。
   * **`writeOpts.now` を渡すと、積み直す embed ジョブの `availableAt`/`createdAt` にその値を使う。
   * 省略時は実装が壁時計を使う。** runtime（`Runtime.reembed`）はこの欄に `clock.now()` を渡す。
   * 第2引数 `opts`（{@link RequeueEmbedJobsOptions}）は `Runtime.reembed` の公開の入力と同じ型なので、
   * 時刻はそこへ足さず、別の引数にした。
   */
  requeueEmbedJobs(
    ctx: Ctx,
    opts: RequeueEmbedJobsOptions,
    writeOpts?: { now?: Date },
  ): Promise<RequeueEmbedJobsResult>;
  /**
   * Issue #134 / [ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md):
   * docs/memory-model.md §11 行5 が要求する「旧行の `status`/`superseded_by_id` 更新と
   * **新 Memory の作成**は1トランザクションで完結させる」の、後半（新 Memory の作成側）を
   * 満たすための口。`updateStatusWithEvent`（ADR 0031）は既存 Memory の status 更新と
   * イベント追記の対だけを扱い、新しい Memory の作成は範囲外だった——このメソッドは
   * その2つを1回の呼び出し・1トランザクションにまとめる。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に 0.1.4 で公開済み、
   * `docs/autonomy.md:114`）。この口を実装しない adapter は今日どおり
   * `updateStatusWithEvent` + 別呼び出しの `createMemoryWithOutbox` の2段のままでよい。
   *
   * `news` が配列である理由: `runtime.consolidate`（N→1）は1件で足りるが、
   * `runtime.reextract` は候補ごとに `createMemoryWithOutbox` をループで呼び M件作る
   * （`runtime.ts` の `createMemoriesFromCandidates`）。1件しか受け取らない形にすると
   * `reextract` をこの口へ寄せられない。
   *
   * 意味論:
   * - `news` の各要素は {@link MemoryStore.createMemoryWithOutbox} と**同じ冪等経路**
   *   （ON CONFLICT。既存行と衝突したら `created: false` を返し、ジョブは一切積まない）。
   * - `supersede` の各要素は {@link MemoryStore.updateStatusWithEvent} と**同じ CAS 意味論**
   *   （`status` は常に `"superseded"` に固定——このメソッドは supersede 専用であり、
   *   任意の status への更新は今日どおり `updateStatus`/`updateStatusWithEvent` を使うこと）。
   * - 🔴 **CAS に弾かれた対象は例外にしない。** `conflicted` に `{ id, observedStatus }` として
   *   積み、**トランザクションはそのまま commit する**（条件付き UPDATE の0行はエラーでは
   *   ない）。ADR 0031「採らなかった案」（supersede ループ全体を1トランザクションにする案の
   *   却下）を本メソッドは覆さない——「1件の競合」を「全部やらなかった」に化けさせない。
   * - 🔴 **`supersede[].id` の行がそもそも存在しない場合は、`updateStatusWithEvent` と同じ
   *   「memory not found」の `Error` を投げる。**このときトランザクション全体がロール
   *   バックされ、**`news` の作成も巻き戻る**——⛔ **`conflicted` には混ぜない**
   *   （「CAS で弾かれた」と「行が無い」は別の「無い」であり、潰すとこの設計の要が壊れる）。
   * - 🔴 **`supersededByIndex` は `news` への索引である**（`MemoryId` ではない）。この口は
   *   「今まさに作る Memory へ寄せる」ためのものであり、その id は store が採番するまで
   *   存在しない——呼び出し側は渡すべき id を渡す前に知りえない（`NewMemory` は
   *   `Omit<Memory, "id" | ...>` で `id` を持たない）。ADR 0100「採らなかった案」参照。
   *   索引にしたことで `supersededById` の外部キー違反は**構造的に起こりえなくなった**
   *   （指す先は必ずこの呼び出しが作った/見つけた行である）——ADR 0047 の「存在」検査は
   *   下の範囲検査がその役目を引き継ぐ。
   * - 🔴 **`event.meta.supersededById` は、実装が解決したアンカーの id で埋める**（呼び出し
   *   側が渡した値があれば上書きする）。呼び出し側は索引しか持たないため、この欄を自分で
   *   埋められない——実装が埋めることで、**監査ログの中身がこの口を実装した adapter と
   *   実装していない adapter で同一になる。**⛔ 同じ論理操作が adapter ごとに別の監査記録を
   *   残す形にはしない。`event` の他の欄は一切変えない。
   * - ⚠ **`supersededByIndex` が指すのは `news[i]` に対応する Memory であって、それが
   *   今回作られたか既に在ったかは問わない**（冪等経路で既存行と衝突した場合も同じ行を
   *   指す。`created[i].created` がどちらかを名乗る）。
   * - 🔴 **`created` は `news` と同じ順序・同じ長さで返す。**`supersededByIndex` が正しい行を
   *   指せるのはこの対応が保たれているときだけであり、⚠ **並びがずれても型は何も言わない**
   *   ——`superseded_by_id` に別の記憶の id が書かれ、検査は緑のまま通る。適合テストが
   *   3件以上の `news` でこの対応を固定している（1件や2件では並びの入れ替えを検出できない）。
   * - 🔴 **範囲外の `supersededByIndex` は専用の失敗として落とす**（`RangeError`。
   *   メッセージは `supersededByIndex out of range`）。⛔ **黙って無視しない。⛔ `conflicted`
   *   にも「memory not found」にも混ぜない**——「呼び手が壊れた索引を渡した」「CAS で
   *   弾かれた」「対象の行が無い」は3つとも別の失敗であり、潰すとこの設計の要が壊れる。
   *   このときも何も書かれない（`news` の作成も巻き戻る）。
   *
   * ⚠ **これは振る舞いの変更である。** 今日（`updateStatusWithEvent` を単独で呼ぶ経路）は
   * 対象が存在しない場合、直前に別途呼んでいた `createMemoryWithOutbox` の作成はすでに
   * commit 済みで残る。このメソッドを経由すると、その作成も巻き戻る——ADR 0100
   * 「引き受ける負債」参照。
   *
   * 🔴 **原子性の証拠ではない。**この口が在ること自体は「adapter がこの口を実装したと
   * 宣言した」ことしか意味しない——`packages/testkit` の `InMemoryMemoryStore` のように、
   * 実装していても「トランザクションは一切模していない」adapter がありうる
   * （`InMemoryMemoryStore` クラス doc 参照）。実際に原子性を測るのは適合テストと
   * `packages/postgres` の並行の歯であって、この口の有無そのものではない。
   *
   * 🔴 [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md):
   * `news[i].input` にも `createMemory` と同じ制約が掛かる——`status === 'contested'` かつ
   * `contestedWithId` が `null`/`undefined` の要素が1件でもあれば、`news`/`supersede`
   * どちらの書き込みも一切行わずに {@link ContestedWithoutCompanionError} を投げる。
   * ⚠ `news[i].input.contestedWithId` が `ctx.tenantId` と同じテナントの行を指しているかは
   * `createMemory` と同じく検査しない（`isContestedWithoutCompanion` の doc コメント、
   * Issue #854）。`supersede[].supersededByIndex` は `news` への索引であり
   * `MemoryId` を直接受け取らないため、この注意は当たらない（上の doc 参照）。
   *
   * ⚠ `news[i].input.provenance` の中身も `createMemory` と同じく検査しない（返った Memory は
   * `MemorySchema` を通らないことがある。拒むのは列挙に無い `kind`・列の `sourceObservationId` が無い
   * `stated`/`inferred`・`null` の3つだけ。`createMemory` の doc 参照）。
   *
   * ⭐ **`opts` は省略可能な第4引数である**（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)、
   * `createMemoryWithOutbox` の同じ欄と同じ理由）。**`opts.now` を渡すと、`news` に積む outbox 行の
   * `availableAt`/`createdAt` にその値を使う。省略時は実装が壁時計を使う。** runtime はこの欄に
   * `clock.now()` を渡す。
   *
   * ⭐ **2026-09-29 追記（Issue #1226 / ADR 0375 決定7、クローン miku の判断）: `opts.abortIfForgotten`
   * を足した。**`runtime.consolidate` が、統合元にした Memory を LLM 呼び出しの間に
   * `forget`（さらに `purge`）されても、その本文から作った統合先を `active` で書いてしまう
   * 競合を閉じるための欄——`createMemoryWithOutbox` の同日付の追記と**同じ意味論**。非空の
   * 配列を渡すと、**`news`/`supersede` どちらの書き込みより前に**、その id の現在の
   * `status` を見直し、1件でも `"forgotten"` だったら何も書かずに
   * {@link SourceMemoryForgottenError} を投げる（`news` の作成も `supersede` の CAS も
   * 一切起きない——**この見直しは既存の `conflicted`（CAS に弾かれた対象だけ飛ばして
   * 他は commit する部分成功）より優先する**。`abortIfForgotten` に挙げた id が
   * `supersede[].id` の部分集合である必要はない——`{ memoryIds }` で束ねた対象のうち
   * eligible だった全 id を渡すのが呼び出し側の使い方だが、この口自体は `supersede` との
   * 関係を検査しない）。空配列・省略時は今日どおり（見直しを一切行わない、`conflicted` の
   * 部分成功のみ）。
   *
   * 🔴 **`@mnemora/postgres` はこの見直しを、`news`/`supersede` の書き込みと同一トランザクションの
   * 中で `SELECT … FOR UPDATE` として行う**（{@link SourceMemoryForgottenError} の doc コメント
   * 参照。見直しと書き込みの間に窓が無い）。**`packages/testkit` の `InMemoryMemoryStore` と
   * `packages/core` のテスト用 `FakeMemoryStore` はこの欄を実装しない**——渡しても無視され、
   * 例外は投げられない（`createMemoryWithOutbox` の同日付の追記と同じ理由・同じ限界）。
   */
  supersedeWithNewMemories?(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
    opts?: { now?: Date; abortIfForgotten?: ReadonlyArray<MemoryId> },
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }>;
  /**
   * [ADR 0410](../../../../docs/decisions/0410-extract-created-event-in-same-transaction.md)（穴 D-3）:
   * 抽出（`runtime.observe` の sync／`tick` の deferred の extract ジョブ）が書く「候補ごとの Memory」と、
   * その `created` イベントを**1つのトランザクション**で書く。今の経路は候補ごとに
   * `createMemoryWithOutbox` でコミットしたあと `EventStore.append` を別の文で呼ぶので、append が
   * 失敗すると記憶だけが残り、再送・tick は `listBySourceObservation` で「在る」と見て素通りして
   * `created` が0件のまま残る（ADR 0347 決定1）。この口はその窓を閉じる。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を壊す破壊的変更になる。
   * 実装しない adapter は今日どおり `createMemoryWithOutbox` の候補ごとのループ＋別の `EventStore.append`
   * のままでよい——**その adapter では取りこぼしが残る**（ADR 0410「引き受けた負債」）。
   * runtime は、この口が**在るかどうか**だけで経路を選ぶ。撃って投げられたときに、旧経路で撃ち直さない
   * （二重に書きうるため。ADR 0100 の `supersedeWithNewMemories` と同じ規律）。
   *
   * 意味論（ADR 0347 決定2〜4 を、1トランザクションの中で守る）:
   * - `news` の各要素は {@link MemoryStore.createMemoryWithOutbox} と**同じ冪等経路**（ON CONFLICT。既存行と
   *   衝突したら `created: false`、ジョブは積まない）。
   * - 🔴 **候補ごとに書きを区切り（Postgres は SAVEPOINT）、保存できない候補（store が拒む値。本文の NUL
   *   など）だけを巻き戻して `dropped` に積む。**残りの候補は書く。
   * - 🔴 **全候補が落ちたら、最初の例外をそのまま投げ、何も書かない**（ADR 0347 決定2。例外の集合は増えない）。
   * - 🔴 **`created` は、書けた候補（`created: true` のものだけ。冪等な再送〔`created: false`〕では積まない）に
   *   ついて、全候補の成否が確定してから同じトランザクションで積む。**`buildCreatedEvent(memory, dropped)` が
   *   返す {@link NewMemoryEvent} を、この store がそのまま `memory_events` へ INSERT する。`dropped` は
   *   store が確定した「落とした候補」（`index` は `news` の索引、`error` は store が投げた例外そのもの）であり、
   *   `meta.droppedCandidates` の組み立て（原因の最内の code/message・NUL と孤立サロゲートの置換・500 文字）
   *   は core 側が行う——store は例外を返すだけである。
   *   `buildCreatedEvent` は**同期・副作用なし**の関数で、書き込みの途中（トランザクションの中）で呼ばれる。
   * - 🔴 **`created` の INSERT が失敗したら、トランザクション全体を巻き戻す**（記憶も outbox も残らない）。
   *   この例外は `dropped` に混ぜず、そのまま投げる。
   * - 戻り値の `written` は書けた候補（`created: false` の既存行を含む）を `news` の順に並べたもので、
   *   `index` が `news` の索引である。`dropped` は落とした候補を `news` の順に並べたもの。
   * - claim key の衝突検出（`detectContested`）はこの口の外——runtime が書いたあとに今どおり走らせる。
   *
   * ⚠ **範囲は抽出の経路だけである。**`reextract`・`consolidate`・`reflect` などは、この口を使わない
   * （ADR 0410「残り」）。
   *
   * 🔴 **原子性の証拠ではない。**`supersedeWithNewMemories` と同じく、この口が在ることは「実装したと宣言した」
   * ことしか意味しない。実際に測るのは適合テストと `packages/postgres` の歯である。
   *
   * ⭐ `opts.now` は `createMemoryWithOutbox` の同じ欄と同じ意味（積む outbox 行の `availableAt`/`createdAt`）。
   * `abortIfForgotten` は取らない（抽出は材料の Memory を持たない）。
   */
  createMemoriesWithOutboxAndEvents?(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    buildCreatedEvent: (
      memory: Memory,
      dropped: ReadonlyArray<{ index: number; error: unknown }>,
    ) => NewMemoryEvent,
    opts?: { now?: Date },
  ): Promise<{
    written: Array<{ index: number; memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    dropped: Array<{ index: number; error: unknown }>;
  }>;
  /**
   * Issue #210: `docs/roadmap.md` §5.4「監査ログの既定保持期間」でオーナーが必須と決めた
   * 「テナント単位で短縮できる口」（`TenantSettingsStore.getEventRetention`/
   * `setEventRetention`、ADR 0050）に対応する削除側。ADR 0050 決定8が明示的に範囲外へ
   * 残していた「期限切れの `memory_events` 行を実際に消す処理」を、この口が埋める。
   *
   * `docs/memory-model.md` §11 Memory lifecycle 行「(memory_events の掃除)」が要求する
   * 保守ジョブ本体。**`EventStore` interface（`append`/`list`/`get`）はこの口を経由しない
   * ——append-only の型そのものに `update`/`delete` を持たせない、という
   * `docs/memory-model.md` §9 の規律を、削除操作の置き場所でも守るためである。**
   * `EventStore.append` を呼ぶことも禁じてはいないが（実際には呼ばない。下記参照）、
   * 型としては `EventStore` に一切触れない。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`
   * 「してはいけないこと」表の「公開 API の破壊的変更」）。[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md)
   * の `supersedeWithNewMemories?` と同じ形の判断。この口を実装しない adapter は、
   * 保持期間を「設定できるが、実際には縮まない」ままにする——[ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)
   * 「守れないもの」に明記した。
   *
   * 契約:
   * - 対象は `tenant_id = ctx.tenantId AND at < opts.olderThan AND kind <> 'events_purged'`
   *   の行に限る。**`kind = 'events_purged'` 自身は対象から除外する**——含めると、
   *   ある回の掃除が積んだ `events_purged` イベントが次回の掃除対象になり得るという
   *   無限後退（ADR 0115 決定「無限後退」参照）を生む。除外の代償として
   *   `events_purged` 行はこの口の対象にならず単調に増え続けるが、増分は「呼び出し
   *   1回につき高々1行」であり、削除対象の生の件数とは無関係に小さい。
   * - **`opts.limit` は必須・既定値を持たない**（`ClaimOutboxJobsOptions.leaseMs`、
   *   ADR 0032 と同じ理由——取り消せない削除の上限を `packages/core` が勝手に決めない）。
   * - 並び順は `at` 昇順（最も古い行から消す）。対象が `opts.limit` を超える場合は
   *   `reachedLimit: true` を返す——**呼び出し側が「1回で消しきれなかった」ことを
   *   知るための唯一の信号であり、`purged === opts.limit` からの推測に頼らせない**
   *   （`opts.limit` ちょうどの件数が対象の全件だった場合と区別できないため）。
   * - **`opts.dryRun` を必ず持つ。**`true` のときは対象を数えるだけで、
   *   `memory_events` を1行も DELETE せず、`events_purged` イベントも1行も INSERT
   *   しない。返り値の `purged`/`reachedLimit`/`oldestPurgedAt`/`newestPurgedAt` は
   *   「実行していたら何が起きたか」のプレビューであり、DB の状態は変わらない。
   * - **削除と `events_purged` イベントの追記は同一トランザクション**（ADR 0031・
   *   ADR 0100 と同じ「必ず」の強制。`forget()` が `EventStore` 追記と同一トランザクション
   *   であるのと同じ理由）。`purged === 0`（対象が無かった）ときは、削除も追記も
   *   一切発生しない——「何も変わらなかった」ことを表す `events_purged` 行を積む
   *   意味が無いため（0件の掃除を毎回記録すると、頻繁なスケジュール実行で無意味な
   *   行が積み上がる）。
   * - 積む `events_purged` イベントの `meta` は `{ purgedCount, oldestPurgedAt,
   *   newestPurgedAt, olderThan }` の4欄のみ——`docs/memory-model.md` §9 が言う
   *   「件数と期間のみ。削除された個々のイベントの詳細は残らない」を、`memory_id`
   *   個別の記録を一切持たないことで守る。
   *
   * ⚠ **2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:
   * 上記の `WHERE`（`kind <> 'events_purged'`）は `kind = 'superseded'` の行を除外しない
   * ——保持期間を過ぎればそれらも他の行と同じく削除の対象になる。** これは決定1どおりの
   * 挙動であり、この口自身は約束を破っていない。ただし `superseded` 行は
   * `MemoryStore.previewRestoreSupersededBy?` が `supersededReason` を読む唯一の
   * 情報源でもある——この口を運用ジョブとして定期的に呼んでいるテナントでは、
   * 保持期間を過ぎた時点で `previewRestoreSupersededBy?`/
   * `groupSupersededCandidatesByOperation`（`packages/core/src/runtime.ts`）が
   * 由来を「分からない」としてまとめてしまうようになる。詳細・採らなかった案は
   * [ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md) の
   * 同日付追記を参照。
   *
   * ⚠ **2026-09-29 追記（[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
   * [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）:
   * `packages/core/src/event-retention-purge.ts` の `purgeExpiredEventsForTenant` は、
   * もうこのメソッドを直接呼ばない。** 呼び出し元が保持期間（`TenantSettingsStore.getEventRetention`）を
   * 読んでから `olderThan` を計算してこのメソッドへ渡す、という上の一連の呼び出し方は、
   * 読みと削除の間に保持期間が変わる race（Issue #1232 本文）を防げない——読みと削除が
   * 別々の adapter（`TenantSettingsStore` と `MemoryStore`）をまたぎ、かつ2回の別々の呼び出しに
   * 分かれているため、途中に割り込む余地が残る。**この race を閉じるには、保持期間の読みと
   * 削除を同じ adapter の同じ操作にする必要がある**——それが下の
   * {@link MemoryStore.purgeExpiredEventsByRetention} である。**このメソッド自体は変えていない**
   * ——`olderThan`/`limit`/`dryRun` を受け取って消すだけの下請けとして、
   * `purgeExpiredEventsByRetention?` の実装（`@mnemora/postgres`・testkit の fixture・
   * `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore`）が内部で呼ぶ
   * （書き写さない、同じ本体を共有する）。
   */
  purgeExpiredEvents?(ctx: Ctx, opts: PurgeExpiredEventsOptions): Promise<PurgeExpiredEventsResult>;
  /**
   * [ADR 0404](../../../../docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md):
   * `createdAt < opts.olderThan` の `recalls` 行を、その `recall_usages` ごと消す。
   * `eraseTenant` 以外に `recalls` の行を消す経路が無かった（ADR 0290 の 2026-09-30 追記、
   * ADR 0357 の負債1）ことへの口。
   *
   * 🔴 **任意メソッドである。**理由は {@link MemoryStore.purgeExpiredEvents} と同じ
   * （`@mnemora/core` は npm 公開済みで、必須化は第三者 adapter を壊す破壊的変更になる）。
   *
   * 契約:
   * - **`opts.olderThan` は必須・既定の保持期間を持たない。**何日残すかは呼び出し側が決める。
   * - 対象は `tenant_id = ctx.tenantId` かつ `created_at < opts.olderThan`（境界
   *   `createdAt === olderThan` は対象外。{@link PurgeExpiredEventsOptions.olderThan} と同じ）。
   *   並びは `created_at` 昇順（最も古い行から消す）。
   * - **`recall_usages` は同一トランザクションで先に消える。**`recall_usages.recall_id` は
   *   `recalls(id)` への外部キー（`ON DELETE` 指定なし）なので、親だけを消せない。
   *   ⟹ **消えた recall の使用記録（どの記憶を使ったと報告されたか）も消える。**
   *   消した後にその `recallId` で {@link MemoryStore.recordUsage} を呼ぶと、外部キー違反
   *   （`@mnemora/postgres`）／同じ検査（`recall not found`、testkit の InMemory 実装）で例外になる。
   * - `memory_events.meta` に `recallId` の文字列が載っていても、外部キーではないので残る。
   * - **`recalls.query` の中身（約束の範囲）には触れていない**——行ごと消えるだけで、
   *   「どこまでを消すと約束するか」はここでは決めていない（ADR 0404）。
   * - `opts.limit` は必須・既定値なし（{@link PurgeExpiredEventsOptions.limit} と同じ理由）。
   *   対象が `limit` を超えれば `reachedLimit: true`。`limit` は **recalls の行数**であり、
   *   同時に消える `recall_usages` の行数は数えない（`result.purgedUsages` に別に返す）。
   * - `opts.dryRun === true` は1行も消さず、消していたら何が起きたかを返す。
   * - `events_purged` のような監査行は積まない（`memory_events` は `memory_id` を軸にした
   *   記憶の履歴であり、`recalls` は記憶ではない）。
   */
  purgeExpiredRecalls?(
    ctx: Ctx,
    opts: PurgeExpiredRecallsOptions,
  ): Promise<PurgeExpiredRecallsResult>;
  /**
   * Issue #1232 / [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md):
   * {@link MemoryStore.purgeExpiredEvents} と `TenantSettingsStore.getEventRetention`/
   * `setEventRetention`（ADR 0050）をまたいで存在していた race——`purgeExpiredEventsForTenant`
   * が保持期間を読んでから {@link MemoryStore.purgeExpiredEvents} を呼ぶまでの間に
   * `setEventRetention` が保持期間を変えても、読んだときの古い期間で削除してしまう
   * （[Issue #1232](https://github.com/takecchi/mnemora/issues/1232) 本文の実測）——を
   * 閉じるための口。**保持期間を読むことと、実際に削除することを、1つの原子的な操作にする。**
   *
   * 🔴 **任意メソッドである。**理由は {@link MemoryStore.purgeExpiredEvents} と同じ
   * （`@mnemora/core` は npm 公開済みで、必須化は第三者 adapter を壊す破壊的変更になる）。
   * この口を実装しない adapter では、`purgeExpiredEventsForTenant` は
   * `{ kind: "store_unsupported" }` を返す——**{@link MemoryStore.purgeExpiredEvents} を
   * 実装していても、そちらへは自動的に落ちない**（`purgeExpiredEventsForTenant` の doc
   * コメント参照）。「保持期間の読みと削除を同じ操作にできる」という宣言そのものが、
   * この口を持つことの意味だからである——`purgeExpiredEvents?` だけを実装している adapter に
   * 自動でフォールバックすると、Issue #1232 が指摘した race をこの新しい経路でも
   * 再導入してしまう。
   *
   * 契約:
   * - **`opts.now`・`opts.limit` は必須・既定値を持たない**（呼び出し側が明示する。
   *   `PurgeExpiredEventsForTenantOptions` と同じ理由）。
   * - `opts.dryRun` は省略可能（省略時 `false`）。`true` のときも、保持期間の読みは
   *   実際の削除と同じ場所・同じ原子性で行う——**「読む」だけを先に軽く済ませない**。
   *   `dryRun` は「読んでから、削除の代わりにプレビューを返す」だけであり、原子性の
   *   保証（読みと、削除またはプレビューの間に割り込ませない）はどちらでも同じである。
   * - **保持期間の読みは、呼び出しのたびにこのメソッドの内部で行う**——引数に
   *   `retention`/`olderThan` は無い。渡された `ctx.tenantId` の
   *   `TenantSettingsStore.getEventRetention` 相当の状態を、実装が直接読む
   *   （`@mnemora/postgres` なら `tenant_settings.event_retention_days` へ直接 SQL を
   *   発行する。`TenantSettingsStore` interface は経由しない——別 adapter を呼ぶと
   *   その呼び出し自体が1つの原子的な操作の外に出てしまうため）。
   * - 戻り値は3種:
   *   - `{ kind: "unset" }` — 読んだ時点でそのテナントの保持期間の設定行が無い。
   *     1行も削除しない。
   *   - `{ kind: "unlimited" }` — 読んだ時点で無期限。1行も削除しない。
   *   - `{ kind: "executed"; result }` — 読んだ時点で有限日数だった。`result` は
   *     {@link MemoryStore.purgeExpiredEvents} と同じ形の
   *     {@link PurgeExpiredEventsResult}——cutoff は `opts.now` からその日数ぶん遡った時刻
   *     （`packages/core/src/event-retention-purge.ts` の `computeEventRetentionCutoff` で
   *     計算する。`EARLIEST_DATE_MS` への寄せも含めて共有する）。
   * - **「読む」と「削除する（またはプレビューする）」の間に、他の `setEventRetention` 呼び出しが
   *   割り込んで見える結果を変えてはならない**——同じ `ctx.tenantId` の保持期間を書き換える
   *   別の呼び出しが同時に走っている場合、この呼び出しが見る保持期間は「読んだ時点の値で
   *   固定され、削除まで変わらない」ことを、adapter 自身の同時実行制御（Postgres なら
   *   同一トランザクション内の `SELECT ... FOR SHARE` による行ロック）で保証する。
   *   歯は `packages/postgres/src/__tests__/purge-expired-events-by-retention-concurrency.postgres.test.ts`。
   * - **`kind <> 'events_purged'` の除外・`events_purged` イベントの追記・`superseded` 行も
   *   含めて消す判断は、すべて {@link MemoryStore.purgeExpiredEvents} と同じ**——この口は
   *   「保持期間の読み方」だけを変え、「何を消すか」は変えない。
   */
  purgeExpiredEventsByRetention?(
    ctx: Ctx,
    opts: PurgeExpiredEventsByRetentionOptions,
  ): Promise<PurgeExpiredEventsByRetentionOutcome>;
  /**
   * [ADR 0114](../../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md):
   * `docs/memory-model.md` §11 行8「`decay_floor_at < now()` を検出する低頻度の掃引…
   * → `status='archived'` + `archived` イベント」を満たすための口。
   *
   * `Memory.decayFloorAt` は書き込み時（作成時・強化時）に計算されて列に持たれている
   * （ADR 0004・ADR 0011）が、**それを読んで実際に `archived` へ倒す経路がこれまで
   * どこにも無かった**——`docs/recall.md` §2 段0・§4 が `FilteredOmission.condition
   * = 'archived'` を定義していても、`status='archived'` にする経路が無い限りこの分岐は
   * 一度も発火しない。このメソッドがその唯一の書き込み口になる。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`:114、
   * ADR 0100 決定1と同じ理由）。この口を実装しない adapter では、`Runtime.sweepArchive`
   * が `{ supported: false, archived: [], reachedLimit: false }` を返すことで
   * 「対応していない」と正しく名乗る——黙って0件を返さない（ADR 0082「黙って何も
   * 起きない形にしない」の哲学をここでも守る）。
   *
   * 契約:
   * - 対象は **`status = 'active'` のみ**（`superseded`/`contested` はこの口では
   *   触らない。lifecycle 表行8が挙げる3つの起点のうち2つを意図的に外している。
   *   ADR 0114「採らなかった案」参照）。
   * - `tenant_id = ctx.tenantId` かつ `decay_floor_at <= opts.now`
   *   （**`<=`、境界を含む**）。⚠ **`VectorFilter.decayFloorAtAfter`
   *   （`./vector-store.js`）は狭義の `>`（境界を含まない）であり、この非対称は意図
   *   である**——`decayFloorAtAfter` は「これより後のものだけを ANN の候補にする」
   *   という recall 側の下限境界、こちらは「これ以前に閾値を割ったものを掃く」という
   *   掃引側の上限境界であり、2つの異なる関心が同じ演算子を共有する理由が無い。
   * - **「どの行を選ぶか」と「どの順で返すか」は別の契約である。**
   *   [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと8・15:
   *   - **選び方**: `opts.limit` 件を切り出す順序は、**掃く軸に合わせる**。
   *     `clock: 'activity'` は `decay_floor_seq` 昇順、`'wall'` と `'either'` は
   *     `decay_floor_at` 昇順（どちらも同着は `id` 昇順）。
   *     ⭐ **`'activity'` をこうしないと、`packages/postgres` 側で
   *     `idx_memories_recall_gate_seq` が並び替えを担えず、掃引で索引が引けない**
   *     ——【実測】2026-09-16 の CI で実際に赤くなった。詳細は
   *     `packages/postgres/src/memory-store.ts` の `buildArchiveDecayedTargetSelect` の
   *     doc コメント。**正しさではなく処理量の問題である。**
   *   - **返し方**: {@link ArchiveDecayedResult.archived} は、`clock` によらず常に
   *     **`decay_floor_at` 昇順**（同着は `id` 昇順）。返り値の型が `decayFloorSeq` を
   *     持たないので、返す並びに活動軸を持ち込まない。
   *   ⟹ `'activity'` では「選んだ順」と「返す順」が一致しないことがある。
   *   **これは意図した仕様であり、見落としではない。**
   * - 選ばれた各行について `status='archived'` への更新と `memory_events` への
   *   `kind='archived'` の追記を行う。**この2つは同一トランザクション**
   *   （ADR 0031 が `updateStatusWithEvent` で確立した「更新とイベントは同値」の
   *   不変条件を、この掃引にも適用する）。
   * - 対象が0件なら `{ archived: [], reachedLimit: false }` を返す（例外を投げない）。
   * - **一度 `archived` になった行は `status = 'active'` の条件に合わなくなるため、
   *   同じ範囲を繰り返し掃引しても同じ行が二度 archived になることはない**
   *   （呼び出し自体が特別にべき等性を持つのではなく、対象条件が書き込みの結果として
   *   自然に外れることによる）。
   * - **同じ範囲の掃引が同時に走っても、同じ行が二度 archived にならず、`archived` の
   *   イベントも1件だけである**（ADR 0114 の 2026-09-27 追記）。上の項目は逐次の繰り返し
   *   についての約束であり、並行については条件が自然に外れることだけでは足りない——
   *   `packages/postgres` の実装は、対象の選択に `FOR UPDATE SKIP LOCKED` を掛けることで
   *   満たす（後から来た掃引は、先の掃引が行ロックを持っている行を飛ばす）。プロセス内で
   *   逐次に動く Fake は自然に満たす。歯は
   *   `packages/postgres/src/__tests__/archive-decayed-concurrency.postgres.test.ts`。
   *
   * ⚠ **既存索引 `idx_memories_recall_gate`（`tenant_id, status, decay_floor_at`、
   * `WHERE status IN ('active','contested')`。`migrations/0001_init.sql`）をそのまま
   * 使う。新しい索引は追加しない**——`status = 'active'` という等値条件はこの部分索引の
   * 述語を含意するため、プランナはこの索引を選べる
   * （`packages/postgres/src/__tests__/archive-decayed-index.test.ts` が適用可能性を
   * 測る）。
   *
   * 🔴 **ADR 0011 の決定と衝突しない。**ADR 0011 は「recall 段1の候補生成クエリに
   * `decay_floor_at` を読み取りフィルタとして使わない」という Phase 1 の決定であり、
   * この掃引は recall の段1とは別の、保守用の書き込み経路である。ADR 0011 は
   * むしろ「索引の3列目として `decay_floor_at` を最初から持つのは、これを読み取りに
   * 使い始めるとき（この掃引を含む）に索引を作り直さずに済むため」と明言しており、
   * この掃引はその想定どおりの使われ方である
   * （`packages/postgres/src/__tests__/recall-gate-index.test.ts` 末尾の注記参照）。
   *
   * 🔴 **この掃引は自動では一度も走らない。**`Runtime.tick`/`Runtime.observe` に
   * 相乗りさせない——呼び出し側が明示的に `Runtime.sweepArchive` を呼んだときだけ走る
   * （`Runtime.sweepArchive` の doc コメント参照）。
   */
  archiveDecayed?(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult>;
  /**
   * Issue #198（docs/roadmap.md §5.3、docs/memory-model.md「forget() と purge() を分ける」・
   * §11 行10、[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)）:
   * `forgotten` な Memory を物理削除する——`content`/`digest` を固定のトゥームストーン
   * 文字列（{@link PURGE_TOMBSTONE_CONTENT}/{@link PURGE_TOMBSTONE_DIGEST}）で上書きし、
   * `purgedAt` を設定する。**行そのものは消さない**（`memory_events` からの外部キー
   * 参照整合性のため、また `superseded_by_id`/`contested_with_id` の参照先としても
   * 残す必要があるため）。
   *
   * 🔴 **[ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md)（Issue #994・
   * #995・#1207）: `content`/`digest` だけでなく、「その記憶の本文と、本文から直接
   * たどれる派生物」も一緒に消す。**この呼び出しの中で、同じ書き込みとして:
   * - `tags` を空配列に、`attributes` を空オブジェクトに、`claimKey` を `null` にする。
   * - この Memory に紐づく label の紐付け（`memory_labels` 相当）をすべて外し、
   *   `status: 'proposed'` のまま残る label の `proposedCount` を、外した本数だけ減らす
   *   （`registered` に昇格済みの label は触らない——`upsertProposedLabels` の increment と
   *   対称。**近似値のままである**——ADR 0318「引き受けた負債」1 が同じ `proposedCount`
   *   を既に近似値と引き受けている）。
   * - このテナントの `recalls`（recall の記録）の目次帯（`IndexBand.digestBand`）に、
   *   この `memoryId` を持つエントリがあれば、その `digest` をトゥームストーンへ
   *   書き換える（`truncated` は落とす）。
   *
   * 🔴 **この呼び出しの後も残るもの**（ADR 0375「(b) 残る」表）: `recalls.query`
   * （`consolidate`/`reflect` が種の digest を `text` にして撃った recall の分を含む
   * ——`memoryId` で特定できないため触らない）、`contentHash`、元の Observation の
   * `payload`、`memory_events.digestSnapshot`（監査ログ）、`provenance.speaker`、
   * `recall_usages`・完了した outbox の行、**今の `embeddingProvider.space` 以外の
   * embedding**（決定5参照）。詳しくは ADR 0375 を見ること。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`「してはいけ
   * ないこと」表の「公開 API の破壊的変更」、[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md)
   * 決定1と同じ理由）。この口を実装しない adapter では `Runtime.purge` が
   * `{ supported: false, outcomes: [...すべて not_attempted] }` を返す——`archiveDecayed`/
   * `purgeExpiredEvents` と同じ「フォールバック経路を持たない」形（`content`/`digest`/
   * `purgedAt` を書く経路はこの口以外に無いため）。
   *
   * **なぜ既存の `updateStatusWithEvent` を再利用しないか**: [ADR 0122](../../../../docs/decisions/0122-restore-archived-memory.md)
   * の `restoreArchived` は「`status` を1つ動かし、同一トランザクションで
   * `memory_events` に1件積む」という形が既存の `updateStatusWithEvent` にそのまま
   * 収まったため、新しい任意メソッドを足さなかった。**`purge` はこの形に収まらない**
   * ——`status` を動かさない代わりに `content`/`digest`/`purgedAt` という、
   * `updateStatusWithEvent` のシグネチャには無い列を書く必要がある
   * （`archiveDecayed`/`purgeExpiredEvents` と同じ「既存のどのメソッドにも無い形」）。
   *
   * 契約:
   * - 対象の行が存在しなければ「memory not found」の `Error` を投げる
   *   （`updateStatusWithEvent` と同じ規約。`id` が adapter の期待する形式でない場合も
   *   同じ結果になる——`packages/postgres/src/mapping.ts` の `isUuidLike` の doc 参照）。
   * - 🔴 **CAS の条件は `status = 'forgotten' AND purged_at IS NULL` の両方。**
   *   `purge` は `status` を動かさないため（`purged` は `memories.status` の値ではない）、
   *   `status` だけを条件にすると、同じ Memory への2回目の呼び出しも条件を満たしてしまい、
   *   `content`/`digest`/`purgedAt` が再び書かれ、`purged` イベントが2件目積まれる
   *   ——**`purged_at IS NULL` がこの操作固有のべき等性を買う。**
   * - 条件を満たさない場合（対象は存在するが `status !== 'forgotten'` または
   *   `purgedAt` が既に非 `null`）は {@link MemoryPurgeConflictError} を投げる。
   * - 条件を満たす場合、`content`/`digest` を `tombstone.content`/`tombstone.digest` へ
   *   上書きし、`purgedAt` に書き込み時刻を設定し、同一トランザクションで `event`
   *   （`kind: 'purged'`）を追記する。**片方だけ起きることはない**（ADR 0031 が確立した
   *   「更新とイベントは同値」をここでも適用）。
   * - 🔴 **[ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md) 決定1**:
   *   同じ書き込みで `tags` を `[]` へ、`attributes` を `{}` へ、`claimKey` を `null` へ
   *   上書きする。
   * - 🔴 **ADR 0375 決定2**: 同じトランザクションで、この Memory に紐づく label の
   *   紐付けをすべて外し、`status: 'proposed'` のまま残る label の `proposedCount` を
   *   外した本数だけ減らす（床は0。`registered` な label は触らない）。
   * - 🔴 **ADR 0375 決定3**: 同じトランザクションで、このテナントの `recalls` の
   *   `IndexBand.digestBand` からこの `memoryId` のエントリを見つけ、`digest` を
   *   `tombstone.digest` へ書き換える（`truncated` は落とす）。`recalls.query` は
   *   触らない（`memoryId` で特定できないため、ADR 0375 決定4）。
   * - `status`/`contentHash`/`digestSource` は変更しない。**`status` は `'forgotten'` の
   *   ままである。**
   * - `event.digestSnapshot` は呼び出し側が上書き**前**の digest を渡すこと
   *   （このメソッド自身は snapshot を作らない——`updateStatusWithEvent` と同じ、
   *   「呼び出し側が読んだ値を event に埋める」規律）。**purge の後、`memories` の行には元の
   *   `content`・`digest`・`tags`・`attributes`・`claimKey` は残らない。**
   *   それでも残るものの一覧（`recalls.query`・`contentHash`・元の Observation の
   *   `payload`・監査ログの `digestSnapshot`・`provenance.speaker`・別 space の
   *   embedding など）は ADR 0375「(b) 残る」表と `docs/memory-model.md` §9 の
   *   2026-09-29 追記を見ること。
   *   ⚠ 2026-09-28 訂正: ここは以前「purge 後、元の digest が残る唯一の場所はこの監査ログである
   *   （`content` は事後もどこにも残らない）」と書いていたが、recall の記録の分と
   *   Observation の `payload` があり、実装と合っていなかった。文書を実装に合わせた。
   *   ⚠ 2026-09-29 追記（ADR 0375）: 上の訂正が挙げた「recall の記録に残る元の digest」は
   *   `index_band` の分についてはこの PR で消える（`recalls.query` の分は残ったまま）。
   */
  purgeMemory?(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * Issue #197（ADR 0134）: `docs/memory-model.md` §11 行6「判定できない対向を検出
   * → 両側の `status='contested'`、`contested_with_id` を相互に設定」を書き込む口。
   *
   * [ADR 0046](../../../../docs/decisions/0046-contested-pair-invariant-tooth.md) が数え上げた
   * とおり、**`contested_with_id` を作成後に書けるメソッドは今日この口が追加されるまで
   * 存在しなかった**（`updateStatus`/`updateStatusWithEvent` の `SET` 句は `status` と
   * `superseded_by_id` だけであり、`createMemory` 系は作成時にしか書けない——相互参照は
   * 「まだ存在しない側」を先に指すことができないため作成時には構成不能）。この口が、
   * ADR 0046 が「作成後に書く経路が入るとき、表は数え直すこと」と予告していたその経路である。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`「してはいけ
   * ないこと」表の「公開 API の破壊的変更」、ADR 0100 決定1と同じ理由）。
   *
   * ⚠ **フォールバック経路を持たない**（`archiveDecayed?`/`purgeMemory?` と同じ判断。
   * `sweepArchive`/`purge` の doc コメント参照）。`supersedeWithNewMemories?` のように
   * 「口が無ければ既存メソッドの2段呼び出しで代替する」という擬似フォールバックは、
   * **意図的に作らない**——既存メソッドは `contestedWithId` を書けないため、
   * 代替として書けるのは「片方だけ `status='contested'` にして `contestedWithId` は
   * 空のまま」という状態に限られ、それは ADR 0046 が「単独で返り、機構2（`docs/memory-model.md`
   * §5）が破れる」と名指しした壊れた状態そのものである。**この口を実装しない adapter に
   * 対しては、`Runtime.markContested` は「対応していない」とだけ返し、劣化した代替を
   * 試みない**（`docs/decisions/0134-*.md` 参照）。
   *
   * 契約:
   * - **両側とも呼び出し時点で `status === 'active'` であること**（CAS。この口は
   *   `active → contested`（lifecycle 行6）専用であり、他の status からの遷移や
   *   任意の status への更新は今日どおり `updateStatus`/`updateStatusWithEvent` を使う
   *   こと。`supersedeWithNewMemories` が `status` を `'superseded'` に固定するのと
   *   同じ形の専用化）。
   * - 🔴 **`first.id === second.id` は呼び出し前の programmer error として扱う。**
   *   実装は `RangeError`（メッセージ: `markContestedPair: first.id and second.id must differ`）
   *   を、書き込みを一切行う前に投げる——`supersedeWithNewMemories` の
   *   `supersededByIndex out of range` と同じ「開く前に落とす」位置。
   * - **両側どちらかの id がそのテナントに存在しない場合、`updateStatusWithEvent` と同じ
   *   「memory not found」の `Error` を投げる。**書き込みは一切行われない（もう一方が
   *   存在してもロールバックする）。
   * - **CAS が破れた場合（存在はするが `status !== 'active'`）は
   *   {@link MemoryStatusConflictError} を投げる。**`expectedStatus` は常に `'active'`。
   *   `supersedeWithNewMemories` の `conflicted` 配列（部分成功を許す設計）とは違い、
   *   **この口は全部成功するか全部失敗するかのどちらかである**——対向ペアは本質的に
   *   結合しており、「片方だけ contested になった」状態を作ること自体が防ぐべき対象
   *   （ADR 0046）だからである。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: 両側の
   *   `status='contested'`・`contestedWithId` を相手の id に相互設定、`memory_events`
   *   へそれぞれ1件ずつ追記（`event.kind` は呼び出し側が渡した値をそのまま使う。
   *   `docs/memory-model.md` §11 行6 が定める形は `kind:'updated'`,
   *   `meta.reason:'contested'` だが、この口自体は値を強制しない——`updateStatusWithEvent`
   *   と同じく「渡された event をそのまま積む」規律）。
   * - 🔴 **原子性の証拠ではない。**`supersedeWithNewMemories` の doc コメントと同じ
   *   注意——この口が在ることは adapter がこの口を実装したことしか意味しない。
   *   実際に原子性を測るのは適合テストと `packages/postgres` の並行の歯である。
   */
  markContestedPair?(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }>;
  /**
   * Issue #197（ADR 0150）: `docs/memory-model.md` §11 lifecycle 行7「`contested` →
   * `active | superseded`」を書き込む口。`markContestedPair`（ADR 0134）の解決側であり、
   * その形を手本に対称に書いてある。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`「してはいけ
   * ないこと」表の「公開 API の破壊的変更」、ADR 0100 決定1と同じ理由）。
   *
   * ⚠ **フォールバック経路を持たない**（`markContestedPair?`/`archiveDecayed?`/
   * `purgeMemory?` と同じ判断）。`updateStatus`/`updateStatusWithEvent` には
   * `contestedWithId` を書く引数がそもそも無く（`markContestedPair` の doc コメント
   * 参照）、書いても消せない列を残したまま `status` だけ動かすことになる——`status` が
   * `'active'`/`'superseded'` へ離れたのに `contestedWithId` が相手を指したままの行は、
   * [ADR 0046](../../../../docs/decisions/0046-contested-pair-invariant-tooth.md) が
   * 「一対一が要求する状態」として数え上げた不変条件をこの口自身が破ることになる。
   * さらに [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
   * により `status: 'contested'` への書き込みは常に対向必須へ寄せられているが、
   * `'contested'` **から離れる**側にその制約は掛からない——にもかかわらず
   * `contestedWithId` を `null` に戻せる経路は、作成後に限れば今日この口だけである。
   * **この口を実装しない adapter に対しては、`Runtime.resolveContested` は
   * 「対応していない」とだけ返し、劣化した代替を試みない。**
   *
   * 契約（`markContestedPair` と対称。差分だけを述べる）:
   * - **両側とも呼び出し時点で `status === 'contested'` かつ、相手の `contested_with_id`
   *   が互いを指していること**（CAS）。この口は `contested → active | superseded`
   *   （lifecycle 行7）専用であり、他の status からの遷移は今日どおり
   *   `updateStatus`/`updateStatusWithEvent` を使うこと。
   * - 🔴 **`first.id === second.id` は呼び出し前の programmer error として扱う。**
   *   実装は `RangeError`（メッセージ:
   *   `resolveContestedPair: first.id and second.id must differ`）を、書き込みを一切
   *   行う前に投げる。
   * - **両側どちらかの id がそのテナントに存在しない場合、`updateStatusWithEvent` と同じ
   *   「memory not found」の `Error` を投げる。**書き込みは一切行われない。
   * - **CAS が破れた場合（存在はするが `status !== 'contested'`、または `contested` では
   *   あるが相互参照が成立していない）は {@link MemoryStatusConflictError} を投げる。**
   *   `expectedStatus` は常に `'contested'`。`markContestedPair` と同じく**この口も
   *   全部成功するか全部失敗するかのどちらかである**——部分成功は無い（対向ペアは本質的
   *   に結合しているため）。
   * ⚠ **`first.supersededById`/`second.supersededById` が `ctx.tenantId` と同じテナントの
   * 行を指しているかは検査しない**（`isContestedWithoutCompanion` の doc コメント、
   * Issue #854）。`Runtime.resolveContested` は勝者の id（`first.id`/`second.id` のどちらか、
   * 同じ `ctx` で存在を確かめた側）をそのまま渡すため、この口を `Runtime` 経由で使う限り
   * 実際には他テナントを指す値は渡らない。
   *
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: 両側とも
   *   `contestedWithId` を `null` にし、`first.status`/`second.status`（呼び出し側が
   *   指定した、それぞれ `'active'` か `'superseded'`）へ更新し（`superseded` を指定した
   *   側は `first.supersededById`/`second.supersededById` も書く）、`memory_events`
   *   へそれぞれ1件ずつ追記する（`event.kind` は呼び出し側が渡した値をそのまま使う。
   *   `docs/memory-model.md` §11 行7 が定める形は `kind: 'updated'`（勝者・`both_active`
   *   の両側）または `kind: 'superseded'`（敗者）だが、この口自体は値を強制しない——
   *   `markContestedPair` と同じく「渡された event をそのまま積む」規律）。
   * - 🔴 **原子性の証拠ではない。**`markContestedPair`/`supersedeWithNewMemories` の
   *   doc コメントと同じ注意——この口が在ることは adapter がこの口を実装したことしか
   *   意味しない。実際に原子性を測るのは適合テストと `packages/postgres` の並行の歯である。
   */
  resolveContestedPair?(
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
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }>;
  /**
   * [Issue #825](https://github.com/takecchi/mnemora/issues/825)（ADR 0150 追記、
   * 2026-09-26）: `resolveContestedPair`（上）の決定3（CAS「両側とも `contested` かつ
   * 相互参照が成立」）は、対向を `forget()` した後の対では**構造的に満たせない**——forget は
   * `status` を `'forgotten'` に動かすだけで `contestedWithId` には触れないため
   * （`Runtime.forget` の doc コメント）、生存側は `status: 'contested'` のまま、対向は
   * もう `'contested'` ではなくなる。この口は**その対の生存側1件だけ**を対象にした、
   * `resolveContestedPair` とは別の任意メソッドである——**決定3の CAS 自体は変えない**
   * （`resolveContestedPair` は1文字も変更していない）。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`markContestedPair?`/`resolveContestedPair?` と同じ理由）。
   * **フォールバック経路は無い**——`contestedWithId` を `null` に戻せる口は今日
   * `resolveContestedPair` とこの口以外に無い。この口を実装しない adapter に対しては、
   * `Runtime.resolveOrphanedContested` は「対応していない」とだけ返し、劣化した代替を
   * 試みない。
   *
   * ⚠ **「対向が forgotten/見つからない」という適格性の判定はこの口自身は行わない。**
   * それは `Runtime.resolveOrphanedContested` が読み側で行う（interface JSDoc 参照）——
   * この口は「呼び出し側が既に適格と判定した1件を、CAS を課して書く」だけである
   * （`markContestedPair`/`resolveContestedPair` と同じ「判定はしない」規律）。
   *
   * 契約:
   * - **`survivor.id` 側は呼び出し時点で `status === 'contested'` かつ
   *   `contestedWithId === survivor.contestedWithId`（呼び出し側が読んだ時点の値）で
   *   あること**（CAS）。**対向（`survivor.contestedWithId` が指す行）の現在の状態は
   *   この口自身は検査しない**——対向はもう `contested` ではない前提の口だからである。
   * - `survivor.id` が `isUuidLike` でない、またはそのテナントに存在しなければ
   *   `updateStatusWithEvent` と同じ「memory not found」の `Error` を投げる。
   * - CAS が破れた場合（存在するが `status !== 'contested'`、または `contestedWithId` が
   *   渡された値と一致しない）は {@link MemoryStatusConflictError} を投げる。
   *   `expectedStatus` は常に `'contested'`。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う: `survivor.id` の
   *   `status` を `'active'` に、`contestedWithId` を `null` に更新し、`memory_events` へ
   *   1件追記する（`event.kind` は呼び出し側が渡した値をそのまま使う）。**対向の行には
   *   一切触れない**——`UPDATE`/`INSERT` の対象はどちらも `survivor.id` 側だけである。
   * - 🔴 **原子性の証拠ではない。**`markContestedPair`/`resolveContestedPair` の
   *   doc コメントと同じ注意——この口が在ることは adapter がこの口を実装したことしか
   *   意味しない。
   */
  resolveOrphanedContested?(
    ctx: Ctx,
    survivor: { id: MemoryId; contestedWithId: MemoryId; event: NewMemoryEvent },
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * Issue #207/#933 PR2（ADR 0292 決定1、ADR 0327 §2・§4-b・§5、ADR 0378 決定1〜4、
   * ADR 0381）: `docs/memory-model.md` §11 lifecycle 行6「`active → contested`」を、
   * **3件以上**（群）へ書く口。`markContestedPair`（ADR 0134、2者専用）の形を手本にした、
   * N者版。呼び出し側（`Runtime`）が「誰を群に含めるか」（穴A＝既存の対の吸収・複数の
   * 既存群の合併を含む）を決め、この口はその集合を受け取って**1トランザクションで**
   * 書くだけである——`markContestedPair` と同じ「判定はしない・渡された集合をそのまま
   * 書く」規律。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`markContestedPair?`/`resolveContestedPair?` と同じ理由）。
   *
   * ⚠ **フォールバック経路を持たない**（`markContestedPair?` と同じ判断）。この口を
   * 実装しない adapter に対しては、`Runtime.markContestedGroup` は「対応していない」と
   * だけ返す——`RelationStore` が配線されていない場合と同じ扱いで、PR1（ADR 0378 決定5）
   * の「状態を動かさず evidence だけ積む」経路のままになる。
   *
   * 契約:
   * - **`members.length < 3` は呼び出し前の programmer error として扱う**（`RangeError`。
   *   メッセージ: `markContestedGroup: members must have at least 3 entries`）。2者は
   *   `markContestedPair` の領分のまま（ADR 0378 決定1 の (ii)）——この口は3件以上専用。
   * - 🔴 **`members` に同じ `id` が2回以上現れるのは programmer error として扱う。**
   *   実装は `RangeError`（メッセージ: `markContestedGroup: member ids must be
   *   unique`）を、書き込みを一切行う前に投げる。
   * - **各メンバーが呼び出し時点で次のいずれかであること**（CAS。行ごとに判定する）:
   *   1. `status === 'active'`（新しく群に加わる）。
   *   2. `status === 'contested'` かつ `contestedWithId` が **他の** `members` の
   *      いずれかの `id` と一致する（既存の2者間の対〔穴A〕を吸収する——対の相方も
   *      必ず同じ `members` に含めるのは呼び出し側の責務。含めずに片方だけ渡すと、
   *      その片方は次の3の条件に落ちてしまい `MemoryStatusConflictError` になる）。
   *   3. `status === 'contested'` かつ `contestedWithId === null`（既存の3件以上の
   *      群のメンバーを吸収する〔合併〕——その群が本当にこの `members` の他の誰かと
   *      つながっているかは、この口自身は検査しない。呼び出し側が
   *      `RelationStore.listRelated` で確かめてから渡す前提）。
   *   上のどれにも当てはまらない（`status === 'contested'` かつ `contestedWithId` が
   *   `members` の外を指す、または `active`/`contested` 以外）場合は CAS 違反として
   *   扱う。
   * - **どちらの id もそのテナントに存在しない場合、`updateStatusWithEvent` と同じ
   *   「memory not found」の `Error` を投げる。**書き込みは一切行われない。
   * - **CAS が破れた場合は {@link MemoryStatusConflictError} を投げる。**
   *   `expectedStatus` は常に `'active'`（CAS 条件が複数あるが、型としては
   *   `MarkContestedSideOutcome`/`markContestedPair` と同じ語彙に揃える——「新規に
   *   群へ入れる資格が無かった」という1つの意味として扱う）。**全部成功するか全部
   *   失敗するかのどちらかである**——部分成功は無い（`markContestedPair` と同じ理由）。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う:
   *   1. 全メンバーの `status = 'contested'`・`contestedWithId = NULL` に更新する
   *      （群のメンバーは `contestedWithId` を持たない、ADR 0378 決定1 §3.3 の
   *      「多者間ケースにまでこの『キャッシュ』の比喩を広げない」判断の継承）。
   *   2. `memory_relations` へ、**有効期間が重なるメンバーの組だけ**（ADR 0381
   *      決定1——「完全グラフ」は「一致した全員を結ぶ」ではなく「その中で実際に
   *      重なる組を結ぶ」と読み替える）、双方向2行ずつ `kind: 'contradicts'` で
   *      追記する。**既に同じ行が存在する場合は無視する**（`ON CONFLICT DO NOTHING`
   *      相当——穴A・合併で一部の対が既に表に住んでいることがあるため）。
   *   3. `memory_events` へ、`members[].event` をそれぞれ1件ずつ追記する
   *      （`event.kind` は呼び出し側が渡した値をそのまま使う。`markContestedPair` と
   *      同じ「渡された event をそのまま積む」規律）。
   * - 🔴 **原子性の証拠ではない。**`markContestedPair` の doc コメントと同じ注意
   *   ——この口が在ることは adapter がこの口を実装したことしか意味しない。
   */
  markContestedGroup?(
    ctx: Ctx,
    members: ReadonlyArray<{ id: MemoryId; event: NewMemoryEvent }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }>;
  /**
   * Issue #207/#933 PR2（ADR 0327 §4-c、ADR 0378 決定3、ADR 0381）: `markContestedGroup`
   * の解決側。`resolveContestedPair`（ADR 0150、2者専用）の形を手本にした N者版——
   * `ContestedResolution`（`{kind:"supersede",winnerId}` | `{kind:"both_active"}`）の
   * 意味を、2者からそのまま群へ広げる（ADR 0378 決定3）。新しい決着の種類は増やさない。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`markContestedPair?`/`resolveContestedPair?` と同じ理由）。
   *
   * ⚠ **フォールバック経路を持たない**（`resolveContestedPair?` と同じ判断）。
   *
   * 契約（`markContestedGroup`・`resolveContestedPair` と対称。差分だけを述べる）:
   * - **`members.length < 3` は呼び出し前の programmer error**（`RangeError`。
   *   メッセージ: `resolveContestedGroup: members must have at least 3 entries`）。
   * - 🔴 **重複 `id` も programmer error**（`RangeError`。メッセージ:
   *   `resolveContestedGroup: member ids must be unique`）。
   * - **各メンバーが呼び出し時点で `status === 'contested'` であること**（CAS）。
   *   群のメンバーは `contestedWithId` を持たない設計（`markContestedGroup` 契約）
   *   なので、`resolveContestedPair` の「相互参照が成立していること」に相当する検査は
   *   無い——`status` だけを見る。
   * - ⚠ **2026-09-30 の直し（ADR 0381 追記、段階Bの穴埋め）: `members` は、
   *   `memory_relations` でつながった「今も `contested` な」群の全員と一致しなければ
   *   ならない（CAS）。**一部だけを渡した解消（部分解消）は拒む——`members` から
   *   `memory_relations`（`kind: 'contradicts'`）を辿って求めた到達集合のうち、
   *   `status === 'contested'` のものが `members` の id 集合と完全に一致することを
   *   要求する。**forget・supersede・purge・archive で群から抜けたメンバー
   *   （決定10——関係の行は残すが `status` はもう `'contested'` ではない）は、この
   *   到達集合に含めない**——「今の群」を、行の有無ではなく `status` で判定する。
   *   足りないメンバーが見つかった場合、その1件を名指しして
   *   {@link ContestedGroupMembershipMismatchError}（2026-09-30 のさらなる直し、
   *   ADR 0381 §7 解消——当初は `MemoryStatusConflictError(missingId, "contested",
   *   "contested")` という `expectedStatus`/`observedStatus` が同じ値になる特別な
   *   使い方だったが、専用の型に切り出した）を投げ、何も書き込まない。
   * - 存在しない id は「memory not found」の `Error`。それ以外の CAS 違反は
   *   {@link MemoryStatusConflictError}（`expectedStatus` は常に `'contested'`）。
   *   全部成功するか全部失敗するかのどちらか。
   * - すべての条件を満たす場合のみ、**1トランザクションで**次を行う:
   *   1. 各メンバーを `members[].status`（`'active'` か `'superseded'`）へ更新し、
   *      `'superseded'` を指定した側は `members[].supersededById` も書く。
   *   2. **`both_active`・`supersede` のどちらでも**、この `members` 全員を結んでいた
   *      `memory_relations` の行を**双方向とも削除する**——2者版 `resolveContestedPair`
   *      が決着の種類に関わらず常に `contestedWithId = NULL` へ戻すのと同じ扱いに
   *      揃える（ADR 0381 決定3「関係の行の扱いも2者に揃える」）。「一度解消したら
   *      再び争わせない」ための印は作らない——後から同じ claim key の新しい記憶が来て
   *      一致すれば、また群になりうる。
   *   3. `memory_events` へ、`members[].event` をそれぞれ1件ずつ追記する。
   * - 🔴 **原子性の証拠ではない。**`markContestedGroup`/`resolveContestedPair` の
   *   doc コメントと同じ注意。
   */
  resolveContestedGroup?(
    ctx: Ctx,
    members: ReadonlyArray<{
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    }>,
  ): Promise<{ members: Memory[]; events: MemoryEvent[] }>;
  /**
   * Issue #372（(B) 第2段。`docs/decisions/`「主張キーの衝突を検出する」ADR、ADR 0185
   * 決定4・ADR 0320 決定7・決定8 の続き）: 「同じ tenant・同じ `subjectId`・同じ claim key
   * （`claimKeySubject`/`claimKeyPredicate`）・有効期間が重なる・`contentHash` が違う、
   * 他の `active` Memory」を**列と索引だけで**（LLM を一度も呼ばずに）見つける読み取り
   * 専用の口。`idx_memories_claim_key`
   * （`packages/postgres/migrations/0021_memories_claim_key.sql`、ADR 0320 決定7）が
   * このためにある——`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)` の
   * 部分索引で絞り込み、`status`/`contentHash`/有効期間の重なりはこの口が追加で絞る
   * （ADR 0320 決定8「`status` の絞り込みは呼び出し側〔＝この口〕に委ねる」）。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`markContestedPair?`/`resolveContestedPair?` などと同じ理由、
   * `docs/autonomy.md`「してはいけないこと」表）。**フォールバック経路は無い**——この口が
   * 無い adapter に対しては、`Runtime` 側の検出（`claimKey.detectContested: true`）は
   * 何もしない。判定を近似で代替する擬似フォールバックは意図的に作らない
   * （`markContestedPair?` と同じ判断——近似は北極星 問い3「説明できるか」を壊しうる）。
   *
   * 契約:
   * - **`subjectId` は NULL 同士も一致として扱う**（SQL でいう `IS NOT DISTINCT FROM`）。
   *   `docs/memory-model.md` の「`NULLS NOT DISTINCT` が要る理由」と同じ配慮——
   *   `subjectId` を持たない Memory 同士（両方 `null`）も「同じ主題」として扱う。
   *   ⚠ **recall 側の `RecallScope.subjectId`（既定は厳密一致、`includeSubjectless` で
   *   明示的に緩める）とは異なる規約である**——検出は「同じかどうか」を問うだけで、
   *   緩める/締めるという選択肢を持たない。
   * - **`query.claimKey.subject`/`.predicate` は正規化済みの文字列として、そのまま
   *   等値比較する**（呼び出し側が既に `normalizeClaimKey` を通した値を渡す前提。
   *   この口自体は正規化しない）。
   * - **`status = 'active'` の行だけを返す。**`contested`/`superseded`/`archived`/
   *   `forgotten` は対象外。
   * - **`query.excludeMemoryId` に一致する行は返さない**（呼び出し側は通常、いま作った
   *   ばかりの Memory 自身の id を渡す）。
   * - **`query.contentHash` と一致する行は返さない**——内容が同じなら矛盾ではない
   *   （Issue #372 の判定規則そのもの）。
   * - **有効期間が重ならない行は返さない。**半開区間 `[validFrom, validUntil)` として
   *   扱い、`validFrom` が `null` なら `-∞`、`validUntil` が `null` なら `+∞` として扱う
   *   （`aggregateScope` の `validAt` ゲートと同じ NULL の読み方——ただしこちらは「1点」
   *   ではなく「区間の重なり」を判定する）。
   * - **返す順序は規定しない。**呼び出し側（`Runtime`）は件数（0/1/2件以上）で分岐する
   *   だけで、順序に依存する判断をしない。
   * - **LLM を一度も呼ばない。**列の等値比較・範囲比較・索引アクセスだけで完結する
   *   （北極星 問い5）。
   *
   * ⚠ **（ADR 0377、Issue #835 候補1）この口自体は `sourceObservationId` で絞らない
   * ——同じ observation から抽出された兄弟 Memory どうしも、他の契約（鍵・有効期間・
   * `contentHash`）を満たせば返り値に含めてよい。** 呼び出し側（`Runtime.
   * detectClaimKeyContested`）が、返り値から「検出中の memory と同じ
   * `sourceObservationId`」を持つ行を件数を数える前に除く前提で実装されている
   * （`memory.sourceObservationId` が `null` のときは除かない）。この口の contract に
   * `LIMIT` は無いので、adapter が独自に結果件数を絞らない限りこの前提は保てる——
   * ただし interface 自体は adapter が `LIMIT` を付けることを禁じていない（その場合
   * core 側の除外が効かないことがある）。詳細は ADR 0377 の「店へ押し下げない理由」を
   * 見ること。
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
   * Issue #933（案2、`docs/decisions/0378-*.md`。ADR 0324 決定5・決定6・#207・ADR 0327 の
   * 続き）: `findActiveByClaimKey?` と**同じ絞り込み**を、`status = 'active'` の代わりに
   * `status = 'contested'` の行に対して行う、読み取り専用の口。
   *
   * ## なぜこの口が要るか
   *
   * `findActiveByClaimKey?` は `status = 'active'` の行しか見ない。ところが
   * `detectClaimKeyContested`（`Runtime`）が同じ鍵の主張を1件ずつ検出するたびに、
   * 一致した2件はどちらも `markContested` で `active` から `contested` へ移る——
   * その結果、同じ鍵に3件目が届いたときには、1件目・2件目はもう `active` ではないため
   * `findActiveByClaimKey?` の一致から**構造的に**消えている（#933）。この口は、その
   * 「もう `active` ではないが、同じ鍵で争われている」相手を見つけるためにある。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`findActiveByClaimKey?`/`markContestedPair?` と同じ理由）。
   * **フォールバック経路は無い**——この口が無い adapter に対しては、`Runtime` 側の検出は
   * 今まで通り `findActiveByClaimKey?` の一致（`active` のみ）だけで判定する。**後方互換**
   * ——この口を実装していない既存の adapter の振る舞いは1バイトも変わらない。
   *
   * 契約は `findActiveByClaimKey?` と同一で、`status` の絞り込みだけが異なる:
   *
   * - **`subjectId` は NULL 同士も一致として扱う**（`IS NOT DISTINCT FROM`）。
   * - **`query.claimKey.subject`/`.predicate` は正規化済みの文字列として、そのまま
   *   等値比較する。**
   * - **`status = 'contested'` の行だけを返す。**`active`/`superseded`/`archived`/
   *   `forgotten` は対象外——`findActiveByClaimKey?` が `active` 以外を対象外にするのと
   *   対称。
   * - **`query.excludeMemoryId` に一致する行は返さない。**
   * - **`query.contentHash` と一致する行は返さない。**
   * - **有効期間が重ならない行は返さない**（半開区間 `[validFrom, validUntil)`、`NULL` は
   *   `-∞`/`+∞`。`findActiveByClaimKey?` と同じ判定式）。
   * - **返す順序は規定しない。**
   * - **LLM を一度も呼ばない。**
   *
   * ⚠ **（ADR 0377 と同じ前提）この口自体は `sourceObservationId` で絞らない。**
   * 呼び出し側（`Runtime.detectClaimKeyContested`）が、`findActiveByClaimKey?` の返り値と
   * この口の返り値を合わせた上で、同じ `sourceObservationId` を持つ兄弟を件数を数える前に
   * 除く（ADR 0377 の除外を、combined な一致に対しても同じ形でかける。ADR 0378）。
   *
   * ⚠ **この口の一致は `markContested` の対にはしない。**`detectClaimKeyContested` は、
   * 合わせた一致（`findActiveByClaimKey?` + この口）が2件以上のとき、または、
   * ちょうど1件でもその1件がこの口由来（＝既に `contested`）のときは `markContested` を
   * 呼ばず、状態を一切動かさずに `memory_events` へ evidence（`meta.reason:
   * 'claim_key_conflict_unresolved'`）を積むだけに留める（ADR 0324 決定6 の経路、
   * ADR 0378 決定2・決定7-d）。`markContested` の対になれるのは、合わせた一致がちょうど
   * 1件で、かつその1件が `findActiveByClaimKey?` 由来（＝`active`）のときだけである。
   * **多者間グループを実際に `contested` として束ねる書き込み（ADR 0327 が設計した
   * `markContestedGroup` 相当）は、この口の範囲外**——`RelationStore`（ADR 0327・
   * ADR 0292、まだ実装されていない）が要る（ADR 0378 の「PR2 へ残すもの」）。
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
   * Issue #691 続き（`docs/decisions/0327-*.md`、ADR 0326 が「採らなかった案B」として
   * 保留した「`knownPredicates` を store の既存 predicate 一覧から動的に渡す」の実装）:
   * 同じ tenant・同じ `subjectId` で claim key を持つ `active` な Memory から、
   * `claim_key_predicate` を**新しい順・重複なく**列挙する読み取り専用の口。
   * `deriveClaimKeys`（`claim-key.ts`）の `knownPredicates` 語彙ヒントを、呼び出し側が
   * 手で作らずに store から集めるために使う（`ClaimKeyOptions.knownPredicatesFromStore`）。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`findActiveByClaimKey?`/`markContestedPair?` と同じ理由）。
   * **フォールバック経路は無い**——この口が無い adapter に対しては、
   * `knownPredicatesFromStore` は黙って効かない（渡した `knownPredicates` だけが使われる。
   * ADR 0324 決定1の「渡されたが効かない」規約と同じ）。
   *
   * 契約:
   * - **`subjectId` は NULL 同士も一致として扱う**（`IS NOT DISTINCT FROM`）——
   *   `findActiveByClaimKey?` と同じ規約。
   * - **`status = 'active'` の行だけを対象にする。** `contested`/`superseded`/`archived`/
   *   `forgotten` は対象外——`findActiveByClaimKey?` と同じ「今読むべき主張」の定義。
   * - **`claim_key_predicate` が非 `null` の行だけを対象にする**
   *   （`idx_memories_claim_key`、`migrations/0021_memories_claim_key.sql` の部分索引の
   *   条件と同じ）。
   * - 返す `string[]` は `claim_key_predicate` の**重複を除いた**一覧。同じ predicate を
   *   持つ行が複数あれば、そのうち最も新しい行（`created_at` が最大のもの）で代表させる。
   * - **新しい順**（代表行の `created_at` 降順）に並べる。呼び出し側
   *   （`ClaimKeyOptions.knownPredicates` との合成、`runtime.ts`）は「利用者の一覧を先に、
   *   この一覧を後に、重複除去」という順序に依存するため、この口自身の返り値の順序は
   *   「新しい順」であることを契約にする（`findActiveByClaimKey?` の「順序は規定しない」
   *   とは異なる——あちらは呼び出し側が件数でしか分岐しないが、こちらは語彙ヒントの
   *   優先順位に順序がそのまま使われる）。
   * - **同着（代表行の `created_at` が同じ predicate が複数ある）は、predicate の
   *   コードポイント順の昇順**で並べる。同着の順が実装ごと・呼び出しごとに変わると、
   *   `limit` で切った先頭の集合と、語彙ヒントの優先順位が変わり、同じ入力に別の
   *   プロンプトが出るため。DB の照合順序（collation）にも、書いた順にも、UTF-16 コード単位順
   *   （JS の `<`。BMP の U+E000〜U+FFFF と補助面の文字で、コードポイント順と食い違う）にも
   *   依らない。`PostgresMemoryStore` は `COLLATE "C"`、`packages/testkit` の in-memory 実装は
   *   UTF-8 のバイト列の比較で、これに揃える。⚠ 以前は同着の順を規定していなかった
   *   （Issue #1412 の続き）。
   * - **`query.limit` を超えない件数を返す。**`limit` は呼び出し側
   *   （`ClaimKeyOptions.knownPredicatesFromStore`）が決める——この口自身は既定値を
   *   持たない。
   * - **`claim_key_subject` の値は返り値に出ない。** この口が集めるのは predicate の
   *   語彙だけである（`buildKnownPredicateInstruction` が predicate だけを渡す形と
   *   対応する）。
   * - **LLM を一度も呼ばない。**列の等値比較・`GROUP BY`・索引アクセスだけで完結する
   *   （北極星 問い5）。
   *
   * ⚠ **`subject` 側の対（`listActiveClaimSubjects?` のような口）は意図的に作っていない**
   * （Issue #372負債6、ADR 0334「採らなかった案」）。store が自己蓄積した `claim_key_subject`
   * の値（LLM が自由記述で作った曖昧な値になりがち、例: `'sibling'`）を汎用語彙ヒントとして
   * 横流しすると、無関係な話題の主張にまでその値が誤って使い回される汚染を実測で確認した
   * ——predicate 側で起きる語彙の使い回し（ADR 0329「負債1」）より一段深刻（別人の
   * claim key `subject` を取り違えて同一視しうる）。`ClaimKeyOptions.knownSubjects` は
   * 呼び出し側が明示的に渡す静的な語彙だけをサポートする（`subjectCandidates` への
   * 暗黙の転用はしない——ADR 0334 追記〔2026-09-26〕）——詳細は ADR 0334。
   */
  listActiveClaimPredicates?(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]>;
  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」を書き込む口
   * （`Runtime.restoreSuperseded` の doc コメントに設計全体の理由がある。ここは
   * この店側メソッド固有の契約と、**なぜ新しい任意メソッドが要るか**だけを述べる）。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`「してはいけ
   * ないこと」表の「公開 API の破壊的変更」、[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md)
   * 決定1と同じ理由）。この口を実装しない adapter に対しては、`Runtime.restoreSuperseded`
   * が `{ supported: false, supersedingMemoryId, outcomes: [] }` を返す——`archiveDecayed?`/
   * `Runtime.sweepArchive` と同じ「対応していない、と名指しする」形（ADR 0082）。
   *
   * ⚠ **フォールバック経路を持たない**（`archiveDecayed?`/`purgeMemory?`/
   * `markContestedPair?`/`resolveContestedPair?` と同じ判断）。「口が無ければ既存メソッドの
   * 呼び出しで代替する」という擬似フォールバックは意図的に作らない——下の理由のとおり、
   * 既存の必須メソッドにはこの操作を表現する形がそもそも無い。
   *
   * 🔴 **なぜ既存の `updateStatusWithEvent` を再利用しないか（ここが `restoreArchived`
   * との分岐点）。** [ADR 0122](../../../../docs/decisions/0122-restore-archived-memory.md)
   * 決定1は「`archived → active` は1件の compare-and-swap であり、既に必須メソッドとして
   * 存在する `updateStatusWithEvent` がそのまま満たせる形をしている」ことを理由に、新しい
   * 任意メソッドを足さなかった。**この前例は `superseded → active` には転用できない**。
   * 理由は2つある:
   * 1. **粒度が違う。** `restoreArchived` は id 単位の CAS だが、`restoreSuperseded`
   *    （`Runtime` 側）は「置き換えた側の id」から**群**（複数の Memory）を選ぶ
   *    範囲走査であり、`archiveDecayed?` と同じ「既存のどのメソッドにも無い形
   *    （範囲走査 + 一括更新）」に属する。
   * 2. **`superseded_by_id` を `NULL` へ戻す経路が、型にも SQL にも無い。** 本ファイル
   *    上部の `updateStatusWithEvent` の契約・`packages/postgres/src/memory-store.ts` の
   *    実装は `superseded_by_id = COALESCE(${opts.supersededById ?? null}, superseded_by_id)`
   *    である——`opts.supersededById` を省略すると**現在の値をそのまま保持する**という
   *    意味しか無く、明示的に `NULL` を書く経路が引数の形にもクエリにも存在しない
   *    （`opts.supersededById` は `MemoryId | undefined` であり `MemoryId | null |
   *    undefined` ではない）。⟹ `updateStatusWithEvent` をどう組み合わせても
   *    `superseded_by_id` を `NULL` へ戻すことはできず、理由1の粒度の問題を措いても
   *    この一点だけで新しい任意メソッドが要る。
   *
   * 契約:
   * - 対象は **`tenant_id = ctx.tenantId AND superseded_by_id = supersededById AND
   *   status = 'superseded'` の行に限る。**既存の部分索引
   *   `idx_memories_superseded_by`（`tenant_id, superseded_by_id`、
   *   `WHERE superseded_by_id IS NOT NULL`、`migrations/0001_init.sql`）がそのまま
   *   この `WHERE` を担う——新しい索引は足さない。
   * - 🔴 **`status = 'superseded'` を条件に必ず含める。** `superseded_by_id` が
   *   非 `null` のまま `status` が `'archived'`/`'forgotten'` へ**さらに**進んだ行
   *   （`purge`/`sweepArchive` 等、`superseded_by_id` を消さない別の遷移を経由した行）
   *   を巻き込まない——この口が動かしてよい遷移は lifecycle 表行15の
   *   `superseded → active` 一本だけであり、他の起点からの `→ active` は今日どおり
   *   `updateStatus`/`updateStatusWithEvent` の領分である。
   * - すべての条件を満たす行について、**1トランザクションで**次を行う: `status='active'`・
   *   `superseded_by_id=NULL`・`updated_at=now()` へ更新し、行ごとに `memory_events` へ
   *   `kind: 'unsuperseded'` を1件追記する（`MemoryEventKind` が本 PR で足す新しい値、
   *   `packages/core/src/event.ts` 参照）。`digestSnapshot` にはその Memory の
   *   （変更しない）現在の `digest` を入れる——`content`/`digest` はこの操作では
   *   一切書き換えない。
   * - `meta` には最低限 `{ reason, supersededById }` を入れる。`reason` は
   *   `event.reason` を渡された値、省略時は固定タグ `"unsuperseded"`
   *   （`Runtime.restoreSuperseded` 側の `RestoreSupersededOptions.reason` の doc
   *   コメント参照——`ForgetOptions.reason`/`RestoreArchivedOptions.reason` のような
   *   「省略時はキー自体を持たせない」規律とはここだけ意図的に違う）。`supersededById`
   *   には**外した相手の id**（＝この呼び出しの `supersededById` 引数、更新前に
   *   `superseded_by_id` へ入っていた値）をそのまま入れる——`status='superseded'` の
   *   行がまとめて対象になる一括操作である以上、個々の `memory_events` 行だけを見ても
   *   「どの群の一部として戻ったか」が分かるようにする。
   * - `event.actor` を省略した場合は `{ type: 'system' }`。
   * - 対象が0件なら `{ restored: [] }` を返す（**例外にしない**）。`supersededById` に
   *   実在しない・形式不正な id を渡した場合も同じ（`isUuidLike` の doc 参照。
   *   `updateStatusWithEvent` のような「対象が無ければ例外」の規律はここでは採らない
   *   ——この口はそもそも「範囲に何件あるか分からない」問い合わせであり、0件は
   *   異常ではなく正常な結果の一種であるため。`archiveDecayed?` が対象0件で
   *   `{ archived: [] }` を返すのと同じ規律）。
   *   ⚠ **2026-09-28 追記（[Issue #1229](https://github.com/takecchi/mnemora/issues/1229)）:
   *   `event.at` が Invalid Date のときも、対象が0件なら `{ restored: [] }` を返す（例外にしない）。**2実装で同じ。
   *   対象が在るときは、どちらも例外で、1件も戻さない（`@mnemora/postgres` は `invalid input syntax for type
   *   timestamp with time zone` が drizzle の `Failed query` に包まれ、`cause` に入る）。
   *   以前は `@mnemora/postgres` だけが、対象が無くても `at` を `timestamptz` に変えて例外になっていた。
   *   例外の少ない側（testkit の fixture）に揃えた（クローン miku の判断であり、オーナーの判断ではない）。
   *   core の `Runtime.restoreSuperseded` は `clock.now()` を渡すので、ここに届くのは store を直接呼ぶ側だけである。
   *   【実測 2026-09-28】`restore-superseded-invalid-at.postgres.test.ts`（Postgres と testkit の fixture）。
   * - 返す `restored` の順序は adapter に委ねる（`Runtime.restoreSuperseded` 側は
   *   これをそのまま `outcomes` の順序として運ぶだけで、特定の順序を要求しない）。
   * - 🔴 **原子性の証拠ではない。**`markContestedPair`/`supersedeWithNewMemories` の
   *   doc コメントと同じ注意——この口が在ることは adapter がこの口を実装したことしか
   *   意味しない。実際に原子性を測るのは適合テストと `packages/postgres` の並行の歯である。
   *
   * ⭐ **`filter?.onlyMemoryIds`（[Issue #515](https://github.com/takecchi/mnemora/issues/515)
   * 方向①、[ADR 0258](../../../../docs/decisions/0258-restore-superseded-operation-scope.md)）:**
   * 指定すると、上記の対象（`tenant_id`/`superseded_by_id`/`status` の3条件）に加えて
   * **`id` がこの配列に含まれること**を条件に足す（積集合）。**省略時は従来どおり——
   * この任意引数を追加する前の振る舞いを1バイトも変えない。**空配列を渡すと対象0件
   * （`id = ANY('{}')` は常に偽であるため、0件は「対象が無かった」と同じ扱いで
   * 例外にしない）。この任意メソッドを実装している adapter が `filter` パラメータ
   * 自体（またはその中の `onlyMemoryIds`）を実装するかどうかは、さらに独立した
   * 適合フラグ（`MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?`、
   * `@mnemora/testkit`）で検査する——**未指定なら「検査していない」と名乗る**
   * （PR #524 が `supportsPreviewRestoreSupersededBy` を必須にして破壊的だった
   * 前例、ADR 0237 冒頭の訂正、を踏まえ、この新フラグは任意にした）。
   */
  restoreSupersededBy?(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string; actor?: EventActor; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ restored: Memory[] }>;
  /**
   * `restoreSupersededBy?` を実際に呼ぶ**前**に、その群に何が入っているかを見るための
   * 読み取り専用の口（[Issue #515](https://github.com/takecchi/mnemora/issues/515)、
   * ADR 0237。ADR 0230 冒頭の訂正が挙げた「群＝1回の操作ではない」を埋める。
   * `Runtime.restoreSuperseded` の `opts.dryRun` から呼ばれる）。
   *
   * 🔴 **`restoreSupersededBy?` の既存の振る舞いは1バイトも変えない。** この口は
   * 別に足す任意メソッドであり、`restoreSupersededBy?` を呼ばずには済まない既定
   * （実際に戻す）はそのまま残る——[ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md)
   * 決定1と同じ「既存必須/既存契約は壊さない」判断を、ここでは「既存の任意メソッドの
   * 意味も変えない」まで広げている。
   *
   * **対象の選び方は `restoreSupersededBy?` の `WHERE` と完全に一致させる**——
   * `tenant_id = ctx.tenantId AND superseded_by_id = supersededById AND
   * status = 'superseded'`。ここが2つの口でずれると、「戻る前に見たものと、実際に
   * 戻ったものが違う」という、この口を作った理由そのものを裏切る不整合になる。
   * 適合テスト（`packages/testkit` の `memory-store-conformance.ts`）はこの一致を
   * 両方の口を同じ入力で呼んで比較することで検査する。
   *
   * **書き込みは一切行わない**——`memories` の `UPDATE` も `memory_events` への
   * `INSERT` も無い。`SELECT` だけで完結する（費用の見立ては ADR 本文参照）。
   *
   * **`supersededReason`**: 対象の Memory について、`status` を `'superseded'` に
   * した直近の `memory_events` 行（`kind = 'superseded'`、`memory_id` が一致する
   * 行のうち `at` が最大のもの）の `meta.reason` をそのまま運ぶ。⚠ **これは
   * 「なぜその群に入っているか」を*厳密に型付けした*分類ではない**——`meta.reason`
   * は `Runtime` の3つの書き手（`reextract` は `"reextract_superseded"`、
   * `consolidate` は `"consolidated"`、`resolveContested` は `"contested_resolved"`）
   * が自由文として積んだ値をそのまま読むだけであり、この口はそれを解釈も変換もしない。
   * 一致する `memory_events` 行が無い場合（この adapter が対象について1件も
   * `kind: 'superseded'` を積んでいない、または将来別の書き手が `reason` を
   * 省略した場合）は `null`。
   *
   * ⚠ **2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:
   * 「一致する行が無い」は、上記2つの理由に加えて第三の理由でも起きる——
   * `MemoryStore.purgeExpiredEvents?`（[ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)）
   * が保持期間の設定に従ってその `kind: 'superseded'` 行を既に削除した場合である。**
   * `purgeExpiredEvents?` の対象選定は `kind = 'events_purged'` 以外の行すべてであり、
   * `superseded` を特別扱いして除外しない。この3つの理由はどれも `supersededReason: null`
   * という同じ値になり、呼び出し側からは区別できない——「由来が最初から無かった」のか
   * 「由来はあったが保持期間の掃除で消えた」のかを、この戻り値だけでは判定できない。
   * 詳細・採らなかった案は
   * [ADR 0258](../../../../docs/decisions/0258-restore-superseded-operation-scope.md)
   * の同日付追記を参照。
   *
   * - 対象が0件なら `{ candidates: [] }`（`restoreSupersededBy?` の「対象0件なら
   *   例外にしない」規律と同じ）。
   * - 返す順序は adapter に委ねる（`restoreSupersededBy?` の `restored` と同じ規律）。
   *
   * ⭐ **`filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy?`
   * の同名パラメータと完全に同じ意味・同じ `WHERE` 条件を追加する。**この口が
   * `restoreSupersededBy?` と「対象の選び方が1文字も違わない」という既存の契約
   * （上記）を守るには、`filter` の扱いも両者で一致させる必要がある——適合テストは
   * 両方の口へ同じ `filter` を渡して結果を突き合わせることでこれを検査する。
   */
  previewRestoreSupersededBy?(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }>;

  /**
   * Issue #201 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md):
   * このテナントの taxonomy 語彙を一覧する（`labels` テーブル、
   * `docs/memory-model.md` §8）。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に公開済み、`docs/autonomy.md`「して
   * はいけないこと」表の「公開 API の破壊的変更」、ADR 0100 決定1と同じ理由）。
   *
   * 契約:
   * - `name` の**コードポイント順**（Postgres の `COLLATE "C"` と同じ、バイト順）の
   *   昇順で返す。並び順の保証はこの1点のみ（Issue #881 / 本 ADR 追記
   *   （2026-09-26、クローン miku の判断）: ロケール依存の自然順（例:
   *   `String.prototype.localeCompare` の既定ロケール、DB の既定照合順序）は
   *   実装や実行環境によって互いにずれるため、契約からは外した）。
   * - `status` は `'registered'` か `'proposed'` のいずれか。
   * - `proposedCount` は「この名前を `tags` に含む Memory が新規作成された回数」の
   *   近似値である——**厳密な『いまこの名前を持つ生きた Memory の数』ではない**
   *   （対象の Memory が後から `forgotten`/`purged` になっても減らない。§8 の
   *   「昇格の候補として表に出る」ための目安であり、正確な現在数を保証する欄ではない。
   *   詳細は ADR 0318「決めたこと」）。
   * - `registeredAt` は `status: 'registered'` のときだけ非 null。
   * - テナントに1件も無ければ空配列。例外にしない。
   *
   * ⚠ 2026-09-27 追記（今の振る舞いを書くだけ）:
   * - **テナントの全ラベルを1回で返す。**ページング（件数の上限・続きから読む口）は無い。
   * - **ラベルの行は消えない。**`tags` にその名前を持つ Memory が全部 `forgotten`・`archived`・
   *   `superseded` になっても、行は残り、`proposedCount` も減らない。⟹ 誰も使わなくなった
   *   `proposed` のラベルも一覧に出続ける。消す口・却下する口は無い（`registerLabel?` の追記）。
   *   purge した Memory の語が残る件は Issue #995。
   */
  listLabels?(ctx: Ctx): Promise<LabelSummary[]>;

  /**
   * Issue #201 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md):
   * 語彙を `registered` へ昇格する（`docs/memory-model.md` §8「テナントが語彙として
   * 登録すると `registered` になる」）。
   *
   * 🔴 **任意メソッドである。**理由は `listLabels?` と同じ。
   *
   * 契約:
   * - 対象の `name` が `labels` にまだ存在しなければ、`proposedCount: 0` の新しい行を
   *   `registered` として作る——「まだ誰も `tags` に使っていない語彙を先に登録する」
   *   という運用（§8 が想定する語彙管理）を妨げない。
   * - 既に `proposed` として存在すれば、`status` を `registered` に更新し
   *   `registeredAt` を現在時刻にする。`proposedCount` は変えない。
   * - 既に `registered` であれば、`registeredAt` を変えずに現在の行をそのまま返す
   *   （何度呼んでも同じ結果になる——冪等）。
   * - 戻り値は更新後の `LabelSummary`。
   *
   * ⚠ **状態は `proposed` → `registered` の一方向だけである**（2026-09-27 追記、今の振る舞いを
   * 書くだけ）。`registered` を `proposed` へ戻す口も、ラベルを却下・削除する口も無い。
   * `name` の形は検査しない——`""`・空白だけの名前もそのまま `registered` の行になる
   * （`@mnemora/postgres`・testkit とも。`tags` の要素と同じく完全一致の語彙で、正規化もしない。
   * `docs/memory-model.md` §8 の 2026-09-27 追記）。`@mnemora/postgres` では、NUL を含む名前は
   * 例外になり、孤立サロゲートは U+FFFD に置き換わり、索引の1行の上限を超える長い名前は例外に
   * なる（`Ctx` の doc、Issue #1074）。testkit は置き換えも長さの上限も持たず、そのまま受け入れる
   * （NUL を Postgres に揃えて拒むのは PR #1135）。
   */
  registerLabel?(ctx: Ctx, name: string): Promise<LabelSummary>;

  /**
   * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
   * このテナントに属する行を**跡形なく**消す——`purgeMemory?` と違い、行そのものを
   * 物理削除する（tombstone を書き残さない）。`eraseTenant`（同ファイルの独立関数、
   * `packages/core/src/erase-tenant.ts`）が、この口を含む4つの port の任意メソッドを
   * 束ねて1つの結果に落とす。**このメソッド単体は orchestrator ではない**——呼び出し順・
   * 他 port との整合は `eraseTenant` 側の責務であり、このメソッドは「自分が持つ表から
   * このテナントの行を消す」ことだけを行う。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`purgeMemory?`/`archiveDecayed?` と同じ理由、ADR 0100 決定1）。
   * ADR 0050 が `getEventRetention`/`setEventRetention` を必須にした理由（「口が無い」と
   * 「失敗した」が見分けられない）はここでは当たらない——{@link EraseTenantStoreResult}
   * の `store_unsupported`（`eraseTenant`（独立関数）側で組み立てる）が port を名指しで
   * 区別するため、任意メソッドのままでも「口が無い」を「失敗した」と取り違えない。
   * 詳細は ADR 0383「検討した代替案」。
   *
   * **消す表**（Issue #1207 の実測が数え上げた、テナント消去で残っていた表）: `memories`・
   * `observations`・`memory_events`・`recalls`・`recall_usages`・`labels`・
   * `memory_labels`・`tenant_activity`・`tenant_subject_activity`。**`DB には消去の記録を
   * 何も残さない**——`memory_events` に `events_purged` 相当の行を積んだりしない
   * （ADR 0115 決定4「`events_purged` は掃除の対象外」は保持期間の掃除だけの話であり、
   * テナント消去はこの行自体も消す。ADR 0383 参照）。呼び出し側に返すのは戻り値だけである。
   *
   * 契約:
   * - `opts.limit` 個を目安に、子→親の順（`memory_labels`・`recall_usages`・
   *   `memory_events` → `memories` → `observations` → `recalls` → `labels` →
   *   `tenant_activity`・`tenant_subject_activity`）で削除する。**1回の呼び出しで
   *   全部消し切れるとは限らない**——`result.reachedLimit === true` なら、呼び出し側は
   *   同じ `opts`（`limit` はそのまま）で呼び直すこと。**この口は何度呼んでも安全**
   *   （既に空になった表は0件を返すだけで、エラーにはならない）。
   * - 🔴 **同じテナント内の自己参照（`memories.superseded_by_id`/`contested_with_id`）は、
   *   `memories` を削除する前に、このテナントの行**全体**について `NULL` へ書き換えてから
   *   削除する。** `limit` で区切ったバッチをまたいで自己参照が残っていると
   *   （例: バッチ1で削除する行を、まだ削除していないバッチ2の行が `superseded_by_id` で
   *   指している）、`memories(id)` への FK（`migrations/0001_init.sql` の
   *   `superseded_by_id uuid NULL REFERENCES memories(id)`/`contested_with_id uuid NULL
   *   REFERENCES memories(id)`。どちらも `ON DELETE` 指定が無く既定の `NO ACTION`）が
   *   違反になる。`superseded_by_id`/`contested_with_id` には
   *   `provenance_kind`/`source_observation_id` のような他の列を道連れにする `CHECK` 制約が
   *   無い（`migrations/0001_init.sql` 確認済み——`CHECK` が掛かっているのは
   *   `digest_source`・`provenance_kind`・`(provenance_kind, source_observation_id)`・
   *   `status`・`embedding_status` の5本で、`superseded_by_id`/`contested_with_id` を
   *   含む `CHECK` は無い）ため、`NULL` へ書き換えて構わない——このテナントを丸ごと
   *   消す以上、「何に置き換わったか」「どれと矛盾していたか」という参照先の情報を
   *   残す意味も無い。
   * - 🔴 **他テナントの行がこのテナントの行を参照している場合（外部キーのどの経路でも。
   *   埋め込み空間の表のように、このテナントの行を消すと巻き込まれて消える行も含む）、
   *   `{ kind: "blocked_by_foreign_reference"; count }` を返し、1行も消さない**
   *   （他テナントの行は一度も書き換えない）。`count` は参照している他テナントの行数。
   *   **この検査・削除は1つのトランザクションの中で行う**——検査で見つからなければ、その
   *   同じトランザクションでそのまま削除を進める。`eraseTenant`（独立関数）はこの口を
   *   4つの port の中で最初に呼ぶので、これが返ったときほかの port にはまだ触れていない
   *   （ADR 0383 決定5・決定8）。
   * - `opts.dryRun === true` のときは、削除もこの自己参照の書き換えも一切行わず、
   *   削除していたら消えていたであろう件数だけを返す（`purgeExpiredEventsByRetention`
   *   の `dryRun` と同じ意味）。
   * - 戻り値の `deleted` は、この呼び出しで実際に削除した行数の合計（対象8表すべての
   *   合計。`dryRun` のときはプレビューの合計）。
   *
   * ⚠ **`recalls` の保持方針は、この ADR では決めていない**（[ADR 0290](../../../../docs/decisions/0290-activity-seq-read-path-documented-not-implemented.md)
   * が「`recalls` の保持方針」を先の話として残したまま——この口は「テナントを丸ごと
   * 消す」操作の一部として `recalls` も含めて消すが、それは「生きているテナントの
   * `recalls` を今後どう保持するか」という未決の問いには答えていない）。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantStoreResult>;
}

/**
 * {@link MemoryStore.eraseTenant}・`VectorStore.eraseTenant`・`OutboxStore.eraseTenant`・
 * `TenantSettingsStore.eraseTenant` が共通して受け取る引数
 * （Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）。
 *
 * `packages/core/src/erase-tenant.ts` の独立関数 `eraseTenant` の `opts`
 * （`confirmTenantId`・`limit`・`dryRun`）のうち、`confirmTenantId` は port には渡さない
 * （その検査は独立関数の側で書き込み前に行う——`Ctx` の `tenantId` を信じてよいことが
 * port 側の前提になる）。
 */
export interface EraseTenantStoreOptions {
  /**
   * 1回の呼び出しで削除する目安の上限。**必須・既定値なし**
   * （`PurgeExpiredEventsOptions.limit` と同じ理由——取り消せない削除の上限を
   * `packages/core` が勝手に決めない）。
   */
  limit: number;
  /** `true` なら削除を一切行わず、削除していたら消えていたであろう件数だけを返す。省略時は `false`。 */
  dryRun?: boolean;
}

/**
 * `VectorStore.eraseTenant`・`OutboxStore.eraseTenant`・`TenantSettingsStore.eraseTenant`
 * の戻り値（Issue #1207、ADR 0383）。`MemoryStore.eraseTenant` は
 * {@link EraseTenantStoreResult}（`blocked_by_foreign_reference` を含む）を使う——
 * 他の3 port には自己参照 FK も、他テナントの行から参照される構造も無いため、
 * この結果だけで足りる。
 */
export interface EraseTenantResult {
  /** この呼び出しで実際に削除した行数（`dryRun` のときはプレビューの件数）。 */
  deleted: number;
  /**
   * `true` なら、この store にまだ削除しきれていない行が残っている可能性がある
   * （`opts.limit` で打ち切った）ことを示す。呼び出し側は同じ `opts` で呼び直すこと。
   * ⚠ **`deleted === opts.limit` ちょうどで削除しきれていた場合も `true` を返すことがある**
   * （保守的な近似——「本当にまだ残っているか」を確認する追加のクエリを毎回発行しない
   * 実装上の判断。詳細は `@mnemora/postgres` の実装 doc）。呼び直しても安全（その場合は
   * 次の呼び出しが0件で返るだけ）。
   */
  reachedLimit: boolean;
}

/**
 * {@link MemoryStore.eraseTenant} の戻り値（Issue #1207、ADR 0383）。
 * `{ kind: "executed", ... }` は {@link EraseTenantResult} と同じ形に `kind` を足しただけ。
 */
export type EraseTenantStoreResult =
  | { kind: "executed"; deleted: number; reachedLimit: boolean }
  | {
      kind: "blocked_by_foreign_reference";
      /** 他テナントの行のうち、このテナントの行を（外部キーのいずれかの経路で）参照している件数。 */
      count: number;
    };

/**
 * Issue #201 / [ADR 0318](../../../../docs/decisions/0318-taxonomy-labels.md): taxonomy
 * 語彙1件（`labels` テーブル1行、`docs/memory-model.md` §8）。
 *
 * ⚠ **`attributes`（Issue #152/#153、呼び手専用の別列）とは別物である。** `LabelSummary`
 * が指す「ラベル」は `memories.tags` に語彙の状態（`registered`/`proposed`）を持たせた
 * もの——mnemora 自身が解釈する語彙である。`attributes` は mnemora が解釈しない呼び手
 * 専用の値であり、ラベルの語彙登録の対象にはならない（ADR 0318「決めたこと」参照）。
 */
export interface LabelSummary {
  /** ラベルの名前（`tags` の要素と同じ語彙。正規化せず、完全一致で比べる）。 */
  name: string;
  /** `"registered"` は `registerLabel` で登録した名前、`"proposed"` は記憶の `tags` に現れただけで未登録の名前。 */
  status: "registered" | "proposed";
  /**
   * この名前を `tags` に含む Memory が新規作成された回数の近似値。
   * `listLabels?`/`registerLabel?` の doc コメント参照——正確な現在数の契約ではない。
   */
  proposedCount: number;
  /** `status === 'registered'` のときだけ非 null。 */
  registeredAt: Date | null;
}

/**
 * {@link MemoryStore.reinforce} の省略可能な第4引数
 * ([ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16)。
 *
 * **穴**: `reinforce` にはこれまで活動時計の「いま」を渡す口が無かった。強化すると
 * 壁時計の床（`decay_floor_at`）は引き直されるのに、活動時計の床（`decay_floor_seq`）は
 * 据え置かれたままになる——`decay_clock` が `'activity'` のテナントでは、強化が忘却
 * ゲートに対して完全な no-op になり、`'either'` では壁時計軸だけが戻る非対称になる。
 * これは ADR 0165 の文脈節の表（「起点は両方の時計で同じく『最後の書き込み（作成・
 * 強化）』に置く」）と食い違っていたため、この口を足す。
 *
 * ⭐ **非破壊である**——引数を1つ増やすだけであり、`opts` を省略すればいまと同じ
 * `reinforce(ctx, id, at)` の3引数呼び出しがそのまま動く。既存の3引数の実装
 * （`MemoryStore` を実装する第三者の adapter を含む）も、1行も直さずにこの4引数の
 * interface をそのまま満たす——TypeScript の構造的部分型の下では「呼び出し側が
 * 省略可能な引数を渡さない」ことと「実装がその引数を最初から受け取らない」ことは
 * 区別されない。`@mnemora/core` は npm 公開済みなので、これは ADR 0165 決めたこと13
 * （`TenantSettingsStore` の新メソッドを省略可能にした判断）と同じ理由で選んでいる。
 */
export interface ReinforceOptions {
  /**
   * 強化する時点の活動時計の「いま」（`tenant_activity.activity_seq`）。
   * `ArchiveDecayedOptions.nowSeq` と同じ規律（ADR 0037「時刻は呼び出し側が渡す」）
   * ——**store が自分で `tenant_activity` を読みに行かない。**
   *
   * **省略した場合の契約: 活動時計側の3列（`decayBaseSeq`/`decayFloorSeq`/
   * `halfLifeRecalls`）は据え置く**（本 ADR 以前と同じ挙動）。**黙って `0` として
   * 扱わない**——省略と `0` は別の指示である。壁時計側（`lastReinforcedAt`/
   * `decayFloorAt`）の更新には一切影響しない。
   *
   * 対象の Memory が `halfLifeRecalls` を持たない（`null`/未設定、＝そもそも活動時計では
   * 沈まない Memory）場合は、`nowSeq` を渡しても活動時計側の列には触れない
   * （`Memory.decayBaseSeq` の doc コメント、ADR 0165 決めたこと4「NULL は…緩い側へ倒す」
   * と同じ理由）。
   */
  nowSeq?: number;

  /**
   * [ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)
   * （ADR 0353 の負債1の解消）: `true` のとき、`nowSeq` は**テナントのカウンタ `T` だけ**を
   * 意味し、store は**強化する Memory 自身の `subjectId` の `S_x`**
   * （`tenant_subject_activity.activity_seq`。行が無い・`subjectId` が `null` なら `0`）を
   * **行ごとに**足した `T + S_x` を、その Memory の活動時計の「いま」
   * （`decayBaseSeq` に書く値。`decayFloorSeq` の計算の起点）として使う。
   *
   * 読む側（段1 SQL・`archiveDecayed`・`recall` の段2）は、行ごとに Memory 自身の `S_x` を足して
   * 「有効ないま」を作る（ADR 0353）。書く側が呼び出しの `ctx.subjectId` の `S_x` を
   * 全件に足すと、`ctx.subjectId` と Memory の `subjectId` が違うとき（`tick` の ctx には
   * 通常 `subjectId` が無い。`reinforceMany` は同じ `opts` を全件に適用する）に、読む側の
   * 式と食い違う起点が書かれる。この項目は、その食い違いを store が行ごとに解くことで防ぐ。
   *
   * `nowSeq` が省略されたときは何もしない（`nowSeq` の契約のとおり、活動時計側の列は据え置く）。
   * 省略、または `false` のときは、`nowSeq` をそのまま起点として使う（この項目を足す以前と同じ）。
   *
   * ⭐ **非破壊である**——任意の項目を1つ足すだけ。この項目を知らない adapter は `nowSeq` を
   * 「そのまま起点」として読み続ける。**runtime は、`MemoryStore.supportsAddOwnSubjectSeq?()` が
   * `true` を返す store にだけこの項目を渡す**（宣言が無い store には、今までどおり `T + S_ctx` を
   * フラグなしの `nowSeq` として渡す）。⟹ この項目を読まない adapter は、宣言しなければ今より悪くならない。
   * 宣言する store は、`tenant_subject_activity` に行が無い subject・主題なしの Memory には `S_x = 0`
   * として扱うこと。`tenant_subject_activity` に行が無いテナント（`hasSubjectActivityCounters` が
   * `false`）では `S_x` はどの行でも `0` で結果が同じなので、runtime はこの項目を渡さない。
   */
  addOwnSubjectSeq?: boolean;
}

/**
 * {@link MemoryStore.archiveDecayed} の引数（ADR 0114）。
 *
 * **`now` は呼び出し側が渡す**（ADR 0037 の「時刻は呼び出し側が渡す」規律をここでも
 * 踏襲する——テストで時刻を固定できるようにするため。`packages/core` 内部の
 * `Clock`（`systemClock`/`{ now: () => Date }`）を経由させず、この口の引数として
 * 明示的に要求する）。
 *
 * **`limit` には既定値を置かない**（`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）・
 * `RequeueEmbedJobsOptions.limit`（ADR 0079）と同じ理由——1回の掃引でいくつ処理するかは
 * 運用方針であり、`packages/core` が発明してよい値ではない。この口は範囲走査
 * （`decay_floor_at` の昇順）の打ち切り位置を決めるので、既定値を置くとその影響範囲を
 * core が黙って決めることになる）。
 */
export interface ArchiveDecayedOptions {
  /** この時刻以前に `decay_floor_at` を迎えた Memory を対象にする（`<=`、境界を含む）。 */
  now: Date;
  /** 1回の呼び出しで archived にする上限。**既定値なし**（上の doc コメント参照）。 */
  limit: number;
  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15:
   * 「いまの `activity_seq`」を呼び出し側から受け取る。`now: Date` と同じ規律
   * （ADR 0037「時刻は呼び出し側が渡す」）——**store が自分で `tenant_activity` を
   * 読みに行かない。** `clock` が `'activity'`/`'either'` のときに必須になる（`clock` の
   * doc コメント参照）。
   */
  nowSeq?: number;
  /**
   * ADR 0165 決めたこと1・12・15: どの軸で掃くかを選ぶ。省略時は `'wall'`
   * （本 ADR 以前と1バイトも変わらない挙動）。
   *
   * ⚠ **この既定は `MemoryStore.archiveDecayed` そのものの既定であり、
   * `Runtime.sweepArchive` はこれをそのまま踏襲しない**（Issue #364 /
   * [ADR 0186](../../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * `Runtime.sweepArchive` は `opts.clock` を省略されたとき、ここでの `'wall'` 固定では
   * なく `tenant_settings.decay_clock` を読んでから、この口へ明示的な `clock`/`nowSeq`
   * を渡す。**この口（store 実装）を直接呼ぶ経路にはその解決が乗らない**——`'wall'`
   * 省略時の既定は、あくまで `MemoryStore` 実装を直接叩く場合のものである。
   *
   * - `'wall'`（省略時と同じ）: `decay_floor_at <= now`（現行、境界を含む）。
   * - `'activity'`: `decay_floor_seq IS NOT NULL AND decay_floor_seq <= nowSeq`
   *   （`nowSeq` は必須。境界を含む——`now`/`decay_floor_at` と同じ非対称を seq 側にも
   *   写す。下記「境界の非対称」参照）。
   * - `'either'`: **AND**（両方の軸で沈んでいるものだけ掃く）。
   *
   * **⭐ `'either'` が段1のゲートでは OR（どちらかが生きていれば通す、決めたこと1）なのに、
   * ここでは AND である理由**: ゲートの `'either'` は「どちらかの軸で生きていれば
   * まだ通す」という**寛容**の向きに働く。掃引はその裏返し——「まだ通る」の否定は
   * 「**両方の軸で**死んでいる」でなければならない。ゲートが通すのに掃引が掃く、
   * という矛盾（ある行が段1では返り続けるのに `archiveDecayed` からは消える）を
   * 避けるには、掃引の条件はゲートの条件の**論理否定**と一致していなければならず、
   * `NOT (A OR B) = (NOT A) AND (NOT B)` により AND になる。
   *
   * **境界の非対称（ADR 0165 決めたこと14）**: ゲートは狭義の `>`（境界を含まない）、
   * 掃引は `<=`（境界を含む）——これは `decayFloorAtAfter`/既存の `now` 側で既に
   * 意図的だと明記されている非対称であり（上の `now` の doc コメント、
   * `VectorFilter.decayFloorAtAfter` の doc コメント参照）、`decay_floor_seq` 側にも
   * そのまま写す。片方だけ `>=` にする実装ミスは、境界1件のズレとして歯に出ないまま
   * 紛れ込みうる——`packages/testkit` の適合テストが境界の歯を seq 側にも同じ形で置く。
   */
  clock?: DecayClock;
  /**
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `true` のときだけ、`nowSeq`（`T`）に、行の subject に対応する
   * `tenant_subject_activity` の値（`S_x`）を足した値と比較する——段1の
   * `VectorFilter.decayFloorSeqUsesSubjectCounters` と同じ意味・同じ最適化理由
   * （既定/未使用のテナントでは相関サブクエリを足さない）。既定 `false`。
   */
  usesSubjectActivityCounters?: boolean;
}

/** {@link MemoryStore.archiveDecayed} の返り値（ADR 0114）。 */
export interface ArchiveDecayedResult {
  /**
   * 実際に archived にした Memory。`decay_floor_at` 昇順（最も古く遠ざかったもの順）。
   * ⚠ `opts.clock` が `'activity'`/`'either'` のときも同じ——`decay_floor_seq` 順の契約は
   * 無い（この型が `decayFloorSeq` を持たないことがその宣言。`archiveDecayed` の
   * 契約節、doc コメント参照）。
   */
  archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }>;
  /**
   * 🔴 **`true` は「`limit` 件ちょうど返した＝まだ在るかもしれない」を意味する。**
   * `archived.length === opts.limit` のときに `true`——`decay_floor_at <= now` を満たす
   * `active` な Memory が、まだこの呼び出しの範囲の外に残っている可能性がある
   * （`countKind` の `'unknown'`/`'lower_bound'` と同じ理由づけ。`docs/recall.md` §4
   * 「推定値を実測値の顔で出さない」）。
   *
   * ⚠ **「残り何件か」は返さない。**数えるには対象全体を数える別のクエリが要り、
   * この掃引を「範囲走査のみで安価に済ませる」という設計（`docs/memory-model.md` §11
   * 「アーカイブ掃引…は…全件走査ではなく `decay_floor_at` の範囲走査」）そのものと
   * 衝突する。「もう無い」（`false`）と「分からない」（`true`）を区別するところまでが
   * この口の契約であり、`ann_truncated`/`ann_unreached`（`docs/recall.md` §4）が
   * 守っている規律と同じ形である。
   */
  reachedLimit: boolean;
}

/**
 * {@link MemoryStore.purgeExpiredEvents} の引数（Issue #210、ADR 0115）。
 */
export interface PurgeExpiredEventsOptions {
  /** この日時より古い（`at < olderThan`）行だけが対象。境界値の `at === olderThan` は対象外。 */
  olderThan: Date;
  /**
   * 1回の呼び出しで削除する上限。**必須・既定値なし**
   * （`ClaimOutboxJobsOptions.leaseMs` と同じ理由。上の interface doc 参照）。
   *
   * **0以上の整数を渡す前提である。負数を渡したときの結果は未定義——実装ごとに違う**
   * （[Issue #876](https://github.com/takecchi/mnemora/issues/876)、クローン miku:
   * 挙動を変えず、負数を「受け付けない値」として明記し、結果を実装依存のまま残す判断）。
   *
   * **今の実装の挙動**（2026-09-26 実測、PostgreSQL 17.11 + pgvector 0.8.0、
   * `main` cb6d1db）:
   *
   * | 実装 | `limit: -1` | `limit <= -2` |
   * |---|---|---|
   * | `PostgresMemoryStore`（`packages/postgres`） | 例外にならず `{ purged: 0, reachedLimit: true }` を返す——`buildPurgeExpiredEventsTargetSelect` の `LIMIT ${opts.limit + 1}` が `LIMIT 0` になる**算術上の偶然**であり、狙って設計した契約ではない | 例外（`LIMIT` に負数は渡せない） |
   * | `InMemoryMemoryStore`（`@mnemora/testkit`）／`FakeMemoryStore`（`@mnemora/core`） | 例外（`purgeExpiredEvents: limit must not be negative`） | 例外（同上） |
   *
   * **どちらの実装でも「誤って削除する」ことは起きない**——Postgres は0件、Fake 側は
   * 例外。ただし `-1` の結果そのもの（例外か `purged: 0` か）は実装間で分かれたままであり、
   * **この分岐を揃える予定は無い**——揃える2案（Fake を Postgres の `-1` に合わせる／
   * Postgres の全負数を0件に倒す）を採らなかった理由は
   * [ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md) の2026-09-26追記を参照。
   */
  limit: number;
  /**
   * `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。
   * 省略時は `false`（`runtime.ts` の `ConsolidateOptions.dryRun`/`ReflectOptions.dryRun`
   * と同じ既定）。
   */
  dryRun?: boolean;
}

/** {@link MemoryStore.purgeExpiredRecalls} の引数（ADR 0404）。 */
export interface PurgeExpiredRecallsOptions {
  /** この日時より古い（`created_at < olderThan`）recall だけが対象。境界値は対象外。**既定値なし。** */
  olderThan: Date;
  /** 1回の呼び出しで消す `recalls` の行数の上限。**必須・既定値なし。**0以上の整数を渡す前提（負数の結果は未定義）。 */
  limit: number;
  /** `true` なら何も消さず、消していたら何が起きたかだけを返す。省略時 `false`。 */
  dryRun?: boolean;
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

/** {@link MemoryStore.purgeExpiredEvents} の返り値（Issue #210、ADR 0115）。 */
export interface PurgeExpiredEventsResult {
  /**
   * 実際に削除された行数。`opts.dryRun === true` のときは、削除していたら消えていた
   * であろう件数（プレビュー）——1行も削除していない。
   */
  purged: number;
  /**
   * 対象が `opts.limit` より多かった（＝この呼び出しだけでは消しきれなかった）ことを示す。
   * `purged === opts.limit` からの推測に頼らせないための専用の信号
   * （interface doc の契約節参照）。
   */
  reachedLimit: boolean;
  /** 削除された（またはプレビューで数えられた）行のうち最も古い `at`。`purged === 0` なら `null`。 */
  oldestPurgedAt: Date | null;
  /** 削除された（またはプレビューで数えられた）行のうち最も新しい `at`。`purged === 0` なら `null`。 */
  newestPurgedAt: Date | null;
  /** `opts.dryRun` の写し。呼び出し側が結果だけを見て「本当に消えたか」を取り違えないため。 */
  dryRun: boolean;
}

/**
 * {@link MemoryStore.purgeExpiredEventsByRetention} の引数（Issue #1232、
 * [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）。
 *
 * {@link PurgeExpiredEventsOptions} と違い `olderThan` を持たない——cutoff は
 * このメソッドの内部で、保持期間を読んだ直後に `opts.now` から計算する
 * （呼び出し側が計算して渡すと、計算した時点と実際に読む時点がずれ、Issue #1232 の
 * race が形を変えて残る）。
 */
export interface PurgeExpiredEventsByRetentionOptions {
  /**
   * 「いま」を何とするか。**必須・既定値なし**——`PurgeExpiredEventsForTenantOptions.now`
   * と同じ理由（テストが決定的な cutoff を固定できるようにする。呼び出し元の
   * `purgeExpiredEventsForTenant` は省略時に `new Date()` を補ってから渡す）。
   */
  now: Date;
  /**
   * 1回の呼び出しで削除する上限。**必須・既定値なし**——{@link PurgeExpiredEventsOptions.limit}
   * と同じ理由（取り消せない削除の上限を `packages/core` が勝手に決めない）。
   */
  limit: number;
  /**
   * `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。省略時は `false`。
   * 保持期間の読みは `dryRun` の値によらず同じ原子性で行う（下の interface doc 参照）。
   */
  dryRun?: boolean;
}

/**
 * {@link MemoryStore.purgeExpiredEventsByRetention} の戻り値（Issue #1232、ADR 0354）。
 * `PurgeExpiredEventsForTenantOutcome`（`packages/core/src/event-retention-purge.ts`）の
 * `store_unsupported` を除いた3種——`store_unsupported` は「この口が無い」ことそのものであり、
 * この口の内側からは返せない。
 */
export type PurgeExpiredEventsByRetentionOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };

/**
 * {@link MemoryStore.requeueEmbedJobs} の引数（ADR 0079）。
 *
 * **`statuses` にも `limit` にも既定値を置かない。**`ClaimOutboxJobsOptions.leaseMs`
 * （ADR 0032）と同じ理由である——「どの `not_indexed` を積み直すか」「一度にいくつ
 * 積み直すか」は運用方針であり、`packages/core` が発明してよい値ではない。この口は
 * 1回の呼び出しで `memories` と `outbox` の両方へ書くので、既定値を置くとその影響範囲を
 * core が黙って決めることになる。
 */
export interface RequeueEmbedJobsOptions {
  /**
   * 対象にする現在の `embeddingStatus`。
   *
   * **型が `NotIndexedReason` なのは意図である**——`recall` が
   * `{ kind: 'not_indexed', reason }` として名乗った値を、そのままここへ渡せる。
   * 「見えているもの」と「積み直せるもの」を同じ語彙に固定する。
   *
   * ⚠ **`'pending'` も指定できる。**「待てば解ける」はずの `pending` に、
   * **待っても解けない行が混ざりうる**ためである: `runtime.tick` の `processEmbedJob` は
   * `memoryStore.get` を `try` の外で呼んでおり、また `catch` の中の
   * `setEmbeddingStatus(..., 'failed')` 自体も例外を投げうる。どちらを通っても
   * outbox 行だけが終端（`failed_at`）になり、Memory は `pending` のまま残る——
   * その行は `recall` が `notIndexed.pending`（＝「待て」）として数え続ける。
   * **⚠ これは構造から読める「起こりうる」であって、発生を観測したものではない**
   * （ADR 0079「確かめていないこと」）。
   */
  statuses: NotIndexedReason[];
  /** 対象をこの id の集合との積に絞る（任意）。省略時は `statuses` の条件だけで選ぶ。 */
  memoryIds?: MemoryId[];
  /** 1回の呼び出しで積み直す上限。**既定値なし**（上の doc コメント参照）。 */
  limit: number;
}

/** {@link MemoryStore.requeueEmbedJobs} の返り値（ADR 0079）。 */
export interface RequeueEmbedJobsResult {
  /** 実際に積み直した件数。`memoryIds.length` と必ず一致する。 */
  requeued: number;
  /** 積み直した Memory の id。`opts.limit` で切られた後の集合。 */
  memoryIds: MemoryId[];
}
