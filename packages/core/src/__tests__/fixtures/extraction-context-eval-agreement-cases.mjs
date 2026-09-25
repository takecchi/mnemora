// Issue #704 のさらに続き。PR #740（ADR 0299 追記3）の要因分離（言い回し・件数・位置）は
// 「話題間で揃って回復する要因は1つに絞れなかった」で終わった。そのADR追記3自身が、
// 「未検証の仮説」として次を書き残していた:
//   PR #740 の12ケースは、応答がすべて「それでお願いします」だった。PR #737 で5/5
//   だった i 系は、応答が「大丈夫です」「それで大丈夫です」の類だった。**同意の言い方は
//   動かしていない要因**であり、これまでの結果からは何も言えない。
// 本ファイルは、この「同意の言い方」という未検証の仮説を、初めて単独の要因として動かす
// （マネージャー依頼）。`extraction.ts` は1バイトも変えない。
//
// 組み方: 基準は PR #740 の m0（eval-m0-topicA-baseline / eval-m0-topicB-baseline）。
// **observation の発話テキスト（田中の同意の言い方）だけを変え、文脈
// （contextMessages）・話者（speaker/subjectId）・日時（occurredAt/recordedAt/timeZone）は
// m0 と1バイトも違わず同じにする**——`buildExtractionPrompt` はプロンプト本文の JSON に
// speaker/subjectId/occurredAt/recordedAt/observedLocalDate/relativeDates/context/timeZone
// を埋め込む（`packages/core/src/extraction.ts` 実測）ため、これらのどれか1つでも変えると
// 「言い方だけを動かした」という前提が崩れる。
//
// 同意の言い方は4種（依頼が名指し）: 「大丈夫です」「それで」「了解です、それで行きましょう」
// 「それでいいです」。対照として、m0 そのもの（「それでお願いします」）も**同じ回に**
// 測り直す——PR #740 の m0 の記録済み結果（話題A 1/5・話題B 2/5）を対照として流用せず、
// 同一バッチ内で録り直すことで、バッチ間の変動（モデル・APIの日々のばらつき）を対照と
// 各言い方とで揃える。
//
// 話題は PR #740 と同じ2つ（話題A: 集合場所=正面玄関、話題B: 締切=金曜日）。
// 各話題で5ケース（対照+4種）、計10ケース、各5回で50回。
//
// 期待値は m0 と同じにする（参照先の語が includes に入るだけ——`extraction.ts` を見て
// 調整した開発ケースではない）。
//
// 各ケースは5回ずつ録音する（`scripts/record-extraction-context-eval-agreement.mjs`）。
//
// ⛔ このファイルは録音後に書き換えない——期待値・入力を結果に合わせて直すことはしない。
// 直したくなった点は commit せず、報告に書く。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。判定（機械的な
// 包含/非包含）は
// `packages/core/src/__tests__/extraction-context-eval-agreement.test.ts` が、録音済みの
// `extraction-context-eval-agreement-recorded.json` に対して行う。

// PR #740（`extraction-context-eval-factors-cases.mjs`）の m0 と1バイト違わず同じ値。
const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const OCCURRED_AT = "2026-04-10T09:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";
// tenantId は observation のメタデータであり、プロンプト本文（PromptSpec）には現れない
// （`buildExtractionPrompt` は tenantId を読まない）——別のカセットキーにするためだけに
// 新しい値にしてある。この違いはプロンプト自体には影響しない。
const TENANT_ID = "context-eval-agreement";

// --- 話題A: 集合場所（PR #740 のm0=eval-l3と同一の題材。contextMessagesはm0と1バイト
//     違わず同じ）---
const topicA = {
  contextMessages: [
    { speaker: "assistant", text: "集合場所は正面玄関にします" },
    { speaker: "佐藤", text: "了解です、ありがとうございます" },
    { speaker: "鈴木", text: "今日は暑いですね" },
    { speaker: "佐藤", text: "本当に、真夏日ですね" },
  ],
  expectWord: "正面玄関",
};

// --- 話題B: 締切（話題Aと独立、PR #740 のm0と1バイト違わず同じ）---
const topicB = {
  contextMessages: [
    { speaker: "assistant", text: "締切は金曜日にします" },
    { speaker: "佐藤", text: "了解です、よろしくお願いします" },
    { speaker: "鈴木", text: "最近雨が多いですね" },
    { speaker: "佐藤", text: "本当に、傘が手放せません" },
  ],
  expectWord: "金曜",
};

// 依頼が名指しした4種＋対照（m0そのもの）。全ての話題で共通のテキストを使う——
// 言い方という単一要因だけを動かすため、テキスト自体は話題に依らず固定する。
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
