import type { ProbeUtterance } from "./probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 「単独トークンの数詞・記号インデックス」を弁別軸とする第4の probe set
 * （[ADR 0135](../../../docs/decisions/0135-numeral-token-discriminator-probe-domain-design.md)、
 * Issue #109）。
 *
 * **背景**: [ADR 0110](../../../docs/decisions/0110-single-char-token-discriminator.md) は、
 * `japanese-name-probe-set.ts` の `org-b`（`開発一課` 対 `開発二課`）が落ちる理由を
 * 「弁別部分が単独1文字のトークン1個に割られ、かつ mean pooling が長い共有前置で
 * それを薄めたとき」と特定した——**しかし常設した probe にはしていない**（1文の
 * 反実仮想で確かめただけ）。ADR 0135 はこの現象を、**文字種（漢数字/算用数字/
 * アルファベット）× 共有前置長（長い/中間/短い）の行列**として、意図して系統的に
 * 再現可能な形へ格上げする。
 *
 * ⛔ **`./identifier-probe-set.js`/`./japanese-name-probe-set.js` は1文字も変更していない**
 * （どちらも import していない——弁別構造の狙いは似ているが、コードとしては独立している）。
 * ⛔ **`./probe-set.js` も1文字も変更していない**（`buildHaystackUtterance`/
 * `DEFAULT_HAYSTACK_SIZE` を import して `sparse` haystack に再利用するだけである）。
 *
 * **弁別構造**: gold と distractor は「同じ語幹（会社名・部署・拠点等）を共有し、
 * 末尾の短い索引（数詞または英字1〜2文字）だけが異なる」——識別子集合・日本語固有名詞
 * 集合と同じ「同じ書式・違う対象」構造である。**query は discriminator（索引そのもの）を
 * 含める**（ADR 0135 §5.2。「短い索引そのものを embedding がどれだけ精密に区別できるか」を
 * 測るのが狙いであり、言い換えクイズにしない）。
 *
 * **行列（ADR 0135 §5.1・§5.4）**: 文字種3（`kanji`/`arabic`/`alpha`） ×
 * 共有前置長3（`long`≒10文字以上/`medium`≒4〜6文字/`short`≒0〜1文字）= 9セル。
 * **セルあたり2つの独立した語彙インスタンス**（同じ構造・違う単語）を置く——
 * ADR 0135 §3.3 が「長い前置+漢数字」という2要因だけでは失敗を予測できないことを
 * 実測で確認しており（`long-kanji` は負けるが、別語彙の `long-kanji-2` は健全に勝つ）、
 * **1セル1件（n=1）では同じ罠を再現しうる**ため。⟹ 最小件数 = 9セル × 2インスタンス
 * = **18件**。
 *
 * 🔑 **なぜ3インスタンス/セルにしなかったか（実装時の判断、ADR 0135 §5.4 が
 * 委ねた点）**: ADR 0135 は「実装時にセルごとのインスタンスを3つに増やせば27件に
 * なる——その判断は実装時に行う」と明記して残件にしている。この実装では**2に
 * 留めた**——理由は、(1) ADR 0135 が示した最小要件（n=1 の危険を避ける）は2で
 * 満たされる、(2) 初回実装ではレビュー対象・手作業で書く語彙の量を抑え、
 * まず9セル×2の値を実測してから「セル内の2件が食い違うか」（ADR 0135 §3.3 と
 * 同型の兆候）を観察するほうが、値を見る前に3件目を当てずっぽうで足すより
 * 実験計画として健全だと判断したため。**もし実測でセル内の2件が大きく食い違う
 * セルが見つかったら、そのセルだけ3件目を足すことを次の課題として残す**
 * （このファイルの一存では決めない——基準値の provenance に実測結果を残し、
 * 次の判断に委ねる）。
 *
 * **lexicalControl 相当の対照群は置かない**（ADR 0135 §5.3。識別子集合・日本語
 * 固有名詞集合と同じ理由——query が discriminator を含む時点で、擬似 embedding
 * でも部分一致しうるため「対照」として機能する保証がない）。
 */
