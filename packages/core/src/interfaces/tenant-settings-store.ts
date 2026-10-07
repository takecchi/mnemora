import type { Ctx } from "../ctx.js";
import { omitParamsFromError } from "../failure-description.js";
import type { EraseTenantStoreOptions, EraseTenantResult } from "./memory-store.js";

/**
 * テナント設定行が存在しない場合のフォールバックの半減期（720時間 = 30日）。
 * `tenant_settings.default_half_life_hours` の DB 側デフォルト（docs/memory-model.md §10 の `DEFAULT 720`）と一致させる。
 */
export const DEFAULT_HALF_LIFE_HOURS = 720;

/**
 * `halfLifeHours` の値域は **`(0, ∞)`（有限の正の実数）**である（ADR 0125）。
 * `Memory.halfLifeHours` と `tenant_settings.default_half_life_hours` の両方に同じ意味で適用する。
 *
 * - **0 を含めない**: 「即座に消える」は `strength` を下げる・`status: 'forgotten'` にする既存の経路が表せる。
 * - **負を含めない**: `defaultDecayStrategy` の `decay` が `+Infinity` に発散し、「必ず想起の1位に来る」壊れ方になる。
 * - **有限に限る**: `Infinity` は式の中では発散しないが、「半減期」の意味上、矛盾した値である（ADR 0078。
 *   緩めるのは後から非破壊、締めるのは後から破壊的）。
 * - `NaN` は式全体を `NaN` に伝播させる。
 */
export function isHalfLifeHoursInRange(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}

/**
 * `tenant_settings.event_retention_days` が取りうる3つの状態（`docs/memory-model.md` §9「保持方針」）。
 *
 * ⚠ この3つを2つに潰さないこと:
 *
 * - `unset`: `tenant_settings` に行が無い（まだ設定していない。既定は無期限として動く）。
 * - `unlimited`: 行は在るが `event_retention_days` が `NULL`（無期限）。
 * - `days`: 行が在り、`event_retention_days` に具体的な日数が入っている。
 *
 * ⚠ 保持期間以外の設定を1つでも書くと行ができるので、保持期間を一度も触っていないテナントも `unlimited` になる
 * （`getEventRetention` の doc 参照）。
 */
export type EventRetention =
  { kind: "unset" } | { kind: "unlimited" } | { kind: "days"; days: number };

/**
 * `setEventRetention` に渡せる値。`unset`（行が無い状態）は*観測される*状態であって、*設定できる*値ではない。
 * 「行を無かったことにする」削除操作を、この interface は提供しない。
 */
export type EventRetentionSetting = Exclude<EventRetention, { kind: "unset" }>;

/**
 * `setEventRetention` に不正な `days`（正の整数でない値）を渡したときに両実装が投げる `Error` の
 * メッセージに必ず含める文字列。
 */
export const EVENT_RETENTION_DAYS_INVALID_MESSAGE =
  "event retention days must be a positive integer";

/**
 * `days` が正の整数で、int4 に収まる（`2^31 - 1` 以下。ADR 0499）ことを検査する。不正なら `EVENT_RETENTION_DAYS_INVALID_MESSAGE`
 * を含む `Error` を投げる。`packages/postgres`・`packages/testkit` の両方の `setEventRetention` 実装がこの関数を呼ぶ。
 *
 * ⚠ 延長（いまより長い日数への変更）は禁止しない（ADR 0050）。
 */
export function assertValidEventRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(EVENT_RETENTION_DAYS_INVALID_MESSAGE);
  }
  if (days > EVENT_RETENTION_DAYS_MAX) {
    throw new Error(
      `setEventRetention: days does not fit in a Postgres "integer" (int4) column (got ${days})`,
    );
  }
}

/** `event_retention_days`（`integer`、int4）列に収まる最大の日数（`2^31 - 1`）。 */
const EVENT_RETENTION_DAYS_MAX = 2 ** 31 - 1;

