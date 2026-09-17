import type { CorrectionHitCase } from "./correction-case.js";

/**
 * 訂正の相手探しベンチの**開発用**ケース集合（`tuningUse: "development"`）。
 *
 * ここは**調整に使ってよい**側である。器が動くことの確認に使い、実装のふるまいを
 * 見ながら直してよい（`correction-case-set.eval.ts` の冒頭コメントと対になる）。
 *
 * ⛔ **この集合の結果を「未使用の評価」として報告しない**（`docs/autonomy.md` §2.2 決定5）。
 *
 * ⚠ `dev-color` は repo に既に在った唯一の訂正シナリオ
 * （`correction-scenario.ts` の「好きな色は青 → 赤」）と同じ題材である。**そちらは相手を
 * `contestedPair` にハードコードしており**、相手探しの的中率という量を生成できない
 * ——この集合はそこを測れる形に置き直したものである。
 */
export const CORRECTION_CASE_SET_DEV: CorrectionHitCase[] = [
  {
    id: "dev-color",
    gold: "私の好きな色は青です。",
    distractor: "妹の好きな色は緑です。",
    correction: "訂正します。よく考えたら、好きな色は青ではなく赤でした。",
    grounds:
      "訂正の発話が「好きな色は青ではなく」と、訂正前の値（青）を名指ししている。主語はどちらも本人であり、妹の色には掛からない。",
    tuningUse: "development",
  },
  {
    id: "dev-pet",
    gold: "私は猫を2匹飼っています。",
    distractor: "同僚は犬を3匹飼っています。",
    correction: "訂正です。飼っているのは2匹ではなく3匹でした。",
    grounds:
      "訂正の発話が「2匹ではなく」と、訂正前の数を名指ししている。主語はどちらも本人であり、同僚の飼育数には掛からない。",
    tuningUse: "development",
  },
  {
    id: "dev-lang",
    gold: "普段書いているのは TypeScript です。",
    distractor: "同僚が普段書いているのは Rust です。",
    correction: "さきほどの件、普段書いているのは TypeScript ではなく Go でした。",
    grounds:
      "訂正の発話が「TypeScript ではなく」と、訂正前の値を名指ししている。主語はどちらも本人である。",
    tuningUse: "development",
  },
  {
    id: "dev-city",
    gold: "弟は札幌に住んでいます。",
    distractor: "姉は福岡で働いています。",
    correction: "訂正します。弟が住んでいるのは札幌ではなく仙台でした。",
    grounds:
      "訂正の発話が主語（弟）と訂正前の値（札幌）の両方を名指ししている。姉についての記述には掛からない。",
    tuningUse: "development",
  },
  {
    id: "dev-trip",
    gold: "来月は京都へ出張します。",
    distractor: "部長は来月大阪へ出張します。",
    correction: "出張先を間違えていました。京都ではなく奈良です。",
    grounds:
      "訂正の発話が「京都ではなく」と、訂正前の行き先を名指ししている。主語はどちらも本人であり、部長の出張には掛からない。",
    tuningUse: "development",
  },
];
