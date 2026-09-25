import type { AnswerCase } from "./answer-case.js";

/**
 * ADR 0334 追記 2026-09-26（2）（Issue #372負債6の続き、クローン miku の委譲で動く
 * セッションが追加。判断はクローン miku のもの、オーナーではない）。
 *
 * **既存の `answer-case-set.dev.ts`/`answer-case-set.eval.ts`（dev6+eval8=14件）は
 * 1バイトも変えない。この集合は別ファイルとして追加する**——14件の母集合・
 * `__tests__/answer-case.test.ts` の「14件中4件」の歯を動かさないため。
 *
 * ## なぜこの集合が要るか
 *
 * ADR 0334 の追記（2026-09-26）は、既存14件のうち `knownSubjects` を持つ4件
 * （`other-person-birthday` 等）で `knownSubjects` の効果を測ったが、
 * **その4件はいずれも本人の事実と第三者の事実が同じターン（同じ `observe()`
 * 呼び出し）に同居していた**（例: 「わたしの誕生日は4月3日です。妻の誕生日は
 * 9月10日です。」が1つの `AnswerCaseTurn.text`）。ADR 0334 決定1「型A」
 * （1回の `deriveClaimKeys` 呼び出しは、本番では通常「1件の Observation から
 * 抽出された候補群」だけを含む——比較材料を構造的に持たない）が成り立つのは
 * **本人の事実と第三者の事実が別ターン（別の `observe()`）にある場合**であり、
 * 既存14件はこの条件を満たしていなかった（追記「なぜ ADR 0324/決定2 の実測と
 * 食い違うか」節）。
 *
 * この集合は、本人の事実と第三者の事実を**意図的に別々のターン**（別の
 * `AnswerCaseTurn`、したがって別の `observe()` 呼び出し）に分けて書く——
 * ADR 0324 §4 real-fixture 実測・ADR 0334 決定2 の ON-ceiling 実測が使った
 * `family`/`diet`/`language` の型（誤帰属率が高かった3類、ADR 0324 §4:
 * family 4/5・language 3/5・diet 2/5）と `pet`（0/5 だった対照）を参考にした。
 *
 * ⛔ **ケースを作り込んで型Aを無理に再現させない。** 会話は自然な家族・同僚・
 * 配偶者の発話にする——ADR 0324/0334 が使った関係名詞（弟/姉/妹/同僚/父/妻）を
 * そのまま流用せず、この集合独自の自然な文にする（既存ケースとの重複を避ける
 * 意図もある）。
 *
 * ## 構造上の規約（`__tests__/answer-case-set.separate-turn.test.ts` が検査する）
 *
 * - 3〜6件。
 * - 全件 `AnswerCase.knownSubjects` を持つ（`["user", "<第三者>"]`、上限＝オラクル
 *   測定用——`AnswerCase.knownSubjects` docstring と同じ限定がそのまま当てはまる）。
 * - 全件、本人の事実の語（`expected.reject` の値）と第三者の事実の語
 *   （`expected.accept` の値）が**同じ `conversation` ターンに同居しない**——
 *   これが「別ターン」であることの機械的な歯である（同居していれば、その時点で
 *   型Aの前提が崩れる）。
 * - `tuningUse: "held-out"`——`answer-case-set.eval.ts` と同じ規律（実装の挙動を
 *   見てからケースを直さない）で、実装結果を見る前に会話・期待値・`knownSubjects`
 *   を決めてから実測に使った。
 *
 * ## 使い方
 *
 * `scripts/record-answer-claim-key.ts` の `MNEMORA_ANSWER_CASE_SET=separate-turn`
 * （opt-in、省略時は従来どおり dev+eval の14件）でこの集合を選べる。
 */
