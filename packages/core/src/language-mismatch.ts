/**
 * 言語の事後検査。**判定だけをする純関数**であり、公開しない（`index.ts` から export しない。
 * 中身は `runtime.ts` が `created` イベントの `meta.languageMismatch` に写す。ADR 0391）。
 *
 * 観測にはかな・漢字があるのに、記憶の本文にはかな・漢字が1文字も無くラテン文字が大半のとき、
 * 本文が観測と違う言語で書かれた疑いとして印を返す。**印を付けるだけ**で、再試行も全文フォールバックも
 * Memory の書き換えもしない。
 *
 * 取りこぼす側と余計に拾う側の両方が在り、**実データでの偽陽性率・取りこぼし率は測っていない**
 * （ADR 0391）。印は「疑い」であり、門（落とす検査）にしない。閾値は全て偽陽性を避ける側へ倒してある
 * （取りこぼしは承知）。コード片（バッククォート・`&&`・`=>`・`--flag` 等）は言語を持たないので判定自体を
 * せず、URL は数える前に除く。
 */

/** 判定に必要な、本文のラテン文字の最小数。短い固有名詞・コマンド（`Tokyo Disneyland`）を弾く。 */
export const LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS = 20;
/** 判定に必要な、本文の「小文字だけでできた語」の最小数。固有名詞の羅列を弾く。 */
export const LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS = 3;
/** 本文の文字（`\p{L}`）のうちラテン文字が占める割合の下限（「大半」）。 */
export const LANGUAGE_MISMATCH_MIN_LATIN_SHARE = 0.9;
/** 観測を日本語（かな・漢字）とみなす、かな・漢字の最小数。 */
export const LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS = 4;
/** 観測の（かな・漢字 + ラテン文字）のうち、かな・漢字が占める割合の下限。 */
export const LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE = 0.3;

/** 言語の取り違えの疑い。`created` イベントの `meta.languageMismatch` に、そのまま入る。 */
export interface LanguageMismatch {
  /**
   * 判定規則の名前。判定の基準（何を取り違えとみなすか）を変えたときに名前を変え、過去の印と区別できるようにする。
   * 数え方の修正（基準はそのままで、数え間違いを直す）だけなら名前は変えない。
   */
  rule: "cjk_observation_latin_content";
  /** 本文のラテン文字の数（URL を除いた後）。 */
  contentLatinLetters: number;
  /** 本文の文字のうちラテン文字が占める割合（小数第2位まで）。 */
  contentLatinShare: number;
}

const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
// ラテン文字の「文字」だけを数える。`Script=Latin` にはローマ数字（U+2160〜2188、Nl）のような文字でない
// ものも入り、そのまま数えると割合が1を超える。
const LATIN = /(?=\p{L})\p{Script=Latin}/gu;
const LETTER = /\p{L}/gu;
const URL_PATTERN = /https?:\/\/\S+/gi;
// バッククォート・括弧の記号・パイプ・`&&`・`=>`・`--flag`・パス（`./x`・`/usr/bin`）。
// `;` `$` `/` 単独は散文にも出るので入れない。
const CODE_MARKER = /[`{}<>|\\]|&&|=>|(?:^|\s)--[a-z]|(?:^|\s)\.{0,2}\/[\w.-]+/;
const LOWERCASE_WORD = /^[a-z]+(?:'[a-z]+)?[.,!?;:]?$/;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * 観測の本文の文字種の数（かな・漢字、ラテン文字）。**観測ごとに1回**数えて、候補ごとの判定
 * （`detectLanguageMismatchFromProfile`）へ使い回す（ADR 0507）。数えるのは観測の本文だけで、
 * 候補（本文）には依らない。
 */
export interface ObservationLanguageProfile {
  readonly cjk: number;
  readonly latin: number;
}

/** 観測の本文を数える。本文の長さに比例する（33万字で数十 ms）ので、観測ごとに1回だけ呼ぶこと。 */
export function profileObservationLanguage(observationText: string): ObservationLanguageProfile {
  const cjk = count(observationText, CJK);
  // かな・漢字が下限に満たなければ、ラテン文字は判定に使われない（数えない）。
  const latin =
    cjk < LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS ? 0 : count(observationText, LATIN);
  return { cjk, latin };
}

/**
 * 観測の本文（`observationText`）と、抽出された記憶の本文（`content`）から、
 * 言語の取り違えの疑いを返す。疑いが無ければ `null`。
 */
export function detectLanguageMismatch(
  observationText: string,
  content: string,
): LanguageMismatch | null {
  return detectLanguageMismatchFromProfile(profileObservationLanguage(observationText), content);
}

/** `detectLanguageMismatch` の、観測の数えを済ませた版（結果は同じ）。 */
export function detectLanguageMismatchFromProfile(
  observation: ObservationLanguageProfile,
  content: string,
): LanguageMismatch | null {
  const observationCjk = observation.cjk;
  if (observationCjk < LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS) return null;
  const observationLatin = observation.latin;
  if (
    observationCjk / (observationCjk + observationLatin) <
    LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE
  ) {
    return null;
  }
  // 本文にかな・漢字が1文字でもあれば、日本語で書こうとした本文として扱う。
  if (count(content, CJK) > 0) return null;
  if (CODE_MARKER.test(content)) return null;
  const prose = content.replace(URL_PATTERN, " ");
  const latinLetters = count(prose, LATIN);
  if (latinLetters < LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS) return null;
  const share = latinLetters / count(prose, LETTER);
  if (share < LANGUAGE_MISMATCH_MIN_LATIN_SHARE) return null;
  const lowercaseWords = prose.split(/\s+/).filter((word) => LOWERCASE_WORD.test(word)).length;
  if (lowercaseWords < LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS) return null;
  return {
    rule: "cjk_observation_latin_content",
    contentLatinLetters: latinLetters,
    contentLatinShare: Math.round(share * 100) / 100,
  };
}