/**
 * `setEventRetention` に型の外の `kind`（`"unlimited"`・`"days"` のいずれでもない値）を渡したときに
 * 両実装が投げる `Error` のメッセージに必ず含める文字列。
 */
export const EVENT_RETENTION_KIND_INVALID_MESSAGE =
  "event retention kind must be 'unlimited' or 'days'";

/**
 * `value` が `EventRetentionSetting` の `kind`（`"unlimited"`・`"days"`）のいずれかであることを検査する。
 * 不正なら `EVENT_RETENTION_KIND_INVALID_MESSAGE` を含む `Error` を投げる。
 * 型の外の `kind`（綴りの誤りなど）が、例外にならずに保持期間を無期限にするのを防ぐ。
 */
export function assertValidEventRetentionKind(
  value: string,
): asserts value is EventRetentionSetting["kind"] {
  if (value !== "unlimited" && value !== "days") {
    throw new Error(EVENT_RETENTION_KIND_INVALID_MESSAGE);
  }
}

/**
 * 減衰の時計の種類（ADR 0165 決めたこと1）。
 *
 * - `'wall'`: 段1のゲートは `decay_floor_at > now()` のみ。
 * - `'activity'`: 段1のゲートは `decay_floor_seq > <そのテナントの activity_seq>` のみ。
 * - `'either'`: どちらかが生きていれば通す（OR）。**最も緩い。**
 */
export type DecayClock = "wall" | "activity" | "either";

/**
 * テナント設定行が存在しない場合のフォールバックの減衰の時計（`'wall'`。ADR 0165 決めたこと1）。
 * `tenant_settings.decay_clock` の DB 側デフォルトと一致させる。
 */
export const DEFAULT_DECAY_CLOCK: DecayClock = "wall";

/**
 * テナント設定行が存在しない場合のフォールバックの `default_half_life_recalls`（ADR 0165 決めたこと3）。
 * `tenant_settings.default_half_life_recalls` の DB 側デフォルトと一致させる。
 *
 * `720` は「1 recall ↔ 1時間」の1対1の対応を既定に置いたもので、`DEFAULT_HALF_LIFE_HOURS` と揃えてある。
 * 活動が疎（1時間に1回未満）なテナントでは活動時計のほうが遅く進み、密（1時間に1回超）なテナントでは速く進む。
 */
export const DEFAULT_HALF_LIFE_RECALLS = 720;

/**
 * `halfLifeRecalls` の値域は **`(0, ∞)`（有限の正の実数）**であり、`isHalfLifeHoursInRange` と**同じ値域**である（ADR 0125）。
 *
 * ⚠ この関数が見るのは float64 の値域だけである。保存先の Postgres の列は `real`（float4）なので、
 * float4 に収まらない値（上限は約 `3.4028235e38`、下限は約 `1.4e-45`）は、各 adapter が別に明示の例外で拒む
 * （`setDefaultHalfLifeRecalls` の doc 参照）。
 */
export function isHalfLifeRecallsInRange(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}

/**
 * `setDefaultHalfLifeRecalls` に不正な値（`isHalfLifeRecallsInRange` の値域外）を渡したときに
 * 投げる `Error` のメッセージに必ず含める文字列。
 */
export const HALF_LIFE_RECALLS_INVALID_MESSAGE =
  "half life recalls must be a finite number greater than 0";

/**
 * `value` が `isHalfLifeRecallsInRange` の値域の内側であることを検査する。
 * 不正なら `HALF_LIFE_RECALLS_INVALID_MESSAGE` を含む `Error` を投げる。
 * `packages/postgres`・`packages/testkit` の両方の `setDefaultHalfLifeRecalls` 実装がこの関数を呼ぶ。
 */
export function assertValidHalfLifeRecalls(value: number): void {
  if (!isHalfLifeRecallsInRange(value)) {
    throw new Error(HALF_LIFE_RECALLS_INVALID_MESSAGE);
  }
}

