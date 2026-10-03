import type { Ctx } from "./ctx.js";
import type { MemoryStore, PurgeExpiredEventsResult } from "./interfaces/memory-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import { omitParamsFromError } from "./failure-description.js";

/**
 * Issue #210 / [ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)
 * （[ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md) で
 * `purgeExpiredEvents?` から `purgeExpiredEventsByRetention?` へ切り替えた）:
 * `TenantSettingsStore.getEventRetention`（ADR 0050）が返す3状態（`unset`/`unlimited`/
 * `days`）と、`MemoryStore.purgeExpiredEventsByRetention?`（任意メソッド）の
 * 有無を1つの結果に落とす。**`unset` と `unlimited` を同じ顔で返さない**——
 * 呼び出し側（運用ジョブ）が「まだ設定していないテナント」と「明示的に無期限を選んだ
 * テナント」を区別できることを、この関数の返り値でも保つ（ADR 0050 が
 * `TenantSettingsStore.getEventRetention` 自体で守った区別を、ここで潰さない）。
 *
 * - `{ kind: "unset" }` — テナントが event retention を一度も設定していない。
 *   **この関数が最初に読んだ値が `unset` のときは、`memoryStore` には一切触れない**（削除しない理由が
 *   「無期限」の一種であり、store 側の対応の有無を問う必要が無いため）。
 *   ⚠ `days` と読んだ後に `memoryStore.purgeExpiredEventsByRetention` が自分の読み直しで `unset` を返した場合も、
 *   その値がそのまま返る（`PurgeExpiredEventsByRetentionOutcome`）。
 * - `{ kind: "unlimited" }` — テナントが明示的に無期限を選んだ。同上（最初の読みが `unlimited` なら
 *   `memoryStore` に触れない。store の読み直しが `unlimited` を返した場合はそのまま返る）。
 * - `{ kind: "store_unsupported" }` — 保持期間は有限日数だが、渡された `MemoryStore`
 *   実装が `purgeExpiredEventsByRetention` を持たない（任意メソッド未実装の adapter）。
 *   [ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md) の
 *   `WriteAtomicity.store_unsupported` と同じ語彙上の判断——「この adapter では
 *   構造的に縮められない」ことを、実行時エラーではなく戻り値の種類で示す。
 *   ⚠ **[Issue #1232](https://github.com/takecchi/mnemora/issues/1232) の修正
 *   （[ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)）以降、
 *   `purgeExpiredEvents?` を実装していても `purgeExpiredEventsByRetention?` を実装していない
 *   adapter は、ここに落ちる**——保持期間の読みと削除を1つの原子的な操作にできない adapter で
 *   自動的に古い経路（`purgeExpiredEvents` を直接呼ぶ）へ落とすと、Issue #1232 が指摘した race を
 *   再導入してしまうため、意図して「旧経路への自動フォールバックは無い」と決めた。
 * - `{ kind: "executed"; result }` — `MemoryStore.purgeExpiredEventsByRetention` を実際に呼んだ。
 *   `result` はその戻り値そのもの（`dryRun` を含む。`result.purged` が実削除件数）。
 *   🔴 **値を `"executed"` と名付け、`"purged"` にしなかった**——
 *   `packages/core/src/event.ts` の `MemoryEventKind`（`memory_events.kind` 列の型）にも
 *   同名の値 `"purged"` が存在し、`kind: "purged"` という同じ文字面のオブジェクトリテラルに
 *   なる。両者は無関係の型（あちらは物理削除イベント種別——Issue #198 / ADR 0124で
 *   実装済み、こちらはこのオーケストレータの実行結果）だが、
 *   [ADR 0117](../../../docs/decisions/0117-unreachable-union-values-inventory.md)
 *   の回帰テスト（`unreachable-union-values.test.ts`）は型を見ずテキスト一致で
 *   `kind: "purged"` を探すため、同じ文字列を使うと「`MemoryEventKind.purged` が
 *   生成された」という偽陽性になる。**文字列が衝突するなら、文字列を変えて衝突を解消する**
 *   ——ADR 0117 側のテキストスキャンを型認識に書き換える負担を、無関係な本 PR に持ち込まない。
 *   ⚠ 2026-09-28 追記（[Issue #1264](https://github.com/takecchi/mnemora/issues/1264)）: この理由は今は当たらない。
 *   `unreachable-union-values.test.ts` は、`Runtime.purge` の実装（Issue #198、ADR 0124）で `kind: "purged"` を
 *   棚卸しの対象から外しており、今はこの文字列を探していない。名前を `"executed"` のまま変えない理由は、
 *   公開の値を変えないことである。
 */
export type PurgeExpiredEventsForTenantOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "store_unsupported" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };

/** `Date` が表せる最も古い時刻（ECMAScript の時刻値の下限）。 */
const EARLIEST_DATE_MS = -8.64e15;

