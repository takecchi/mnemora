import type { AnswerCase } from "./answer-case.js";

/**
 * 本人の事実と第三者の事実を、意図的に別ターン（別の `observe()`）に分けた集合。
 * 同じターンに同居すると、1回の `deriveClaimKeys` が比較材料を持つ前提が崩れる（既存14件はそうだった）。
 *
 * 既存の `answer-case-set.dev.ts`/`answer-case-set.eval.ts` は変えず、別ファイルにする。
 * 14件の母集合と `answer-case.test.ts` の「14件中4件」の歯を動かさないため。
 *
 * ケースを作り込んで型Aを無理に再現させない。会話は自然な発話にする。
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