export type NumeralCharKind = "kanji" | "arabic" | "alpha";
export type NumeralPrefixLength = "long" | "medium" | "short";

export interface NumeralTokenProbe {
  id: string;
  /** 弁別トークンの文字種。 */
  charKind: NumeralCharKind;
  /** gold/distractor が共有する前置の長さの目安。 */
  prefixLength: NumeralPrefixLength;
  /** `${charKind}-${prefixLength}`。`ArmProbeSetSpec` が要求する `category` 欄
   *  （識別子集合の `project-code`/`ticket`/... 、日本語固有名詞集合の
   *  `person`/`org`/... に相当する、この集合独自の区分）。 */
  category: `${NumeralCharKind}-${NumeralPrefixLength}`;
  /** 会話の冒頭付近で1度だけ表明される、索引を含む事実。これが gold。 */
  fact: string;
  /** 終盤に投げる質問。**索引そのものを含む**（識別子集合・日本語固有名詞集合と同じ狙い）。 */
  query: string;
  /** 同じ語幹・違う索引の記憶。gold より上に来たら「語幹は合うが対象が違う」。 */
  distractor: string;
}

export const NUMERAL_TOKEN_PROBES: NumeralTokenProbe[] = [
  // --- kanji × long(共有前置≒11文字) ---
  {
    id: "kanji-long-a",
    charKind: "kanji",
    prefixLength: "long",
    category: "kanji-long",
    fact: "瑞穂精機株式会社の製造三課は精密部品の検査を担当しています。",
    query: "瑞穂精機株式会社の製造三課は何を担当していますか?",
    distractor: "瑞穂精機株式会社の製造四課は精密部品の組立を担当しています。",
  },
  {
    // ⚠ ADR 0135 §3.3 の `long-kanji-2` と同じ文（実測: margin +2.417745e-2、健全）。
    // ここでは常設 probe として組み込む——ADR の実測を裏付ける実装であり、
    // 値を見てから作り直したものではない。
    id: "kanji-long-b",
    charKind: "kanji",
    prefixLength: "long",
    category: "kanji-long",
    fact: "彩雲物流株式会社の営業一部は法人向け商材を扱っています。",
    query: "彩雲物流株式会社の営業一部は何を扱っていますか?",
    distractor: "彩雲物流株式会社の営業二部は個人向け商材を扱っています。",
  },
  // --- arabic × long ---
  {
    id: "arabic-long-a",
    charKind: "arabic",
    prefixLength: "long",
    category: "arabic-long",
    fact: "瑞穂精機株式会社の製造3課は精密部品の検査を担当しています。",
    query: "瑞穂精機株式会社の製造3課は何を担当していますか?",
    distractor: "瑞穂精機株式会社の製造4課は精密部品の組立を担当しています。",
  },
  {
    id: "arabic-long-b",
    charKind: "arabic",
    prefixLength: "long",
    category: "arabic-long",
    fact: "彩雲物流株式会社の営業1部は法人向け商材を扱っています。",
    query: "彩雲物流株式会社の営業1部は何を扱っていますか?",
    distractor: "彩雲物流株式会社の営業2部は個人向け商材を扱っています。",
  },
  // --- alpha × long ---
  {
    id: "alpha-long-a",
    charKind: "alpha",
    prefixLength: "long",
    category: "alpha-long",
    fact: "瑞穂精機株式会社の製造Cチームは精密部品の検査を担当しています。",
    query: "瑞穂精機株式会社の製造Cチームは何を担当していますか?",
    distractor: "瑞穂精機株式会社の製造Dチームは精密部品の組立を担当しています。",
  },
  {
    id: "alpha-long-b",
    charKind: "alpha",
    prefixLength: "long",
    category: "alpha-long",
    fact: "彩雲物流株式会社の営業Aチームは法人向け商材を扱っています。",
    query: "彩雲物流株式会社の営業Aチームは何を扱っていますか?",
    distractor: "彩雲物流株式会社の営業Bチームは個人向け商材を扱っています。",
  },
  // --- kanji × medium(共有前置≒4文字) ---
  {
    id: "kanji-medium-a",
    charKind: "kanji",
    prefixLength: "medium",
    category: "kanji-medium",
    fact: "総務部の三番窓口は書類受付を担当しています。",
    query: "総務部の三番窓口は何を担当していますか?",
    distractor: "総務部の四番窓口は来客対応を担当しています。",
  },
  {
    id: "kanji-medium-b",
    charKind: "kanji",
    prefixLength: "medium",
    category: "kanji-medium",
    fact: "資材課の五番ロッカーは工具を保管しています。",
    query: "資材課の五番ロッカーは何を保管していますか?",
    distractor: "資材課の六番ロッカーは消耗品を保管しています。",
  },
  // --- arabic × medium ---
  {
    id: "arabic-medium-a",
    charKind: "arabic",
    prefixLength: "medium",
    category: "arabic-medium",
    fact: "総務部の3番窓口は書類受付を担当しています。",
    query: "総務部の3番窓口は何を担当していますか?",
    distractor: "総務部の4番窓口は来客対応を担当しています。",
  },
  {
    id: "arabic-medium-b",
    charKind: "arabic",
    prefixLength: "medium",
    category: "arabic-medium",
    fact: "資材課の5番ロッカーは工具を保管しています。",
    query: "資材課の5番ロッカーは何を保管していますか?",
    distractor: "資材課の6番ロッカーは消耗品を保管しています。",
  },
  // --- alpha × medium ---
  {
    id: "alpha-medium-a",
    charKind: "alpha",
    prefixLength: "medium",
    category: "alpha-medium",
    fact: "総務部のCブースは書類受付を担当しています。",
    query: "総務部のCブースは何を担当していますか?",
    distractor: "総務部のDブースは来客対応を担当しています。",
  },
  {
    id: "alpha-medium-b",
    charKind: "alpha",
    prefixLength: "medium",
    category: "alpha-medium",
    fact: "資材課のEロッカーは工具を保管しています。",
    query: "資材課のEロッカーは何を保管していますか?",
    distractor: "資材課のFロッカーは消耗品を保管しています。",
  },
  // --- kanji × short(共有前置≒0文字) ---
  {
    id: "kanji-short-a",
    charKind: "kanji",
    prefixLength: "short",
    category: "kanji-short",
    fact: "三号店は駅前で営業しています。",
    query: "三号店はどこで営業していますか?",
    distractor: "四号店は郊外で営業しています。",
  },
  {
    id: "kanji-short-b",
    charKind: "kanji",
    prefixLength: "short",
    category: "kanji-short",
    fact: "三号線は日中運休しています。",
    query: "三号線は今どんな状況ですか?",
    distractor: "四号線は通常運行しています。",
  },
  // --- arabic × short ---
  {
    id: "arabic-short-a",
    charKind: "arabic",
    prefixLength: "short",
    category: "arabic-short",
    fact: "3号店は駅前で営業しています。",
    query: "3号店はどこで営業していますか?",
    distractor: "4号店は郊外で営業しています。",
  },
  {
    id: "arabic-short-b",
    charKind: "arabic",
    prefixLength: "short",
    category: "arabic-short",
    fact: "3号線は日中運休しています。",
    query: "3号線は今どんな状況ですか?",
    distractor: "4号線は通常運行しています。",
  },
  // --- alpha × short ---
  {
    id: "alpha-short-a",
    charKind: "alpha",
    prefixLength: "short",
    category: "alpha-short",
    fact: "A店は駅前で営業しています。",
    query: "A店はどこで営業していますか?",
    distractor: "B店は郊外で営業しています。",
  },
  {
    id: "alpha-short-b",
    charKind: "alpha",
    prefixLength: "short",
    category: "alpha-short",
    fact: "A線は日中運休しています。",
    query: "A線は今どんな状況ですか?",
    distractor: "B線は通常運行しています。",
  },
];

