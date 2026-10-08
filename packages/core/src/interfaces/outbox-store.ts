import type { Ctx } from "../ctx.js";
import { matchesStoreErrorKind } from "../store-error-kind.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { EraseTenantStoreOptions, EraseTenantResult } from "./memory-store.js";
import type { OutboxJobKind } from "./scheduler.js";

/**
 * OutboxStore（docs/architecture.md §3.4・ADR 0005 の transactional outbox パターンの「運搬役」側）。
 * `runtime.tick(ctx, opts)` がこの interface を使い、未処理行を claim して処理し、完了/失敗を記録する。
 *
 * 契約:
 * - `claimBatch` は同時に複数のワーカーから呼ばれても同じジョブを二重に claim してはならない。
 * - `claimBatch` が返すジョブは `completed_at IS NULL AND failed_at IS NULL` かつ `available_at <= now` のものに限る。
 * - 🔴 **claim のリース（ADR 0032）**: `claimBatch` は、一度も claim されていない行に加えて、**`claimed_at` が
 *   `opts.leaseMs` 以上前**（`claimed_at <= opts.now - opts.leaseMs`）の行も返す。
 *   **これにより処理は at-least-once になる**——リースが切れる前に処理が完了しなかったジョブは再び claim され、
 *   **同じジョブが複数回処理されうる**。呼び出し側は冪等な形で書くこと。
 *   ⚠ **`extract` のジョブは、逐次の再配達では2回目が何も書かない**（ADR 0347）。`processExtractJob` は LLM を呼ぶ前に、
 *   その Observation から今の抽出器の版で作られた Memory（status を問わない）が在るかを見て、在れば抽出を済んだものとして
 *   ジョブを完了にする。
 *   - 塞げないもの: **並行の2本**（どちらも書く前にこの確認を通る）。
 *   - 引き換え: **1回目が候補の一部だけを書いて止まった場合、残りの候補は作られない。** `Runtime.reextract` で回復する
 *     （`reextract` はこの確認を通らない）。
 *   - 旧い版の Memory しか無い Observation は、新しい版で抽出する。
 *
 *   `reflect` は再配達で2件になる（`Runtime.reflect` の doc）。`embed`・`consolidate` は1回だけ処理したときと同じ状態になる。
 *   **`leaseMs` に既定値は無く、省略できない**——リース長は運用方針で、呼び出し側が決める（ADR 0032）。
 * - 🔴 **`complete` / `fail` は compare-and-swap である（ADR 0142）。** `expectedAttempts` に、呼び出し側が自分の
 *   `claimBatch`（または `createObservationWithOutbox` 等の生成経路）から受け取った `OutboxJobRecord.attempts` の値を渡す。
 *   adapter は `attempts` がその値と一致する行だけを更新し、一致しなければ {@link OutboxLeaseConflictError} を投げる。
 *   リース切れ後に別のワーカーが再 claim すると `attempts` が進むため、古いワーカーが遅れて `complete`/`fail` を呼んでも、
 *   新しいワーカーが書いた終端状態を上書きできない。**省略不可・既定値なし。**
 * - **対象の行が存在しない（または id の形式が不正な）場合は、`expectedAttempts` の値に関わらず例外を投げない。**
 *   **行が存在するが `attempts` が一致しない場合にのみ** {@link OutboxLeaseConflictError} を投げる。
 *   行が存在し `attempts` が一致する場合は、対象が既に完了/失敗していても例外を投げない。
 * - 🔴 **`complete`/`fail` は互いに排他でもある。** `attempts` が一致していても、相手側の終端が既に付いていれば、
 *   先に付いた終端が勝つ——行を変えず、例外も投げない（無言の no-op）。
 * - 🔴 **終端は先勝ちである（ADR 0440）。** 同じ claim で同種（`complete` → `complete`、`fail` → `fail`）が再び呼ばれても、
 *   1回目の `completedAt`／`failedAt`・`lastError` を保つ（2回目の `at`・`error` は捨てる）。戻り値と例外は変わらない。
 * - ⚠ **`attempts` は claim のたびに1増え、上限は無い。** 終端に達しないまま止まり続ける job は、リースが切れるたびに
 *   claim され続ける。`attempts` はフェンシングにだけ使い、再試行の上限には使わない。`attempts` が N を超えたら `fail` にする、
 *   のような上限での終端は入れていない（ADR 0032）。
 *   ⚠ **止まり続ける job が `limit` 本以上あっても、後ろの job は飢えない**（ADR 0357）。`claimBatch` は、リースが切れた行を
 *   **取り直す**ときに限り、`available_at` を `opts.now` へ書き直す。**初めての claim** では `available_at` を変えない。
 * - ⚠ **取る集合は `available_at` の古い順だが、同じ `available_at` の行どうしの並びと、1回の `claimBatch` が返す配列の中の順
 *   （`tick` はこの順に処理する）は約束しない。**
 * - 失敗したジョブの自動リトライは行わない（`fail` は終端状態。リースが切れたジョブの再 claim とは別の話）。
 */
