import { isBeforePgTimestamptzMin } from "./mapping.js";

/**
 * Postgres の `text` 型は NUL (U+0000) を構造的に拒む。DB に触れる前に、何が悪いかを名指しして断る。
 * 識別子（tenantId など）の NUL は、ここでは扱わない。
 */
export function assertNoNul(owner: string, field: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`${owner}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/**
 * `timestamptz` へ渡す日時が Invalid Date（`getTime()` が `NaN`）なら、DB に触れる前に名指しして断る（ADR 0594）。
 * 行を探す前の入口が静かに返る口（`OutboxStore.complete`/`fail` の、形の崩れた `jobId`）では DB まで届かず拒まれないため。
 * 文面は `<owner>: <欄> must be a valid Date (got Invalid Date)`。省略（`undefined`/`null`）は検査しない。
 * 下限は見ない（`assertNotBelowTimestamptzMin` が見る）。
 */
export function assertValidDate(
  owner: string,
  field: string,
  value: Date | null | undefined,
): void {
  if (value != null && Number.isNaN(value.getTime())) {
    throw new Error(`${owner}: ${field} must be a valid Date (got Invalid Date)`);
  }
}

/**
 * 行の値になる日時が `timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）より前なら、DB に触れる前に
 * `RangeError` で断る（ADR 0597）。形の崩れた `jobId` では入口が静かに返り DB が拒まないため。
 * 下限ちょうどは通す。Invalid Date は見ない（`assertValidDate` が先に見る）。省略（`undefined`/`null`）は検査しない。
 * **読みの口の条件には使わない**（ADR 0547: 読みの口は下限へ寄せて比べる）。
 */
export function assertNotBelowTimestamptzMin(
  owner: string,
  field: string,
  value: Date | null | undefined,
): void {
  if (value != null && isBeforePgTimestamptzMin(value)) {
    throw new RangeError(
      `${owner}: ${field} must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`,
    );
  }
}

/**
 * pgvector の `vector` の成分は float4 で、収まらない値（有限でない値も含む）は生の例外になる。
 * DB に触れる前に断る。`Math.fround` が有限に収まるかで見る（pgvector の float4 への変換と同じ丸め）。
 */
export function assertFloat4Vector(owner: string, vector: readonly number[]): void {
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i]!;
    if (!Number.isFinite(Math.fround(x))) {
      throw new RangeError(
        `${owner}: vector component [${i}] does not fit in a float4 (pgvector) value (got ${x})`,
      );
    }
  }
}

/** `search` の検索クエリのベクトルが float4 に収まるか（収まらなければ比較不能として扱う。投げない）。 */
export function fitsFloat4(vector: readonly number[]): boolean {
  return vector.every((x) => Number.isFinite(Math.fround(x)));
}

/**
 * 読み取りの絞り（`labels`・`attributes`）の NUL を、DB に触れる前に名指しして断る（ADR 0456）。
 * `attributes` は key と value の両方を見る。
 */
export function assertNoNulInScopeFilter(
  owner: string,
  filter:
    | {
        labels?: readonly string[] | undefined;
        attributes?: Readonly<Record<string, string>> | undefined;
      }
    | null
    | undefined,
  field = "filter",
): void {
  if (typeof filter !== "object" || filter === null) {
    return;
  }
  filter.labels?.forEach((label) => assertNoNul(owner, `${field}.labels`, label));
  if (filter.attributes !== undefined) {
    for (const [key, value] of Object.entries(filter.attributes)) {
      assertNoNul(owner, `${field}.attributes`, key);
      if (typeof value === "string") {
        assertNoNul(owner, `${field}.attributes`, value);
      }
    }
  }
}

/** `value` の中の文字列（オブジェクトの key も）のどれかが `pred` を満たすか。循環は辿り直さない。 */
function jsonStringsSome(
  value: unknown,
  pred: (text: string) => boolean,
  seen: Set<object> = new Set(),
): boolean {
  if (typeof value === "string") {
    return pred(value);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((v) => jsonStringsSome(v, pred, seen));
  }
  return Object.entries(value).some(([k, v]) => pred(k) || jsonStringsSome(v, pred, seen));
}

const hasNul = (text: string): boolean => text.includes("\u0000");

/** 対をなさない UTF-16 サロゲートコードユニット（`JSON.stringify` は `\udXXX` に直し、`jsonb` はそれを拒む）を含むか。 */
const hasLoneSurrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

/**
 * `memories` へ書く値の NUL を、DB に触れる前に名指しして断る（ADR 0499）。
 * 文面は `<owner>: <欄> must not contain NUL characters (U+0000)`。
 * 型を外れた値（文字列でない・欠けている欄）は見ない。断るのは「文字列で、NUL を含む」ものだけ。
 *
 * `content` も見る。抽出の候補の `digest` は、LLM が返さないとき本文から作られるので、
 * `digest` だけ見ると、本文の NUL を「digest が悪い」と説明してしまう。
 */