// ---------------------------------------------------------------------------
// 索引の重なり検査(機械的) — `./identifier-probe-set.js`/`./japanese-name-probe-set.js`
// と同じ形の検査を、この数詞・記号索引にも用意する。
// ---------------------------------------------------------------------------

/**
 * probe ごとの索引(語幹+discriminator+接尾語のまとまり。単独の数詞・英字1文字だけを
 * キーワードにはしない——`一`/`A` のような単独1文字を拾うと、無関係な haystack 文
 * （「明日、資料を1部用意します。」等）まで違反として拾ってしまい、検査として粗すぎる。
 * `./japanese-name-probe-set.js` の `JAPANESE_NAME_TOPIC_KEYWORDS` が姓単独ではなく
 * 「姓+名」のまとまりをキーワードにしているのと同じ理由)。
 *
 * `NUMERAL_TOKEN_PROBES` に probe を足したら、ここにも対応する索引を足すこと。
 */
export const NUMERAL_TOKEN_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "kanji-long-a": ["製造三課", "製造四課"],
  "kanji-long-b": ["営業一部", "営業二部"],
  "arabic-long-a": ["製造3課", "製造4課"],
  "arabic-long-b": ["営業1部", "営業2部"],
  "alpha-long-a": ["製造Cチーム", "製造Dチーム"],
  "alpha-long-b": ["営業Aチーム", "営業Bチーム"],
  "kanji-medium-a": ["三番窓口", "四番窓口"],
  "kanji-medium-b": ["五番ロッカー", "六番ロッカー"],
  "arabic-medium-a": ["3番窓口", "4番窓口"],
  "arabic-medium-b": ["5番ロッカー", "6番ロッカー"],
  "alpha-medium-a": ["Cブース", "Dブース"],
  "alpha-medium-b": ["Eロッカー", "Fロッカー"],
  "kanji-short-a": ["三号店", "四号店"],
  "kanji-short-b": ["三号線", "四号線"],
  "arabic-short-a": ["3号店", "4号店"],
  "arabic-short-b": ["3号線", "4号線"],
  "alpha-short-a": ["A店", "B店"],
  "alpha-short-b": ["A線", "B線"],
};

