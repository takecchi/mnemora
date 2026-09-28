import type { NewMemoryEvent } from "@mnemora/core";
import { MemoryEventKindSchema } from "@mnemora/core";

// testkit の fixture の内部モジュール。`InMemoryEventStore` と `InMemoryMemoryStore` の関数の中身から
// だけ使う——`.d.ts` の import に出ないので、公開の型の面（`exports` から辿れる宣言）には入らない。

/**
 * 文字列 `value` が、Postgres の `jsonb` が拒む文字を含むか。
 *
 * `packages/postgres` は `event.actor`・`event.meta` を丸ごと `JSON.stringify(...)::jsonb` で書く
 * （`event-store.ts`・`memory-store.ts`）。`JSON.stringify` は NUL（U+0000）を `\u0000` に、
 * 対をなさない UTF-16 サロゲートコードユニット（孤立サロゲート。上位 `\uD800`〜`\uDBFF`・下位
 * `\uDC00`〜`\uDFFF` のどちらか単体）を `\udXXX` のエスケープに変えるが、Postgres の `jsonb` は
 * どちらのエスケープも「有効な Unicode 文字を表さない」として `invalid input syntax for type json`
 * で拒む（実測。孤立サロゲートの側は Issue #1075 で Observation/Memory の `jsonb` 欄について
 * 確かめたのと同じ根）。対になったサロゲートペア（絵文字など）は有効な文字なので拒まない。
 */
function hasNulOrLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // 上位サロゲート。直後が対になる下位サロゲートなら有効なペア——まとめて読み飛ばす。
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true; // 対の無い上位サロゲート
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // 上位サロゲートに消費されなかった、対の無い下位サロゲート
    }
  }
  return false;
}

/**
 * `value`（`event.actor` か `event.meta`）の中に、NUL か孤立サロゲートを含む文字列（キー・値の
 * どちらも）が無いか。素の JS の値をそのまま辿る——`JSON.stringify` を経由しない（`meta` に
 * BigInt・関数・Symbol が混ざっていても、ここでは無視して先へ進む。BigInt は `JSON.stringify` が
 * 例外を投げるが、その扱いは本関数の対象外——{@link assertStorableMemoryEvent} の doc コメント参照）。
 * プレーンな配列・オブジェクトだけを再帰する。
 */
function containsNulOrLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") {
    return hasNulOrLoneSurrogate(value);
  }
  if (Array.isArray(value)) {
    return value.some((v) => containsNulOrLoneSurrogate(v));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([k, v]) => hasNulOrLoneSurrogate(k) || containsNulOrLoneSurrogate(v),
    );
  }
  return false;
}

/**
 * `memory_events` の1行として書けるイベントかを確かめる（Postgres が拒む入力を、同じ入力で拒む）。
 *
 * - `at`: Invalid Date（`.getTime()` が `NaN`）なら拒む（Issue #807）。省略（`undefined`）は
 *   「無い」であって Invalid Date ではないので検査しない。
 * - `kind`: `MemoryEventKind` に無い値なら拒む（Issue #1096）。`events_purged` で `memoryId` が null でなければ拒む
 *   （Postgres の `memory_events_check`）。Postgres は CHECK 制約
 *   `memory_events_kind_check` で拒む。型を外した呼び出し・JavaScript からの呼び出しで届く。
 * - `actor`・`meta`: NUL（U+0000）か孤立サロゲートを含む文字列（キーも値も、入れ子の中も）が
 *   あれば拒む（Issue #1211）。Postgres は `JSON.stringify(actor)`/`JSON.stringify(meta)` を
 *   `::jsonb` に渡す時点で拒む——`Runtime` の口に渡す `reason`（`meta.reason`/`meta.note` に入る）と
 *   `actor.id` に届く。**BigInt・関数・Symbol はこの検査の対象外**——{@link containsNulOrLoneSurrogate}
 *   の doc コメントと `MemoryEvent.meta` の TSDoc（`@mnemora/core` の `event.ts`）の表のとおり、
 *   BigInt は fixture がそのまま保存する差として残し（Postgres は例外）、関数・Symbol は
 *   {@link assertCloneableMemoryEvent} が別に扱う。
 *
 * `buildStoredMemoryEvent` が呼ぶほか、呼び手のイベントを受け取る `InMemoryMemoryStore` の口は、
 * **状態を書き換える前に**これを呼ぶ——Postgres は1トランザクションで巻き戻るので、拒んだときに
 * 何も書かない。それを写す。
 */
export function assertStorableMemoryEvent(event: NewMemoryEvent): void {
  if (event.at !== undefined && Number.isNaN(event.at.getTime())) {
    throw new Error(`memory_events.at must be a valid Date (got Invalid Date)`);
  }
  // Postgres の `memory_events_check`: `events_purged`（保持期間の掃除の記録）は特定の Memory を指さない
  // （core の `MemoryEventSchema` の `refine` と同じ約束）。
  if (event.kind === "events_purged" && event.memoryId !== null) {
    throw new Error(
      `memory_events.memoryId must be null for kind "events_purged" (got ${JSON.stringify(event.memoryId)})`,
    );
  }
  if (!MemoryEventKindSchema.safeParse(event.kind).success) {
    throw new Error(
      `memory_events.kind must be one of ${MemoryEventKindSchema.options.join(", ")} (got ${JSON.stringify(event.kind)})`,
    );
  }
  if (containsNulOrLoneSurrogate(event.actor)) {
    throw new Error(
      `memory_events.actor must not contain NUL (U+0000) or a lone surrogate code unit`,
    );
  }
  if (containsNulOrLoneSurrogate(event.meta)) {
    throw new Error(
      `memory_events.meta must not contain NUL (U+0000) or a lone surrogate code unit`,
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
