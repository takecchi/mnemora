// 要因（言い回し・件数・位置）を1つずつ動かす評価。話題Aの m0 は eval-l3
// （`extraction-context-eval-more-cases.mjs`）と入力を1バイト違わず同じにしてある。
// `llmCassetteKey` は PromptSpec の SHA-256 で observation メタデータに依らないため、m0 は eval-l3 と同じプロンプトになる。
//   m0 基準      : eval-l3と同じ形（言い切り・4件・1件目）
//   m1 言い回しだけ: 提案を疑問形にする。それ以外はm0と同じ
//   m2 件数だけ（少）: 文脈は提案1件だけ
//   m3 件数だけ（多）: 無関係な発言を足して8件にする。提案は1件目のまま
//   m4 位置だけ（末尾）: m0と同じ4件を並べ替え、提案を4件目にする
//   m5 位置だけ（中間）: 同じく、提案を2件目にする
//
// m2/m3 の追加・維持する発言を「提案と無関係な他人の雑談だけ」にしたのは、m0 の「了解です、ありがとうございます」が
// 提案への反応として読めるため、含めると「反応の有無」も動いて件数という単一要因の切り分けにならないから。
// m4 は m0 の4件をそのまま並べ替えるので、提案への反応が時系列上は提案より前に来る。これは内容を同一に保つための妥協で、直さない。
//
// ⛔ このファイルは録音後に書き換えない。期待値・入力を結果に合わせて直すことはしない。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。

const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const TENANT_ID = "context-eval-factors";
const OCCURRED_AT = "2026-04-10T09:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";

// --- 話題A: 集合場所（eval-l3と同一の題材）---
const topicA = {
  baselineMessages: [
    { speaker: "assistant", text: "集合場所は正面玄関にします" },
    { speaker: "佐藤", text: "了解です、ありがとうございます" },
    { speaker: "鈴木", text: "今日は暑いですね" },
    { speaker: "佐藤", text: "本当に、真夏日ですね" },
  ],
  wordingVariantProposal: { speaker: "assistant", text: "集合場所は正面玄関でいいですか？" },
  moreMessages: [
    { speaker: "assistant", text: "集合場所は正面玄関にします" },
    { speaker: "鈴木", text: "今日は暑いですね" },
    { speaker: "佐藤", text: "本当に、真夏日ですね" },
    { speaker: "鈴木", text: "最近忙しいですか？" },
    { speaker: "佐藤", text: "そこそこですね" },
    { speaker: "鈴木", text: "お昼は何を食べましたか？" },
    { speaker: "佐藤", text: "コンビニのお弁当です" },
    { speaker: "鈴木", text: "そうなんですね" },
  ],
  expectWord: "正面玄関",
  text: "それでお願いします",
};

// --- 話題B: 締切（話題Aと独立、同じ言い切りの形）---
const topicB = {
  baselineMessages: [
    { speaker: "assistant", text: "締切は金曜日にします" },
    { speaker: "佐藤", text: "了解です、よろしくお願いします" },
    { speaker: "鈴木", text: "最近雨が多いですね" },
    { speaker: "佐藤", text: "本当に、傘が手放せません" },
  ],
  wordingVariantProposal: { speaker: "assistant", text: "締切は金曜日でいいですか？" },
  moreMessages: [
    { speaker: "assistant", text: "締切は金曜日にします" },
    { speaker: "鈴木", text: "最近雨が多いですね" },
    { speaker: "佐藤", text: "本当に、傘が手放せません" },
    { speaker: "鈴木", text: "週末は出かけましたか？" },
    { speaker: "佐藤", text: "家でゆっくりしていました" },
    { speaker: "鈴木", text: "映画とか見ましたか？" },
    { speaker: "佐藤", text: "配信で一本見ました" },
    { speaker: "鈴木", text: "そうなんですね" },
  ],
  expectWord: "金曜",
  text: "それでお願いします",
};

function makeExpect(word) {
  return { includes: [word], excludes: [], dateMatch: null, dateMustNotMatch: null };
}

function makeInput(text, contextMessages) {
  return {
    subjectId: "tanaka",
    speaker: "田中",
    text,
    occurredAt: OCCURRED_AT,
    timeZone: TIME_ZONE,
    contextMessages,
  };
}

function buildTopicCases(topicLabel, t, rationaleFor) {
  const [m0a, m0b, m0c, m0d] = t.baselineMessages;
  return [
    {
      id: `eval-m0-${topicLabel}-baseline`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m0-baseline",
      rationale: rationaleFor.m0,
      input: makeInput(t.text, [m0a, m0b, m0c, m0d]),
      expect: makeExpect(t.expectWord),
    },
    {
      id: `eval-m1-${topicLabel}-wording-question`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m1-wording",
      rationale: rationaleFor.m1,
      input: makeInput(t.text, [t.wordingVariantProposal, m0b, m0c, m0d]),
      expect: makeExpect(t.expectWord),
    },
    {
      id: `eval-m2-${topicLabel}-count-fewer`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m2-count-fewer",
      rationale: rationaleFor.m2,
      input: makeInput(t.text, [m0a]),
      expect: makeExpect(t.expectWord),
    },
    {
      id: `eval-m3-${topicLabel}-count-more`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m3-count-more",
      rationale: rationaleFor.m3,
      input: makeInput(t.text, t.moreMessages),
      expect: makeExpect(t.expectWord),
    },
    {
      id: `eval-m4-${topicLabel}-position-tail`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m4-position-tail",
      rationale: rationaleFor.m4,
      input: makeInput(t.text, [m0c, m0d, m0b, m0a]),
      expect: makeExpect(t.expectWord),
    },
    {
      id: `eval-m5-${topicLabel}-position-middle`,
      topic: topicLabel === "topicA" ? "A-meeting-point" : "B-deadline",
      factorVariant: "m5-position-middle",
      rationale: rationaleFor.m5,
      input: makeInput(t.text, [m0c, m0a, m0b, m0d]),
      expect: makeExpect(t.expectWord),
    },
  ];
}

