import type { ProbeUtterance } from "./probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 日本語の固有名詞を含む probe set。`./identifier-probe-set.js` と弁別構造（同じ書式・違う対象）は同じだが、
 * コードとしては独立している（import しない）。query は固有名詞そのものを含め、言い換えクイズにしない。
 */
export interface JapaneseNameProbe {
  id: string;
  category: "person" | "org" | "product" | "place";
  fact: string;
  query: string;
  distractor: string;
}

export const JAPANESE_NAME_PROBES: JapaneseNameProbe[] = [
  {
    id: "person-a",
    category: "person",
    fact: "藤井健太さんは総務部に所属しています。",
    query: "藤井健太さんはどの部署に所属していますか?",
    distractor: "藤井大輝さんは経理部に所属しています。",
  },
  {
    id: "person-b",
    category: "person",
    fact: "三浦陽子さんは広報部の担当です。",
    query: "三浦陽子さんはどの部署の担当ですか?",
    distractor: "三浦真由美さんは人事部の担当です。",
  },
  {
    id: "person-c",
    category: "person",
    fact: "小島誠さんは品質保証部のリーダーです。",
    query: "小島誠さんはどの部署のリーダーですか?",
    distractor: "小島学さんは開発部のリーダーです。",
  },
  {
    id: "person-d",
    category: "person",
    fact: "桐生美咲さんは法務部に配属されました。",
    query: "桐生美咲さんはどの部署に配属されましたか?",
    distractor: "桐生麻衣さんは営業部に配属されました。",
  },
  {
    id: "org-a",
    category: "org",
    fact: "蒼天ロジスティクスの第一営業部は関東エリアを担当しています。",
    query: "蒼天ロジスティクスの第一営業部はどのエリアを担当していますか?",
    distractor: "蒼天ロジスティクスの第二営業部は関西エリアを担当しています。",
  },
  {
    id: "org-b",
    category: "org",
    fact: "北陵物産株式会社の開発一課はモバイルアプリを担当しています。",
    query: "北陵物産株式会社の開発一課は何を担当していますか?",
    distractor: "北陵物産株式会社の開発二課は基幹システムを担当しています。",
  },
  {
    id: "org-c",
    category: "org",
    fact: "桜庭商事株式会社の東日本支社は法人向け営業を担当しています。",
    query: "桜庭商事株式会社の東日本支社は何を担当していますか?",
    distractor: "桜庭商事株式会社の西日本支社は個人向け営業を担当しています。",
  },
  {
    id: "product-a",
    category: "product",
    fact: "かがやき手帳は来月にアップデートが予定されています。",
    query: "かがやき手帳はいつアップデートが予定されていますか?",
    distractor: "かがやき台帳は来週にアップデートが予定されています。",
  },
  {
    id: "product-b",
    category: "product",
    fact: "きらめき工房は今期から月額料金プランに変わりました。",
    query: "きらめき工房は今期から何のプランに変わりましたか?",
    distractor: "きらめき道場は来期から年額料金プランに変わります。",
  },
  {
    id: "product-c",
    category: "product",
    fact: "はるか会計は来週に新機能がリリースされます。",
    query: "はるか会計はいつ新機能がリリースされますか?",
    distractor: "はるか給与は再来週に新機能がリリースされます。",
  },
  {
    id: "place-a",
    category: "place",
    fact: "浜松支店は来月に移転する予定です。",
    query: "浜松支店はいつ移転する予定ですか?",
    distractor: "静岡支店は来年に移転する予定です。",
  },
  {
    id: "place-b",
    category: "place",
    fact: "札幌配送センターは24時間稼働しています。",
    query: "札幌配送センターは何時間稼働していますか?",
    distractor: "旭川配送センターは12時間稼働しています。",
  },
];

/**
 * probe ごとの固有名詞。`JAPANESE_NAME_PROBES` から自動導出せず人手で書き出す。probe を足したらここにも足すこと。
 * 姓+名・組織+部署のように完全な固有名詞のまとまりを1キーワードにする。単独の姓にすると、
 * 無関係な同姓の haystack 文まで違反として拾い、検査として粗すぎる。
 */