export function assertNoNulInNewMemory(
  owner: string,
  input: {
    content: string;
    contentHash: string;
    digest: string;
    tags: readonly string[];
    extractorVersion?: string | null | undefined;
    claimKey?: { subject: string; predicate: string } | null | undefined;
    attributes?: unknown;
    provenance: unknown;
  },
): void {
  const text = (field: string, value: unknown): void => {
    if (typeof value === "string") {
      assertNoNul(owner, field, value);
    }
  };
  text("content", input.content);
  if (Array.isArray(input.tags)) {
    input.tags.forEach((tag) => text("tags", tag));
  }
  text("digest", input.digest);
  text("contentHash", input.contentHash);
  text("extractorVersion", input.extractorVersion);
  text("claimKey.subject", input.claimKey?.subject);
  text("claimKey.predicate", input.claimKey?.predicate);
  if (jsonStringsSome(input.attributes ?? {}, hasNul)) {
    throw new Error(`${owner}: attributes must not contain NUL characters (U+0000)`);
  }
  if (jsonStringsSome(input.provenance, hasNul)) {
    throw new Error(`${owner}: provenance must not contain NUL characters (U+0000)`);
  }
}

/** `value`（JSON にする値）の中に BigInt が在るか。`JSON.stringify` は BigInt を `TypeError` で拒む。 */
function jsonHasBigInt(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value === "bigint") {
    return true;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((v) => jsonHasBigInt(v, seen));
}

/**
 * `memory_events` へ書くイベントの NUL を、DB に触れる前に名指しして断る（ADR 0499）。
 * `meta`・`actor` は、対をなさない UTF-16 サロゲートも断る（`jsonb` が拒む）。
 * 文面は `memory_events.<欄> must not contain NUL …`。
 *
 * - **イベントを書く文の直前で呼ぶ**（事前の検査より前に置かない）。ほかの理由で先に落ちる入力
 *   （status の CAS 違反・対象が無いなど）は、その例外のままにするため。
 * - **BigInt は NUL より先**に `TypeError`（`JSON.stringify` と同じ文言）で断る。`JSON.stringify` が
 *   INSERT の引数を組む時点で投げるので、NUL を DB が見る機会が無い。
 */
export function assertNoNulInNewMemoryEvent(
  owner: string,
  event: { actor: unknown; meta: unknown; digestSnapshot?: string | null | undefined },
): void {
  if (jsonHasBigInt(event.actor) || jsonHasBigInt(event.meta)) {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (jsonStringsSome(event.actor, (t) => hasNul(t) || hasLoneSurrogate(t))) {
    throw new Error(
      `${owner}: memory_events.actor must not contain NUL (U+0000) or a lone surrogate code unit`,
    );
  }
  if (jsonStringsSome(event.meta, (t) => hasNul(t) || hasLoneSurrogate(t))) {
    throw new Error(
      `${owner}: memory_events.meta must not contain NUL (U+0000) or a lone surrogate code unit`,
    );
  }
  if (typeof event.digestSnapshot === "string" && hasNul(event.digestSnapshot)) {
    throw new Error(
      `${owner}: memory_events.digestSnapshot must not contain NUL characters (U+0000)`,
    );
  }
}

/**
 * `observations` へ書く値の NUL を、DB に触れる前に名指しして断る（ADR 0505。`createObservation`・
 * `createObservationWithOutbox`）。型を外れた値（文字列でない `kind`）は見ない。
 *
 * `subjectId`・`externalId` は `assertWellFormedIdentifier`（ADR 0423）が先に断るので、ここでは見ない。
 */
export function assertNoNulInNewObservation(
  owner: string,
  input: { kind: unknown; payload: unknown; attributes?: unknown },
): void {
  if (typeof input.kind === "string") {
    assertNoNul(owner, "kind", input.kind);
  }
  if (jsonStringsSome(input.payload, hasNul)) {
    throw new Error(`${owner}: payload must not contain NUL characters (U+0000)`);
  }
  if (jsonStringsSome(input.attributes ?? {}, hasNul)) {
    throw new Error(`${owner}: attributes must not contain NUL characters (U+0000)`);
  }
}

/**
 * `recalls` へ書く値（`jsonb` 列）の NUL を、DB に触れる前に名指しして断る（ADR 0505。`createRecall`）。
 * 文面は `createRecall: <欄> must not contain NUL characters (U+0000)`。`subjectId` は
 * `assertWellFormedIdentifier` が先に断る。JSON にならない値（`undefined` など）は見ない。
 */
export function assertNoNulInNewRecall(record: {
  query: unknown;
  budget?: unknown;
  omitted: unknown;
  usage: unknown;
  indexBand: unknown;
  explain: unknown;
  returnedMemories: unknown;
}): void {
  for (const [field, value] of [
    ["query", record.query],
    ["budget", record.budget],
    ["omitted", record.omitted],
    ["usage", record.usage],
    ["indexBand", record.indexBand],
    ["explain", record.explain],
    ["returnedMemories", record.returnedMemories],
  ] as const) {
    if (jsonStringsSome(value, hasNul)) {
      throw new Error(`createRecall: ${field} must not contain NUL characters (U+0000)`);
    }
  }
}
