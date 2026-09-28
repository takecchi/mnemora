import type { Ctx } from "../ctx.js";
import type { EventId } from "../ids.js";
import type { EventFilter, MemoryEvent, NewMemoryEvent } from "../event.js";

/**
 * EventStore — Phase 1（監査ログ、docs/architecture.md §5.8）。
 *
 * **`update` / `delete` を意図的に持たせない。** append-only。alteroid の `JournalStore`
 * と同じ形——型に無ければ、実装が間違って消す経路がそもそも生えない、という静的な担保
 * （docs/memory-model.md §9）。
 */
export interface EventStore {
  /**
   * ⚠ **`event.memoryId` がほかのテナントの Memory を指していても、テナントの一致は
   * 約束として検査しない**（[Issue #1051](https://github.com/takecchi/mnemora/issues/1051)）。
   * adapter によって違う:
   * - `@mnemora/postgres`: 受け付け、呼んだテナントのイベントとして記録する
   *   （`memories(id)` への外部キーは `tenant_id` を見ない）。
   * - `@mnemora/testkit` の `InMemoryEventStore`: `ctx` のテナントで Memory を引くので、
   *   「memory not found」で拒む。
   *
   * どちらでも、ほかのテナントの行とイベントは変わらない。`Runtime` は同じ `ctx` で確かめた
   * id しか渡さない。`docs/memory-model.md` §5 の 2026-09-27 追記を参照。
   *
   * ⚠ **`event.meta`・`event.actor` の値の中身は検査しない。**JSON で往復しない値と、NUL・孤立サロゲートを
   * 含む文字列の扱いは adapter によって違う——{@link MemoryEvent.meta} の doc の表を参照
   * （[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)）。
   *
   * ⚠ 2026-09-28 追記（今の振る舞い。`@mnemora/postgres` と testkit の fixture へ同じ入力を当てて確かめた）:
   * **`event` の形もほとんど検査しない。**
   * - 列挙に無い `actor.type`、`actor: null`、オブジェクトでない `meta`（`null`・配列・文字列）、負の `sizeBeforeBytes` も、
   *   そのまま書いて返す。**返った `MemoryEvent` は `MemoryEventSchema` を通らないことがある。**
   * - 整数でない `sizeBeforeBytes`（例: `1.5`）は、**`@mnemora/postgres` だけが**例外を投げる（列が整数）。fixture は受け付けて返す。
   * - `event.tenantId` が `ctx.tenantId` と違っても拒まず、**`ctx.tenantId` のテナントとして書く**（返る値の `tenantId` も
   *   `ctx.tenantId`）。
   * - 拒むのは、列挙に無い `kind`・`memoryId` が非 `null` の `events_purged`（{@link MemoryEvent.memoryId}）・Invalid Date の `at`・
   *   存在しない（または形式の壊れた）`memoryId`・`actor`/`meta` に含まれる NUL（U+0000）か孤立サロゲートの文字列
   *   （2026-09-29、[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)。両方とも adapter で同じ入力を拒む）である
   *   （例外の種類は adapter で違う）。
   *
   * `MemoryStore` の `event` を受け取る口（`updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・
   * `markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`）も、`event` について同じである
   * ——`updateStatusWithEvent` は同じ入力を当てて確かめた。ほかの口は、fixture が同じ検査（`assertStorableMemoryEvent`）を通し、
   * Postgres が同じ列へ書くことをコードで読んだ（実測はしていない）。
   */
  append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
  /**
   * `id` が adapter の期待する形式でない場合も「存在しない」と同じ `null` を返す
   * （例外を投げない）。core の `EventId` は単なる `string` であり形式を強制しないため、
   * ある adapter が主キーに特定の形式（例: UUID）を要求していても、その形式に合わない
   * `id` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   */
  get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
  /**
   * `filter` に一致する `MemoryEvent` を返す（docs/decisions/0042 参照）。
   *
   * - **並び順**: `at` の昇順（`PostgresEventStore` の `ORDER BY at ASC` が基準）。
   *   **`at` が同値の行同士の順序は規定しない** —— Postgres の `ORDER BY at ASC` は
   *   同値の行の順序を保証しないため、規定しても守れない約束になる。
   * - **`limit`**: 上記の並び順に**並べ替えた後**に適用する。すなわち「`at` が最も
   *   古い n 件」を返す —— 挿入順の先頭 n 件ではない。`append` は呼び出し側が
   *   任意の `at` を渡せる（`event.at ?? new Date()`）ため、挿入順と `at` 順は
   *   一致するとは限らない。
   * - **`since` / `until`**: 両端を含む（`at >= since` かつ `at <= until`）。
   * - ⚠ **`since` と `limit` では、取りこぼしも重複も無いページングは組めない。** カーソルの口は
   *   無い。同じ `at` の行が `limit` の境目を跨ぐと、次のページを最後の行の `at` から始めれば
   *   （`since` は両端を含むので）同じ行がもう一度返り、1 ms 進めれば残りの同じ `at` の行を
   *   飛ばす（同じ `at` の行どうしの順序は上のとおり規定しない）。今の振る舞いを書いたもの。
   * - **`filter.memoryId`**: adapter の期待する形式でない場合も「一致する行が無い」と
   *   同じ空配列を返す（他のフィルタの指定に関わらず。例外を投げない）。
   */
  list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}
