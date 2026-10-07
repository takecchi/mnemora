import type { Ctx } from "./ctx.js";
import type { MemoryStore, PurgeExpiredEventsResult } from "./interfaces/memory-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import { omitParamsFromError } from "./failure-description.js";

/**
 * `TenantSettingsStore.getEventRetention`（ADR 0050）が返す3状態（`unset`/`unlimited`/`days`）と、
 * `MemoryStore.purgeExpiredEventsByRetention?`（任意メソッド）の有無を1つの結果に落とす
 * （[ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)、
 * [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)）。
 * **`unset` と `unlimited` を同じ顔で返さない**（「まだ設定していないテナント」と
 * 「明示的に無期限を選んだテナント」を区別できるようにする）。
 *
 * - `{ kind: "unset" }` — テナントが event retention を一度も設定していない。
 *   **この関数が最初に読んだ値が `unset` のときは、`memoryStore` には一切触れない。**
 *   ⚠ `days` と読んだ後に `memoryStore.purgeExpiredEventsByRetention` が自分の読み直しで `unset` を返した場合も、
 *   その値がそのまま返る（`PurgeExpiredEventsByRetentionOutcome`）。
 * - `{ kind: "unlimited" }` — テナントが明示的に無期限を選んだ。`unset` と同じ扱い
 *   （最初の読みが `unlimited` なら `memoryStore` に触れず、store の読み直しが返したときはそのまま返る）。
 * - `{ kind: "store_unsupported" }` — 保持期間は有限日数だが、渡された `MemoryStore`
 *   実装が `purgeExpiredEventsByRetention` を持たない。
 *   [ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md) の
 *   `WriteAtomicity.store_unsupported` と同じ語彙で、「この adapter では構造的に縮められない」ことを
 *   実行時エラーではなく戻り値の種類で示す。
 *   ⚠ **`purgeExpiredEvents?` を実装していても `purgeExpiredEventsByRetention?` を実装していない
 *   adapter は、ここに落ちる**——読みと削除を1つの原子的な操作にできない adapter を旧経路
 *   （`purgeExpiredEvents` を直接呼ぶ）へ自動で落とすと、ADR 0354 が直した race を再導入するため。
 * - `{ kind: "executed"; result }` — `MemoryStore.purgeExpiredEventsByRetention` を実際に呼んだ。
 *   `result` はその戻り値そのもの（`dryRun` を含む。`result.purged` が実削除件数）。
 *   値を `"purged"` にしなかったのは、`MemoryEventKind`（`event.ts`）に同名の `"purged"`
 *   （物理削除イベント種別）があり、無関係の型なのに同じ文字面になるため。
 */
export type PurgeExpiredEventsForTenantOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "store_unsupported" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };

/** `Date` が表せる最も古い時刻（ECMAScript の時刻値の下限）。 */
const EARLIEST_DATE_MS = -8.64e15;

/**
 * `now` から `days` 日ぶん遡った cutoff（`olderThan`）を計算する（[ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)）。
 *
 * `MemoryStore.purgeExpiredEventsByRetention?` を実装する各 adapter が共有する。cutoff の計算は
 * 読みと削除を1つの原子的な操作にするため store 側で行うが、算術は1箇所に固定し、実装ごとに書き写さない。
 *
 * 日数が大きいと差が `Date` の範囲（±8.64e15 ms）を越え、Invalid Date になる
 * （約1億日から。`setEventRetention` は正の整数を上限なく受け付ける）。そのときは表せる最も古い時刻へ
 * 寄せる（それより古い行は無い）。
 */
export function computeEventRetentionCutoff(now: Date, days: number): Date {
  return new Date(Math.max(now.getTime() - days * 24 * 60 * 60 * 1000, EARLIEST_DATE_MS));
}

/**
 * {@link purgeExpiredEventsForTenant} の引数。
 */
