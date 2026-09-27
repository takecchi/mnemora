import type { NewMemoryEvent } from "@mnemora/core";
import { MemoryEventKindSchema } from "@mnemora/core";

// testkit の fixture の内部モジュール。`InMemoryEventStore` と `InMemoryMemoryStore` の関数の中身から
// だけ使う——`.d.ts` の import に出ないので、公開の型の面（`exports` から辿れる宣言）には入らない。

/**
 * `memory_events` の1行として書けるイベントかを確かめる（Postgres が拒む入力を、同じ入力で拒む）。
 *
 * - `at`: Invalid Date（`.getTime()` が `NaN`）なら拒む（Issue #807）。省略（`undefined`）は
 *   「無い」であって Invalid Date ではないので検査しない。
 * - `kind`: `MemoryEventKind` に無い値なら拒む（Issue #1096）。Postgres は CHECK 制約
 *   `memory_events_kind_check` で拒む。型を外した呼び出し・JavaScript からの呼び出しで届く。
 *
 *
 * `buildStoredMemoryEvent` が呼ぶほか、呼び手のイベントを受け取る `InMemoryMemoryStore` の口は、
 * **状態を書き換える前に**これを呼ぶ——Postgres は1トランザクションで巻き戻るので、拒んだときに
 * 何も書かない。それを写す。
 */
export function assertStorableMemoryEvent(event: NewMemoryEvent): void {
  if (event.at !== undefined && Number.isNaN(event.at.getTime())) {
    throw new Error(`memory_events.at must be a valid Date (got Invalid Date)`);
  }
  if (!MemoryEventKindSchema.safeParse(event.kind).success) {
    throw new Error(
      `memory_events.kind must be one of ${MemoryEventKindSchema.options.join(", ")} (got ${JSON.stringify(event.kind)})`,
    );
  }
}

/**
 * `buildStoredMemoryEvent` が `structuredClone` で写せないイベント（`actor`・`meta` に関数・Symbol
 * など）なら、そこで投げるのと同じ `DataCloneError` を、**状態を書き換える前に**投げる。
 *
 * 書き換えた後の `buildStoredMemoryEvent` で初めて投げると、状態だけが書き換わってイベントが残らない
 * （Postgres は1トランザクションで巻き戻る）。投げる入力は変えない——**必ずそのイベントを書く口でだけ**
 * 呼ぶこと（CAS に弾かれてイベントを書かない対象に呼ぶと、今まで投げなかった入力で投げる）。
 */
export function assertCloneableMemoryEvent(event: NewMemoryEvent): void {
  structuredClone({ actor: event.actor, meta: event.meta });
}