const rationaleTopicA = {
  m0:
    "基準（話題A=集合場所）。eval-l3-length4-position1-meeting-point（`extraction-context-" +
    "eval-more-cases.mjs`）と入力を1バイト違わず同じにした——言い切り・4件（提案1件+" +
    "同意の反応1件+無関係な世間話2件）・提案は1件目。この基準に対し、m1〜m5で言い回し・" +
    "件数・位置のいずれか1つだけを動かした差分を見る。プロンプト自体はeval-l3と同一に" +
    "なるはずであり（`llmCassetteKey`はPromptSpecのSHA-256でtenantId等の観測メタデータ" +
    "には依存しない）、この意味でm0は同時にeval-l3の追試（別サンプルでの再現性確認）でもある。",
  m1:
    "言い回しだけを動かす（話題A）。m0の1件目「集合場所は正面玄関にします」（言い切り）を" +
    "「集合場所は正面玄関でいいですか？」（疑問形）に変える。2〜4件目（同意の反応「了解" +
    "です、ありがとうございます」を含む）はm0と1件も変えていない。PR #737のl1/l2は" +
    "（要確認の指摘どおり確認したところ）どちらも言い切りでありl3と言い回しは" +
    "変わっていなかった——本ケースが、この要因を初めて独立に動かす。",
  m2:
    "件数だけを動かす・少（話題A）。文脈は提案1件（m0の1件目と同一文言）のみとし、" +
    "同意の反応・無関係な世間話のいずれも含めない——m0の「了解です」は提案への反応として" +
    "読めるため、件数という単一要因を切り分ける変種には持ち込まない（一貫した扱い: m2/m3" +
    "では反応系の発言を使わず、無関係な雑談か0件で構成する）。",
  m3:
    "件数だけを動かす・多（話題A）。提案は1件目のまま、無関係な他人の雑談7件（天気・" +
    "多忙さ・昼食の話題——いずれも集合場所に触れない）を足して計8件にする。m0の" +
    "「了解です、ありがとうございます」（提案への反応）は使わず、代わりに全て無関係な" +
    "雑談で埋めた——m2と同じ一貫性（反応系の発言を件数変種に混ぜない）による。",
  m4:
    "位置だけを動かす・末尾（話題A）。m0と同じ4件（同意の反応を含む）をそのまま使い、" +
    "並び順だけを変えて提案を4件目（田中の発話の直前）にする。⚠ この並べ替えにより、" +
    "他人の「了解です」という提案への反応が、時系列上は提案（4件目）より前（3件目）に" +
    "現れる——内容を m0 と同一に保ったまま位置だけを動かすことを優先した設計上の妥協点" +
    "であり、意図的にそのままにしてある（会話としての時系列の自然さは崩れるが、" +
    "「同じ4件を並べ替える」という依頼の指定を文字通り満たす）。",
  m5:
    "位置だけを動かす・中間（話題A）。m0と同じ4件をそのまま使い、提案を2件目にする" +
    "（1件目は無関係な世間話、3件目に同意の反応、4件目にもう1件の世間話）。この並びは" +
    "m4と異なり「了解です」が提案の直後に来るため、時系列としての不自然さは生じていない。",
};

const rationaleTopicB = {
  m0:
    "基準（話題B=締切、話題Aとは独立の題材で同じ言い切りの形）。話題Aのm0と同じ構造" +
    "（言い切り・4件・提案1件目+同意の反応+無関係な世間話2件）を、締切=金曜日という" +
    "別の話題に適用する。要因ごとの効果が話題Aだけの偶然でないかを見るための対照。",
  m1:
    "言い回しだけを動かす（話題B）。m0の1件目「締切は金曜日にします」を「締切は金曜日で" +
    "いいですか？」に変える。2〜4件目はm0と同じ。話題Aのm1と対にして読み、言い回しの" +
    "効果が話題に依らず同じ向きに出るかを見る。",
  m2:
    "件数だけを動かす・少（話題B）。文脈は提案1件のみ。話題Aのm2と同じ一貫性" +
    "（反応系の発言を件数変種に混ぜない）。",
  m3:
    "件数だけを動かす・多（話題B）。提案は1件目のまま、無関係な他人の雑談7件（雨・週末の" +
    "過ごし方・映画——いずれも締切に触れない）を足して計8件にする。話題Aのm3と同じ理由で" +
    "「了解です、よろしくお願いします」は使わない。",
  m4:
    "位置だけを動かす・末尾（話題B）。m0と同じ4件をそのまま並べ替え、提案を4件目にする。" +
    "話題Aのm4と同じ設計上の妥協点（同意の反応が時系列上は提案より前に来る）を引き受ける。",
  m5:
    "位置だけを動かす・中間（話題B）。m0と同じ4件をそのまま並べ替え、提案を2件目にする。" +
    "話題Aのm5と同じく、同意の反応は提案の直後（3件目）に置いた。",
};

export const factorsEvalCases = [
  ...buildTopicCases("topicA", topicA, rationaleTopicA),
  ...buildTopicCases("topicB", topicB, rationaleTopicB),
];

export const FACTORS_EVAL_TENANT_ID = TENANT_ID;
export const FACTORS_EVAL_RECORDED_AT = RECORDED_AT;