/**
 * `setDecayClock` に不正な値（`DecayClock` の3値のいずれでもない文字列）を渡したときに
 * 両実装が投げる `Error` のメッセージに必ず含める文字列。
 */
export const DECAY_CLOCK_INVALID_MESSAGE = "decay clock must be 'wall', 'activity', or 'either'";

/**
 * `value` が `DecayClock` の3値のいずれかであることを検査する。不正なら `DECAY_CLOCK_INVALID_MESSAGE` を含む `Error` を投げる。
 * `packages/postgres`・`packages/testkit` の両方の `setDecayClock` 実装がこの関数を呼ぶ。
 */
export function assertValidDecayClock(value: string): asserts value is DecayClock {
  if (value !== "wall" && value !== "activity" && value !== "either") {
    throw new Error(DECAY_CLOCK_INVALID_MESSAGE);
  }
}

/**
 * `tenant_settings.taxonomy_mode` が取りうる値（ADR 0318）。
 *
 * `strict` が変えるのは「`proposed` なラベルが検索のフィルタ・加点に参加できるか」だけであり、
 * 書き込みは `open`/`strict` に関わらず常に自由である（`docs/memory-model.md` §8）。
 * `recall()` は `getTaxonomyMode?` を読み、`open` なら `registered`・`proposed` の両方、`strict` なら `registered` だけを
 * ラベルの絞り込みの参加資格にする。読むのは、`labels` か `taxonomyGroups` を指定した `recall()` だけである。
 */
export type TaxonomyMode = "open" | "strict";

/**
 * テナント設定行が存在しない場合のフォールバックの `taxonomy_mode`。`tenant_settings.taxonomy_mode` の DB 側デフォルトと一致させる。
 */
export const DEFAULT_TAXONOMY_MODE: TaxonomyMode = "open";

/**
 * `setTaxonomyMode` に不正な値（`TaxonomyMode` の2値のいずれでもない文字列）を渡したときに
 * 両実装が投げる `Error` のメッセージに必ず含める文字列。
 */
export const TAXONOMY_MODE_INVALID_MESSAGE = "taxonomy mode must be 'open' or 'strict'";

/**
 * `value` が `TaxonomyMode` の2値のいずれかであることを検査する。不正なら `TAXONOMY_MODE_INVALID_MESSAGE` を含む `Error` で失敗する。
 * `packages/postgres`・`packages/testkit` の両方の `setTaxonomyMode` 実装がこの関数を呼ぶ。
 */
export function assertValidTaxonomyMode(value: string): asserts value is TaxonomyMode {
  if (value !== "open" && value !== "strict") {
    throw new Error(TAXONOMY_MODE_INVALID_MESSAGE);
  }
}

