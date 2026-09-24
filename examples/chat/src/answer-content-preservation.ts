import type { AnswerExpectation } from "./answer-case.js";
import { normalizeForGrading } from "./answer-case.js";

/**
 * 層2（回答に必要な情報の保持）の決定的な指標（Issue #693 / 親 #498）。
 *
 * `docs/autonomy.md` §2.2 決定2 は三層を区別することを求めている:
 *
 * - 層1 出典への到達 —— `provenance-trace.ts` の `resultContainsObservation`。
 *   `sourceObservationId` を辿るだけで、`digest` の中身を一切読まない
 *   （ADR 0052・ADR 0226）。
 * - 層2 回答に必要な情報の保持 —— **この関数**。
 * - 層3 最終回答の正しさ —— `gradeAnswer`（`answer-case.ts`、一次判定）と
 *   `judgeAnswer`（`answer-judge.ts`、二次観測・LLM 採点）。
 *
 * ⭐ **これは LLM を呼ばない。DB も呼ばない。純関数である。** モデルへ実際に渡す文字列
 * （`serializePromptSpec` の出力。`answer-bench.ts`）と、そのケースの `expected.accept`
 * （すでに全ケースへ手で書いてある「答えが一意に閉じる」ときの正解語）だけを見る——
 * 新しい正解データを何も追加で書かない。
 *
 * ## 何を測るか
 *
 * `expected.kind === "closed-value"` のとき、`expected.accept` のどれか1つでも
 * （`normalizeForGrading` で正規化した上で）モデルへ渡す文字列に**部分文字列として
 * 含まれているか**を見る。含まれていれば、モデルが正しく答えるために必要な生の情報が
 * 少なくとも入力の中に存在する——ただし**モデルが実際にそれを使って正しく答えるか**
 * （層3）は別問題である。
 *
 * **実例（Issue #693 の調査で見つけた、recorded カセットの現物）**:
 * `schedule-change-deadline`（`answer-case-set.eval.ts`）の mnemora 側の digest には
 * 「提出期限を25日に延ばしてもらいたいという要望がある。」が実際に含まれており、
 * `expected.accept = ["25日"]` は層2で `preserved: true` になる。**それでも実際の回答は
 * 「報告書の提出期限は今月の20日です。」（`reject` 値）だった**——ADR 0233 が見つけた
 * 自然発生の fail である。⟹ **層2 が真でも層3 が真とは限らない**、という
 * `docs/autonomy.md` §2.2 の主張を、この関数は実データで再確認できる形にする。
 *
 * `expected.kind === "must-abstain"` のケース（`category: "unknown"`）には、そもそも
 * 会話に根拠となる事実が無い（`AnswerGrounds.turnIndex` が空配列——`answer-case.ts` の
 * docstring）。保持すべき事実そのものが存在しないので、`applicable: false` を返す
 * ——`preserved` は意味を持たないダミー値ではなく `true` を返す（「保持すべきものが
 * 無いので、失われてもいない」という立場を型ではなく値で表す。呼び出し側は
 * `applicable` を先に見ること）。
 *
 * ## 確かめていないこと・既知の限界
 *
 * - **部分文字列一致であり、意味的な言い換えは検出できない。** `expected.accept` に
 *   書いていない言い回し（例: 「紅茶」ではなく「ティー」）で情報が残っていても、
 *   この関数は `preserved: false` を返す——**偽陰性がありうる**。ケース集合が
 *   閉じた短い値（`answer-case.ts` の `gradeAnswer` と同じ制約）を選んでいることで
 *   実害を抑えているが、構造的に排除してはいない。
 * - **`expected.reject` は見ない。** 誤った値が同時に入力へ混ざっていても
 *   `preserved` は変わらない——「必要な情報があるか」だけを見ており、「紛らわしい
 *   情報も混ざっているか」は別の関心事である（それが層3・`gradeAnswer`/judge の役目）。
 * - **naive 経路（全文）でこの関数が `false` を返すことは、ケース集合の作り方
 *   （`expected.accept` は元の発話からの引用）が正しい限り起こらないはずである
 *   ——起きたら、ケースの authoring 自体を疑うこと**
 *   （`__tests__/answer-content-preservation.test.ts` の
 *   「naive 経路は常に preserved」の歯を参照）。
 */
export interface ContentPreservationResult {
  /**
   * `expected.kind === "must-abstain"` のときは `false`
   * ——保持すべき事実そのものが会話に無い。
   */
  applicable: boolean;
  /**
   * `applicable === false` のときは常に `true`
   * （「保持すべきものが無いので、失われてもいない」）。
   * `applicable === true` のときは `matchedAcceptTerms.length > 0` と同値。
   */
  preserved: boolean;
  /** 実際に見つかった `expected.accept` の要素（診断用）。`applicable === false` なら空配列。 */
  matchedAcceptTerms: string[];
}

/**
 * `serializedPrompt`（`answer-bench.ts` の `serializePromptSpec` の出力を想定するが、
 * この関数自体は文字列を受け取るだけで由来を問わない）に、`expected.accept` のいずれかが
 * 部分文字列として残っているかを判定する。
 *
 * ⛔ **`digest` 単体ではなく、モデルへ実際に渡す文字列全体を受け取ること。** 呼び出し側
 * （`answer-bench.ts`）は `serializePromptSpec(promptSpec)` の結果をそのまま渡す——
 * system 文・質問文を含めても、`expected.accept` の語がそこに紛れ込む設計にはなっていない
 * （`ANSWER_SYSTEM_PROMPT`・`buildQuestionSuffix` の文面を参照）ため、実害は無い。
 */
export function checkContentPreserved(
  serializedPrompt: string,
  expected: AnswerExpectation,
): ContentPreservationResult {
  if (expected.kind === "must-abstain") {
    return { applicable: false, preserved: true, matchedAcceptTerms: [] };
  }
  const normalizedPrompt = normalizeForGrading(serializedPrompt);
  const matchedAcceptTerms = expected.accept.filter((term) =>
    normalizedPrompt.includes(normalizeForGrading(term)),
  );
  return {
    applicable: true,
    preserved: matchedAcceptTerms.length > 0,
    matchedAcceptTerms,
  };
}
