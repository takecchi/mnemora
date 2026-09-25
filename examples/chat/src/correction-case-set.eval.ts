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
 * 別期間がどれくらいの頻度で来るか」は測っていない。⟹ **ここから出る率は、この53件に
 * ついての率である。**
 *
 * **A群6件・B群24件（合計30件）を追加した**
 * （[ADR 0291](../../../docs/decisions/0291-primary-probe-coverage-map-correction-candidate-domain.md) §5.4、
 * [ADR 0321](../../../docs/decisions/0321-correction-candidate-domain-implementation.md)）。
 * 追加分の弁別軸は「短い索引の型」（ASCII 識別子／日本語固有名詞／数詞インデックス——
 * ADR 0094・ADR 0135 がすでに一般的な想起で脆いと確立した3型）。**元の15件・8件は
 * 1文字も書き換えていない**（既存ケースは「一般値」のセルとしてそのまま残す）。
 *
 * - A群の新セル: 索引型3 × 2インスタンス = 6件（`ascii-*`/`jpname-*`/`numeral-*`）。
 * - B群の新セル: 索引型3 × kind4（`docs/autonomy.md` §2.2 決定1）× 2インスタンス = 24件。
 *
 * 各ケースの「なぜ訂正すべき/してはいけないか」の一覧表は ADR 0321 の表に1ケース1行で
 * 書いてある——ここには写さない（この doc コメントとケース個別の `grounds` が一次情報）。
 *
 * 数詞インデックスのセルは、ADR 0135 が実装した `numeral-token-probe-set.ts` の
 * 語彙の作り方（算用数字1桁＋短い助数詞・共有前置ほぼ0文字、同ファイルの
 * `arabic-short`/`arabic-medium` 相当）を借りている——ADR 0291 §7-5 が残した
 * 順序の選択肢のうち **(a)**（ADR 0135 実装済みなのでそこから借りる）を採用した。
 */