/**
 * TenantSettingsStore。`docs/memory-model.md` §10 の `tenant_settings` テーブルのうち、
 * Memory 作成時の既定 half-life の読み出しと、監査ログ（`memory_events`）の保持期間の読み書きなどを提供する。
 *
 * 契約:
 * - テナントに `tenant_settings` 行が無い場合、`getDefaultHalfLifeHours` は `DEFAULT_HALF_LIFE_HOURS` を返す（エラーにしない）。
 * - `getEventRetention`/`setEventRetention` は**必須**メソッドである（`?` を付けない。ADR 0050）。
 *   任意にすると、「この adapter は短縮できない」（未実装）と「短縮に失敗した」（実行時エラー）が呼び出し側から同じ顔になる。
 * - `setEventRetention` は `{ kind: "unset" }` を受け付けない。「まだ設定していない」状態への巻き戻し（行の削除）は対象外である。
 * - `setEventRetention` の `days` は、正の整数で、**`2^31 - 1` 以下**でなければならない（`assertValidEventRetentionDays`。ADR 0499）。
 *   超えれば何も書かずに `Error` を投げる。
 *
 * ⭐ **`getEventRetention`/`setEventRetention` 以外のメソッドはすべて省略可能（`?` 付き）である**（ADR 0165 決めたこと13）。
 * `@mnemora/core` は npm 公開済みで、必須メソッドを足すと外部の adapter 実装がコンパイルできなくなる。
 * 既定は `'wall'` なので、実装していない adapter の振る舞いは `?` の欠落を既定へ倒せば一致する。
 *
 * ⚠ **省略時のフォールバックを呼び出し側に散らさないこと。** `packages/core` は `readDecayClock`/`readActivitySeq`/
 * `readDefaultHalfLifeRecalls`（本ファイル）を通してのみ読む。未実装は `readXxx` が既定値へ倒し、実行時エラーは素通しで投げる。
 * `setDecayClock` を持たない adapter へ書こうとした場合は `DECAY_CLOCK_UNSUPPORTED_MESSAGE` を含む `Error` で**明示的に失敗する**
 * （黙って無視しない）。
 *
 * **`setDefaultHalfLifeHours`（壁時計側の対称なメソッド）は足していない**（`setDefaultHalfLifeRecalls` の doc、ADR 0197）。
 *
 * ⚠ **`bumpActivitySeq`（activity_seq を+1する書き込み）はここに無い。** カウンタの前進は `MemoryStore.createRecall` が
 * `recalls` への INSERT と**同一トランザクション**で行う（`NewRecallRecord.advanceActivityClock`）。`TenantSettingsStore` と
 * `MemoryStore` は別 adapter であり、この境界を跨いで1トランザクションを構成できない。`getActivitySeq` は**読み出し専用**。
 *
 * ⚠ **runtime がテナント設定を読む時点は、口によって違う。** どの口も1回の呼び出しの中で同じ設定を1回だけ読むが、
 * 読むのが呼び出しの始めか途中かで、呼び出しの最中に設定を変えたときの効き方が変わる:
 * - `recall`: decay_clock・`activity_seq`・taxonomy を**呼び出しの始め**（埋め込みの前）に読む。
 *   呼び出しの最中に変えた設定は、その呼び出しには効かず、**次の呼び出しから**効く。
 * - `observe`（抽出）・`reextract`・`consolidate`・`reflect`: 書き込む記憶の既定の半減期（`getDefaultHalfLifeHours`）と
 *   活動時計の入力を、**LLM の応答が返った後**、記憶を組み立てる直前に読む。LLM を待っている間に変えた設定は、
 *   **その呼び出しで書く記憶に効く**。
 * - `purgeExpiredEventsForTenant`（保持期間の掃除）: `getEventRetention` を呼び出しの始めに読むが、unset/unlimited を判定するためだけである
 *   （ADR 0354）。`days` のときに実際に使う保持期間は、`MemoryStore.purgeExpiredEventsByRetention?` が自分の内部で読み直した値で、
 *   cutoff の計算から削除までを行う。この口を実装していない adapter は `{ kind: "store_unsupported" }` になり、保持期間を読まない。
 *
 * 「呼び出しの始めの値で揃える」ことは約束していない。
 */
export interface TenantSettingsStore {
  /**
   * テナントの既定の半減期（時間）。書き込む記憶の `halfLifeHours` の既定になる。設定の行が無ければ `DEFAULT_HALF_LIFE_HOURS` を返す（`@mnemora/postgres` と testkit の fixture で同じ）。
   */
  getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;

  /**
   * `tenant_settings.event_retention_days` の現在の状態を、3状態を保ったまま返す。
   *
   * ⚠ `unset` は「そのテナントの設定の行が1つも無い」ことであって、「保持期間を一度も設定していない」ことではない。
   * 保持期間を触らずに別の設定（`setDecayClock`・`setDefaultHalfLifeRecalls`・`setTaxonomyMode`）を1つでも書くと
   * 行ができ、以後は `{ kind: "unlimited" }` を返す（`@mnemora/postgres` と testkit の fixture で同じ）。
   * したがって `unlimited` は「明示的に無期限と決めた」とは限らない。どちらも無期限として振る舞う点は変わらない。
   */
  getEventRetention(ctx: Ctx): Promise<EventRetention>;

