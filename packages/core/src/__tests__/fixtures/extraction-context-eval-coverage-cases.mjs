// Issue #704「未評価の範囲」（曖昧な参照・複雑な日時・3人以上の会話・長い文脈）を埋めるための
// 独立評価ケース定義。
//
// ⚠ これは「実装を見て調整した開発ケース」ではない。カテゴリと期待値・根拠は Issue #704・
// Issue #689 本文が名指しした4つの未評価カテゴリ（「曖昧な参照（文脈の中に候補が2つ以上ある
// 場合）」「複雑な日時表現（週をまたぐ「来週の火曜」、期間、繰り返し）」「3人以上の会話」
// 「長い文脈」）と、ADR 0299 が `buildExtractionPrompt` に与えている指示文そのもの
// （「分からない対象を補わないでください」）だけから導いた。各カテゴリ最低1件。
//
// eval-a2 の教訓（1回の録音だけで「未達」と断定しない）を踏まえ、各ケースは3回ずつ録音し、
// 3回中0〜1回しか通らない場合は「系統的な未達」として `it.fails` で明示する
// （`extraction-context-eval-coverage.test.ts` 参照）。実装（`extraction.ts`）は変えない
// ——落ちても直そうとせず、未達として記録するだけに留める。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。

const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const TENANT_ID = "context-eval-coverage";

/** @type {import('./extraction-context-eval-coverage-cases.d.mts').CoverageEvalCase[]} */
export const coverageEvalCases = [
  {
    id: "eval-e1-ambiguous-two-candidates",
    category: "e-ambiguous-reference",
    rationale:
      "Issue #704「未評価の範囲」: 曖昧な参照（文脈の中に候補が2つ以上ある場合）。" +
      "他の話者が「AかBのどちらか」という二択（互いに排他的な具体的候補）を提案し、" +
      "田中は候補を特定せずに一般的な了承だけを返す。ADR 0299 がプロンプトへ与えている" +
      "指示そのもの（『分からない対象を補わないでください』）に従うなら、田中の記憶は" +
      "二択のどちらか一方に確定的に決め打ちしてはならない——2つの固有名詞のどちらも、" +
      "確定した記憶として単独で残らないことを期待値とする。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "了解しました",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "店員", text: "しずく亭かさくら亭、どちらか予約しておきますね" },
      ],
    },
    expect: {
      includes: [],
      excludes: ["しずく亭", "さくら亭"],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-f1-complex-relative-date-next-week-tuesday",
    category: "f-complex-relative-date",
    rationale:
      "Issue #704「未評価の範囲」: 複雑な日時表現（週をまたぐ「来週の火曜」）。" +
      "`buildExtractionPrompt` の `relativeDates` は昨日・今日・明日・明後日の4つの固定" +
      "オフセットしか計算しない（extraction.ts 参照。コード側の契約テストはこの4つだけを" +
      "保証している）——週をまたぐ相対表現の暦日計算は、モデル自身が observedLocalDate だけを" +
      "手がかりに行う必要があり、契約テストの射程外である。occurredAt は 2026-04-15" +
      "（Asia/Tokyo で水曜日）。ISO週（月曜始まり）で数えると、今週は 04-13(月)〜04-19(日)、" +
      "来週は 04-20(月)〜04-26(日)であり、「来週の火曜」は一意に 2026-04-21 に定まる" +
      "（今週の火曜 04-14 は既に過ぎているため、どちらの数え方でも次に来る火曜は同じ日になる、" +
      "という曖昧さの少ない境界を選んである）。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "来週の火曜に大阪へ出張します",
      occurredAt: "2026-04-15T00:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: /2026(?:年|-)0?4(?:月|-)0?21(?!\d)/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-g1-three-plus-speakers",
    category: "g-three-plus-speakers",
    rationale:
      "Issue #704「未評価の範囲」: 3人以上の会話。既存の話者違いケース（c系）は文脈内の" +
      "他人の発話が1人だけだったが、ここでは文脈に2人の他話者（佐藤・鈴木）を置き、" +
      "田中自身の発話と合わせて3人以上の会話にする。田中の記憶には田中自身の発話" +
      "（日本茶派）だけが残り、佐藤（コーヒー派）・鈴木（紅茶派）どちらの発話も" +
      "田中の stated として混入しないことを期待する——話者が増えても、対象話者以外の" +
      "発話を対象話者の事実として抽出しないという ADR 0299 の原則は変わらないはずである。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "私は日本茶派です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "佐藤", text: "私はコーヒー派です" },
        { speaker: "鈴木", text: "僕は紅茶派だよ" },
      ],
    },
    expect: {
      includes: ["日本茶"],
      excludes: ["コーヒー", "紅茶"],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-h1-long-context-distant-reference",
    category: "h-long-context",
    rationale:
      "Issue #704「未評価の範囲」: 長い文脈。`ExtractionContextSchema`（observation.ts）の" +
      "上限である8件ちょうどの context メッセージを使い、田中が参照する提案（会議室B）を" +
      "先頭付近（2件目）に置き、以降5件を無関係な世間話・事務連絡で埋める。田中の発話" +
      "「それでお願いします」は直近のメッセージ（8件目、雑談）ではなく2件目の提案を指す。" +
      "文脈が長くなり、かつ参照先が直近の発話ではないとき（単純な再帰性だけでは解決できない）" +
      "でも正しく解決できるかを見る——開発ケース reference・eval-a1 はどちらも直近の1発言" +
      "だけを見れば解決できる短い文脈であり、この非対称は見えていなかった。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それでお願いします",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "佐藤", text: "来週の定例、どこでやりますか？" },
        { speaker: "assistant", text: "会議室Bで確定します" },
        { speaker: "佐藤", text: "了解です、ありがとうございます" },
        { speaker: "鈴木", text: "今日は天気がいいですね" },
        { speaker: "佐藤", text: "本当に、洗濯日和です" },
        { speaker: "assistant", text: "資料は共有フォルダに置いておきますね" },
        { speaker: "鈴木", text: "確認しておきます" },
        { speaker: "assistant", text: "他に質問はありますか？" },
      ],
    },
    expect: {
      includes: ["会議室B"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
];

export const COVERAGE_TENANT_ID = TENANT_ID;
export const COVERAGE_RECORDED_AT = RECORDED_AT;
