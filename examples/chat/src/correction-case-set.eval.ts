import type { CorrectionAbstainCase, CorrectionHitCase } from "./correction-case.js";

/**
 * 訂正の相手探しベンチの**調整に使わない**ケース集合（held-out、`tuningUse: "held-out"`）。
 *
 * ⛔ **このファイルのケースを見て実装や閾値を調整しない。** 見て調整したら、そのケースは
 * 以後 `development` として扱い、`correction-case-set.dev.ts` へ移すこと
 * （`docs/autonomy.md` §2.2 決定5）。
 * ⚠ **これを機械で強制する手段は無い。ここは規律に残る。**
 *
 * ⛔ **この集合に代表性は無い。**すべて手書きであり、「実際の会話で訂正・否定・別人・
 * 別期間がどれくらいの頻度で来るか」は測っていない。⟹ **ここから出る率は、この23件に
 * ついての率である。**
 */

/** A 群（15件）: 訂正すべき相手が実在する。hit@k の分母。 */
export const CORRECTION_HIT_CASE_SET_EVAL: CorrectionHitCase[] = [
  {
    id: "move",
    gold: "引っ越し先は横浜に決まりました。",
    distractor: "弟の引っ越し先は名古屋に決まりました。",
    correction: "訂正します。引っ越し先は横浜ではなく川崎になりました。",
    grounds:
      "訂正の発話が訂正前の値（横浜）を名指ししている。主語は本人であり、弟の引っ越し先には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "commute",
    gold: "私は毎朝9時に出社しています。",
    distractor: "上司は毎朝7時に出社しています。",
    correction: "さきほどの話ですが、出社時間は9時ではなく10時の間違いでした。",
    grounds:
      "訂正の発話が訂正前の値（9時）を名指ししている。主語は本人であり、上司の出社時間には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "plan",
    gold: "契約しているのは月額980円のプランです。",
    distractor: "家族が契約しているのは月額1980円のプランです。",
    correction: "すみません、契約プランは980円ではなく1480円でした。訂正します。",
    grounds:
      "訂正の発話が訂正前の値（980円）を名指ししている。主語は本人であり、家族の契約には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "dogname",
    gold: "うちの犬の名前はモモです。",
    distractor: "隣の家の犬の名前はソラです。",
    correction: "犬の名前を間違えて伝えていました。モモではなくハナです。",
    grounds:
      "訂正の発話が訂正前の値（モモ）を名指ししている。対象は自宅の犬であり、隣家の犬には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "anniversary",
    gold: "結婚記念日は6月12日です。",
    distractor: "両親の結婚記念日は9月3日です。",
    correction: "結婚記念日を言い間違えました。6月12日ではなく6月21日です。",
    grounds:
      "訂正の発話が訂正前の値（6月12日）を名指ししている。主語は本人であり、両親の記念日には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "drink",
    gold: "私がよく飲むのはコーヒーです。",
    distractor: "妻がよく飲むのは紅茶です。",
    correction: "訂正です。よく飲むのはコーヒーではなく緑茶に変わりました。",
    grounds:
      "訂正の発話が訂正前の値（コーヒー）を名指ししている。主語は本人であり、妻の飲み物には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "editor",
    gold: "普段使っているエディタは Vim です。",
    distractor: "同僚が普段使っているエディタは Emacs です。",
    correction: "さきほどエディタを間違えました。Vim ではなく VSCode です。",
    grounds:
      "訂正の発話が訂正前の値（Vim）を名指ししている。主語は本人であり、同僚のエディタには掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "grade",
    gold: "息子は小学3年生です。",
    distractor: "姪は小学5年生です。",
    correction: "訂正します。息子は小学3年生ではなく4年生でした。",
    grounds:
      "訂正の発話が主語（息子）と訂正前の値（小学3年生）の両方を名指ししている。姪の学年には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "restaurant",
    gold: "金曜に予約したのは銀座のイタリアンです。",
    distractor: "友人が予約したのは新宿の中華料理店です。",
    correction: "予約した店を間違えて伝えていました。銀座のイタリアンではなく銀座のフレンチです。",
    grounds:
      "訂正の発話が訂正前の値（銀座のイタリアン）を名指ししている。予約したのは本人であり、友人の予約には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "meeting",
    gold: "定例会議は毎週水曜日です。",
    distractor: "採用面談は毎週金曜日です。",
    correction: "訂正します。定例会議は水曜日ではなく木曜日になりました。",
    grounds:
      "訂正の発話が対象（定例会議）と訂正前の値（水曜日）の両方を名指ししている。採用面談には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "phone",
    gold: "私の携帯番号の下4桁は4821です。",
    distractor: "会社の代表番号の下4桁は1200です。",
    correction: "携帯番号を打ち間違えました。下4桁は4821ではなく4812です。",
    grounds:
      "訂正の発話が対象（携帯番号）と訂正前の値（4821）の両方を名指ししている。会社の代表番号には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "project",
    gold: "いま担当しているのは決済基盤のプロジェクトです。",
    distractor: "後輩が担当しているのは検索基盤のプロジェクトです。",
    correction: "訂正します。私の担当は決済基盤ではなく通知基盤に変わりました。",
    grounds:
      "訂正の発話が主語（私）と訂正前の値（決済基盤）の両方を名指ししている。後輩の担当には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "hometown",
    gold: "私の出身は長野です。",
    distractor: "夫の出身は岡山です。",
    correction: "出身地を言い間違えました。長野ではなく長崎です。訂正します。",
    grounds:
      "訂正の発話が訂正前の値（長野）を名指ししている。主語は本人であり、夫の出身地には掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "allergy",
    gold: "私はそばアレルギーがあります。",
    distractor: "娘はピーナッツアレルギーがあります。",
    correction: "訂正です。アレルギーはそばではなく小麦のほうでした。",
    grounds:
      "訂正の発話が訂正前の値（そば）を名指ししている。主語は本人であり、娘のアレルギーには掛からない。",
    tuningUse: "held-out",
  },
  {
    id: "weight",
    gold: "目標体重は68キロにしています。",
    distractor: "兄の目標体重は80キロだそうです。",
    correction: "訂正します。目標体重は68キロではなく65キロに下げました。",
    grounds:
      "訂正の発話が訂正前の値（68キロ）を名指ししている。主語は本人であり、兄の目標体重には掛からない。",
    tuningUse: "held-out",
  },
];