  /**
   * `tenant_settings.event_retention_days` を設定する（UPSERT。行が無ければ作る）。
   * `retention.kind === "days"` のとき、`retention.days` が正の整数でなければ
   * `EVENT_RETENTION_DAYS_INVALID_MESSAGE` を含む `Error` で失敗する（`assertValidEventRetentionDays` 参照）。
   *
   * ⚠ **`days` の上限は `2^31 − 1`**（ADR 0499）。超えれば `@mnemora/postgres` も `InMemoryTenantSettingsStore` も、何も書かずに
   * 同じ文面の `Error` で断る（メッセージは `EVENT_RETENTION_DAYS_INVALID_MESSAGE` ではなく、
   * `setEventRetention: days does not fit in a Postgres "integer" (int4) column` で始まる）。
   *
   * `retention.kind` が `"unlimited"`・`"days"` のどちらでもなければ、`EVENT_RETENTION_KIND_INVALID_MESSAGE` を
   * 含む `Error` で失敗する（`assertValidEventRetentionKind`）。
   *
   * 受け付けた値なら、どれほど大きくても `purgeExpiredEventsForTenant` は例外にならない（0件の削除になる）。
   *
   * ⚠ **走っている掃除との競合**（ADR 0354）: `MemoryStore.purgeExpiredEventsByRetention?` を実装している adapter では、
   * 走っている掃除の内部の読みは、この呼び出しが commit するまで待たされ、commit した後の最新の値を見る。
   */
  setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void>;

  /**
   * `tenant_settings.decay_clock` の現在値。行が無ければ `DEFAULT_DECAY_CLOCK`（`'wall'`）を返す（ADR 0165 決めたこと1）。
   */
  getDecayClock?(ctx: Ctx): Promise<DecayClock>;

  /**
   * `tenant_settings.decay_clock` を設定する（UPSERT。行が無ければ作る）。`clock` が `DecayClock` の3値のいずれでもない場合は
   * `DECAY_CLOCK_INVALID_MESSAGE` を含む `Error` で失敗する（`assertValidDecayClock` 参照）。
   *
   * ⚠ **`'wall'` から `'activity'`/`'either'` へ切り替えても、`'wall'` の間に作られた記憶は活動時計では沈まない**
   * （活動時計の3つ組が `null` のまま＝床が無い。この口は既存の記憶を書き換えない）。
   * 活動時計で沈むのは、切り替えた後に作られた記憶だけである。これを契約とする（ADR 0165）。
   */
  setDecayClock?(ctx: Ctx, clock: DecayClock): Promise<void>;

  /**
   * `tenant_settings.default_half_life_recalls` の現在値。行が無ければ `DEFAULT_HALF_LIFE_RECALLS`（`720`）を返す。
   * これは**新規作成時の初期値としてのみ**使う（ADR 0165 決めたこと3）。既存 Memory の `halfLifeRecalls` はこの値が変わっても再計算されない。
   */
  getDefaultHalfLifeRecalls?(ctx: Ctx): Promise<number>;

  /**
   * `tenant_settings.default_half_life_recalls` を設定する（UPSERT。行が無ければ作る）。
   * `recalls` が `isHalfLifeRecallsInRange` の値域 `(0, ∞)` の外であれば
   * `HALF_LIFE_RECALLS_INVALID_MESSAGE` を含む `Error` で失敗する（`assertValidHalfLifeRecalls` 参照）。
   *
   * Postgres の列は `real`（float4）なので、float4 に収まる範囲（`Math.fround(x)` が有限かつ 0 でない値。上限は約 `3.4028235e38`、下限は約 `1.4e-45`）の外は、`@mnemora/postgres` も testkit の fixture も、メッセージに `does not fit in a Postgres "real" (float4) column` を含む `Error` で拒む。
   *
   * ⭐ **この値は新規作成時の初期値としてのみ使う**（ADR 0165 決めたこと3）。この呼び出しは
   * **既存 Memory の `halfLifeRecalls`/`decayFloorSeq` を1件も書き換えない**。効くのは呼び出し後に新規作成される Memory だけである。
   *
   * ⚠ **`setDefaultHalfLifeHours`（壁時計側の対称なメソッド）は意図的に足していない**（ADR 0197「採らなかった案」1）。
   */
  setDefaultHalfLifeRecalls?(ctx: Ctx, recalls: number): Promise<void>;