export interface ClaimOutboxJobsOptions {
  /** この種別のジョブだけを取る。省略なら種別で絞らない。 */
  kinds?: OutboxJobKind[] | undefined;
  /** 1回に取る上限の本数。0以上の整数を渡す前提。負数・非整数・`bigint` に収まらない値の結果は、約束の上では未定義。testkit の fixture は何も claim せずに `Error` を投げる。`@mnemora/postgres` は多くの場合 Postgres が `LIMIT` を拒むが、実行計画によっては拒まずに0件を返す（#1687 の実測）。 */
  limit: number;
  /** 「今」の時刻。`available_at <= now` とリースの切れ目の判定に使う。 */
  now: Date;
  /**
   * claim した worker の名前（行の `claimed_by` に書く）。
   *
   * ⚠ **空文字も受け付ける**（検査しない）。そのとき返るジョブの `claimedBy` は `""` になり、
   * `OutboxJobRecordSchema`（`claimedBy` は `min(1)`）を通らない。
   */
  claimedBy: string;
  /**
   * claim のリース長（ミリ秒）。`claimed_at` からこの時間が経過した行は、まだ終端が付いていなくても
   * 「止まったワーカーのジョブ」として再び claim される（ADR 0032）。**必須・既定値なし。**
   */
  leaseMs: number;
}

/**
 * `OutboxStore.complete`/`fail` が CAS で弾いたときに投げる例外（ADR 0142）。
 *
 * `observedAttempts` は**弾かれた後に読み直した値であり、弾かれた瞬間の値とは限らない**（ADR 0030 の
 * `MemoryStatusConflictError` と同じ限界）。`null` は、行が見つからなかったことを表しうる型としてだけ残してある
 * （行が見つからない場合は例外を投げず、べき等な no-op として扱う——上の契約）。
 */
export class OutboxLeaseConflictError extends Error {
  /** 判別子。クラスが2つの版に分かれても読める値（ADR 0418）。分岐は `instanceof` ではなく {@link isOutboxLeaseConflictError} で行う。 */
  readonly kind = "outbox_lease_conflict" as const;
  constructor(
    readonly jobId: string,
    readonly expectedAttempts: number,
    readonly observedAttempts: number | null,
  ) {
    super(
      `OutboxStore: expected attempts ${expectedAttempts} for job ${jobId}, but observed ` +
        `${observedAttempts === null ? "(job disappeared)" : observedAttempts}`,
    );
    this.name = "OutboxLeaseConflictError";
  }
}

/**
 * 受け取ったものが {@link OutboxLeaseConflictError} かを、**`instanceof` を使わずに**判定する（ADR 0418）。
 * `kind` を見て、無ければ `name` を見る。
 */
export function isOutboxLeaseConflictError(value: unknown): value is OutboxLeaseConflictError {
  return matchesStoreErrorKind(value, "outbox_lease_conflict", "OutboxLeaseConflictError");
}

