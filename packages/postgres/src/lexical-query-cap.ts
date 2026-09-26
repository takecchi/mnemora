/**
 * クエリの語数に上限を設ける（Issue #878、2026-09-26、クローン miku の判断）。
 *
 * `mnemora_lexical_query_or`/`mnemora_lexical_query_tsqueries`（`migrations/0009_*.sql`）は
 * クエリを語に分解し、語ごとに `websearch_to_tsquery` を呼んで tsquery を組み立てる。
 * 語数に比例しない形には直せない部分が残る（PostgreSQL 自身の tsquery 表現サイズの
 * 上限・OR で結ぶ構築コストの両方——[ADR 0092](../../../docs/decisions/0092-lexical-or-coverage.md)
 * 追記節参照）。**挙動を変えずに直せる部分は #916 で直した**（`lexical-store.ts` の
 * `buildLexicalSearchSelect` doc 参照）が、その先は「語数そのものに上限を置く」以外の
 * 手が無い。
 *
 * ## 何をするか
 *
 * 1. **重複する語を1つにまとめる。**`mnemora_lexical_query_tsqueries` 自身が
 *    `array_agg(DISTINCT q)` で重複を畳んでいるため（`migrations/0009_*.sql`）、
 *    まとめても最終的な `coverage`/候補集合は変わらない——同じ語を何度呼び出しても
 *    同じ tsquery が1つ増えるだけである。
 * 2. **まとめた後、異なる語が {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えたら、
 *    先頭からその数だけを使う。**超えない限り、**元の文字列を1バイトも変えずに返す**
 *    ——上限に触れない大多数のクエリで、挙動が変わる余地を無くすため。
 *
 * ## 「語」の数え方と、SQL 側とのずれ
 *
 * ここでの分割は、`mnemora_lexical_query_terms`（`migrations/0008_*.sql`:
 * `regexp_replace($1, '[^[:ascii:]]+', ' ', 'g')`）と同じ「非 ASCII の連なりを空白に
 * 落とす」処理を模したうえで、空白区切りに割り、大文字小文字を無視して重複を見る
 * （`'simple'` 辞書が小文字化だけを行い語幹処理をしないことに合わせた、保守的な
 * 一致条件——大文字小文字だけが違う語は SQL 側でも同じ tsquery になるので、ここで
 * まとめても結果は変わらない）。
 *
 * **⚠ これは `mnemora_lexical_query_tsqueries` の分割規則と完全には一致しない。**
 * 具体的にずれうる点:
 * - SQL 側は各語を `websearch_to_tsquery` に通した**後**の tsquery 値で重複を見る
 *   （`array_agg(DISTINCT q)`）。ここでは通す**前**の生の文字列（大文字小文字だけ
 *   畳んだもの）で重複を見ている。記号の混じり方が違うだけで同じ tsquery になる語
 *   （例: 引用符の有無）を、ここでは「別の語」と数えることがある。
 * - SQL 側は `websearch_to_tsquery` が空の tsquery しか作れない語（記号だけの語等）を
 *   数えない（`WHERE q::text <> ''`）。ここではその判定をしていないため、そういう語も
 *   1語と数える。
 *
 * **どちらのずれも、上限を「実際より厳しめ」に効かせる向きにしか働かない**——
 * ここで「別の語」と数えすぎることはあっても、SQL 側が数える語をここで見落として
 * 上限をすり抜けさせることは無い（見落とす向きのずれが無いことの理由: ここでの
 * 分割は SQL 側の分割の**上位集合**——SQL 側が空 tsquery として捨てる語も、SQL 側が
 * tsquery で同一視する語も、ここでは律儀に1語として残す。だから、ここで数えた
 * 「異なる語の数」は SQL 側の「異なる語の数」以上にしかならない）。
 * ⟹ 上限に触れる境界のクエリで、SQL 側の実際の語数より少なめに切り詰める方向にだけ
 * ずれうる（安全側。上限をすり抜けて悪化する方向のずれは無い）。
 */
export const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 64;

/**
 * `query` の異なる語（`mnemora_lexical_query_terms` と同じ「非 ASCII の連なりを空白に
 * 落とす」処理を経た、空白区切りの語。大文字小文字は無視して重複を見る）が
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えるとき、先頭からその数だけを空白で
 * つないだ文字列を返す。超えなければ `query` をそのまま返す（1バイトも変えない）。
 *
 * `mnemora_lexical_query_or`/`mnemora_lexical_query_tsqueries`/`mnemora_lexical_coverage`
 * （`migrations/0009_*.sql`）へ渡す**前**に、呼ぶ側（`lexical-store.ts`/
 * `trigram-lexical-store.ts`）がこれを通す。
 *
 * **非 ASCII（日本語等）の語はここで落ちる**——`mnemora_lexical_query_terms` が
 * クエリ側の非 ASCII を落とすのと同じ理由（`lexical-store.ts` の
 * `buildLexicalSearchSelect` doc「本文側と query 側で、通す関数が違う」参照。日本語は
 * クエリ側に残しても真陽性を生まない）。**`PostgresTrigramLexicalStore` の日本語側の
 * 語彙判定（`mnemora_trigram_query_nonascii`/`word_similarity`）には、この関数の戻り値
 * ではなく元の `query` をそのまま渡すこと**——この関数は ASCII 語彙チャンネル専用の
 * 上限であり、トライグラム側の日本語処理を切り詰めるものではない
 * （`buildTrigramLexicalSearchSelect` 参照）。
 */
export function capLexicalQueryWords(query: string): string {
  // [:ascii:]（0x00–0x7F）を字句どおり再現するために制御文字の範囲を含める必要がある
  // （migrations/0008_*.sql の同名の POSIX クラスと同じ範囲）。
  // eslint-disable-next-line no-control-regex
  const asciiOnly = query.replace(/[^\x00-\x7f]+/g, " ");
  const rawTokens = asciiOnly
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  const seenLowercased = new Set<string>();
  const distinctInFirstSeenOrder: string[] = [];
  for (const token of rawTokens) {
    const key = token.toLowerCase();
    if (!seenLowercased.has(key)) {
      seenLowercased.add(key);
      distinctInFirstSeenOrder.push(token);
    }
  }

  if (distinctInFirstSeenOrder.length <= LEXICAL_QUERY_MAX_DISTINCT_WORDS) {
    return query;
  }
  return distinctInFirstSeenOrder.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" ");
}