  /**
   * `tenant_activity.activity_seq` の現在値。行が無ければ `0` を返す（ADR 0165 決めたこと2・5）。
   * **読み出し専用。** 進めるのは `MemoryStore.createRecall`（`advanceActivityClock: true`）だけである。
   */
  getActivitySeq?(ctx: Ctx): Promise<number>;

  /**
   * `tenant_subject_activity` に、このテナントの行が1本でもあるか（ADR 0353）。行が無ければ `false`。
   * **読み出し専用。** 進めるのは `MemoryStore.createRecall`（`advanceActivityClock: { scope: "subject", subjectId }`）だけである。
   *
   * ⭐ **このフラグの目的は正しさではなく、SQL のプラン族を変えないための最適化である。** `false` のテナントでは
   * `getActivitySeq?` のみの単一パラメータ比較のままにし、`true` になって初めて `tenant_subject_activity` を相関サブクエリで引く。
   */
  hasSubjectActivityCounters?(ctx: Ctx): Promise<boolean>;

  /**
   * `tenant_subject_activity.activity_seq`（`S_x`）を、渡した `subjectIds` についてまとめて読む（ADR 0353）。
   * 行が無い `subjectId` はキーを省略してよい。**読み出し専用。**
   */
  getSubjectActivitySeqs?(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>>;

  /**
   * `tenant_settings.taxonomy_mode` の現在値。行が無ければ `DEFAULT_TAXONOMY_MODE`（`'open'`）を返す（ADR 0318）。
   * `labels` か `taxonomyGroups` を指定した `recall()` が `readTaxonomyMode` 経由で読み、`strict` では `proposed` のラベルを参加させない。
   * 未実装の adapter は `'open'` に倒れる。
   */
  getTaxonomyMode?(ctx: Ctx): Promise<TaxonomyMode>;

  /**
   * `tenant_settings.taxonomy_mode` を設定する（UPSERT。行が無ければ作る）。`mode` が `TaxonomyMode` の2値のいずれでもない場合は
   * `TAXONOMY_MODE_INVALID_MESSAGE` を含む `Error` で失敗する（`assertValidTaxonomyMode` 参照）。
   */
  setTaxonomyMode?(ctx: Ctx, mode: TaxonomyMode): Promise<void>;

  /**
   * `ctx.tenantId` の `tenant_settings` 行を消す（ADR 0383）。`eraseTenant`（`erase-tenant.ts`）が束ねて呼ぶ口の1つで、
   * **順序は最後**（設定を先に消すと、途中で処理が中断した場合に `getEventRetention` 等が既定値へ静かに戻り、
   * 消去が完了していないことに気づきにくくなるため）。
   *
   * 🔴 **任意メソッドである。** 理由は `VectorStore.eraseTenant?`/`OutboxStore.eraseTenant?` と同じ（`MemoryStore.eraseTenant` の doc 参照）。
   *
   * **契約**:
   * - 行は高々1行で、`opts.limit` が1未満になることは呼び出し元が書き込み前に弾く。`result.reachedLimit` は常に `false` を返してよい。
   * - `opts.dryRun === true` のときは削除を一切行わず、行が存在すれば `deleted: 1`、存在しなければ `deleted: 0` を返す。
   * - 行が存在しなくても例外にしない（`deleted: 0` を返すだけ）。
   */
  eraseTenant?(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult>;
}

/**
 * `setDecayClock` を実装していない adapter へ書こうとしたときに投げる `Error` のメッセージに必ず含める文字列（ADR 0165 決めたこと13）。
 *
 * ⭐ **黙って無視しない。** `'activity'` に切り替えたつもりのテナントが `'wall'` のまま動くと、誰も気づかないまま減衰の症状が再発する。
 */
export const DECAY_CLOCK_UNSUPPORTED_MESSAGE =
  "this TenantSettingsStore does not support setDecayClock";

/**
 * 下の公開ヘルパー（`read*` / `write*`）は、store が投げた例外に `omitParamsFromError` を掛けてから投げ直す（ADR 0437 決定1）。
 * drizzle の `Failed query: <SQL>\nparams: <値>` の `params:` より後ろを落とす。例外そのものを返す（`kind`・`cause` は変わらない）。
 * 「未実装」のときに投げる `*_UNSUPPORTED_MESSAGE` の `Error` は params を持たないので通さない。
 */
async function omittingParams<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw omitParamsFromError(error);
  }
}