/**
 * `now` から `days` 日ぶん遡った cutoff（`olderThan`）を計算する。
 *
 * [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)：
 * `purgeExpiredEventsForTenant` がかつて自分で行っていた計算をここへ切り出し、
 * `MemoryStore.purgeExpiredEventsByRetention?` を実装する各 adapter
 * （`@mnemora/postgres` の `PostgresMemoryStore`、`@mnemora/testkit` の
 * `InMemoryMemoryStore`、`packages/core/src/__tests__/runtime-fakes.ts` の
 * `FakeMemoryStore`）が共有する——保持期間を読んでから実際に削除するまでを1つの
 * 原子的な操作にするには、cutoff の計算自体を store 側で行う必要があるが、
 * 「日数→`Date`、`EARLIEST_DATE_MS` への寄せ」という算術そのものは1箇所に固定し、
 * 実装ごとに書き写さない。
 *
 * 日数が大きいと差が `Date` の範囲（±8.64e15 ms）を越え、Invalid Date になる
 * （約1億日から。`setEventRetention` は正の整数を上限なく受け付ける）。そのときの cutoff は
 * 「表せる最も古い時刻より前」なので、表せる最も古い時刻へ寄せる——それより古い行は無い。
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
   * {@link MemoryStore.purgeExpiredEventsByRetention} の `opts.limit` へそのまま渡す
   * （`ClaimOutboxJobsOptions.leaseMs` と同じ理由。取り消せない削除の上限を
   * `packages/core` が勝手に決めない）。
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
 * Issue #210 / ADR 0115: `TenantSettingsStore.getEventRetention` を読み、有限日数
 * （`{ kind: "days" }`）のときだけ `MemoryStore.purgeExpiredEventsByRetention?` を呼ぶ。
 *
 * 🔴 **この関数はどこからも自動的に呼ばれない。** `runtime.tick()` にも
 * `runtime.observe()` にも配線しない——設計上の注意7（Issue #210 本文）が
 * 「自動実行しないこと。`tick()` にも `observe()` にも相乗りさせない。明示呼び出しのみ」
 * と明示している。呼び出すのは運用側のスクリプト・cron・別途の保守ジョブの責務であり、
 * `packages/core` はその「呼ぶための部品」だけを提供する。
 *
 * ⚠ **[Issue #1232](https://github.com/takecchi/mnemora/issues/1232) の修正
 * （[ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)）以降、
 * cutoff（`olderThan`）はこの関数では計算しない。** この関数の役目は
 * unset/unlimited/store_unsupported の判定だけであり、`days` のときの cutoff の計算・
 * 実際の削除は `MemoryStore.purgeExpiredEventsByRetention?` の内部（`computeEventRetentionCutoff`
 * を経由）に一本化した——理由は下の2026-09-29追記を参照。
 *
 * ⚠ **2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:**
 * この関数を定期的に呼ぶ運用は、`kind: 'superseded'` の `memory_events` 行も
 * 保持期間どおりに削除する——`MemoryStore.previewRestoreSupersededBy?` が読む唯一の
 * 情報源であり、これが消えると「群の由来が分からない」扱いに劣化する。詳細は
 * {@link MemoryStore.purgeExpiredEvents} の doc コメントを参照。
 *
 * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)）:
 * 保持期間は呼び出しの始めに1回だけ読む。**読んでから `purgeExpiredEvents` で消すまでの間に
 * `setEventRetention` が期間を変えても（無期限にしても、延ばしても）、この呼び出しは読んだときの日数で消す
 * ——設定の呼び出しが返った後に、新しい期間なら残るはずの行が消えうる。消した行は戻らない。
 * 短くした場合は、この回は長い期間で消し、残りは次の呼び出しで消える。読みと削除を1つにまとめる仕組みは無い。
 * 【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture で同じ（`event-retention-change-during-purge.postgres.test.ts`）。
 *
 * ⚠ **2026-09-29 追記: 上の2026-09-27追記はもう成り立たない
 * （[Issue #1232](https://github.com/takecchi/mnemora/issues/1232) の修正、
 * [ADR 0354](../../../docs/decisions/0354-atomic-event-retention-purge.md)）。**
 * この関数自身は、保持期間を呼び出しの始めに1回読む点は変わっていない——ただしそれは
 * **unset/unlimited を判定するためだけの読み**であり、`days` のときに実際へ使う cutoff は
 * ここでは計算しない。`days` のときは `MemoryStore.purgeExpiredEventsByRetention?`
 * （任意メソッド）へ丸ごと委ねる——保持期間の再読み込み・cutoff の計算・削除・
 * `events_purged` の追記を、**store 自身が1つの原子的な操作として行う**（Postgres なら
 * 同一トランザクションの中で `tenant_settings` 行を `FOR SHARE` で読み直す）。
 * この口を実装していない adapter は `{ kind: "store_unsupported" }` になる——
 * **`purgeExpiredEvents?` があっても、そちらへは自動的に落ちない**（下記参照）。
 * 【実測 2026-09-29】`@mnemora/postgres` と testkit の fixture で、上と同じ
 * `event-retention-change-during-purge.postgres.test.ts` の4ケースが、いまは
 * 「変えた後の期間を守る」側の期待で緑になることを確かめた。
 *
 * ⚠ **2026-10-03 訂正:** 上の「この関数の役目は unset/unlimited/store_unsupported の判定だけ」は、
 * 戻り値の `unset`/`unlimited` の出どころを狭く書いていた。`days` と読んだ後に、`purgeExpiredEventsByRetention?`
 * 自身が保持期間を読み直した結果として `unset`/`unlimited` を返すことがあり、この関数はそれをそのまま返す
 * （`PurgeExpiredEventsByRetentionOutcome`、`MemoryStore.purgeExpiredEventsByRetention`）。
 * なお、`opts.limit` の検査はこの関数では行わず、`purgeExpiredEventsByRetention?` へそのまま渡す
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
    // ADR 0430 決定3: 公開の独立関数が投げる例外も、drizzle の `params:` を落とす。
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