export const ANSWER_CASE_SET_SEPARATE_TURN: AnswerCase[] = [
  {
    id: "separate-turn-family-workplace",
    category: "other-person",
    conversation: [
      { role: "user", text: "最近、大阪で新しい仕事を始めました。" },
      { role: "assistant", text: "新しい環境はいかがですか。" },
      { role: "user", text: "週末に読んだ本がとても面白かったです。" },
      { role: "assistant", text: "どんな内容の本でしたか。" },
      { role: "user", text: "姉は先月、福岡に転勤になったそうです。" },
      { role: "assistant", text: "そうなんですね、慣れるまで大変そうですね。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
    ],
    question: "姉はどこで働いていますか?",
    expected: { kind: "closed-value", accept: ["福岡"], reject: ["大阪"] },
    grounds: {
      turnIndex: [4],
      rationale:
        "第4ターンで『姉は先月、福岡に転勤になった』と明言している。第0ターンの大阪は本人の勤務地であり、別人（reject）の値である。本人の事実（第0ターン）と姉の事実（第4ターン）は別ターン（別の observe()）にある。",
    },
    tuningUse: "held-out",
    knownSubjects: ["user", "姉"],
  },
  {
    id: "separate-turn-spouse-diet",
    category: "other-person",
    conversation: [
      { role: "user", text: "わたしは乳製品を控えています。" },
      { role: "assistant", text: "了解しました。" },
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "妻は小麦を控えています。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
    ],
    question: "妻は何を控えていますか?",
    expected: { kind: "closed-value", accept: ["小麦"], reject: ["乳製品"] },
    grounds: {
      turnIndex: [4],
      rationale:
        "第4ターンで『妻は小麦を控えています』と明言している。第0ターンの乳製品は本人が控えているものであり、別人（reject）の値である。本人の事実（第0ターン）と妻の事実（第4ターン）は別ターン（別の observe()）にある。",
    },
    tuningUse: "held-out",
    knownSubjects: ["user", "妻"],
  },
  {
    id: "separate-turn-colleague-language",
    category: "other-person",
    conversation: [
      { role: "user", text: "わたしは英語を話せます。" },
      { role: "assistant", text: "素晴らしいですね。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      { role: "user", text: "同僚はフランス語を話せます。" },
      { role: "assistant", text: "多才な方なんですね。" },
      { role: "user", text: "お昼ご飯は何を食べようか迷っています。" },
      { role: "assistant", text: "軽めのものはいかがでしょうか。" },
    ],
    question: "同僚は何語を話せますか?",
    expected: { kind: "closed-value", accept: ["フランス語"], reject: ["英語"] },
    grounds: {
      turnIndex: [4],
      rationale:
        "第4ターンで『同僚はフランス語を話せます』と明言している。第0ターンの英語は本人が話せる言語であり、別人（reject）の値である。本人の事実（第0ターン）と同僚の事実（第4ターン）は別ターン（別の observe()）にある。",
    },
    tuningUse: "held-out",
    knownSubjects: ["user", "同僚"],
  },
  {
    id: "separate-turn-father-pet",
    category: "other-person",
    conversation: [
      { role: "user", text: "わたしは犬を飼っています。" },
      { role: "assistant", text: "かわいいでしょうね。" },
      { role: "user", text: "最近読んだ本がとても面白かったです。" },
      { role: "assistant", text: "どんな内容の本でしたか。" },
      { role: "user", text: "父は猫を飼っています。" },
      { role: "assistant", text: "猫も癒されますね。" },
      { role: "user", text: "運動不足を感じているので何か始めたいです。" },
      { role: "assistant", text: "軽い運動から始めるのがおすすめです。" },
    ],
    question: "父は何を飼っていますか?",
    expected: { kind: "closed-value", accept: ["猫"], reject: ["犬"] },
    grounds: {
      turnIndex: [4],
      rationale:
        "第4ターンで『父は猫を飼っています』と明言している。第0ターンの犬は本人が飼っているものであり、別人（reject）の値である。本人の事実（第0ターン）と父の事実（第4ターン）は別ターン（別の observe()）にある。",
    },
    tuningUse: "held-out",
    knownSubjects: ["user", "父"],
  },
];