/**
 * `getDecayClock` を持たない adapter では `DEFAULT_DECAY_CLOCK`（`'wall'`）へ倒す（ADR 0165 決めたこと13）。
 *
 * ⚠ **`packages/core` はここを通してのみ `decay_clock` を読む。** メソッドが在って投げた場合は素通しで投げる
 * （「未実装」と「失敗」を混ぜない）。
 */
export async function readDecayClock(store: TenantSettingsStore, ctx: Ctx): Promise<DecayClock> {
  if (store.getDecayClock === undefined) {
    return DEFAULT_DECAY_CLOCK;
  }
  return await omittingParams(() => store.getDecayClock!(ctx));
}

/**
 * `getActivitySeq` を持たない adapter では `0` へ倒す（`tenant_activity` に行が無いテナントと同じ値）。`readDecayClock` と同じ。
 */
export async function readActivitySeq(store: TenantSettingsStore, ctx: Ctx): Promise<number> {
  if (store.getActivitySeq === undefined) {
    return 0;
  }
  return await omittingParams(() => store.getActivitySeq!(ctx));
}

/**
 * `getDefaultHalfLifeRecalls` を持たない adapter では `DEFAULT_HALF_LIFE_RECALLS` へ倒す。`readDecayClock` と同じ。
 */
export async function readDefaultHalfLifeRecalls(
  store: TenantSettingsStore,
  ctx: Ctx,
): Promise<number> {
  if (store.getDefaultHalfLifeRecalls === undefined) {
    return DEFAULT_HALF_LIFE_RECALLS;
  }
  return await omittingParams(() => store.getDefaultHalfLifeRecalls!(ctx));
}

/**
 * テナント単位の活動カウンタ `T`（`getActivitySeq?`）に加え、subject 単位のカウンタ `S_x`（`tenant_subject_activity`）を持つ（ADR 0353）。
 * ある Memory（subject `x`）の「有効ないま」は常に `T + S_x`（主題なしの記憶は `T` のみ）。
 * 読み取り時は呼び出しごとの `activityCounting` の値に関わらず**常に同じ式**で、`activityCounting` が制御するのは前進（+1）の対象だけである。
 *
 * `hasSubjectActivityCounters?` が未実装 / false のテナントでは、`@mnemora/postgres` の段1 SQL ゲート・`aggregateScope`・
 * `archiveDecayed` は `T` のみの単一パラメータ比較のままになる（相関サブクエリを足さない）。
 */
export interface SubjectActivitySeqs {
  [subjectId: string]: number;
}

/**
 * `hasSubjectActivityCounters?` を持たない adapter では `false` へ倒す（`readActivitySeq` と同じ）。
 */
export async function readHasSubjectActivityCounters(
  store: TenantSettingsStore,
  ctx: Ctx,
): Promise<boolean> {
  if (store.hasSubjectActivityCounters === undefined) {
    return false;
  }
  return await omittingParams(() => store.hasSubjectActivityCounters!(ctx));
}

/**
 * `getSubjectActivitySeqs?` を持たない adapter では、渡した `subjectIds` すべてに `0` を割り当てた `SubjectActivitySeqs` へ倒す。
 * `readActivitySeq` と同じ。
 */
