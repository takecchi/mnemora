/**
 * クエリの語数・語ごとの文字数に上限を設ける（Issue #878、2026-09-26、クローン miku の判断）。
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
 * 3. **語**（空白を含まない、連続した非空白文字の並び）**が
 *    {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える文字数を持つ場合、その語自体も
 *    先頭からその文字数に切り詰める。**空白による語数の上限（1・2）だけでは、
 *    空白を1つも含まない代わりに記号だけで長くつないだ「1語」を防げないため
 *    （{@link LEXICAL_QUERY_MAX_WORD_CHARS} の doc 参照）。
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
export const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 32;

/**
 * 1語（空白を含まない、連続した非空白文字の並び）の文字数の上限
 * （Issue #878、2026-09-26、クローン miku の判断）。
 *
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS}（語の**数**の上限）だけでは、
 * 空白を1つも含まない代わりに記号（`-`/`.` 等）だけで長くつないだ「1語」を防げない。
 * `websearch_to_tsquery` は語の中の記号も区切りとして解釈するため、空白の無い1語の
 * 中に大量の区切りが入っていると、その1語だけで `mnemora_lexical_coverage`/
 * `mnemora_lexical_query_or` の計算量が語数の上限とは無関係に膨らむ
 * （実測はマネージャーへの報告のみに残す。具体的な文字数・秒数・入力の形は
 * ここには書かない）。
 *
 * ⟹ 語ごとに、この文字数を超える部分は先頭から切り詰める——上限に触れない
 * 大多数の語（識別子・URL の一部・ハッシュ値等）は1バイトも変わらない。
 */
export const LEXICAL_QUERY_MAX_WORD_CHARS = 64;

/**
 * `query` の異なる語（`mnemora_lexical_query_terms` と同じ「非 ASCII の連なりを空白に
 * 落とす」処理を経た、空白区切りの語。大文字小文字は無視して重複を見る）が
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えるとき、先頭からその数だけを空白で
 * つないだ文字列を返す。また、1語が {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える場合、
 * その語自体も先頭からその文字数だけに切り詰める（語の途中で切れることがある——
 * `websearch_to_tsquery` に渡す前の生の文字列を切るだけであり、切れた結果が
 * 意味を持つ単位かどうかは問わない）。**どちらの上限にも触れなければ、`query` を
 * そのまま返す**（1バイトも変えない）。
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
 * （日本語側の文字数の上限は {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS} が別に持つ。
 * `buildTrigramLexicalSearchSelect` 参照）。
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

  const hasOverlongWord = rawTokens.some((token) => token.length > LEXICAL_QUERY_MAX_WORD_CHARS);
  const truncatedTokens = hasOverlongWord
    ? rawTokens.map((token) => token.slice(0, LEXICAL_QUERY_MAX_WORD_CHARS))
    : rawTokens;

  const seenLowercased = new Set<string>();
  const distinctInFirstSeenOrder: string[] = [];
  for (const token of truncatedTokens) {
    const key = token.toLowerCase();
    if (!seenLowercased.has(key)) {
      seenLowercased.add(key);
      distinctInFirstSeenOrder.push(token);
    }
  }

  if (!hasOverlongWord && distinctInFirstSeenOrder.length <= LEXICAL_QUERY_MAX_DISTINCT_WORDS) {
    return query;
  }
  return distinctInFirstSeenOrder.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS).join(" ");
}

/**
 * `PostgresTrigramLexicalStore` の日本語（非 ASCII）側の語彙判定
 * （`mnemora_trigram_query_nonascii`/`word_similarity`）に渡す文字列の文字数の上限
 * （Issue #878、2026-09-26、クローン miku の判断）。
 *
 * {@link LEXICAL_QUERY_MAX_WORD_CHARS} とは別の軸——ASCII 側は「語」単位（空白区切り）
 * で切り詰めるが、日本語側は分かち書きをせず、非 ASCII の連なり全体を1つの文字列として
 * `word_similarity` に渡す（`buildTrigramLexicalSearchSelect` 参照）。この文字列自体が
 * 長いと、`word_similarity`（トライグラムの生成・比較）の計算量が文字数に応じて
 * 膨らむ（実測はマネージャーへの報告のみに残す）。
 *
 * ⟹ 非 ASCII の連なりが長い場合、先頭からこの文字数だけに切り詰めてから
 * `word_similarity` に渡す——上限に触れない大多数の日本語クエリは1バイトも変わらない。
 *
 * **⚠ この上限は TypeScript の関数としては実装されていない。**`mnemora_trigram_query_nonascii`
 * による非 ASCII の抽出自体が SQL 側（`buildTrigramLexicalSearchSelect` が組み立てる
 * `SELECT`）で行われるため、抽出結果を TypeScript 側で受け取ってから切り詰めることが
 * できない——`buildTrigramLexicalSearchSelect` が生成する SQL の中で、抽出結果に直接
 * `LEFT(..., {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS})` を掛ける形で実装している
 * （`jaTerm` の組み立てを参照）。
 */
export const TRIGRAM_JAPANESE_QUERY_MAX_CHARS = 100;
