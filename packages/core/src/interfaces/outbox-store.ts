import type { Ctx } from "../ctx.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { OutboxJobKind } from "./scheduler.js";

/**
 * OutboxStore — Phase 1（本 PR で追加。docs/architecture.md §3.4・ADR 0005 の
 * transactional outbox パターンの「運搬役」側）。
 *
 * `MemoryStore.createObservationWithOutbox` / `createMemoryWithOutbox` が
 * Observation/Memory の作成と同一トランザクションで `outbox` へジョブを書く一方、
 * `OutboxStore` はその後の「未処理行を claim して処理し、完了/失敗を記録する」側を担う。
 * `runtime.tick(ctx, opts)`（docs/architecture.md §3.3）がこの interface を使う。
 *
 * 契約:
 * - `claimBatch` は同時に複数のワーカーから呼ばれても同じジョブを二重に claim してはならない
 *   （adapter 実装は `SELECT ... FOR UPDATE SKIP LOCKED` 相当で保証する）。
 * - `claimBatch` が返すジョブは `completed_at IS NULL AND failed_at IS NULL` かつ
 *   `available_at <= now` のものに限る。
 * - 🔴 **claim のリース（ADR 0032）**: `claimBatch` は、`claimed_at IS NULL`（一度も
 *   claim されていない）の行に加えて、**`claimed_at` が `opts.leaseMs` 以上前**
 *   （`claimed_at <= opts.now - opts.leaseMs`）の行も返す。`FOR UPDATE SKIP LOCKED`
 *   が保証する行ロックは同一 SQL 文の実行中しか保持されない——claim した文がコミットした
 *   瞬間にロックは解放される。それにもかかわらず一度 claim した行を `claimed_at IS NULL`
 *   だけで再取得不能にすると、claim 後に処理が完了しないまま止まったワーカー
 *   （クラッシュ・ハング）のジョブが `completed_at`/`failed_at` のどちらも付かないまま
 *   **二度と claim されず、どこからも見えなくなる**。リースは、この「見えない停止」を
 *   避けるための時間切れの仕組みである。
 *   **これにより処理は at-least-once になる**——リースが切れる前に処理が完了しなかった
 *   ジョブは、別のワーカー（または同じワーカー）に再び claim され、**同じジョブが
 *   複数回処理されうる**。呼び出し側（`processExtractJob`/`processEmbedJob` 等）は
 *   この重複を前提にしてよい形（冪等）で書くこと。
 *   **下の「Phase 1 では失敗したジョブの自動リトライを行わない」とは別の話**——
 *   あちらは `fail()` で終端状態になった（＝処理を試みて失敗が確定した）ジョブの話、
 *   こちらは終端状態に達しないまま止まったジョブを回収する話である。
 *   **`leaseMs` に既定値は無く、省略できない**——リース長は「何をもって処理が
 *   止まったとみなすか」という運用方針であり、この interface（`packages/core`）が
 *   決めてよい値ではなく、呼び出し側（`runtime.tick` の呼び出し元）が決める
 *   （「採らなかった案」は ADR 0032 参照）。
 * - 🔴 **`complete` / `fail` は compare-and-swap である（ADR 0142、Issue #233）。**
 *   `expectedAttempts` に、呼び出し側が自分の `claimBatch`（または `createObservationWithOutbox`
 *   等の生成経路）から受け取った、まさにその `OutboxJobRecord.attempts` の値を渡す。
 *   adapter は `attempts` がその値と一致する行だけを更新し、一致しなければ
 *   {@link OutboxLeaseConflictError} を投げる。
 *
 *   **理由**: `attempts` は `claimBatch` が claim のたびに厳密に単調増加させる列であり
 *   （ADR 0032）、かつ一度 `completed_at`/`failed_at` が付いた行は `claimBatch` の
 *   `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）から二度と対象にならないため、
 *   終端化された行の `attempts` はその後永久に固定される。**この2つの性質を合わせると、
 *   「自分が claim した瞬間の `attempts`」は、他の誰にも奪われていない自分のリースを
 *   指すフェンシングトークンとして機能する。** リース切れ後に別のワーカーが同じジョブを
 *   再 claim すると `attempts` が進むため、古いワーカーが遅れて `complete`/`fail` を
 *   呼んでも「奪われる前の自分の値」はもう一致せず、**新しいワーカーが書いた終端状態を
 *   黙って上書きできない**。
 *
 *   **省略不可・既定値なし**——ADR 0032 が `leaseMs` に既定値を持たせなかった理由
 *   （寛容な既定は「今日の壊れ方」を裏から実装し直すだけになる）が、ここでも同じ形で効く。
 *   呼び出し側は必ず、直前に自分が受け取った `OutboxJobRecord.attempts` を渡すこと。
 * - **対象の行が存在しない（または id の形式が不正な）場合は、`expectedAttempts` の値に
 *   関わらず例外を投げない**（べき等な終端更新、既存の契約を維持）。**行が存在するが
 *   `attempts` が一致しない場合にのみ** {@link OutboxLeaseConflictError} を投げる。
 *   行が存在し `attempts` が一致する場合は、対象が既に完了/失敗していても例外を投げない
 *   （同じ worker が同じ claim に対して `complete`/`fail` を再度呼ぶことは冪等）。
 * - 🔴 **`complete`/`fail` は互いに排他でもある（Issue #826）。** `attempts` が一致して
 *   いても、相手側の終端（`fail` から見た `completedAt`、`complete` から見た
 *   `failedAt`）が既に付いていれば、先に付いた終端が勝つ——行を変えず、例外も投げない
 *   （無言の no-op）。同じ claim（同じ `attempts`）のまま complete と fail の両方が
 *   呼ばれても、両方の終端が同時に付くことはない。
 * - ⚠ **`attempts` は claim のたびに1増え、上限は無い**（今の振る舞い）。終端に達しないまま
 *   止まり続ける job（毎回ワーカーを止めてしまう job など）は、リースが切れるたびに claim され
 *   続ける。`attempts` はフェンシングにだけ使い、再試行の上限には使っていない
 *   （ADR 0032「これが覆るとしたら」が `attempts` の活用を範囲外として残している）。
 *   ⚠ **2026-09-27 追記（今の振る舞いを書いたもの）: そうした job は古い順の先頭に並び続け、後ろを
 *   止めうる。** `claimBatch` は `available_at` の古い順に `limit` 本を取るので、止まり続ける job が
 *   `limit` 本以上あると、リースが切れるたびに**同じ job だけが取られ、後ろの job に届かない**
 *   （先頭詰まり）。後ろに届くのは、別の `tick` がリースの内に続けて取ったとき（止まった job は
 *   まだ claim 中なので飛ばされる）だけである。【実測 2026-09-27】`@mnemora/postgres` と testkit の
 *   fixture で同じ（歯は `packages/postgres/src/__tests__/outbox-head-of-line.postgres.test.ts`）。
 *   止まり続ける job を後回しにする・隔離する・上限で終端にする、はしていない（新しい方針、
 *   [Issue #1196](https://github.com/takecchi/mnemora/issues/1196)）。
 * - ⚠ **2026-09-27 追記（今の振る舞いを書いたもの）: 取る集合は `available_at` の古い順だが、同じ
 *   `available_at` の行どうしの並びと、1回の `claimBatch` が返す配列の中の順（`tick` はこの順に
 *   処理する）は約束しない。** `@mnemora/postgres` は `ORDER BY available_at` だけで取り、
 *   `UPDATE … RETURNING` の順で返す（SQL はこの順を保証しない）。testkit の fixture は古い順に
 *   並べて返す（同じ時刻なら積んだ順）。【実測 2026-09-27】20本の範囲では両方とも積んだ順・古い順に
 *   返ったが、それは約束ではない。
 * - Phase 1 では失敗したジョブの自動リトライを行わない（`fail` は終端状態。本 PR の決定、
 *   PR 本文に記載）。
 */