export async function readSubjectActivitySeqs(
  store: TenantSettingsStore,
  ctx: Ctx,
  subjectIds: readonly string[],
): Promise<SubjectActivitySeqs> {
  if (subjectIds.length === 0) {
    return {};
  }
  if (store.getSubjectActivitySeqs === undefined) {
    const zeros = Object.create(null) as SubjectActivitySeqs;
    for (const id of subjectIds) {
      zeros[id] = 0;
    }
    return zeros;
  }
  const result = await omittingParams(() => store.getSubjectActivitySeqs!(ctx, [...subjectIds]));
  // ADR 0472: subjectId は利用者が決める文字列で、`constructor`・`toString`・`__proto__` なども入る。
  // `result[id] ?? 0` は `Object.prototype` 側の値を返し（`T + S_x` が文字列連結になる）、プレーンな `{}` への
  // `filled["__proto__"] = ...` は黙って捨てられる。だから store の結果は自前のキーだけ・有限の数だけ読み、
  // 組み立てる側は prototype の無いオブジェクトにする。
  const filled = Object.create(null) as SubjectActivitySeqs;
  for (const id of subjectIds) {
    const value = Object.hasOwn(result, id) ? result[id] : undefined;
    filled[id] = typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return filled;
}

/**
 * `subjectId` 単数版。`readSubjectActivitySeqs` の薄い包み。
 */
export async function readSubjectActivitySeq(
  store: TenantSettingsStore,
  ctx: Ctx,
  subjectId: string,
): Promise<number> {
  const seqs = await readSubjectActivitySeqs(store, ctx, [subjectId]);
  return seqs[subjectId] ?? 0;
}

/**
 * `setDecayClock` を持たない adapter では `DECAY_CLOCK_UNSUPPORTED_MESSAGE` を含む `Error` で**明示的に失敗する**（ADR 0165 決めたこと13）。
 * 読み出し側と違い、書き込みは既定へ倒せない（倒すと「設定したのに効かない」が黙って成立する）。
 */
export async function writeDecayClock(
  store: TenantSettingsStore,
  ctx: Ctx,
  clock: DecayClock,
): Promise<void> {
  if (store.setDecayClock === undefined) {
    throw new Error(DECAY_CLOCK_UNSUPPORTED_MESSAGE);
  }
  await omittingParams(() => store.setDecayClock!(ctx, clock));
}

/**
 * `setTaxonomyMode` を実装していない adapter へ書こうとしたときに投げる `Error` のメッセージに必ず含める文字列（ADR 0318）。
 */
export const TAXONOMY_MODE_UNSUPPORTED_MESSAGE =
  "this TenantSettingsStore does not support setTaxonomyMode";

/**
 * `getTaxonomyMode` を持たない adapter では `DEFAULT_TAXONOMY_MODE`（`'open'`）へ倒す（ADR 0318）。`readDecayClock` と同じ。
 */
export async function readTaxonomyMode(
  store: TenantSettingsStore,
  ctx: Ctx,
): Promise<TaxonomyMode> {
  if (store.getTaxonomyMode === undefined) {
    return DEFAULT_TAXONOMY_MODE;
  }
  return await omittingParams(() => store.getTaxonomyMode!(ctx));
}

/**
 * `setTaxonomyMode` を持たない adapter では `TAXONOMY_MODE_UNSUPPORTED_MESSAGE` を含む `Error` で**明示的に失敗する**
 * （`writeDecayClock` と同じ理由）。
 */
export async function writeTaxonomyMode(
  store: TenantSettingsStore,
  ctx: Ctx,
  mode: TaxonomyMode,
): Promise<void> {
  if (store.setTaxonomyMode === undefined) {
    throw new Error(TAXONOMY_MODE_UNSUPPORTED_MESSAGE);
  }
  await omittingParams(() => store.setTaxonomyMode!(ctx, mode));
}