export interface PurgeExpiredEventsForTenantOptions {
  /**
   * 1回の呼び出しで削除する上限。**必須・既定値なし**——
   * {@link MemoryStore.purgeExpiredEventsByRetention} の `opts.limit` へそのまま渡す。
   * 取り消せない削除の上限を `packages/core` が勝手に決めない。
   */
  limit: number;
  /**
   * `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。省略時は `false`。
   */
  dryRun?: boolean | undefined;
  /**
   * 「いま」を何とするか。省略時は `new Date()`。テストが決定的な cutoff を
   * 固定するために上書きできる。
   */
  now?: Date | undefined;
}

/**
 * `TenantSettingsStore.getEventRetention` を読み、有限日数（`{ kind: "days" }`）のときだけ
 * `MemoryStore.purgeExpiredEventsByRetention?` を呼ぶ（ADR 0115）。
 *
 * 🔴 **この関数はどこからも自動的に呼ばれない。** `runtime.tick()` にも `runtime.observe()` にも
 * 配線しない（明示呼び出しのみ）。呼ぶのは運用側のスクリプト・cron・保守ジョブの責務で、
 * `packages/core` は「呼ぶための部品」だけを提供する。
 *
 * ⚠ **cutoff（`olderThan`）はこの関数では計算しない。** この関数自身の読みは unset/unlimited を
 * 判定するためだけで、`days` のときの保持期間の読み直し・cutoff の計算（`computeEventRetentionCutoff`）・
 * 削除・`events_purged` の追記は、store が1つの原子的な操作として行う（Postgres なら同一トランザクションで
 * `tenant_settings` 行を `FOR SHARE` で読み直す）。読みと削除の間に `setEventRetention` が走っても、
 * 変えた後の期間を守る（ADR 0354）。そのため `unset`/`unlimited` は store の読み直しの結果として返ることもあり、
 * この関数はそれをそのまま返す（`PurgeExpiredEventsByRetentionOutcome`）。
 * `purgeExpiredEventsByRetention?` を持たない store は、`purgeExpiredEvents?` があっても
 * `{ kind: "store_unsupported" }` になる（旧経路へは自動で落ちない）。
 *
 * ⚠ 定期的に呼ぶと `kind: 'superseded'` の `memory_events` 行も保持期間どおりに削除する——
 * `MemoryStore.previewRestoreSupersededBy?` が読む唯一の情報源で、消えると「群の由来が分からない」
 * 扱いに劣化する。詳細は {@link MemoryStore.purgeExpiredEvents} の doc コメントを参照。
 *
 * `opts.limit` の検査はこの関数では行わず、`purgeExpiredEventsByRetention?` へそのまま渡す
 * （`eraseTenant` と違い、この関数自身は `RangeError` を投げない）。
 */
export async function purgeExpiredEventsForTenant(
  ctx: Ctx,
  deps: { memoryStore: MemoryStore; tenantSettingsStore: TenantSettingsStore },
  opts: PurgeExpiredEventsForTenantOptions,
): Promise<PurgeExpiredEventsForTenantOutcome> {
  try {
    return await purgeExpiredEventsForTenantBody(ctx, deps, opts);
  } catch (error) {
    // 公開の独立関数が投げる例外も、drizzle の `params:` を落とす（ADR 0430）。
    throw omitParamsFromError(error);
  }
}

async function purgeExpiredEventsForTenantBody(
  ctx: Ctx,
  deps: { memoryStore: MemoryStore; tenantSettingsStore: TenantSettingsStore },
  opts: PurgeExpiredEventsForTenantOptions,
): Promise<PurgeExpiredEventsForTenantOutcome> {
  const retention = await deps.tenantSettingsStore.getEventRetention(ctx);
  if (retention.kind === "unset") {
    return { kind: "unset" };
  }
  if (retention.kind === "unlimited") {
    return { kind: "unlimited" };
  }
  if (!deps.memoryStore.purgeExpiredEventsByRetention) {
    return { kind: "store_unsupported" };
  }
  const outcome = await deps.memoryStore.purgeExpiredEventsByRetention(ctx, {
    now: opts.now ?? new Date(),
    limit: opts.limit,
    dryRun: opts.dryRun,
  });
  return outcome;
}
