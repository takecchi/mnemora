import type { ProbeUtterance } from "./probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 「単独トークンの数詞・記号インデックス」を弁別軸とする probe set（ADR 0135）。`./identifier-probe-set.js`/
 * `./japanese-name-probe-set.js` と狙いは似ているが、コードとしては独立している（import しない）。
 * query は discriminator（索引そのもの）を含め、言い換えクイズにしない。
 *
 * セルあたり2つの独立した語彙インスタンスを置く。1セル1件では、長い前置+漢数字のような2要因だけでは失敗を予測できない罠を
 * 再現しうるため（ADR 0135 §3.3）。3つにしなかったのは、n=1 の危険は2で避けられ、実測の前に3件目を当てずっぽうで足さないため。
 * 実測でセル内の2件が大きく食い違うセルが見つかったら、そのセルだけ3件目を足す。
 *
 * `lexicalControl` 相当の対照群は置かない。query が discriminator を含む時点で擬似 embedding でも部分一致しうるので、
 * 対照として機能する保証がない（ADR 0135 §5.3）。
 */
export type NumeralCharKind = "kanji" | "arabic" | "alpha";
export type NumeralPrefixLength = "long" | "medium" | "short";

export interface NumeralTokenProbe {
  id: string;
  charKind: NumeralCharKind;
  prefixLength: NumeralPrefixLength;
  category: `${NumeralCharKind}-${NumeralPrefixLength}`;
  fact: string;
  query: string;
  distractor: string;
}

export const NUMERAL_TOKEN_PROBES: NumeralTokenProbe[] = [
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
    // ADR 0135 §3.3 の `long-kanji-2` と同じ文。値を見てから作り直したものではない。
    id: "kanji-long-b",
    charKind: "kanji",
    prefixLength: "long",
    category: "kanji-long",
    fact: "彩雲物流株式会社の営業一部は法人向け商材を扱っています。",
    query: "彩雲物流株式会社の営業一部は何を扱っていますか?",
    distractor: "彩雲物流株式会社の営業二部は個人向け商材を扱っています。",
  },
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

/**
 * probe ごとの索引（語幹+discriminator+接尾語のまとまり）。`一`/`A` のような単独1文字をキーワードにしない——
 * 無関係な haystack 文まで違反として拾い、検査として粗すぎる。`NUMERAL_TOKEN_PROBES` に probe を足したら、ここにも足すこと。
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

export type NumeralTokenHaystackKind = "sparse" | "dense";

interface DenseNumeralTokenFamily {
  id: string;
  count: number;
  identifierAt: (n: number) => string;
  sentenceFor: (token: string) => string;
}

const KANJI_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

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

const DENSE_ALPHA_LETTERS = ["G", "H", "I", "J", "K", "L", "M", "N", "O", "P"] as const;

/**
 * `NUMERAL_TOKEN_PROBES` のセルごとに、probe とは重ならない索引で干し草を作る。値域を probe とは別に固定してある
 * （漢数字は20番台、算用数字は100番台、アルファベットはG〜P）。重なりは `buildNumeralTokenProbeSetConversation` が実行時にも再検査する。
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

export const DEFAULT_NUMERAL_TOKEN_DENSE_HAYSTACK_SIZE: number =
  DENSE_NUMERAL_TOKEN_FAMILIES.reduce((sum, f) => sum + f.count, 0);

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

/** `identifier-gold-<id>`・`japanese-name-gold-<id>` と衝突しないよう別の prefix を使う。 */
export function numeralTokenGoldExternalId(probeId: string): string {
  return `numeral-token-gold-${probeId}`;
}

export function numeralTokenDistractorExternalId(probeId: string): string {
  return `numeral-token-distractor-${probeId}`;
}

export function numeralTokenHaystackExternalId(index: number): string {
  return `numeral-token-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 `NUMERAL_TOKEN_PROBES` の gold/distractor + 共有の haystack を1本の会話に組む。
 * 既定は `"sparse"`。どちらの kind でも索引の重なり検査は必ず通す。
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

/** 型だけを `./identifier-arm.js` から取る（`import type`）——実行時の循環を作らない。 */
export const NUMERAL_TOKEN_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: NUMERAL_TOKEN_PROBES,
  buildConversation: (haystackSize, haystackKind) =>
    buildNumeralTokenProbeSetConversation(haystackSize, haystackKind),
  goldExternalId: numeralTokenGoldExternalId,
  distractorExternalId: numeralTokenDistractorExternalId,
};
