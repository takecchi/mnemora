/**
 * クエリの語数・語ごとの文字数に上限を設ける（`mnemora_lexical_query_or`/`mnemora_lexical_query_tsqueries` は
 * 語ごとに `websearch_to_tsquery` を呼ぶので、語数に比例しない形には直せない。ADR 0092）。
 *
 * 適用順（`capLexicalQueryWords`）:
 *
 * 0. クエリ全体が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超えたら先頭から切り詰める。**他のどの段よりも先に**行う。
 * 1. 重複する語（大文字小文字は無視）を1つにまとめる。SQL 側が `array_agg(DISTINCT q)` で畳むので、
 *    まとめても `coverage`/候補集合は変わらない。
 * 2. 異なる語が {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} を超えたら、先頭からその数だけを使う。
 *    超えない限り、**元の文字列を1バイトも変えずに返す**。
 * 3. 1語が {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超えたら、その語を先頭から切り詰める。
 *
 * ## 「語」の数え方と、SQL 側とのずれ
 *
 * 分割は `mnemora_lexical_query_terms`（`migrations/0008_*.sql`）と同じ「非 ASCII の連なりを空白に落とす」処理を
 * 模して空白区切りに割る。**`mnemora_lexical_query_tsqueries` の分割規則とは完全には一致しない**:
 * - SQL 側は `websearch_to_tsquery` を通した**後**の tsquery で重複を見る。ここは通す**前**の生の文字列なので、
 *   記号の混じり方（引用符の有無など）だけが違う語を「別の語」と数えることがある。
 * - SQL 側は空の tsquery にしかならない語（記号だけの語）を数えない（`WHERE q::text <> ''`）。ここは1語と数える。
 *
 * どちらのずれも、ここで数えた語数が SQL 側以上になる向きにしか働かない（ここの分割は SQL 側の上位集合）。
 * 上限をすり抜ける向きのずれは無く、境界のクエリで少なめに切り詰める側にだけずれる。
 */
export const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 32;

/**
 * クエリ全体の文字数の上限。語数と1語の文字数を両方とも上限まで使った入力は、その2つだけでは十分に小さくならないので、
 * 独立に置く。他の上限より**先に**適用する（`capLexicalQueryWords` 参照）。
 *
 * ASCII 側・日本語側（`PostgresTrigramLexicalStore` の非 ASCII 側）の**両方に、同じ1つの上限として**当てる。
 * 日本語側の {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS} は非 ASCII の連なり**だけ**を見た別の上限で、両方が独立に効く。
 *
 * **これらの上限は、1回の検索にかかる時間を有界にするためのものであり、時間そのものの上限ではない。**
 * DB 側にも `statement_timeout` を設定して併用することを推奨する（`packages/postgres/README.md`「運用」、ADR 0092）。
 */
export const LEXICAL_QUERY_MAX_TOTAL_CHARS = 600;

/**
 * `query` が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、先頭からその文字数
 * （UTF-16 コードユニット）以下に切り詰める。超えなければ `query` をそのまま返す（1バイトも変えない）。
 *
 * 境目が書記素の内側（サロゲートペア・結合文字・ZWJ の絵文字列）に当たるときは、その書記素の手前で
 * 切る。上限は「以下に収める」約束（ADR 0092）で、ちょうど600とは約束していない。
 */
export function capLexicalQueryTotalChars(query: string): string {
  return query.length > LEXICAL_QUERY_MAX_TOTAL_CHARS
    ? sliceAtGraphemeBoundary(query, LEXICAL_QUERY_MAX_TOTAL_CHARS)
    : query;
}

/** 1語（空白を含まない、連続した非空白文字の並び）の文字数の上限。超える部分は先頭から切り詰める。 */
export const LEXICAL_QUERY_MAX_WORD_CHARS = 64;

/**
 * `query` に上限（全体の文字数・語数・1語の文字数）を通す。どの上限にも触れなければ `query` をそのまま返す。
 * 語の途中で切れることがある（`websearch_to_tsquery` に渡す前の生の文字列を切るだけ）。
 *
 * `mnemora_lexical_query_or`/`mnemora_lexical_query_tsqueries`/`mnemora_lexical_coverage` へ渡す**前**に、
 * 呼ぶ側がこれを通す。
 *
 * **非 ASCII（日本語等）の語は語数・1語の文字数の段で落ちる**（`mnemora_lexical_query_terms` がクエリ側の
 * 非 ASCII を落とすのと同じ）。**`PostgresTrigramLexicalStore` の日本語側の語彙判定には、この関数の戻り値でなく
 * {@link capLexicalQueryTotalChars} だけを通した文字列を渡すこと。**語数・1語の文字数の段は ASCII 語彙チャンネル
 * 専用で、日本語処理を切り詰めるものではない。
 */
export function capLexicalQueryWords(query: string): string {
  // 全体の文字数の段を、他のどの段よりも先に適用する。
  const totalCapped = capLexicalQueryTotalChars(query);
  const wasTotalCapped = totalCapped !== query;

  // [:ascii:]（0x00–0x7F）を字句どおり再現するために制御文字の範囲を含める（migrations/0008_*.sql と同じ範囲）。
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
 * `PostgresTrigramLexicalStore` の日本語（非 ASCII）側の語彙判定（`mnemora_trigram_query_nonascii`/`word_similarity`）に
 * 渡す文字列の文字数の上限。{@link LEXICAL_QUERY_MAX_WORD_CHARS} とは別の軸で、日本語側は分かち書きをせず、
 * 非 ASCII の連なり全体を1つの文字列として渡すので、その長さに置く。
 *
 * **この上限は TypeScript の関数としては実装されていない。**非 ASCII の抽出自体が SQL 側で行われ、抽出結果を
 * TypeScript 側で受けてから切れないため、`buildTrigramLexicalSearchSelect` が生成する SQL の中で、抽出結果に
 * 直接 `LEFT(..., {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS})` を掛けている。
 */
export const TRIGRAM_JAPANESE_QUERY_MAX_CHARS = 100;

/**
 * `@mnemora/core` の `sliceAtGraphemeBoundary`（`packages/core/src/text-truncation.ts`）の写し。testkit の fixture（`in-memory-lexical-store.ts`）にも同じ写しがある。
 * core から import しないのは、core の内部関数で公開していないため（公開すると公開 API の snapshot が増える）。
 * export しないのは、このパッケージの公開面に出さないため。切り詰めの規則を変えるときは3つとも見ること。
 */
function sliceAtGraphemeBoundary(text: string, maxLength: number): string {
  const limit = Math.max(0, maxLength);
  if (text.length <= limit) {
    return text;
  }
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const next = index + segment.length;
    if (next > limit) {
      break;
    }
    end = next;
  }
  return text.slice(0, end);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
