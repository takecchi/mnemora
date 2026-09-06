import type { Ctx } from "../ctx.js";

/**
 * `tenant_settings.default_half_life_hours` の DB 側デフォルト（720時間 = 30日、
 * docs/memory-model.md §10 の DDL `DEFAULT 720`）と一致させる、テナント設定行が
 * 存在しない場合のフォールバック値。adapter 実装（`packages/postgres`）・
 * `packages/testkit` の in-memory 実装の両方がこの定数を使う。
 */
export const DEFAULT_HALF_LIFE_HOURS = 720;

/**
 * `tenant_settings.event_retention_days` が取りうる3つの状態（`docs/memory-model.md`
 * §9「保持方針」）。
 *
 * ⚠ この3つを2つに潰さないこと（`ADR 0029` が `not_examined`（見ていない）と
 * `unchanged`（見たが変えなかった）を分けたのと同じ形）:
 *
 * - `unset`: `tenant_settings` に行が無い（まだ設定していない。既定は無期限として動く）。
 * - `unlimited`: 行は在るが `event_retention_days` が `NULL`（**明示的に**無期限と決めた）。
 * - `days`: 行が在り、`event_retention_days` に具体的な日数が入っている。
 *
 * `unset` と `unlimited` は「結果として無期限として振る舞う」点では同じだが、
 * 「テナントが一度も触っていない」ことと「テナントが無期限を選んだ」ことは別の事実であり、
 * `getEventRetention` の呼び出し側（将来の運用ジョブ・管理画面）がこの2つを区別できないと、
 * 「まだ何も設定していないテナントの一覧」が作れなくなる。
 */
export type EventRetention =
  { kind: "unset" } | { kind: "unlimited" } | { kind: "days"; days: number };

/**
 * `setEventRetention` に渡せる値。`unset`（行が無い状態）は*観測される*状態であって、
 * *設定できる*値ではない——「行を無かったことにする」という削除操作を、この interface は
 * 提供しない（`docs/memory-model.md` §9 の削除方針の対象外。下記 doc 参照）。
 */
export type EventRetentionSetting = Exclude<EventRetention, { kind: "unset" }>;

/**
 * `setEventRetention` に不正な `days`（正の整数でない値）を渡したときに両実装が投げる
 * `Error` のメッセージに必ず含める文字列。適合スイート
 * （`packages/testkit/src/tenant-settings-store-conformance.ts`）が、`TypeError` のような
 * 別種の失敗と区別するためにこの文字列を正規表現で固定する
 * （`packages/testkit/src/memory-store-conformance.ts` の `NOT_FOUND_ERROR_MESSAGE` と同じ形）。
 */
export const EVENT_RETENTION_DAYS_INVALID_MESSAGE =
  "event retention days must be a positive integer";

/**
 * `days` が正の整数であることを検査する。不正なら `EVENT_RETENTION_DAYS_INVALID_MESSAGE`
 * を含む `Error` を投げる。`packages/postgres`・`packages/testkit` の両方の
 * `setEventRetention` 実装がこの関数を呼ぶことで、検査の種類を1箇所に固定する
 * （実装ごとに条件式を書き直すと、境界（`>= 1` か `>= 0` か）が実装間でずれる余地を作る）。
 *
 * ⚠ 延長（いまより長い日数への変更）は禁止しない——オーナーが決めたのは「短縮できる口は
 * 必須」であり、延長を禁じたとは言っていない。禁止を勝手に作らない
 * （`docs/decisions/0050-tenant-event-retention.md` 参照）。
 */
export function assertValidEventRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(EVENT_RETENTION_DAYS_INVALID_MESSAGE);
  }
}

/**
 * TenantSettingsStore — Phase 1（当初は `getDefaultHalfLifeHours` のみで追加。
 * `getEventRetention`/`setEventRetention` は `docs/roadmap.md` §5.4 のオーナー決定
 * 「監査ログの既定保持期間は無期限。テナント単位で短縮できる口は必須」を満たすために
 * 後から拡張した——このインターフェース自身の doc が最初から「必要になった段階で拡張する」
 * と明記していた通りの拡張である。詳細は `docs/decisions/0050-tenant-event-retention.md`）。
 *
 * `docs/memory-model.md` §10 の `tenant_settings` テーブルのうち、取り込み
 * （roadmap.md 段階3）が必要とする「Memory 作成時の既定 half-life」の読み出しと、
 * 監査ログ（`memory_events`）の保持期間の読み書きを提供する。`taxonomy_mode` の
 * 読み書きは引き続き本 interface の範囲外である（オーナーが「必須」と決めたのは
 * 保持期間だけであり、`taxonomy_mode` を動かす根拠が無い）。
 *
 * 契約:
 * - テナントに `tenant_settings` 行が無い場合、`getDefaultHalfLifeHours` は
 *   `DEFAULT_HALF_LIFE_HOURS` を返す（エラーにしない。既定値が無いテナントは
 *   「まだ設定していない」という正常系）。
 * - `getEventRetention`/`setEventRetention` は**必須**メソッドである（`?` を付けない）。
 *   理由は2つ: (1) オーナーの決定が「短縮できる口は必須」だから。(2) 任意にすると、
 *   「この adapter は短縮できない」（未実装）と「短縮に失敗した」（実行時エラー）が
 *   呼び出し側から同じ顔になってしまう——interface のレベルで両者を区別できるようにする。
 * - `setEventRetention` は `{ kind: "unset" }` を受け付けない
 *   （`EventRetentionSetting` 型がそもそも許さない）。「まだ設定していない」状態への
 *   巻き戻し（行の削除）は、この interface の対象外である。
 */
export interface TenantSettingsStore {
  getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;

  /** `tenant_settings.event_retention_days` の現在の状態を、3状態を保ったまま返す。 */
  getEventRetention(ctx: Ctx): Promise<EventRetention>;

  /**
   * `tenant_settings.event_retention_days` を設定する（UPSERT。行が無ければ作る）。
   * `retention.kind === "days"` のとき、`retention.days` が正の整数でなければ
   * `EVENT_RETENTION_DAYS_INVALID_MESSAGE` を含む `Error` で失敗する
   * （`assertValidEventRetentionDays` 参照）。
   */
  setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void>;
}