export interface ClaimOutboxJobsOptions {
  /** この種別のジョブだけを取る。省略なら種別で絞らない。 */
  kinds?: OutboxJobKind[];
  /** 1回に取る上限の本数。 */
  limit: number;
  /** 「今」の時刻。`available_at <= now` とリースの切れ目の判定に使う。 */
  now: Date;
  /** claim した worker の名前（行の `claimed_by` に書く）。 */
  claimedBy: string;
  /**
   * claim のリース長（ミリ秒）。`claimed_at` からこの時間が経過した行は、まだ
   * `completed_at`/`failed_at` が付いていなくても「止まったワーカーのジョブ」として
   * 再び claim される（ADR 0032）。**必須・既定値なし**——呼び出し側が方針を決めること。
   */
  leaseMs: number;
}

/**
 * [ADR 0142](../../../../docs/decisions/0142-outbox-complete-fail-compare-and-swap.md)
 * — `OutboxStore.complete`/`fail` が CAS で弾いたときに投げる例外。
 *
 * `observedAttempts` は**弾かれた後に読み直した値であり、弾かれた瞬間の値とは限らない**
 * ——ADR 0030 の `MemoryStatusConflictError` と同じ限界（adapter は `UPDATE ... WHERE
 * attempts = expectedAttempts` が0行だったときに追加の `SELECT` で読み直すため、その
 * `SELECT` と実際に条件が破れた瞬間の間にも別の claim が割り込む余地がある）。
 * `observedAttempts` が `null` になるのは、読み直した時点でも行そのものは見つかった
 * ケースしか無いため、理論上は起きない
 * （行が見つからない場合はそもそも例外を投げず、べき等な no-op として扱う——上記契約参照）。
 * それでも adapter 間の実装差に備え、型は `number | null` のままにする。
 */
export class OutboxLeaseConflictError extends Error {
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

/** outbox の未処理のジョブを claim し、完了・失敗を記録する口。契約（重複 claim の禁止・リース・CAS）は、このファイルの冒頭の doc を見ること。 */
export interface OutboxStore {
  /**
   * 未処理（終端が付いていない）で `available_at <= opts.now` のジョブのうち、未 claim かリースが切れたものを、`available_at` の古い順に `opts.limit` 本まで取る。取るたびに `attempts` を1増やす。
   */
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  /**
   * ジョブを完了にする。`expectedAttempts` が行の `attempts` と違えば {@link OutboxLeaseConflictError}。行が無いときと、`attempts` が一致していれば終端済みでも、例外にしない（冒頭の doc）。
   *
   * ⚠ 既に終端が付いた行でも、行の `attempts` と違う `expectedAttempts` を渡せば {@link OutboxLeaseConflictError} を投げる——終端が付いていることは、`attempts` の検査を外す理由にならない（Issue #1292 で冒頭の doc と実装の側を正と決めた。2実装 `@mnemora/postgres`・`@mnemora/testkit/fixtures` とも、この形で動く）。`fail` も同じ。
   */
  complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void>;
  /** ジョブを失敗（終端）にし、`error` を記録する。自動の再試行はしない。CAS と冪等の扱いは `complete` と同じ。 */
  fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void>;
}
