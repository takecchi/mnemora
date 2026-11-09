/**
 * `contested-detection` の評価ケース（ADR 0703）。claim key による矛盾検出（`claimKey: { enabled, detectContested }`）の
 * **決定的な検出段だけ**を測るため、抽出の結果と claim key を「LLM が理想どおりに付けた」値に固定する（oracle）。
 *
 * ⚠ 合成データである。カテゴリごとの件数は少なく、ここから実運用の誤検出率は主張しない。
 * ⚠ 鍵を固定しているので、LLM の鍵の付け方の揺れ（実 LLM では recall を下げる主因。ADR 0326）は測らない。
 */

export const CONTESTED_CATEGORIES = [
  "true_conflict",
  "explicit_correction",
  "paraphrase",
  "temporal_compatible",
  "non_conflict",
] as const;
export type ContestedCategory = (typeof CONTESTED_CATEGORIES)[number];

/** カテゴリごとに、矛盾として検出されるべきか。 */
export const CATEGORY_EXPECTS_CONFLICT: Record<ContestedCategory, boolean> = {
  true_conflict: true,
  explicit_correction: true,
  paraphrase: false,
  temporal_compatible: false,
  non_conflict: false,
};

export interface ContestedTurn {
  /** 利用者の発話（`observe()` に渡す本文）。 */
  text: string;
  /** 抽出が返す記憶の本文（oracle）。 */
  memories: string[];
  /** 記憶ごとの claim key（oracle。`memories` と同じ順・同じ数）。 */
  keys: { subject: string; predicate: string }[];
  validFrom?: Date;
  validUntil?: Date;
}

export interface ContestedCase {
  id: string;
  category: ContestedCategory;
  /** 何を見るケースか（人が読む説明）。 */
  note: string;
  turns: ContestedTurn[];
}

