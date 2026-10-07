import type { NewMemoryEvent } from "@mnemora/core";
import { MemoryEventKindSchema } from "@mnemora/core";
import { assertInt4Column, assertWrittenTimestamptzFloor, stringHasNul } from "./query-check.js";

/** 文字列 `value` が、Postgres の `jsonb` が拒む文字（NUL、孤立サロゲート）を含むか。対になったサロゲートペアは拒まない。 */
function hasNulOrLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // 直後が対になる下位サロゲートなら有効なペア。
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** `value`（`event.actor` か `event.meta`）の中に、NUL か孤立サロゲートを含む文字列（キー・値とも）が無いか。`JSON.stringify` を経由しない（関数・Symbol は無視する）。 */
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

/** `value` の中に BigInt の値が無いか。プレーンオブジェクトのキーは常に文字列なので、値だけを辿る。 */
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
 * 呼び手のイベントを受け取る口は、状態を書き換える前にこれを呼ぶ（Postgres は1トランザクションで巻き戻るので、拒んだら何も書かない）。
 */
export function assertStorableMemoryEvent(
  event: NewMemoryEvent,
  opts?: { skipAtFloor?: boolean },
): void {
  // BigInt の検査は他のどの検査よりも先に置く: Postgres の `append` は `JSON.stringify` を JS 側で先に評価するので、
  // BigInt があると他の検査（kind・外部キー・NUL など）が DB に届く前に `TypeError` になる。
  if (containsBigInt(event.actor) || containsBigInt(event.meta)) {
    throw new TypeError(`Do not know how to serialize a BigInt`);
  }
  if (event.at !== undefined && Number.isNaN(event.at.getTime())) {
    throw new Error(`memory_events.at must be a valid Date (got Invalid Date)`);
  }
  // `skipAtFloor`: そのイベントを書かないかもしれない呼び手（CAS に弾かれる対象は `at` を見られない）が、下限だけを後の書く分岐へ回すためのもの。
  if (opts?.skipAtFloor !== true) {
    assertWrittenTimestamptzFloor("memory_events", "at", event.at);
  }
  // `events_purged` は特定の Memory を指さない（`memory_events_check`）。
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
  // `text` 列。Postgres は NUL を拒む。孤立サロゲートは node-postgres が U+FFFD へ置き換えるので、NUL だけを見る。
  if (stringHasNul(event.digestSnapshot)) {
    throw new Error(`memory_events.digestSnapshot must not contain NUL characters (U+0000)`);
  }
  // `integer`（int4）列。負の数そのものは拒まない（列に CHECK は無い）。
  // `markContestedGroup`・`resolveContestedGroup` だけは、Postgres が `jsonb` の配列で渡すので `NaN`・`±Infinity` が `null` になって通る。
  // その2つの口は、この関数の前に {@link asJsonSerializedSizeBeforeBytes} で `null` に置き換える。
  assertInt4Column("memory_events", "sizeBeforeBytes", event.sizeBeforeBytes);
}

/** `structuredClone` で写せないイベント（`actor`・`meta` に関数・Symbol）なら、状態を書き換える前に同じ `DataCloneError` を投げる。イベントを必ず書く口でだけ呼ぶこと（CAS に弾かれる対象に呼ぶと、今まで投げなかった入力で投げる）。 */
export function assertCloneableMemoryEvent(event: NewMemoryEvent): void {
  structuredClone({ actor: event.actor, meta: event.meta });
}

/** イベントを、Postgres が `jsonb` の配列で渡したときに届く形にする。`sizeBeforeBytes` の `NaN`・`±Infinity` は `null` になる。 */
export function asJsonSerializedSizeBeforeBytes(event: NewMemoryEvent): NewMemoryEvent {
  const size = event.sizeBeforeBytes;
  return typeof size === "number" && !Number.isFinite(size)
    ? { ...event, sizeBeforeBytes: null }
    : event;
}