/**
 * B 群（8件）: ⛔ **訂正してはいけない**。誤爆率・棄権率の分母。
 *
 * `docs/autonomy.md` §2.2 決定1 の4分類を2件ずつ持つ。
 */
export const CORRECTION_ABSTAIN_CASE_SET_EVAL: CorrectionAbstainCase[] = [
  {
    id: "neg-jog",
    kind: "negation",
    protectedFacts: ["毎朝6時に起きてジョギングをしています。"],
    utterance: "今朝はジョギングをしませんでした。",
    grounds:
      "「今朝しなかった」は特定の1日についての報告であり、習慣そのものを否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "neg-milk",
    kind: "negation",
    protectedFacts: ["私は牛乳を飲むとお腹を壊します。"],
    utterance: "今日は牛乳を飲みませんでした。",
    grounds:
      "「今日飲まなかった」は行動の報告であり、体質についての記憶を訂正していない。体質の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "vague-maybe",
    kind: "vague",
    protectedFacts: [],
    utterance: "やっぱりさっきのは違ったかもしれません。",
    grounds:
      "何を指しているかが発話から決まらない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  {
    id: "vague-dunno",
    kind: "vague",
    protectedFacts: [],
    utterance: "うーん、どうだったかな。少しあいまいですね。",
    grounds: "対象も値も含まない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  {
    id: "person-origin",
    kind: "other_person",
    protectedFacts: ["私が生まれ育ったのは高知です。"],
    utterance: "訂正します。同僚が生まれ育ったのは高知ではなく新潟でした。",
    grounds:
      "訂正の主語は同僚であり、同僚についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の出身地の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "person-pet",
    kind: "other_person",
    protectedFacts: ["私はハムスターを1匹飼っています。"],
    utterance: "訂正します。姉が飼っているのはハムスターではなくウサギでした。",
    grounds:
      "訂正の主語は姉であり、姉についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の飼育の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "period-team",
    kind: "other_period",
    protectedFacts: ["いま所属しているのは品質保証チームです。"],
    utterance: "去年所属していたのは品質保証チームではなく開発支援チームでした。",
    grounds:
      "訂正しているのは去年の所属についての言明であり、現在の所属の記憶には掛からない。現在の所属は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "period-live",
    kind: "other_period",
    protectedFacts: ["いまは千葉に住んでいます。"],
    utterance: "大学生のころ住んでいたのは千葉ではなく仙台でした。",
    grounds:
      "訂正しているのは学生時代の居住地についての言明であり、現在の居住地の記憶には掛からない。現在の居住地は成立し続ける。",
    tuningUse: "held-out",
  },
];