export const JAPANESE_NAME_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "person-a": ["藤井健太", "藤井大輝"],
  "person-b": ["三浦陽子", "三浦真由美"],
  "person-c": ["小島誠", "小島学"],
  "person-d": ["桐生美咲", "桐生麻衣"],
  "org-a": ["蒼天ロジスティクスの第一営業部", "蒼天ロジスティクスの第二営業部"],
  "org-b": ["北陵物産株式会社の開発一課", "北陵物産株式会社の開発二課"],
  "org-c": ["桜庭商事株式会社の東日本支社", "桜庭商事株式会社の西日本支社"],
  "product-a": ["かがやき手帳", "かがやき台帳"],
  "product-b": ["きらめき工房", "きらめき道場"],
  "product-c": ["はるか会計", "はるか給与"],
  "place-a": ["浜松支店", "静岡支店"],
  "place-b": ["札幌配送センター", "旭川配送センター"],
};

const ALL_JAPANESE_NAME_KEYWORDS: string[] = Object.values(JAPANESE_NAME_TOPIC_KEYWORDS).flat();

export interface JapaneseNameKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

export function findJapaneseNameTopicKeywordViolations(
  utterances: readonly string[],
): JapaneseNameKeywordViolation[] {
  const violations: JapaneseNameKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_JAPANESE_NAME_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

export type JapaneseNameHaystackKind = "sparse" | "dense";

interface DenseJapaneseNameFamily {
  id: string;
  count: number;
  identifierAt: (n: number) => string;
  sentenceFor: (identifier: string) => string;
}

const DENSE_PERSON_SURNAMES = [
  "大河内",
  "早乙女",
  "日野",
  "宇佐美",
  "真壁",
  "九条",
  "東雲",
  "時任",
  "黒木",
  "西園寺",
] as const;

const DENSE_PERSON_GIVEN_NAMES = ["俊介", "沙耶香"] as const;

const DENSE_ORG_NAMES = [
  "彩雲物流株式会社",
  "銀河製作所",
  "飛鳥商会",
  "蒼海運輸",
  "若葉電機",
  "朝凪食品",
  "天狼精密",
  "水明堂",
  "橙灯商事",
  "紅葉紡績",
  "青嵐建設",
  "白鷺運送",
  "碧空印刷",
  "黎明化学",
  "風待ち通信",
] as const;

const DENSE_PRODUCT_NAMES = [
  "ひかり手帳",
  "つばさ会計",
  "なぎさ工房",
  "あかつき道場",
  "ゆうなぎ給与",
  "いぶき台帳",
  "こもれび管理",
  "しののめ受付",
  "ゆらぎ在庫",
  "はしだて経理",
  "みずかがみ勤怠",
  "そよかぜ発注",
  "ほしあかり検品",
  "わたぼうし精算",
  "かたわれ月報",
] as const;

const DENSE_PLACE_NAMES = [
  "前橋営業所",
  "高崎倉庫",
  "甲府配送拠点",
  "諏訪工場",
  "飯田物流センター",
  "松本サービスセンター",
  "伊那出張所",
  "岡谷支所",
  "塩尻中継所",
  "茅野受付窓口",
] as const;

/**
 * 60件（密度5:1）は、識別子ベンチが最初に設計されたときの初期条件を再現する。「引けないもの」が出るなら
 * この条件で最も出やすい、という賭けを明示するため。probe 側と値域が重ならないことは、
 * `buildJapaneseNameProbeSetConversation` が実行時にも再検査する。
 */
const DENSE_JAPANESE_NAME_FAMILIES: readonly DenseJapaneseNameFamily[] = [
  {
    id: "person",
    count: DENSE_PERSON_SURNAMES.length * DENSE_PERSON_GIVEN_NAMES.length,
    identifierAt: (n) =>
      `${DENSE_PERSON_SURNAMES[n % DENSE_PERSON_SURNAMES.length]}` +
      `${DENSE_PERSON_GIVEN_NAMES[Math.floor(n / DENSE_PERSON_SURNAMES.length)]}`,
    sentenceFor: (name) => `${name}さんは来月から新しいプロジェクトに参加します。`,
  },
  {
    id: "org",
    count: DENSE_ORG_NAMES.length,
    identifierAt: (n) => DENSE_ORG_NAMES[n]!,
    sentenceFor: (name) => `${name}は来期に業務システムを刷新する予定です。`,
  },
  {
    id: "product",
    count: DENSE_PRODUCT_NAMES.length,
    identifierAt: (n) => DENSE_PRODUCT_NAMES[n]!,
    sentenceFor: (name) => `${name}のマニュアルが今週改訂されました。`,
  },
  {
    id: "place",
    count: DENSE_PLACE_NAMES.length,
    identifierAt: (n) => DENSE_PLACE_NAMES[n]!,
    sentenceFor: (name) => `${name}では来月から窓口対応時間が変わります。`,
  },
];

export const DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE: number =
  DENSE_JAPANESE_NAME_FAMILIES.reduce((sum, f) => sum + f.count, 0);

export function buildDenseJapaneseNameHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildDenseJapaneseNameHaystackUtterance: index は0以上の整数である必要がある` +
        `(実際: ${index})`,
    );
  }
  let remaining = index;
  for (const family of DENSE_JAPANESE_NAME_FAMILIES) {
    if (remaining < family.count) {
      const identifier = family.identifierAt(remaining);
      return family.sentenceFor(identifier);
    }
    remaining -= family.count;
  }
  throw new Error(
    `buildDenseJapaneseNameHaystackUtterance: index ${index} が総件数 ` +
      `${DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE} を超えている`,
  );
}

/** `./identifier-probe-set.js` の `identifier-gold-<id>` と衝突しないよう別の prefix を使う。 */
export function japaneseNameGoldExternalId(probeId: string): string {
  return `japanese-name-gold-${probeId}`;
}

export function japaneseNameDistractorExternalId(probeId: string): string {
  return `japanese-name-distractor-${probeId}`;
}

export function japaneseNameHaystackExternalId(index: number): string {
  return `japanese-name-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 `JAPANESE_NAME_PROBES` の gold/distractor + 共有の haystack を1本の会話に組む。
 * 既定は `"sparse"`。どちらの kind でも固有名詞の重なり検査は必ず通す。
 */
export function buildJapaneseNameProbeSetConversation(
  haystackSize?: number,
  haystackKind: JapaneseNameHaystackKind = "sparse",
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of JAPANESE_NAME_PROBES) {
    utterances.push({
      externalId: japaneseNameGoldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: japaneseNameDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const resolvedSize =
    haystackSize ??
    (haystackKind === "dense" ? DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE : DEFAULT_HAYSTACK_SIZE);
  const buildUtterance =
    haystackKind === "dense" ? buildDenseJapaneseNameHaystackUtterance : buildHaystackUtterance;

  const haystackTexts: string[] = [];
  for (let i = 0; i < resolvedSize; i += 1) {
    haystackTexts.push(buildUtterance(i));
  }
  const violations = findJapaneseNameTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      `buildJapaneseNameProbeSetConversation: haystack(${haystackKind}) が固有名詞 probe の` +
        `固有名詞と重なっている(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({
      externalId: japaneseNameHaystackExternalId(i),
      text,
      kind: "haystack",
    });
  });

  return utterances;
}

/** 型だけを `./identifier-arm.js` から取る（`import type`）——実行時の循環を作らない。 */
export const JAPANESE_NAME_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: JAPANESE_NAME_PROBES,
  buildConversation: (haystackSize, haystackKind) =>
    buildJapaneseNameProbeSetConversation(haystackSize, haystackKind),
  goldExternalId: japaneseNameGoldExternalId,
  distractorExternalId: japaneseNameDistractorExternalId,
};
