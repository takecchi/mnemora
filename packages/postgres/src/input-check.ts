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
 * 以前は `content`・`contentHash` 以外は DB の生の例外（`DrizzleQueryError`。`text` 列は `invalid byte sequence for
 * encoding "UTF8": 0x00`、`jsonb` 列は `unsupported Unicode escape sequence`）だった。断る入力は増やさない。
 * 欄名と文面は testkit の `InMemoryMemoryStore` と同じ（`<owner>: <欄> must not contain NUL characters (U+0000)`）。
 *
 * ⚠ `content` はここで見ない。保存できない候補を落とすとき（`createMemoriesWithOutboxAndEvents`・ADR 0347）、
 * 落とした候補の説明は DB の例外の `code`（`22021`）と文面から作られる（`describeDroppedCandidate`）。
 * 本文の NUL の形を変えるかどうかは、この変更の外（ADR 0499 の「採らなかった案」）。
 */
export function assertNoNulInNewMemory(
  owner: string,
  input: {
    contentHash: string;
    digest: string;
    tags: readonly string[];
    extractorVersion?: string | null | undefined;
    claimKey?: { subject: string; predicate: string } | null | undefined;
    attributes?: unknown;
    provenance: unknown;
  },
): void {
  assertNoNul(owner, "contentHash", input.contentHash);
  assertNoNul(owner, "digest", input.digest);
  input.tags.forEach((tag) => assertNoNul(owner, "tags", tag));
  if (typeof input.extractorVersion === "string") {
    assertNoNul(owner, "extractorVersion", input.extractorVersion);
  }
  if (input.claimKey !== undefined && input.claimKey !== null) {
    assertNoNul(owner, "claimKey.subject", input.claimKey.subject);
    assertNoNul(owner, "claimKey.predicate", input.claimKey.predicate);
  }
  if (jsonStringsSome(input.attributes ?? {}, hasNul)) {
    throw new Error(`${owner}: attributes must not contain NUL characters (U+0000)`);
  }
  if (jsonStringsSome(input.provenance, hasNul)) {
    throw new Error(`${owner}: provenance must not contain NUL characters (U+0000)`);
  }
}

/**
 * ADR 0499（ADR 0456 M4・ADR 0446 の材料）: `memory_events` へ書くイベントの NUL を、DB に触れる前に名指しして断る。
 * 以前は `digestSnapshot`（`text` 列）・`meta`・`actor`（`jsonb` 列）の NUL が DB の生の例外になっていた
 * （`Runtime` の口に渡す `reason` は `meta.reason`/`meta.note` に、`actor.id` は `actor` に入る）。
 * `meta`・`actor` は、対をなさない UTF-16 サロゲートも断る（`jsonb` が拒む——以前から同じ入力で落ちていた）。
 * 文面は testkit の `assertStorableMemoryEvent` と同じ欄名（`memory_events.<欄> must not contain NUL …`）。
 *
 * **イベントを書く文の直前で呼ぶ**（事前の検査より前に置かない）——ほかの理由で先に落ちる入力（status の CAS 違反・
 * 対象が無いなど）は、今までどおりその例外になる。
 */
export function assertNoNulInNewMemoryEvent(
  owner: string,
  event: { actor: unknown; meta: unknown; digestSnapshot?: string | null | undefined },
): void {
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