const key = (predicate: string, subject = "user") => ({ subject, predicate });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export const CONTESTED_CASES: readonly ContestedCase[] = [
  // --- 同じ主語・同じ時点で値が矛盾する（検出されるべき） ---
  {
    id: "conflict-color",
    category: "true_conflict",
    note: "好きな色が別ターンで食い違う",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      { text: "好きな色は赤です。", memories: ["好きな色は赤"], keys: [key("favorite_color")] },
    ],
  },
  {
    id: "conflict-residence-same-period",
    category: "true_conflict",
    note: "同じ期間（validFrom/validUntil が重なる）に別の都市に住んでいた",
    turns: [
      {
        text: "2024年は札幌に住んでいました。",
        memories: ["2024年は札幌に住んでいた"],
        keys: [key("residence")],
        validFrom: day("2024-01-01"),
        validUntil: day("2025-01-01"),
      },
      {
        text: "2024年は福岡に住んでいました。",
        memories: ["2024年は福岡に住んでいた"],
        keys: [key("residence")],
        validFrom: day("2024-01-01"),
        validUntil: day("2025-01-01"),
      },
    ],
  },
  {
    id: "conflict-employer",
    category: "true_conflict",
    note: "勤め先が食い違う（期間なし）",
    turns: [
      {
        text: "勤め先は物流会社です。",
        memories: ["物流会社に勤めている"],
        keys: [key("employer")],
      },
      { text: "勤め先は銀行です。", memories: ["銀行に勤めている"], keys: [key("employer")] },
    ],
  },
  {
    id: "conflict-blood-type",
    category: "true_conflict",
    note: "血液型が食い違う",
    turns: [
      { text: "血液型はA型です。", memories: ["血液型はA型"], keys: [key("blood_type")] },
      { text: "血液型はB型です。", memories: ["血液型はB型"], keys: [key("blood_type")] },
    ],
  },
  // --- 明示的な訂正（検出されるべき） ---
  {
    id: "correction-separate-turn",
    category: "explicit_correction",
    note: "別ターンで「青ではなく赤」と訂正する",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      {
        text: "訂正します。青ではなく赤でした。",
        memories: ["好きな色は赤"],
        keys: [key("favorite_color")],
      },
    ],
  },
  {
    id: "correction-residence",
    category: "explicit_correction",
    note: "「実は川崎ではなく横浜」と住所を訂正する",
    turns: [
      { text: "川崎に住んでいます。", memories: ["川崎に住んでいる"], keys: [key("residence")] },
      {
        text: "すみません、実は川崎ではなく横浜です。",
        memories: ["横浜に住んでいる"],
        keys: [key("residence")],
      },
    ],
  },
  {
    id: "correction-same-utterance",
    category: "explicit_correction",
    note: "同じ発話の中で言い直す（「金曜、じゃなくて水曜」）。同じ observation の兄弟は検出の対象外（ADR 0377）",
    turns: [
      {
        text: "会議は金曜、じゃなくて水曜です。",
        memories: ["会議は金曜", "会議は水曜"],
        keys: [key("meeting_day"), key("meeting_day")],
      },
    ],
  },
  {
    id: "correction-allergy",
    category: "explicit_correction",
    note: "アレルギーの対象を訂正する",
    turns: [
      {
        text: "卵アレルギーがあります。",
        memories: ["卵アレルギーがある"],
        keys: [key("allergy")],
      },
      {
        text: "間違えました、卵ではなくそばのアレルギーです。",
        memories: ["そばのアレルギーがある"],
        keys: [key("allergy")],
      },
    ],
  },
  // --- 意味は同じで言い方が違う（検出されるべきでない） ---
  {
    id: "paraphrase-color",
    category: "paraphrase",
    note: "「好きな色は青」と「青色が一番好き」",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      { text: "青色が一番好きです。", memories: ["青色が一番好き"], keys: [key("favorite_color")] },
    ],
  },
  {
    id: "paraphrase-whitespace",
    category: "paraphrase",
    note: "前後の空白だけが違う",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      { text: "好きな色は青です。", memories: ["  好きな色は青 "], keys: [key("favorite_color")] },
    ],
  },
  {
    id: "paraphrase-residence",
    category: "paraphrase",
    note: "「東京在住」と「東京に住んでいる」",
    turns: [
      { text: "東京在住です。", memories: ["東京在住"], keys: [key("residence")] },
      { text: "東京に住んでいます。", memories: ["東京に住んでいる"], keys: [key("residence")] },
    ],
  },
  {
    id: "paraphrase-pet",
    category: "paraphrase",
    note: "「猫を飼っている」と「ペットは猫」",
    turns: [
      { text: "猫を飼っています。", memories: ["猫を飼っている"], keys: [key("pet")] },
      { text: "ペットは猫です。", memories: ["ペットは猫"], keys: [key("pet")] },
    ],
  },
  // --- 時間的に両立する（検出されるべきでない） ---
  {
    id: "temporal-explicit-periods",
    category: "temporal_compatible",
    note: "期間（validFrom/validUntil）が重ならない居住",
    turns: [
      {
        text: "2020年は札幌に住んでいました。",
        memories: ["2020年は札幌に住んでいた"],
        keys: [key("residence")],
        validFrom: day("2020-01-01"),
        validUntil: day("2021-01-01"),
      },
      {
        text: "2024年から福岡に住んでいます。",
        memories: ["2024年から福岡に住んでいる"],
        keys: [key("residence")],
        validFrom: day("2024-01-01"),
      },
    ],
  },
  {
    id: "temporal-explicit-employer",
    category: "temporal_compatible",
    note: "期間が重ならない勤め先",
    turns: [
      {
        text: "2019年までは銀行に勤めていました。",
        memories: ["2019年までは銀行に勤めていた"],
        keys: [key("employer")],
        validUntil: day("2020-01-01"),
      },
      {
        text: "2020年から物流会社に勤めています。",
        memories: ["2020年から物流会社に勤めている"],
        keys: [key("employer")],
        validFrom: day("2020-01-01"),
      },
    ],
  },
  {
    id: "temporal-in-text-only",
    category: "temporal_compatible",
    note: "年は本文にだけあり、期間を構造化していない居住",
    turns: [
      {
        text: "2020年は札幌に住んでいました。",
        memories: ["2020年は札幌に住んでいた"],
        keys: [key("residence")],
      },
      {
        text: "2024年は福岡に住んでいます。",
        memories: ["2024年は福岡に住んでいる"],
        keys: [key("residence")],
      },
    ],
  },
  {
    id: "temporal-in-text-age",
    category: "temporal_compatible",
    note: "時点の違う年齢（期間を構造化していない）",
    turns: [
      { text: "去年は34歳でした。", memories: ["去年は34歳だった"], keys: [key("age")] },
      { text: "今年35歳になりました。", memories: ["今年35歳になった"], keys: [key("age")] },
    ],
  },
  // --- 矛盾しない別の情報（検出されるべきでない） ---
  {
    id: "non-conflict-other-person",
    category: "non_conflict",
    note: "本人と妹の好きな色（主語が違う）",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      {
        text: "妹の好きな色は緑です。",
        memories: ["妹の好きな色は緑"],
        keys: [key("favorite_color", "sister")],
      },
    ],
  },
  {
    id: "non-conflict-other-predicate",
    category: "non_conflict",
    note: "好きな色と嫌いな色（述語が違う）",
    turns: [
      { text: "好きな色は青です。", memories: ["好きな色は青"], keys: [key("favorite_color")] },
      { text: "嫌いな色は赤です。", memories: ["嫌いな色は赤"], keys: [key("disliked_color")] },
    ],
  },
  {
    id: "non-conflict-multi-valued",
    category: "non_conflict",
    note: "趣味が2つある（同じ述語に複数の値が両立する）",
    turns: [
      { text: "趣味は釣りです。", memories: ["趣味は釣り"], keys: [key("hobby")] },
      { text: "読書も趣味です。", memories: ["趣味は読書"], keys: [key("hobby")] },
    ],
  },
  {
    id: "non-conflict-languages",
    category: "non_conflict",
    note: "話せる言語が2つある（同じ述語に複数の値が両立する）",
    turns: [
      { text: "英語が話せます。", memories: ["英語が話せる"], keys: [key("spoken_language")] },
      {
        text: "スペイン語も話せます。",
        memories: ["スペイン語が話せる"],
        keys: [key("spoken_language")],
      },
    ],
  },
];
