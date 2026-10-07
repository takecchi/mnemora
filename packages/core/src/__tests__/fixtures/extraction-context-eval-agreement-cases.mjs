// 同意の言い方だけを単独の要因として動かす評価。基準は m0（eval-m0-topicA-baseline / eval-m0-topicB-baseline）。
// observation の発話テキストだけを変え、文脈（contextMessages）・話者・日時は m0 と1バイトも違わず同じにする:
// `buildExtractionPrompt` はこれらをプロンプト本文の JSON に埋め込むため、どれか1つでも変えると
// 「言い方だけを動かした」という前提が崩れる。
//
// 対照として m0 そのもの（「それでお願いします」）も同じ回に録り直す。記録済みの結果を流用すると、バッチ間の変動が対照と各言い方とで揃わない。
//
// ⛔ このファイルは録音後に書き換えない。期待値・入力を結果に合わせて直すことはしない。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。

const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const OCCURRED_AT = "2026-04-10T09:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";
// tenantId は observation のメタデータでプロンプト本文に現れない。別のカセットキーにするためだけに新しい値にしてある。
const TENANT_ID = "context-eval-agreement";

// --- 話題A: 集合場所（contextMessages は m0 と同じ）---
const topicA = {
  contextMessages: [
    { speaker: "assistant", text: "集合場所は正面玄関にします" },
    { speaker: "佐藤", text: "了解です、ありがとうございます" },
    { speaker: "鈴木", text: "今日は暑いですね" },
    { speaker: "佐藤", text: "本当に、真夏日ですね" },
  ],
  expectWord: "正面玄関",
};

// --- 話題B: 締切（contextMessages は m0 と同じ）---
const topicB = {
  contextMessages: [
    { speaker: "assistant", text: "締切は金曜日にします" },
    { speaker: "佐藤", text: "了解です、よろしくお願いします" },
    { speaker: "鈴木", text: "最近雨が多いですね" },
    { speaker: "佐藤", text: "本当に、傘が手放せません" },
  ],
  expectWord: "金曜",
};

// 全ての話題で共通のテキストを使う。言い方という単一要因だけを動かすため。
const agreementVariants = [
  { variant: "control", text: "それでお願いします", label: "対照（PR #740のm0と同一文言）" },
  { variant: "p1-daijoubu", text: "大丈夫です", label: "同意の言い方1: 「大丈夫です」" },
  { variant: "p2-sorede", text: "それで", label: "同意の言い方2: 「それで」" },
  {
    variant: "p3-ryokai-ikimashou",
    text: "了解です、それで行きましょう",
    label: "同意の言い方3: 「了解です、それで行きましょう」",
  },
  { variant: "p4-sore-ii", text: "それでいいです", label: "同意の言い方4: 「それでいいです」" },
];

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

function buildTopicCases(topicLabel, topicTag, t) {
  return agreementVariants.map((v) => ({
    id: `eval-agreement-${topicLabel}-${v.variant}`,
    topic: topicTag,
    variant: v.variant,
    rationale:
      `${v.label}（話題${topicTag}）。文脈（contextMessages）・話者（speaker/subjectId）・` +
      `日時（occurredAt/recordedAt/timeZone）はPR #740のm0（eval-m0-${topicLabel}-baseline）と` +
      "1バイトも変えていない。動かしているのは田中の発話テキスト（同意の言い方）だけ。" +
      (v.variant === "control"
        ? "この対照はPR #740のm0の記録を流用せず、4種の言い方と同じ回に録り直したもの" +
          "——バッチ間の変動を対照と各言い方とで揃えるため。"
        : "PR #740 ADR 0299追記3が残した未検証の仮説「同意の言い方は動かしていない要因」を" +
          "初めて単独の要因として動かす。"),
    input: makeInput(v.text, t.contextMessages),
    expect: makeExpect(t.expectWord),
  }));
}

export const agreementEvalCases = [
  ...buildTopicCases("topicA", "A-meeting-point", topicA),
  ...buildTopicCases("topicB", "B-deadline", topicB),
];

export const AGREEMENT_EVAL_TENANT_ID = TENANT_ID;
export const AGREEMENT_EVAL_RECORDED_AT = RECORDED_AT;
