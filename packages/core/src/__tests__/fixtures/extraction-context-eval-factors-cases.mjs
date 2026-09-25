// Issue #704 のさらに続き。PR #737（`extraction-context-eval-more-cases.mjs` の
// eval-l1/l2/l3）が「長い文脈の変種3本」を組んだところ、eval-l3（4件・1件目・
// 言い切り）だけが2/5（過半数割れ、run3〜5で「正面玄関」を落とす）で、
// eval-l1/l2（いずれも8件・言い切り、位置は3件目/6件目）は5/5だった。PR #737 の
// ADR追記2はl1/l2/l3が「件数・位置・話題」を同時に動かしていたため交絡しており、
// 何が効いたか確定できないと明記していた。
//
// 本ファイルは、その交絡を切り分けるために要因を1つずつ動かす評価を追加する
// （マネージャー依頼）。動かす要因は3つ: 言い回し（疑問形 vs 言い切り）・件数・位置。
// 話題を2つ用意し（話題A: eval-l3と同じ集合場所=正面玄関、話題B: 別の話題で同じ
// 言い切りの形＝締切=金曜日）、各話題で次の6ケースを作る:
//   m0 基準      : eval-l3と同じ形（言い切り・4件・1件目）
//   m1 言い回しだけ: 提案を疑問形にする。それ以外はm0と同じ
//   m2 件数だけ（少）: 文脈は提案1件だけ
//   m3 件数だけ（多）: 無関係な発言を足して8件にする。提案は1件目のまま
//   m4 位置だけ（末尾）: m0と同じ4件を並べ替え、提案を4件目にする
//   m5 位置だけ（中間）: 同じく、提案を2件目にする
// 計12ケース、各5回で60回。
//
// ⚠ 話題A・m0（eval-m0-topicA-baseline-meeting-point）は、eval-l3
// （eval-l3-length4-position1-meeting-point、`extraction-context-eval-more-cases.mjs`）
// と入力（contextMessages・text・occurredAt・timeZone）を1バイト違わず同じにしてある
// ——「同じ入力を新しい fixture で測り直す」という依頼どおりであり、tenantId・
// observation id・録音先が別であるため別カセットキーになる（`llmCassetteKey` は
// PromptSpec の SHA-256——tenantId等の observation メタデータはプロンプト本文に
// 影響しないため、実際にはプロンプト自体はeval-l3と同一になる。したがって
// m0-topicA は「eval-l3の追試（再現性の別サンプル）」でもある）。
//
// ⚠ 「了解です」のような相手の反応の扱いについて（依頼文が名指しした点）:
// - m0/m1（話題ごとに固定した4件）は、eval-l3の元の4件（提案・相手の同意の反応
//   「了解です、ありがとうございます」・無関係な世間話2件）をそのまま使う。m1は
//   m0の1件目の文言だけを疑問形に変え、2〜4件目（同意の反応を含む）はm0と同じに
//   固定する——依頼文の「それ以外はm0と同じ」を文字通り満たすため。
// - m2/m3（件数だけを動かす変種）では、追加・維持する発言を「提案と無関係な他人の
//   雑談だけ」に統一した——m0の「了解です、ありがとうございます」は提案への
//   反応として読めるため、件数だけを独立させる変種には含めない（含めると
//   「反応の有無」も一緒に動いてしまい、件数という単一要因の切り分けにならない
//   ため）。m2は提案1件のみ、m3は提案1件＋無関係な世間話7件（天気・週末・休日の
//   過ごし方など、提案に一切触れない話題）で計8件にした。
// - m4/m5（位置だけを動かす変種）は、依頼文が明示的に「m0と同じ4件を並べ替え」と
//   指定しているため、m0の4件（同意の反応を含む）をそのまま使い、並び順だけを
//   変えた。⚠ その結果、m4（提案が4件目＝末尾）では、他人の「了解です」という
//   提案への反応が、時系列上は提案より前に来てしまう（並べ替えである以上、
//   会話としての時系列の自然さは保っていない）——これは意図した設計上の妥協点
//   であり、修正していない（内容を同一に保ったまま位置だけを動かすことを
//   優先した）。m5（提案が2件目）は反応をその直後の3件目に置いたため、この
//   不自然さは生じていない。
//
// ⚠ PR #737 は l1/l2 が「疑問形かどうか」を確認していなかった（依頼文が
// 「要確認」と指摘した点）。実際に見ると、l1（「予算は50万円で確定します」）・l2
// （「新商品の名称は『そよ風』に決定します」）はどちらも eval-l3 と同じ**言い切り**
// である。つまり l1/l2 と l3 の間で言い回しは変わっていない——l1/l2 が5/5で
// l3が2/5だった差を「疑問形 vs 言い切り」に帰属させる根拠は元々無かった
// （交絡していたのは件数・位置・話題であって言い回しではない）。本ファイルの
// m1（話題ごとに言い切りを疑問形に変えた変種）は、この要因を初めて独立に動かす。
//
// ⚠ これは「実装を見て調整した開発ケース」ではない。期待値・根拠は、
// eval-l3の期待値（「正面玄関」を含む）をそのまま話題Aの各変種に流用し、話題B
// （締切=金曜日）は同じ形の期待語（「金曜」）を新たに決めた——`extraction.ts`は
// 1バイトも変えていない。
//
// 各ケースは5回ずつ録音する（`scripts/record-extraction-context-eval-factors.mjs`）。
//
// ⛔ このファイルは録音後に書き換えない——期待値・入力を結果に合わせて直すことは
// しない。直したくなった点は commit せず、報告に書く。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。
// 判定（機械的な包含/非包含）は
// `packages/core/src/__tests__/extraction-context-eval-factors.test.ts` が、録音済みの
// `extraction-context-eval-factors-recorded.json` に対して行う。

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
