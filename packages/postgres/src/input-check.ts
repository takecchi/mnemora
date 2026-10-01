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