const ALL_NUMERAL_TOKEN_KEYWORDS: string[] = Object.values(NUMERAL_TOKEN_TOPIC_KEYWORDS).flat();

export interface NumeralTokenKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

/**
 * `./identifier-probe-set.js` の `findIdentifierTopicKeywordViolations` と同じ形の検査を、
 * この数詞・記号索引 probe set に対して行う。haystack の各文が `NUMERAL_TOKEN_PROBES` の
 * 索引を(偶然にも)含んでいないかを機械的に見る。空配列を返せば「重なり無し」。
 */
export function findNumeralTokenTopicKeywordViolations(
  utterances: readonly string[],
): NumeralTokenKeywordViolation[] {
  const violations: NumeralTokenKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_NUMERAL_TOKEN_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

// ---------------------------------------------------------------------------
// 密な haystack(数詞・記号索引が密な干し草)
// ---------------------------------------------------------------------------

export type NumeralTokenHaystackKind = "sparse" | "dense";

interface DenseNumeralTokenFamily {
  /** このファミリーが対応する probe の `category`(設計メモ、表示・集計には使わない)。 */
  id: string;
  /** このファミリーが提供する干し草の件数。 */
  count: number;
  /** ファミリー内の連番(0始まり)から、`NUMERAL_TOKEN_PROBES` に無い新しい索引を作る。 */
  identifierAt: (n: number) => string;
  /** 索引を埋め込んだ、ありふれた事務連絡文(意味は無害・probe の話題とは無関係)。 */
  sentenceFor: (token: string) => string;
}

const KANJI_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

/**
 * 1〜99 の漢数字表記を作る(決定的、乱数無し)。`NUMERAL_TOKEN_PROBES` が使う漢数字は
 * 一〜六(1〜6)までなので、dense haystack ではこの範囲より大きい値(20台)だけを使い、
 * 衝突を値の範囲そのもので避ける。
 */
function kanjiNumeral(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 99) {
    throw new Error(`kanjiNumeral: 1〜99の整数である必要がある(実際: ${n})`);
  }
  if (n < 10) {
    return KANJI_DIGITS[n]!;
  }
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 1 ? "十" : `${KANJI_DIGITS[tens]}十`;
  return ones === 0 ? tensPart : `${tensPart}${KANJI_DIGITS[ones]}`;
}

