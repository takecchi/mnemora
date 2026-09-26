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
 * 0. **クエリ全体の文字数が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、
 *    先頭からその文字数に切り詰める。**これは他のどの段よりも先に行う——以降の
 *    段（分割・重複まとめ・語数・1語の文字数）は、すべてこの時点で既に短くなった
 *    入力に対して行われる。語数・1語の文字数の上限（1〜3）を組み合わせても、
 *    なお大きな入力を許しうる場合があるため、入力そのものを先に縮める1段を
 *    独立に持つ（{@link LEXICAL_QUERY_MAX_TOTAL_CHARS} の doc 参照）。
 * 1. **重複する語を1つにまとめる。**`mnemora_lexical_query_tsqueries` 自身が
 *    `array_agg(DISTINCT q)` で重複を畳んでいるため（`migrations/0009_*.sql`）、
 *    まとめても最終的な `coverage`/候補集合は変わらない——同じ語を何度呼び出しても
 *    同じ tsquery が1つ増えるだけである。
 * 2. **まとめた後、異なる語が {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えたら、
 *    先頭からその数だけを使う。**超えない限り、**元の文字列を1バイトも変えずに返す**
 *    ——上限に触れない大多数のクエリで、挙動が変わる余地を無くすため。
 * 3. **語**（空白を含まない、連続した非空白文字の並び）**が
 *    {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える文字数を持つ場合、その語自体も
 *    先頭からその文字数に切り詰める。**語数の上限（1・2）だけでは大きな入力を
 *    抑えきれない場合があるため（{@link LEXICAL_QUERY_MAX_WORD_CHARS} の doc 参照）。
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
 * クエリ全体の文字数の上限（Issue #878、2026-09-26、クローン miku の判断）。
 *
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS}（語数）と
 * {@link LEXICAL_QUERY_MAX_WORD_CHARS}（1語の文字数）を両方とも上限まで使った入力は、
 * この2つの上限だけでは十分に小さくならない場合がある。**⟹ クエリ全体の文字数にも、
 * 独立した上限を置く。**
 *
 * この上限は、他の上限（語数・1語の文字数）より**先に**適用する——クエリ全体を
 * 先頭からこの文字数に切り詰めてから、残りの段（語への分割・重複まとめ・語数・
 * 1語の文字数）を行う（`capLexicalQueryWords` 参照）。
 *
 * **ASCII 側・日本語側（`PostgresTrigramLexicalStore` の非 ASCII 側）の両方に、
 * 同じ1つの上限として当てる**（軸を分けない）——`PostgresTrigramLexicalStore` は
 * ASCII 側の処理（`capLexicalQueryWords`）と日本語側の処理
 * （`mnemora_trigram_query_nonascii` に渡す SQL 側の抽出）の両方に、この上限で
 * 切り詰めた**同じ**文字列を渡す（`buildTrigramLexicalSearchSelect` 参照）。
 * 日本語側は独自の文字数の上限（{@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS}）を
 * 別に持っているが、それは分かち書きをしない非 ASCII の連なり**だけ**を見た上限であり、
 * クエリ全体（ASCII と非 ASCII が混在した生の文字列）を見るこの上限とは対象が異なる
 * ——両方が独立に効く。
 *
 * 値は、自然文の長いクエリ（数百文字程度）を切り詰めないことを条件に選んだ。
 * **これらの上限（語数・1語の文字数・全体の文字数）は、1回の検索にかかる時間を
 * 有界にするためのものであり、時間そのものの上限ではない。**DB 側でも
 * `statement_timeout` を設定して併用することを推奨する（`docs/architecture.md` §5.2.1・
 * `packages/postgres/README.md`「運用」・ADR 0092 追記節）。
 */
export const LEXICAL_QUERY_MAX_TOTAL_CHARS = 600;

/**
 * `query` が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、先頭からその文字数に
 * 切り詰める。超えなければ `query` をそのまま返す（1バイトも変えない）。
 */
export function capLexicalQueryTotalChars(query: string): string {
  return query.length > LEXICAL_QUERY_MAX_TOTAL_CHARS
    ? query.slice(0, LEXICAL_QUERY_MAX_TOTAL_CHARS)
    : query;
}

/**
 * 1語（空白を含まない、連続した非空白文字の並び）の文字数の上限
 * （Issue #878、2026-09-26、クローン miku の判断）。
 *
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS}（語の**数**の上限）だけでは、
 * 大きな入力を抑えきれない場合がある。1語の長さにも上限を置いた。
 *
 * ⟹ 語ごとに、この文字数を超える部分は先頭から切り詰める——上限に触れない
 * 大多数の語（識別子・URL の一部・ハッシュ値等）は1バイトも変わらない。
 */
export const LEXICAL_QUERY_MAX_WORD_CHARS = 64;

/**
 * `query` に3段の上限を通す。**0段目（全体の文字数）を最初に適用してから**、
 * 残りの段（分割・語数・1語の文字数）を行う:
 *
 * 0. `query` 全体が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、先頭から
 *    その文字数に切り詰める。
 * 1〜3. （0段目の結果に対して）異なる語（`mnemora_lexical_query_terms` と同じ
 *    「非 ASCII の連なりを空白に落とす」処理を経た、空白区切りの語。大文字小文字は
 *    無視して重複を見る）が {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えるとき、
 *    先頭からその数だけを空白でつないだ文字列を返す。また、1語が
 *    {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える場合、その語自体も先頭から
 *    その文字数だけに切り詰める（語の途中で切れることがある——
 *    `websearch_to_tsquery` に渡す前の生の文字列を切るだけであり、切れた結果が
 *    意味を持つ単位かどうかは問わない）。
 *
 * **どの上限にも触れなければ、`query` をそのまま返す**（1バイトも変えない）。
 *
 * `mnemora_lexical_query_or`/`mnemora_lexical_query_tsqueries`/`mnemora_lexical_coverage`
 * （`migrations/0009_*.sql`）へ渡す**前**に、呼ぶ側（`lexical-store.ts`/
 * `trigram-lexical-store.ts`）がこれを通す。
 *
 * **非 ASCII（日本語等）の語は1〜3段目で落ちる**——`mnemora_lexical_query_terms` が
 * クエリ側の非 ASCII を落とすのと同じ理由（`lexical-store.ts` の
 * `buildLexicalSearchSelect` doc「本文側と query 側で、通す関数が違う」参照。日本語は
 * クエリ側に残しても真陽性を生まない）。**`PostgresTrigramLexicalStore` の日本語側の
 * 語彙判定（`mnemora_trigram_query_nonascii`/`word_similarity`）には、この関数の
 * 戻り値ではなく {@link capLexicalQueryTotalChars} だけを通した文字列を渡すこと**
 * ——0段目（全体の文字数）は ASCII・日本語の両方に共通で効かせるが、1〜3段目
 * （語への分割・語数・1語の文字数）は ASCII 語彙チャンネル専用であり、日本語処理を
 * 切り詰めるものではない（日本語側の文字数の上限は
 * {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS} が別に持つ。
 * `buildTrigramLexicalSearchSelect` 参照）。
 */
export function capLexicalQueryWords(query: string): string {
  // 0. クエリ全体の文字数（他のどの段よりも先に適用する。このファイル冒頭の doc・
  // LEXICAL_QUERY_MAX_TOTAL_CHARS の doc 参照）。
  const totalCapped = capLexicalQueryTotalChars(query);
  const wasTotalCapped = totalCapped !== query;

  // [:ascii:]（0x00–0x7F）を字句どおり再現するために制御文字の範囲を含める必要がある
  // （migrations/0008_*.sql の同名の POSIX クラスと同じ範囲）。
  // eslint-disable-next-line no-control-regex
  const asciiOnly = totalCapped.replace(/[^\x00-\x7f]+/g, " ");
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

  if (
    !wasTotalCapped &&
    !hasOverlongWord &&
    distinctInFirstSeenOrder.length <= LEXICAL_QUERY_MAX_DISTINCT_WORDS
  ) {
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
 * `word_similarity` に渡す（`buildTrigramLexicalSearchSelect` 参照）。この文字列にも
 * 上限を置いた。
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