/** A 群（15件 + 新規6件 = 21件）: 訂正すべき相手が実在する。hit@k の分母。 */
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
  // --- ここから ADR 0291/0321 の新規セル（索引型 × 2インスタンス = 6件） ---
  {
    id: "ascii-a",
    gold: "PROJ-6801 の初回リリースは来月10日を予定しています。",
    distractor: "PROJ-6802 の初回リリースは来月20日を予定しています。",
    correction: "訂正します。PROJ-6801 の初回リリースは来月10日ではなく来月17日になりました。",
    grounds:
      "訂正の発話が対象の識別子（PROJ-6801）と訂正前の値（来月10日）の両方を名指ししている。PROJ-6802 は同じ書式・違う対象であり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
  {
    id: "ascii-b",
    gold: "TICKET-77410 は検索結果が表示されない不具合の報告です。",
    distractor: "TICKET-77411 は検索結果が重複表示される不具合の報告です。",
    correction:
      "訂正します。TICKET-77410 は検索結果が表示されない不具合ではなく、検索が極端に遅い不具合の報告でした。",
    grounds:
      "訂正の発話が対象の識別子（TICKET-77410）を名指ししている。TICKET-77411 は同じ書式の別チケットであり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
  {
    id: "jpname-a",
    gold: "橘啓太さんは営業部に所属しています。",
    distractor: "橘拓也さんは開発部に所属しています。",
    correction: "訂正します。橘啓太さんの所属は営業部ではなく人事部でした。",
    grounds:
      "訂正の発話が主語（橘啓太）と訂正前の値（営業部）の両方を名指ししている。橘拓也は同じ姓・違う人物であり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
  {
    id: "jpname-b",
    gold: "白鷺製作所の品質管理一課は出荷前検査を担当しています。",
    distractor: "白鷺製作所の品質管理二課は工程内検査を担当しています。",
    correction:
      "訂正します。白鷺製作所の品質管理一課の担当は出荷前検査ではなく最終検査に変わりました。",
    grounds:
      "訂正の発話が組織名（白鷺製作所の品質管理一課）と訂正前の値（出荷前検査）の両方を名指ししている。品質管理二課は同じ会社の別部署であり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
  {
    id: "numeral-a",
    gold: "5号倉庫は季節商品を保管しています。",
    distractor: "6号倉庫は日用品を保管しています。",
    correction: "訂正します。5号倉庫の保管品目は季節商品ではなく什器に変わりました。",
    grounds:
      "訂正の発話が対象（5号倉庫）と訂正前の値（季節商品）の両方を名指ししている。6号倉庫は同じ書式・違う対象であり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
  {
    id: "numeral-b",
    gold: "7番会議室は午後の定例会議で使用しています。",
    distractor: "8番会議室は午後の面談で使用しています。",
    correction: "訂正します。7番会議室の用途は定例会議ではなく研修に変わりました。",
    grounds:
      "訂正の発話が対象（7番会議室）と訂正前の値（定例会議）の両方を名指ししている。8番会議室は同じ書式・違う対象であり、訂正の対象ではない。",
    tuningUse: "held-out",
  },
];

/**
 * B 群（8件 + 新規24件 = 32件）: ⛔ **訂正してはいけない**。誤爆率・棄権率の分母。
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
  // --- ここから ADR 0291/0321 の新規セル（索引型3 × kind4 × 2インスタンス = 24件） ---
  // --- ASCII識別子 × negation ---
  {
    id: "neg-ticket-1",
    kind: "negation",
    protectedFacts: ["TICKET-90210 はまだ調査中のステータスです。"],
    utterance: "今日はTICKET-90210の対応をしませんでした。",
    grounds:
      "「今日対応しなかった」は当日の行動報告であり、チケットのステータス自体を否定していない。ステータスの記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "neg-proj-1",
    kind: "negation",
    protectedFacts: ["PROJ-4410 は毎週月曜に進捗報告をしています。"],
    utterance: "今週はPROJ-4410の進捗報告をしませんでした。",
    grounds:
      "「今週報告しなかった」は特定週の行動報告であり、報告の習慣自体を否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- ASCII識別子 × vague ---
  {
    id: "vague-ascii-1",
    kind: "vague",
    protectedFacts: [],
    utterance: "さっきの案件番号の件、やっぱり違ったかもしれません。",
    grounds:
      "どの案件番号を指しているかが発話から決まらない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  {
    id: "vague-ascii-2",
    kind: "vague",
    protectedFacts: [],
    utterance: "チケットの件、うーん、番号があいまいで自信がありません。",
    grounds: "対象のチケット番号を含まない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  // --- ASCII識別子 × other_person ---
  {
    id: "person-ticket-1",
    kind: "other_person",
    protectedFacts: ["私が担当しているのはTICKET-33210です。"],
    utterance: "訂正します。同僚が担当しているのはTICKET-33210ではなくTICKET-33220でした。",
    grounds:
      "訂正の主語は同僚であり、同僚の担当チケットについての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の担当チケットの記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "person-proj-1",
    kind: "other_person",
    protectedFacts: ["私が主担当なのはPROJ-5510です。"],
    utterance: "訂正します。後輩が主担当なのはPROJ-5510ではなくPROJ-5520でした。",
    grounds:
      "訂正の主語は後輩であり、後輩の担当案件についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の担当案件の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- ASCII識別子 × other_period ---
  {
    id: "period-ticket-1",
    kind: "other_period",
    protectedFacts: ["いま対応しているのはTICKET-61010です。"],
    utterance: "先月対応していたのはTICKET-61010ではなくTICKET-60990でした。",
    grounds:
      "訂正しているのは先月の対応チケットについての言明であり、現在の対応チケットの記憶には掛からない。現在のチケットは成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "period-proj-1",
    kind: "other_period",
    protectedFacts: ["いま参加しているのはPROJ-7010です。"],
    utterance: "去年参加していたのはPROJ-7010ではなくPROJ-6990でした。",
    grounds:
      "訂正しているのは去年の参加案件についての言明であり、現在の参加案件の記憶には掛からない。現在の案件は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 日本語固有名詞 × negation ---
  {
    id: "neg-jpname-1",
    kind: "negation",
    protectedFacts: ["毎週水曜に橘啓太さんと1on1をしています。"],
    utterance: "今週は橘啓太さんと1on1をしませんでした。",
    grounds:
      "「今週しなかった」は特定週の報告であり、1on1の習慣自体を否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "neg-jpname-2",
    kind: "negation",
    protectedFacts: ["白鷺製作所の品質管理一課は毎朝朝礼をしています。"],
    utterance: "今朝は白鷺製作所の品質管理一課の朝礼がありませんでした。",
    grounds:
      "「今朝は無かった」は特定日の報告であり、朝礼の習慣自体を否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 日本語固有名詞 × vague ---
  {
    id: "vague-jpname-1",
    kind: "vague",
    protectedFacts: [],
    utterance: "さっきの名前の話、やっぱり違ったかもしれません。",
    grounds:
      "誰の名前を指しているかが発話から決まらない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  {
    id: "vague-jpname-2",
    kind: "vague",
    protectedFacts: [],
    utterance: "部署の名前、うーん、あいまいで自信がありません。",
    grounds: "対象の部署名を含まない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  // --- 日本語固有名詞 × other_person ---
  {
    id: "person-jpname-1",
    kind: "other_person",
    protectedFacts: ["私の直属の上司は橘啓太さんです。"],
    utterance: "訂正します。同期の直属の上司は橘啓太さんではなく橘拓也さんでした。",
    grounds:
      "訂正の主語は同期であり、同期の上司についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の上司の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "person-jpname-2",
    kind: "other_person",
    protectedFacts: ["私が所属しているのは白鷺製作所の品質管理一課です。"],
    utterance:
      "訂正します。先輩が所属しているのは白鷺製作所の品質管理一課ではなく品質管理二課でした。",
    grounds:
      "訂正の主語は先輩であり、先輩の所属についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の所属の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 日本語固有名詞 × other_period ---
  {
    id: "period-jpname-1",
    kind: "other_period",
    protectedFacts: ["いまの直属の上司は橘啓太さんです。"],
    utterance: "3年前の直属の上司は橘啓太さんではなく橘拓也さんでした。",
    grounds:
      "訂正しているのは3年前の上司についての言明であり、現在の上司の記憶には掛からない。現在の上司は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "period-jpname-2",
    kind: "other_period",
    protectedFacts: ["いま所属しているのは白鷺製作所の品質管理一課です。"],
    utterance: "入社時に所属していたのは白鷺製作所の品質管理一課ではなく品質管理二課でした。",
    grounds:
      "訂正しているのは入社時の所属についての言明であり、現在の所属の記憶には掛からない。現在の所属は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 数詞インデックス × negation ---
  {
    id: "neg-numeral-1",
    kind: "negation",
    protectedFacts: ["毎週金曜に5号倉庫の棚卸しをしています。"],
    utterance: "今週は5号倉庫の棚卸しをしませんでした。",
    grounds:
      "「今週しなかった」は特定週の報告であり、棚卸しの習慣自体を否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "neg-numeral-2",
    kind: "negation",
    protectedFacts: ["毎朝7番会議室を清掃しています。"],
    utterance: "今朝は7番会議室を清掃しませんでした。",
    grounds:
      "「今朝しなかった」は特定日の報告であり、清掃の習慣自体を否定していない。習慣の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 数詞インデックス × vague ---
  {
    id: "vague-numeral-1",
    kind: "vague",
    protectedFacts: [],
    utterance: "さっきの倉庫番号の話、やっぱり違ったかもしれません。",
    grounds:
      "どの倉庫番号を指しているかが発話から決まらない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  {
    id: "vague-numeral-2",
    kind: "vague",
    protectedFacts: [],
    utterance: "会議室の番号、うーん、あいまいで自信がありません。",
    grounds: "対象の会議室番号を含まない。⟹ どの記憶を相手として選んでも、選んだ根拠が発話に無い。",
    tuningUse: "held-out",
  },
  // --- 数詞インデックス × other_person ---
  {
    id: "person-numeral-1",
    kind: "other_person",
    protectedFacts: ["私が管理しているのは5号倉庫です。"],
    utterance: "訂正します。後任が管理しているのは5号倉庫ではなく6号倉庫でした。",
    grounds:
      "訂正の主語は後任であり、後任の管理倉庫についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の管理倉庫の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "person-numeral-2",
    kind: "other_person",
    protectedFacts: ["私がよく使うのは7番会議室です。"],
    utterance: "訂正します。隣の課がよく使うのは7番会議室ではなく8番会議室でした。",
    grounds:
      "訂正の主語は隣の課であり、隣の課の利用会議室についての記憶は一度も述べられていない。⟹ 失効させてよい相手が存在しない。本人の利用会議室の記憶は成立し続ける。",
    tuningUse: "held-out",
  },
  // --- 数詞インデックス × other_period ---
  {
    id: "period-numeral-1",
    kind: "other_period",
    protectedFacts: ["いま管理しているのは5号倉庫です。"],
    utterance: "去年管理していたのは5号倉庫ではなく4号倉庫でした。",
    grounds:
      "訂正しているのは去年の管理倉庫についての言明であり、現在の管理倉庫の記憶には掛からない。現在の倉庫は成立し続ける。",
    tuningUse: "held-out",
  },
  {
    id: "period-numeral-2",
    kind: "other_period",
    protectedFacts: ["いまよく使うのは7番会議室です。"],
    utterance: "異動前によく使っていたのは7番会議室ではなく3番会議室でした。",
    grounds:
      "訂正しているのは異動前の利用会議室についての言明であり、現在の利用会議室の記憶には掛からない。現在の会議室は成立し続ける。",
    tuningUse: "held-out",
  },
];
