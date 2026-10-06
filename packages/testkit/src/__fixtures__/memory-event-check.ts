import type { NewMemoryEvent } from "@mnemora/core";
import { MemoryEventKindSchema } from "@mnemora/core";
import { assertInt4Column, assertWrittenTimestamptzFloor, stringHasNul } from "./query-check.js";

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
 * 関数・Symbol が混ざっていても、ここでは無視して先へ進む。BigInt は {@link containsBigInt} が
 * 別に、この関数より前に検査する——{@link assertStorableMemoryEvent} の doc コメント参照）。
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
 * `value`（`event.actor` か `event.meta`）の中に BigInt の値が無いか（Issue #1384）。
 *
 * JS のプレーンオブジェクト・配列のキーは常に文字列（BigInt をキーにはできない）なので、
 * 値だけを辿れば足りる——{@link containsNulOrLoneSurrogate} と違い、キー自体は検査しない。
 * プレーンな配列・オブジェクトだけを再帰する（`containsNulOrLoneSurrogate` と同じ形）。
 */
function containsBigInt(value: unknown): boolean {
  if (typeof value === "bigint") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((v) => containsBigInt(v));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => containsBigInt(v));
  }
  return false;
}

/**
 * `memory_events` の1行として書けるイベントかを確かめる（Postgres が拒む入力を、同じ入力で拒む）。
 *
 * - `actor`・`meta` に BigInt の値（入れ子・配列の要素も）があれば、**最初に**拒む（Issue #1384）。
 *   `packages/postgres` は `event.actor`・`event.meta` を丸ごと `JSON.stringify(...)::jsonb` で
 *   書く（`event-store.ts`・`memory-store.ts`）——`JSON.stringify` は BigInt を渡されると
 *   `TypeError: Do not know how to serialize a BigInt` を投げる。この関数もそれと**同じ型
 *   （`TypeError`）・同じ文言**で投げる。
 *   ⚠ **この検査は他のどの検査よりも先に置く。**`packages/postgres` の `EventStore.append` は
 *   `INSERT` 文の引数（`actor`・`meta` を含む）を**すべて JS 側で評価してから**初めて DB へ
 *   問い合わせを送る——`actor`/`meta` の `JSON.stringify` が BigInt で例外を投げると、その時点で
 *   問い合わせ自体が一切送られない。⟹ `kind` が列挙に無くても・`memoryId` が実在しなくても・
 *   `at` が Invalid Date でも・`actor`/`meta` に NUL/孤立サロゲートがあっても、**BigInt が
 *   どこかに在れば、それらの検査を Postgres 自身が行う機会が無いまま `TypeError` になる**
 *   （【実測 2026-09-29】`kind` 不正・`at` Invalid Date・`memoryId` 実在しない、のそれぞれと
 *   `meta` の BigInt を同時に渡し、すべて `TypeError: Do not know how to serialize a BigInt`
 *   になることを確かめた。`memory_events_check`・`memory_events_kind_check`・外部キー・NUL の
 *   拒否は、どれも BigInt が無い場合にだけ実際に働く）。
 * - `at`: Invalid Date（`.getTime()` が `NaN`）なら拒む（Issue #807）。省略（`undefined`）は
 *   「無い」であって Invalid Date ではないので検査しない。
 * - `kind`: `MemoryEventKind` に無い値なら拒む（Issue #1096）。`events_purged` で `memoryId` が null でなければ拒む
 *   （Postgres の `memory_events_check`）。Postgres は CHECK 制約
 *   `memory_events_kind_check` で拒む。型を外した呼び出し・JavaScript からの呼び出しで届く。
 * - `actor`・`meta`: NUL（U+0000）か孤立サロゲートを含む文字列（キーも値も、入れ子の中も）が
 *   あれば拒む（Issue #1211）。Postgres は `JSON.stringify(actor)`/`JSON.stringify(meta)` を
 *   `::jsonb` に渡す時点で拒む——`Runtime` の口に渡す `reason`（`meta.reason`/`meta.note` に入る）と
 *   `actor.id` に届く。**関数・Symbol はこの検査の対象外**——{@link assertCloneableMemoryEvent}
 *   が別に扱う。
 *
 * `buildStoredMemoryEvent` が呼ぶほか、呼び手のイベントを受け取る `InMemoryMemoryStore` の口は、
 * **状態を書き換える前に**これを呼ぶ——Postgres は1トランザクションで巻き戻るので、拒んだときに
 * 何も書かない。それを写す。
 */
export function assertStorableMemoryEvent(
  event: NewMemoryEvent,
  opts?: { skipAtFloor?: boolean },
): void {
  if (containsBigInt(event.actor) || containsBigInt(event.meta)) {
    throw new TypeError(`Do not know how to serialize a BigInt`);
  }
  if (event.at !== undefined && Number.isNaN(event.at.getTime())) {
    throw new Error(`memory_events.at must be a valid Date (got Invalid Date)`);
  }
  // ADR 0640: `at` は `timestamptz` 列。下限（4714-11-24 BC 00:00:00 UTC）より前は、Postgres が行を書くときに `22008` で拒む。
  // `skipAtFloor` は、そのイベントを**書かない**かもしれない呼び手（`supersedeWithNewMemories` の事前検査。CAS に弾かれる対象は
  // イベントを書かず、Postgres は `at` を見ない）が、下限だけを後の「書く」分岐へ回すためのもの（Invalid Date は今までどおり先に見る）。
  if (opts?.skipAtFloor !== true) {
    assertWrittenTimestamptzFloor("memory_events", "at", event.at);
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
  // ADR 0434: `digest_snapshot` は `text` 列で、Postgres は NUL を拒む（`22021`）。孤立サロゲートは拒まない
  // （node-postgres が U+FFFD へ置き換える）ので、ここでは NUL だけを見る。
  if (stringHasNul(event.digestSnapshot)) {
    throw new Error(`memory_events.digestSnapshot must not contain NUL characters (U+0000)`);
  }
  // ADR 0434: `size_before_bytes` は `integer`（int4）列。整数でない・`NaN`・`Infinity`・範囲外（`-2^31` 未満、
  // `2^31 - 1` 超）は Postgres が `22P02`・`22003` で拒む。負の数そのものは拒まない（列に CHECK は無い）。
  //
  // ⚠ `markContestedGroup`・`resolveContestedGroup` だけは、Postgres が複数のイベントを1つの `jsonb` の配列で渡す
  // （`insertMemoryEventsBatch`）ので、`NaN`・`±Infinity` は `JSON.stringify` で `null` になって通る（【実測】。`1.5`・範囲の外は
  // 他の口と同じく拒む）。その2つの口は、この関数を呼ぶ前に {@link asJsonSerializedSizeBeforeBytes} で `null` に置き換える。
  assertInt4Column("memory_events", "sizeBeforeBytes", event.sizeBeforeBytes);
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

/**
 * イベントを、Postgres が `jsonb` の配列（`JSON.stringify`）で渡したときに届く形にする（ADR 0434）。`sizeBeforeBytes` の
 * `NaN`・`±Infinity` は `JSON.stringify` で `null` になり、`integer` 列へ `NULL` として入る。`markContestedGroup`・
 * `resolveContestedGroup`（`insertMemoryEventsBatch`）だけがこの経路で、他の口は `jsonb` を通らず、`NaN` を `22P02` で拒む。
 */
export function asJsonSerializedSizeBeforeBytes(event: NewMemoryEvent): NewMemoryEvent {
  const size = event.sizeBeforeBytes;
  return typeof size === "number" && !Number.isFinite(size)
    ? { ...event, sizeBeforeBytes: null }
    : event;
}
