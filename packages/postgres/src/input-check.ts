// 入口の検査（DB に触れる前に、明示の例外で断る）。穴 O-6（ADR 0424）。
// `packages/testkit` の in-memory 実装が同じ入力を同じ文面で断る（適合テストが両方を縛る）。

/**
 * Postgres の `text` 型は NUL (U+0000) を構造的に拒む（C 文字列表現に由来する制約）。以前は DB の生の例外
 * （`invalid byte sequence for encoding "UTF8": 0x00`）が出ていた。DB に触れる前に、何が悪いかを名指しして断る。
 * 識別子（tenantId など）の NUL は、ここでは扱わない。
 */
export function assertNoNul(owner: string, field: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`${owner}: ${field} must not contain NUL characters (U+0000)`);
  }
}

/**
 * pgvector の `vector` の成分は float4 で、収まらない値（`1e308` など。有限でない値も含む）は
 * `"1e+308" is out of range for type vector` 等の生の例外になる。DB に触れる前に断る。
 * `Math.fround` が有限に収まるかで見る（pgvector の float4 への変換と同じ丸め）。
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
 * ADR 0456: 読み取りの絞り（`labels`・`attributes`）の NUL を、DB に触れる前に名指しして断る。
 * 以前は、`labels` の NUL が `invalid byte sequence for encoding "UTF8": 0x00`、`attributes` の NUL が
 * `unsupported Unicode escape sequence` という DB の生の例外（`Failed query: …`）になっていた。
 * 断る入力は増やさない（以前も同じ入力で落ちていた）。`attributes` は key と value の両方を見る。
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

/** `value`（JSON にする値）の中の文字列（オブジェクトの key も）のどれかが `pred` を満たすか。循環は辿り直さない。 */
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
 * ADR 0499（ADR 0456 M4）: `memories` へ書く値の NUL を、DB に触れる前に名指しして断る。
 * 以前は `contentHash` 以外は DB の生の例外（`DrizzleQueryError`。`text` 列は `invalid byte sequence for
 * encoding "UTF8": 0x00`、`jsonb` 列は `unsupported Unicode escape sequence`）だった。断る入力は増やさない。
 * 欄名・検査の順・文面は testkit の `InMemoryMemoryStore` と同じ（`<owner>: <欄> must not contain NUL characters (U+0000)`）。
 *
 * 型を外れた値（文字列でない・欠けている欄）はここでは見ない——以前と同じ経路（DB の検査）に任せる。
 * 断るのは「文字列で、NUL を含む」ものだけ。
 *
 * 🔴 `content` も見る。抽出の候補の `digest` は、LLM が `digest` を返さないとき本文から作られる（本文に NUL があれば
 * `digest` にも入る）ので、`digest` だけ見ると、本文の NUL を「digest が悪い」と説明してしまう。保存できない候補を落とすとき
 * （ADR 0347）、落とした候補の説明（`describeDroppedCandidate`）は、以前の DB の例外（`code: "22021"`・pg の文面）から、
 * この名指しの例外（`code: null`・`content must not contain NUL …`）に変わる——testkit の fixture と同じ形。
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
 * ADR 0499（ADR 0456 M4・ADR 0446 の材料）: `memory_events` へ書くイベントの NUL を、DB に触れる前に名指しして断る。
 * 以前は `digestSnapshot`（`text` 列）・`meta`・`actor`（`jsonb` 列）の NUL が DB の生の例外になっていた
 * （`Runtime` の口に渡す `reason` は `meta.reason`/`meta.note` に、`actor.id` は `actor` に入る）。
 * `meta`・`actor` は、対をなさない UTF-16 サロゲートも断る（`jsonb` が拒む——以前から同じ入力で落ちていた）。
 * 文面は testkit の `assertStorableMemoryEvent` と同じ欄名（`memory_events.<欄> must not contain NUL …`）。
 *
 * - **イベントを書く文の直前で呼ぶ**（事前の検査より前に置かない）——ほかの理由で先に落ちる入力（status の CAS 違反・
 *   対象が無いなど）は、今までどおりその例外になる。
 * - **BigInt は NUL より先**に `TypeError`（`JSON.stringify` と同じ文言）で断る。以前は INSERT の引数を JS で組む時点で
 *   `JSON.stringify` が投げ、NUL を DB が見る機会が無かった（`event-meta-roundtrip.postgres.test.ts` が縛る）。
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
 * ADR 0505（ADR 0456 M4 の残り）: `observations` へ書く値の NUL を、DB に触れる前に名指しして断る
 * （`createObservation`・`createObservationWithOutbox`）。以前は DB の生の例外（`DrizzleQueryError`。`kind` は
 * `invalid byte sequence for encoding "UTF8": 0x00`、`payload`・`attributes`（`jsonb`）は `unsupported Unicode escape
 * sequence`）だった。断る入力は増やさない。欄名・検査の順・文面は testkit の `InMemoryMemoryStore` と同じ
 * （`<owner>: <欄> must not contain NUL characters (U+0000)`）。
 *
 * `subjectId`・`externalId` は、`assertWellFormedIdentifier`（ADR 0423）が先に断る（NUL を含む識別子）ので、ここでは見ない。
 * 型を外れた値（文字列でない `kind`）は見ない——以前と同じ経路（DB の検査）に任せる。
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
 * ADR 0505（ADR 0456 M4 の残り）: `recalls` へ書く値（`jsonb` 列）の NUL を、DB に触れる前に名指しして断る
 * （`createRecall`）。以前は `unsupported Unicode escape sequence` の生の例外だった。断る入力は増やさない。
 * 文面は testkit の `InMemoryMemoryStore.createRecall` と同じ（`createRecall: <欄> must not contain NUL characters (U+0000)`）。
 * 欄の順も同じ。`subjectId` は `assertWellFormedIdentifier` が先に断る。JSON にならない値（`undefined` など）は
 * ここでは見ない（以前と同じ経路——`NOT NULL` の列が拒む）。
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
