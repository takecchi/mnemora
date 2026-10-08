import type { TokenCounter } from "./interfaces/token-counter.js";

/** CJK と判定するコードポイント範囲（閉区間、両端含む）。Unicode のブロック単位の固定表で、ブロック改定には追随しない。 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], // ハングル字母 (Hangul Jamo)
  [0x2e80, 0x2eff], // CJK部首補助 (CJK Radicals Supplement)
  [0x2f00, 0x2fdf], // 康熙部首 (Kangxi Radicals)
  [0x3000, 0x303f], // CJK記号・句読点 (CJK Symbols and Punctuation)
  [0x3040, 0x309f], // ひらがな (Hiragana)
  [0x30a0, 0x30ff], // カタカナ (Katakana)
  [0x3100, 0x312f], // 注音 (Bopomofo)
  [0x3130, 0x318f], // ハングル互換字母 (Hangul Compatibility Jamo)
  [0x31a0, 0x31bf], // 注音拡張 (Bopomofo Extended)
  [0x31f0, 0x31ff], // カタカナ音声拡張 (Katakana Phonetic Extensions)
  [0x3200, 0x33ff], // 囲みCJK・CJK互換 (Enclosed CJK Letters and Months, CJK Compatibility)
  [0x3400, 0x4dbf], // CJK統合漢字拡張A (CJK Unified Ideographs Extension A)
  [0x4e00, 0x9fff], // CJK統合漢字 (CJK Unified Ideographs)
  [0xa960, 0xa97f], // ハングル字母拡張A (Hangul Jamo Extended-A)
  [0xac00, 0xd7ff], // ハングル音節+拡張B (Hangul Syllables, Hangul Jamo Extended-B)
  [0xf900, 0xfaff], // CJK互換漢字 (CJK Compatibility Ideographs)
  [0xfe30, 0xfe4f], // CJK互換形 (CJK Compatibility Forms)
  [0xff00, 0xffdf], // 半角・全角形 (Halfwidth and Fullwidth Forms)
  [0x20000, 0x3ffff], // SIP（CJK統合漢字拡張B以降。Supplementary Ideographic Plane）
];

/** すべての CJK 範囲は 0x1100 以上から始まる。それ未満（ASCII を含む）なら判定するまでもなく非CJK。 */
const CJK_RANGE_FLOOR = 0x1100;

function isCjkCodePoint(codePoint: number): boolean {
  if (codePoint < CJK_RANGE_FLOOR) return false;
  return CJK_RANGES.some(([start, end]) => codePoint > start && codePoint <= end);
}

// 係数は「1コードポイントあたり何トークンか」を 20分率の整数比で表す（0.9 = 18/20、0.25 = 5/20）。
// 浮動小数の乗算の丸め差が環境によって出力を変える余地を、整数演算で断つ。
const CJK_WEIGHT_NUMERATOR = 18; // 0.9 トークン/コードポイント
const NON_CJK_WEIGHT_NUMERATOR = 5; // 0.25 トークン/コードポイント（現行の 1/4 を据え置き）
const WEIGHT_DENOMINATOR = 20;

/**
 * 既定の `TokenCounter` 実装。
 *
 * モデル固有のトークナイザに依存しない、コードポイント数ベースの CJK 対応推定
 * （CJK 0.9 トークン/コードポイント、非CJK 0.25 トークン/コードポイント。純ASCIIは `length / 4` 切り上げと同じ値）。
 * **常に `counter: 'heuristic'` を返す**——推定値を実測値の顔で返さない。
 *
 * ## ⚠ 直っていない範囲
 *
 * CJK **以外** の非ラテン文字（キリル文字・タイ文字・アラビア文字、絵文字）は 0.25/字で数えるため、
 * **過小評価する**（o200k_base 実測に対する合計比は タイ語 0.564 / アラビア語 0.813 / キリル文字 0.864）。
 * **厳密さが要る用途では `TokenCounter` を実測トークナイザに差し替えること。**
 *
 * ## ⚠ 対象トークナイザ
 *
 * 係数は `o200k_base`（gpt-4o / gpt-4o-mini 系）に合わせてある。旧世代の `cl100k_base`
 * （gpt-4 / gpt-3.5-turbo / text-embedding-3-*）に対しては日本語で約12%過小評価する（合計比 0.878）。
 * **Anthropic のトークナイザに対しては測っていない。**使う場合は別途実測すること。
 */
export const heuristicTokenCounter: TokenCounter = {
  count(text: string): { tokens: number; counter: "heuristic" } {
    let cjkCount = 0;
    let nonCjkCount = 0;
    // `text.length` は UTF-16 コード単位数でサロゲートペアを2と数えるため、for...of でコードポイント単位に走査する。
    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (isCjkCodePoint(codePoint)) {
        cjkCount++;
      } else {
        nonCjkCount++;
      }
    }
    const tokens = Math.ceil(
      (cjkCount * CJK_WEIGHT_NUMERATOR + nonCjkCount * NON_CJK_WEIGHT_NUMERATOR) /
        WEIGHT_DENOMINATOR,
    );
    return { tokens, counter: "heuristic" };
  },
};
