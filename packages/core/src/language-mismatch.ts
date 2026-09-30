/**
 * Issue #1370（ADR 0391）: 言語の事後検査。**判定だけをする純関数**であり、公開しない
 * （`index.ts` から export しない。中身は `runtime.ts` が `created` イベントの
 * `meta.languageMismatch` に写す）。
 *
 * 「観測にはかな・漢字があるのに、記憶の本文（content）にはかな・漢字が1文字も無く、
 * ラテン文字が大半」のとき、本文が観測と違う言語（実測の例は英語）で書かれた疑いとして
 * 印を返す。**印を付けるだけ**——再試行も、全文フォールバックも、Memory の書き換えもしない。
 *
 * ⚠ 取りこぼす側（言語の取り違えなのに印が付かない）と、余計に拾う側（取り違えでないのに
 * 印が付く）の両方が在る。**実データでの偽陽性率・取りこぼし率は測っていない**（ADR 0391）。
 * だから印は「疑い」であり、門（落とす検査）にしない。
 *
 * 閾値の根拠（全て偽陽性を避ける側へ倒した。取りこぼしは承知）:
 * - `MIN_CONTENT_LATIN_LETTERS`: 短い本文は言語を言えない。`Tokyo Disneyland`（15字）・
 *   `npm run build`（11字）のような固有名詞・コマンドを弾く下限。
 * - `MIN_CONTENT_LOWERCASE_WORDS`: 英語の文は `the`・`and`・`works` のような小文字始まりの語を
 *   含む。固有名詞の羅列（`Tokyo Disneyland Resort Hotel MiraCosta`）は含まない。
 * - `MIN_LATIN_SHARE`: 「ラテン文字が大半」。他の文字体系が混じる本文を弾く。
 * - `MIN_OBSERVATION_CJK_CHARS` / `MIN_OBSERVATION_CJK_SHARE`: 観測が英語の文に日本語の名前が
 *   1つ混じる程度なら、英語の本文は自然である。日本語の観測とみなす下限。
 * - コード片（バッククォート・`&&`・`=>`・`--flag` 等）と URL は、言語を持たないので、
 *   URL は数える前に除き、コード片は判定自体をしない。
 *
 * ⚠ 上の値は推論であって、実データで当てたものではない（ADR 0391 の【推論】）。
 */

/** 判定に必要な、本文のラテン文字の最小数。`Tokyo Disneyland`（15字）を弾く（>15）。 */
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
  /** 判定規則の名前（規則を変えたときに、過去の印と区別できるようにする）。 */
  rule: "cjk_observation_latin_content";
  /** 本文のラテン文字の数（URL を除いた後）。 */
  contentLatinLetters: number;
  /** 本文の文字のうちラテン文字が占める割合（小数第2位まで）。 */
  contentLatinShare: number;
}

const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN = /\p{Script=Latin}/gu;
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
 * 観測の本文（`observationText`）と、抽出された記憶の本文（`content`）から、
 * 言語の取り違えの疑いを返す。疑いが無ければ `null`。
 */
export function detectLanguageMismatch(
  observationText: string,
  content: string,
): LanguageMismatch | null {
  const observationCjk = count(observationText, CJK);
  if (observationCjk < LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS) return null;
  const observationLatin = count(observationText, LATIN);
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