/** dense haystack 専用のアルファベット(G〜P、`NUMERAL_TOKEN_PROBES` が使う A〜F とは
 *  重ならない値域)。 */
const DENSE_ALPHA_LETTERS = ["G", "H", "I", "J", "K", "L", "M", "N", "O", "P"] as const;

/**
 * `NUMERAL_TOKEN_PROBES`(9セル×2 = 18件)のセルごとに、probe とは重ならない索引で
 * 干し草を作る。1セルあたり10件、合計 **90件**(18件 × 5、ADR 0135 §5.4 の密度)。
 *
 * ⚠ **値域を probe とは別に固定してある**——漢数字は20番台(`NUMERAL_TOKEN_PROBES` は
 * 一〜六=1〜6のみ)、算用数字は100番台(同12以下)、アルファベットはG〜P(同A〜F)。
 * その保証は「選んだ」だけでは終わらない——`buildNumeralTokenProbeSetConversation` が
 * `findNumeralTokenTopicKeywordViolations` で機械的に再検査し、万一重なっていれば
 * 構築時に例外にする(識別子集合・日本語固有名詞集合と同じ規律)。
 */
const DENSE_NUMERAL_TOKEN_FAMILIES: readonly DenseNumeralTokenFamily[] = [
  {
    id: "kanji-long",
    count: 10,
    identifierAt: (n) => kanjiNumeral(20 + n),
    sentenceFor: (tok) => `青嵐電機株式会社の経理${tok}課は月次資料を作成しています。`,
  },
  {
    id: "kanji-medium",
    count: 10,
    identifierAt: (n) => kanjiNumeral(20 + n),
    sentenceFor: (tok) => `管理部の${tok}番デスクは備品を貸し出しています。`,
  },
  {
    id: "kanji-short",
    count: 10,
    identifierAt: (n) => kanjiNumeral(20 + n),
    sentenceFor: (tok) => `${tok}号倉庫は在庫を保管しています。`,
  },
  {
    id: "arabic-long",
    count: 10,
    identifierAt: (n) => String(100 + n),
    sentenceFor: (tok) => `青嵐電機株式会社の経理${tok}課は月次資料を作成しています。`,
  },
  {
    id: "arabic-medium",
    count: 10,
    identifierAt: (n) => String(100 + n),
    sentenceFor: (tok) => `管理部の${tok}番デスクは備品を貸し出しています。`,
  },
  {
    id: "arabic-short",
    count: 10,
    identifierAt: (n) => String(100 + n),
    sentenceFor: (tok) => `${tok}号倉庫は在庫を保管しています。`,
  },
  {
    id: "alpha-long",
    count: 10,
    identifierAt: (n) => DENSE_ALPHA_LETTERS[n % DENSE_ALPHA_LETTERS.length]!,
    sentenceFor: (tok) => `青嵐電機株式会社の経理${tok}チームは月次資料を作成しています。`,
  },
  {
    id: "alpha-medium",
    count: 10,
    identifierAt: (n) => DENSE_ALPHA_LETTERS[n % DENSE_ALPHA_LETTERS.length]!,
    sentenceFor: (tok) => `管理部の${tok}デスクは備品を貸し出しています。`,
  },
  {
    id: "alpha-short",
    count: 10,
    identifierAt: (n) => DENSE_ALPHA_LETTERS[n % DENSE_ALPHA_LETTERS.length]!,
    sentenceFor: (tok) => `${tok}倉庫は在庫を保管しています。`,
  },
];

/** `DENSE_NUMERAL_TOKEN_FAMILIES` の件数の合計から導く——ここにも 90 を書き写さない。 */
export const DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE: number =
  DENSE_NUMERAL_TOKEN_FAMILIES.reduce((sum, f) => sum + f.count, 0);

/**
 * `index`(0始まり)に対応する、数詞・記号索引が密な haystack 文を1件返す。
 * ファミリーを跨ぐ累積オフセットで、どのファミリーの何番目かを決める(決定的、乱数無し)。
 */
export function buildDenseNumeralTokenHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildDenseNumeralTokenHaystackUtterance: index は0以上の整数である必要がある` +
        `(実際: ${index})`,
    );
  }
  let remaining = index;
  for (const family of DENSE_NUMERAL_TOKEN_FAMILIES) {
    if (remaining < family.count) {
      const token = family.identifierAt(remaining);
      return family.sentenceFor(token);
    }
    remaining -= family.count;
  }
  throw new Error(
    `buildDenseNumeralTokenHaystackUtterance: index ${index} が総件数 ` +
      `${DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE} を超えている`,
  );
}

// ---------------------------------------------------------------------------
// 会話の組み立て
// ---------------------------------------------------------------------------

/** `numeral-token-gold-<id>` の externalId 規約。`./identifier-probe-set.js` の
 *  `identifier-gold-<id>`・`./japanese-name-probe-set.js` の `japanese-name-gold-<id>` と
 *  衝突しないよう別の prefix を使う。 */
export function numeralTokenGoldExternalId(probeId: string): string {
  return `numeral-token-gold-${probeId}`;
}

/** `numeral-token-distractor-<id>` の externalId 規約。 */
export function numeralTokenDistractorExternalId(probeId: string): string {
  return `numeral-token-distractor-${probeId}`;
}

/** `numeral-token-filler-NNNN`(4桁ゼロ埋め)の externalId 規約。 */
export function numeralTokenHaystackExternalId(index: number): string {
  return `numeral-token-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 `NUMERAL_TOKEN_PROBES` の gold/distractor + 共有の haystack を1本の会話に組む。
 *
 * `haystackKind`(既定 `"sparse"`)で haystack の生成器を切り替える:
 * - `"sparse"`: `./probe-set.js` の `buildHaystackUtterance`(数詞・記号索引を1件も
 *   含まない、話題語ベースの既定 haystack)を再利用する。
 * - `"dense"`: 上の `buildDenseNumeralTokenHaystackUtterance`(同じ9セルの索引が密な
 *   haystack、計90件)。
 *
 * どちらの kind でも、索引の重なり検査(`findNumeralTokenTopicKeywordViolations`)は
 * 必ず通す——`dense` は probe の索引と衝突しない値を選んで設計してあるが、
 * 「選んだつもり」で終わらせず実行時にも再検査する。
 */
export function buildNumeralTokenProbeSetConversation(
  haystackSize?: number,
  haystackKind: NumeralTokenHaystackKind = "sparse",
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of NUMERAL_TOKEN_PROBES) {
    utterances.push({
      externalId: numeralTokenGoldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: numeralTokenDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const resolvedSize =
    haystackSize ??
    (haystackKind === "dense" ? DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE : DEFAULT_HAYSTACK_SIZE);
  const buildUtterance =
    haystackKind === "dense" ? buildDenseNumeralTokenHaystackUtterance : buildHaystackUtterance;

  const haystackTexts: string[] = [];
  for (let i = 0; i < resolvedSize; i += 1) {
    haystackTexts.push(buildUtterance(i));
  }
  const violations = findNumeralTokenTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      `buildNumeralTokenProbeSetConversation: haystack(${haystackKind}) が数詞・記号索引` +
        `probe の索引と重なっている(${violations.length}件): ` +
        `${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({
      externalId: numeralTokenHaystackExternalId(i),
      text,
      kind: "haystack",
    });
  });

  return utterances;
}

/**
 * `runIdentifierProbeArm` へ渡す probe 集合の仕様(`./identifier-arm.js` の
 * `ArmProbeSetSpec`)。
 *
 * ⚠ **型だけを `./identifier-arm.js` から取る**(`import type`)——実行時の循環を
 * 作らない。`identifier-arm.ts` はこのファイルを import しない(既定は識別子 probe
 * 集合のまま、`./japanese-name-probe-set.js` と同じ配線)。
 */
export const NUMERAL_TOKEN_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: NUMERAL_TOKEN_PROBES,
  buildConversation: (haystackSize, haystackKind) =>
    buildNumeralTokenProbeSetConversation(haystackSize, haystackKind),
  goldExternalId: numeralTokenGoldExternalId,
  distractorExternalId: numeralTokenDistractorExternalId,
};
