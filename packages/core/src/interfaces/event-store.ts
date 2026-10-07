import type { Ctx } from "../ctx.js";
import type { EventId } from "../ids.js";
import type { EventFilter, MemoryEvent, NewMemoryEvent } from "../event.js";

/**
 * EventStore（監査ログ、docs/architecture.md §5.8）。
 *
 * **`update` / `delete` を意図的に持たせない。** append-only。型に無ければ、実装が間違って消す経路が
 * そもそも生えない（docs/memory-model.md §9）。
 */
export interface EventStore {
  /**
   * **`event.memoryId` が非 `null` のとき、その Memory が `ctx.tenantId` の Memory でなければ、行を書かずに
   * `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる**（ADR 0436。ADR 0398 の `RelationStore.link` と同じ作法。
   * クラス名の接頭辞は `PostgresEventStore:`／`InMemoryEventStore:`）。実在しない id・別のテナントの Memory の id・
   * uuid の形でない id（`@mnemora/postgres`）を区別しない。`memoryId` が `null` のイベント（`events_purged`）は検査しない。
   *
   * ⚠ **`event.meta`・`event.actor` の値の中身は検査しない。**JSON で往復しない値と、NUL・孤立サロゲートを
   * 含む文字列の扱いは adapter によって違う（BigInt は両 adapter とも拒む）。{@link MemoryEvent.meta} の doc の表を参照。
   *
   * ⚠ **`event` の形もほとんど検査しない**（`@mnemora/postgres` と testkit の fixture で同じ）。
   * - 列挙に無い `actor.type`、`actor: null`、オブジェクトでない `meta`（`null`・配列・文字列）、負の `sizeBeforeBytes` も、
   *   そのまま書いて返す。**返った `MemoryEvent` は `MemoryEventSchema` を通らないことがある。**
   * - 整数でない `sizeBeforeBytes`（`1.5`・`NaN`・`Infinity`）と、int4 の範囲（`-2^31`〜`2^31 - 1`）に収まらない値は、
   *   例外を投げる（範囲の端ちょうどの値は通る。ADR 0434）。
   * - `event.tenantId` が `ctx.tenantId` と違っても拒まず、**`ctx.tenantId` のテナントとして書く**（返る値の `tenantId` も同じ）。
   * - 拒むのは、列挙に無い `kind`・`memoryId` が非 `null` の `events_purged`（{@link MemoryEvent.memoryId}）・Invalid Date の `at`・
   *   存在しない（または形式の壊れた）`memoryId`・別のテナントの Memory を指す `memoryId`・`actor`/`meta` に含まれる
   *   NUL（U+0000）か孤立サロゲートの文字列・`actor`/`meta` に含まれる BigInt である（例外の種類は adapter で違う）。
   * - ⚠ **BigInt はこの一覧の他のどの拒否よりも先に働く**。`actor`/`meta` に BigInt があると、他の検査より先に
   *   `TypeError` になる（`@mnemora/postgres`。{@link MemoryEvent.meta} の doc 参照）。
   *
   * `MemoryStore` の `event` を受け取る口（`updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・
   * `markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`）も、`event` について同じである
   * （`updateStatusWithEvent` は実測。ほかの口は fixture が同じ検査 `assertStorableMemoryEvent` を通し、Postgres が同じ列へ書く）。
   */
  append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
  /**
   * `id` が adapter の期待する形式でない場合も「存在しない」と同じ `null` を返す（例外を投げない）。
   * UUID 形式の `id` は大文字小文字を区別しない（`list` の `filter.memoryId` も同じ）。
   * 別のテナントのイベントの `id` も `null` を返す。
   */
  get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
  /**
   * `filter` に一致する `MemoryEvent` を返す（ADR 0042）。
   *
   * - **並び順**: `at` の昇順。**`at` が同値の行同士の順序は規定しない。**
   *   ⚠ **この順序を当てにしてはいけない**（ADR 0422）。同じ操作が積む `created` と `superseded`
   *   （`consolidate`・`reextract`）は同じ `at` を持つので、その並びは挿入順とも限らない。
   *   順が要るときは `kind` と `meta`（例: `superseded` の `meta.supersededById`）で関係を読むこと。
   * - **`limit`**: 並べ替えた後に適用する。「`at` が最も古い n 件」を返す。挿入順の先頭 n 件ではない
   *   （`append` は任意の `at` を渡せる）。
   * - **`since` / `until`**: 両端を含む（`at >= since` かつ `at <= until`）。
   * - ⚠ **`since` と `limit` では、取りこぼしも重複も無いページングは組めない。** カーソルの口は無い。
   *   同じ `at` の行が `limit` の境目を跨ぐと、次のページを最後の行の `at` から始めれば同じ行がもう一度返り、
   *   1 ms 進めれば残りの同じ `at` の行を飛ばす。
   * - **`filter.memoryId`**: adapter の期待する形式でない場合も「一致する行が無い」と同じ空配列を返す
   *   （他のフィルタの指定に関わらず。例外を投げない）。
   */
  list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}
