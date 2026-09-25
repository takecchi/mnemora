import type { AnswerCase } from "./answer-case.js";

/**
 * `answer` ベンチの調整に使わないケース集合（held-out、`tuningUse: "held-out"`）。
 *
 * ⛔ **このファイルのケースを見て実装を調整しない。** 見て調整したら、そのケースは以後
 * `development` として扱い、`answer-case-set.dev.ts` へ移すこと（`docs/autonomy.md` §2.2
 * 決定5）。
 * ⚠ **これを機械で強制する手段は無い。ここは規律に残る。**
 *
 * 6類（`AnswerCategory`）すべてを最低1件ずつ含む（`answer-case-set.dev.ts` と同じ最低数）。
 * `unknown` 類の `grounds.turnIndex` の扱いは `answer-case-set.dev.ts` と同じ規約
 * （空配列を `unknown` のときだけ許す。`answer-case.ts` の `AnswerGrounds.turnIndex` /
 * `assertGroundsPresent` 参照）に揃える。
 *
 * ## 2026-09 追記: 誤帰属・推論の断定を検知するケース（Issue #691 完了条件4、末尾2件）
 *
 * **この2件は、実装（`buildMnemoraPrompt` の由来・話者・主題タグ描画）や dev 対照の
 * 結果を見る前に、期待値（`expected`）と根拠（`grounds.rationale`）を決めてから書いた**
 * ——このファイル冒頭の禁止（⛔ 見て調整しない）と同じ規律を、新規追加の時点でも
 * 自分自身に課した、という意味である（コミット履歴上、このケース定義のコミットは
 * 実装や描画の変更を一切含まない）。
 *
 * - `eval-misattribution-order-swapped`: 既存の `other-person` 類（本人→他人の順で
 *   事実を並べる）を、**語順を逆にした**（他人→本人の順）ストレス版。語順に引きずられて
 *   最初に出てきた値（他人の値）を「わたし」の答えとして誤帰属しないかを検査する。
 * - `eval-inferred-habit-not-attributed-to-user`: 第三者の**習慣の記述**（「〜するといつも
 *   …する」）を先に置き、本人の明示的な事実表明を後に置く。前者は「本人が明示的に
 *   述べた事実」ではなく、抽出器（`packages/core/src/extraction.ts` の
 *   `EXTRACTION_PROMPT_SYSTEM_BASE`）が `provenanceKind: "inferred"` に区別しうる
 *   類の記述——**第三者についての推論を「わたし」の事実として答えないか**を検査する。
 *
 * 🔴 **検知できないこと（意図してケースに含めなかった）**: 「推論を断定的な言い回しで
 * 話すか、留保付きで話すか」という**言い回しの確信度**は、`gradeAnswer`（文字列包含の
 * 一次判定）では原理的に閉じない——これは登録した語を含むかどうかの判定であり、
 * 語りの確信度（ヘッジの有無）を測る一次判定は設計できなかった。この次元は
 * `judgeAnswer`（LLM 採点、二次観測）の領分であり、本 Issue の完了条件が求める
 * 「答えの形が一次判定で閉じるケースだけ」という制約の外にある——ここでは扱わず、
 * 未評価のまま残す（PR #698 本文「未評価の範囲」）。
 *
 * ⚠ **話者を区別した取り込みはできていない。** `ingestConversation`（`mnemora-path.ts`）は
 * `observe()` へ `speaker: turn.role` を渡すだけであり、`answer-case-set.*` の
 * `AnswerCaseTurn.role` は `"user" | "assistant"` の2値しか持たない——会話文中に
 * 出てくる「佐藤さん」「鈴木さん」といった第三者は、`speaker` 欄としては常に `"user"`
 * （その発話をしたのは本人だから）になる。⟹ **`RecalledMemory.speaker` タグで
 * 「これは佐藤さんが言った」と直接区別することはできない**——区別できるとすれば
 * `subjectId`（抽出器が本文から判断する主題）だけである。この2ケースは
 * `subjectId`/`provenanceKind` タグと本文（digest）だけを頼りに区別できるかを見る。
 */