/** outbox の未処理のジョブを claim し、完了・失敗を記録する口。契約は {@link ClaimOutboxJobsOptions} の直前の doc を見ること。 */
export interface OutboxStore {
  /**
   * 未処理（終端が付いていない）で `available_at <= opts.now` のジョブのうち、未 claim かリースが切れたものを、`available_at` の古い順に `opts.limit` 本まで取る。取るたびに `attempts` を1増やす。
   */
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  /**
   * ジョブを完了にする。`expectedAttempts` が行の `attempts` と違えば {@link OutboxLeaseConflictError}。行が無いときと、`attempts` が一致していれば終端済みでも、例外にしない。**終端済みの行への呼び出しは、行を変えない（先勝ち、ADR 0440）。**
   *
   * ⚠ 既に終端が付いた行でも、行の `attempts` と違う `expectedAttempts` を渡せば {@link OutboxLeaseConflictError} を投げる。`fail` も同じ。
   *
   * UUID 形式の `jobId` は大文字小文字を区別しない——大文字で渡しても同じジョブに当たる（CAS・先勝ちも同じ行に対して働く）。
   * UUID 形式でない `jobId` の大文字小文字の扱いは約束しない。`fail` も同じ。
   *
   * **`opts.at` を渡すと `completedAt` にその値を使う。省略時は実装が壁時計を使う。** runtime はこの欄に `clock.now()` を渡す（ADR 0355）。
   *
   * **`opts.at` が Invalid Date なら例外を投げ、行には触れない。検査は `jobId` の形・行の有無より先**——形の崩れた・存在しない `jobId` でも、`opts.at` が Invalid Date なら例外にする（ADR 0594）。**`opts.at` が `timestamptz` の下限（`Date.UTC(-4713, 10, 24)`）より前なら、同じく `jobId` の形・行の有無より先に `RangeError` を投げ、行には触れない**（下限ちょうどは書ける。ADR 0597）。渡された `Date` は複製して持つ。`fail` も同じ。
   */
  complete(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void>;
  /**
   * ジョブを失敗（終端）にし、`error` を記録する。自動の再試行はしない。CAS と冪等の扱いは `complete` と同じ（終端済みの行には、`failedAt`・`lastError` を含めて何も書かない。先勝ち、ADR 0440）。`jobId` の大文字小文字の扱いも `complete` と同じ。
   *
   * **`opts.at` を渡すと `failedAt` にその値を使う。省略時は実装が壁時計を使う。** ⚠ **`available_at` の再計算はしない。**
   *
   * **`error` に NUL（U+0000）が含まれていてもよい**——実装は目に見える6文字の `\u0000` に置き換えて `lastError` に残す（`@mnemora/postgres`・`@mnemora/testkit/fixtures` とも）。
   */
  fail(
    ctx: Ctx,
    jobId: string,
    error: string,
    expectedAttempts: number,
    opts?: { at?: Date | undefined },
  ): Promise<void>;
  /**
   * `ctx.tenantId` に属する `outbox` の行を跡形なく消す（ADR 0383）。`eraseTenant`（`erase-tenant.ts`）が束ねて呼ぶ口の1つ。
   *
   * 🔴 **任意メソッドである。** 理由は `VectorStore.eraseTenant?` と同じ（`MemoryStore.eraseTenant` の doc 参照）。
   * 対応していない adapter は `eraseTenant`（独立関数）の `{ kind: "store_unsupported" }` で名指しされる。
   *
   * **契約**:
   * - 完了・失敗・未処理を問わず、`ctx.tenantId` の行を `opts.limit` を目安に削除する。
   * - `opts.dryRun === true` のときは削除を一切行わず、削除していたら消えていたであろう件数だけを返す。
   * - `result.reachedLimit === true` なら、呼び出し側は同じ `opts` で呼び直すこと。何度呼んでも安全。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult>;
  /**
   * **完了した**ジョブ（`completed_at IS NOT NULL AND completed_at < opts.olderThan`）だけを消す（ADR 0404）。
   *
   * 🔴 **任意メソッドである。** 理由は `eraseTenant?` と同じ。
   *
   * 契約:
   * - **`opts.olderThan` は必須・既定の保持期間を持たない。**
   * - **完了していない行は決して消さない**——claim 中（リース内でもリース切れでも）・未処理・`failed_at` が付いた行は、
   *   どれだけ古くても対象外。**`failed` は完了ではない。**
   * - 境界は `completed_at < olderThan`（`completed_at === olderThan` は対象外）。並びは `completed_at` 昇順。
   * - `opts.limit` は必須・既定値なし。対象が `limit` を超えれば `reachedLimit: true`。
   * - `opts.dryRun === true` は1行も消さず、消していたら何が起きたかを返す。
   * - 他テナントの行には触れない。
   */
  purgeCompletedJobs?(ctx: Ctx, opts: PurgeCompletedJobsOptions): Promise<PurgeCompletedJobsResult>;
}

/** {@link OutboxStore.purgeCompletedJobs} の引数（ADR 0404）。 */
export interface PurgeCompletedJobsOptions {
  /** この日時より前に完了した（`completed_at < olderThan`）ジョブだけが対象。境界値は対象外。**既定値なし。** */
  olderThan: Date;
  /** 1回の呼び出しで消す行数の上限。**必須・既定値なし。**0以上の整数を渡す前提。負数・非整数の結果は、約束の上では未定義。testkit の fixture は `Error` を投げる。`@mnemora/postgres` は `LIMIT limit + 1` で渡すので `-1` は0件になり、それより小さい値は多くの場合 Postgres が拒むが、実行計画によっては拒まずに0件を返す（#1687 の実測）。 */
  limit: number;
  /** `true` なら何も消さず、消していたら何が起きたかだけを返す。省略時 `false`。 */
  dryRun?: boolean | undefined;
}

/** {@link OutboxStore.purgeCompletedJobs} の返り値（ADR 0404）。 */
export interface PurgeCompletedJobsResult {
  /** 消した行数（`dryRun` のときは消していたであろう行数）。 */
  purged: number;
  /** 対象が `opts.limit` より多かった（この呼び出しだけでは消しきれなかった）ことを示す専用の信号。 */
  reachedLimit: boolean;
  /** 消した行のうち最も古い `completedAt`。`purged === 0` なら `null`。 */
  oldestPurgedAt: Date | null;
  /** 消した行のうち最も新しい `completedAt`。`purged === 0` なら `null`。 */
  newestPurgedAt: Date | null;
  /** `opts.dryRun` の写し。 */
  dryRun: boolean;
}