export const ANSWER_CASE_SET_EVAL: AnswerCase[] = [
  {
    id: "pref-window-seat",
    category: "preference",
    conversation: [
      { role: "user", text: "飛行機の座席は、通路側より窓側のほうが好きです。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "料理のレシピを教えてほしいです。" },
      { role: "assistant", text: "得意な食材はありますか。" },
      { role: "user", text: "ペットの調子があまり良くないので心配です。" },
      { role: "assistant", text: "早めに病院で診てもらうと安心です。" },
    ],
    question: "飛行機の座席は、わたしにはどちら側を用意すればいいですか?",
    expected: { kind: "closed-value", accept: ["窓側"], reject: ["通路側"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで本人が『通路側より窓側のほうが好き』と明言している。会話中にこれを覆す発言は無い。",
    },
    tuningUse: "held-out",
  },
  {
    id: "schedule-change-deadline",
    category: "schedule-change",
    conversation: [
      { role: "user", text: "報告書の提出期限は今月の20日でお願いします。" },
      { role: "assistant", text: "承知しました。20日ですね。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
      { role: "user", text: "新しい趣味を始めようと思っています。" },
      { role: "assistant", text: "それは良い挑戦だと思います。" },
      {
        role: "user",
        text: "やはり提出期限を25日に延ばしてもらえますか。20日は間に合いそうにありません。",
      },
      { role: "assistant", text: "承知しました。25日に変更します。" },
    ],
    question: "報告書の提出期限はいつですか?",
    expected: { kind: "closed-value", accept: ["25日"], reject: ["20日"] },
    grounds: {
      turnIndex: [0, 6],
      rationale:
        "第0ターンで20日と決めたが、第6ターンで『25日に延ばしてもらえますか』と依頼し、承諾されている。最新の期限は25日である。",
    },
    tuningUse: "held-out",
  },
  {
    id: "negation-moved-job",
    category: "negation",
    conversation: [
      { role: "user", text: "以前はエンジニアとして働いていました。" },
      { role: "assistant", text: "そうなんですね。" },
      { role: "user", text: "今日はいい天気ですね。" },
      { role: "assistant", text: "そうですね、良い一日になりそうです。" },
      { role: "user", text: "いまはエンジニアではなく、デザイナーとして働いています。" },
      { role: "assistant", text: "デザイナーのお仕事ですね、承知しました。" },
      { role: "user", text: "最近見た映画の感想を話したいです。" },
      { role: "assistant", text: "ぜひ聞かせてください。" },
    ],
    question: "わたしはいま何の仕事をしていますか?",
    expected: { kind: "closed-value", accept: ["デザイナー"], reject: ["エンジニア"] },
    grounds: {
      turnIndex: [0, 4],
      rationale:
        "第0ターンでエンジニアだったと述べているが、第4ターンで『いまはエンジニアではなく、デザイナーとして働いています』と明示的に否定・更新している。",
    },
    tuningUse: "held-out",
  },
  {
    id: "other-person-favorite-food",
    category: "other-person",
    conversation: [
      {
        role: "user",
        text: "わたしの好きな食べ物はラーメンです。息子の好きな食べ物はカレーです。",
      },
      { role: "assistant", text: "覚えておきますね。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      { role: "user", text: "運動不足を感じているので何か始めたいです。" },
      { role: "assistant", text: "軽い運動から始めるのがおすすめです。" },
      { role: "user", text: "仕事の進捗について相談したいことがあります。" },
      { role: "assistant", text: "詳しく教えていただけますか。" },
    ],
    question: "息子の好きな食べ物は何ですか?",
    expected: { kind: "closed-value", accept: ["カレー"], reject: ["ラーメン"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『わたしはラーメン、息子はカレー』と2人分の事実が並んでいる。問いは息子の側だけを指しており、本人のラーメンは別人（reject）の値である。",
    },
    tuningUse: "held-out",
    // ADR 0334 負債2: 本人以外の第三者（息子）が出てくるケース。正解の claim key
    // subject 候補（上限＝オラクル測定用、`AnswerCase.knownSubjects` docstring参照）。
    knownSubjects: ["user", "息子"],
  },
  {
    id: "other-period-city-last-year",
    category: "other-period",
    conversation: [
      { role: "user", text: "今年は東京に住んでいます。去年は大阪に住んでいました。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "最近読んだ本がとても面白かったです。" },
      { role: "assistant", text: "どんな内容の本でしたか。" },
      { role: "user", text: "お昼ご飯は何を食べようか迷っています。" },
      { role: "assistant", text: "軽めのものはいかがでしょうか。" },
    ],
    question: "去年、わたしはどこに住んでいましたか?",
    expected: { kind: "closed-value", accept: ["大阪"], reject: ["東京"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『今年は東京、去年は大阪』と期間ごとの事実が並んでいる。問いは去年を指しており、今年の東京は別期間（reject）の値である。",
    },
    tuningUse: "held-out",
  },
  {
    id: "unknown-favorite-number",
    category: "unknown",
    conversation: [
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "新しい趣味を始めようと思っています。" },
      { role: "assistant", text: "それは良い挑戦だと思います。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      { role: "user", text: "料理のレシピを教えてほしいです。" },
      { role: "assistant", text: "得意な食材はありますか。" },
    ],
    question: "わたしの好きな数字は何ですか?",
    expected: {
      kind: "must-abstain",
      accept: ["分かりません", "分かりかねます", "聞いていません", "知りません", "存じません"],
      reject: ["7", "3", "8"],
    },
    grounds: {
      // `answer-case-set.dev.ts` の unknown ケースと同じ採用: 空配列を許す。
      turnIndex: [],
      rationale:
        "会話のどのターンにも好きな数字についての言及が無い。根拠となるターンが構造的に存在しない。",
    },
    tuningUse: "held-out",
  },
  {
    id: "eval-misattribution-order-swapped",
    category: "other-person",
    conversation: [
      {
        role: "user",
        text: "同僚の佐藤さんの好きな飲み物はコーヒーです。わたしの好きな飲み物は紅茶です。",
      },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
    ],
    question: "わたしの好きな飲み物は何ですか?",
    expected: { kind: "closed-value", accept: ["紅茶"], reject: ["コーヒー"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『佐藤さんはコーヒー、わたしは紅茶』の順で2人分の事実が並ぶ——" +
        "既存の other-person ケースとは逆に、他人の事実が先に置かれている。" +
        "問いは『わたし』を指しており、先に出てきた佐藤さんのコーヒーは別人（reject）の" +
        "値である。語順に引きずられて誤帰属しないかを検査する。",
    },
    tuningUse: "held-out",
    // ADR 0334 負債2: 本人以外の第三者（同僚の佐藤さん）が出てくるケース。正解の
    // claim key subject 候補（上限＝オラクル測定用、`AnswerCase.knownSubjects`
    // docstring参照）。会話中の呼び方に揃えて「佐藤さん」を使う。
    knownSubjects: ["user", "佐藤さん"],
  },
  {
    id: "eval-inferred-habit-not-attributed-to-user",
    category: "other-person",
    conversation: [
      { role: "user", text: "友人の鈴木さんは我が家に来るといつも麦茶を飲みます。" },
      { role: "assistant", text: "そうなんですね。" },
      { role: "user", text: "わたしの好きな飲み物は緑茶です。" },
      { role: "assistant", text: "覚えておきますね。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
    ],
    question: "わたしの好きな飲み物は何ですか?",
    expected: { kind: "closed-value", accept: ["緑茶"], reject: ["麦茶"] },
    grounds: {
      turnIndex: [2],
      rationale:
        "第0ターンは友人・鈴木さんの来訪時の習慣（麦茶を飲む）についての言及であり、" +
        "本人が明示的に述べた事実ではない——抽出されるとしても、それは鈴木さん側の" +
        "事実（または推論）であって『わたし』の事実ではない。第2ターンで本人が" +
        "『好きな飲み物は緑茶です』と明示的に述べており、問いは『わたし』を指す。" +
        "鈴木さんの麦茶を『わたし』の答えとして混同しないか（誤帰属の検知）を検査する。",
    },
    tuningUse: "held-out",
    // ADR 0334 負債2: 本人以外の第三者（友人の鈴木さん）が出てくるケース。正解の
    // claim key subject 候補（上限＝オラクル測定用、`AnswerCase.knownSubjects`
    // docstring参照）。会話中の呼び方に揃えて「鈴木さん」を使う。
    knownSubjects: ["user", "鈴木さん"],
  },
];
