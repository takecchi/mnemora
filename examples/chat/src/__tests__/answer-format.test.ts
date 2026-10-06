import { describe, expect, it } from "vitest";
import {
  formatAnswerContentPreservation,
  formatAnswerInputReduction,
  formatAnswerIntro,
  formatAnswerQualityBanner,
} from "../answer-format.js";

/**
 * `formatAnswerQualityBanner` の**陽性対照**（Issue #577 / ADR 0260 の増分）。
 *
 * ## 🔴 なぜこの歯が要るのか —— 「消えた」と「廃止した」を区別する
 *
 * ADR 0260 の決定により、`answer` の**既定の道**（env 無指定・鍵なし）は
 * `deterministic` から `recorded` へ倒れる。⟹ `answerQualityClaimable` が
 * `false` → `true` に反転し、⛔⛔⛔「回答品質は測っていない」バナーが
 * **既定の画面から消える**。
 *
 * ⚠ **既定の道でバナーが出ないことだけを歯にすると、それは「バナーを廃止した」
 * でも同じ結果になる。** ⟹ 後から読む人に、次の2つを区別する手段が無い:
 *
 * | | 既定の道でバナーが出ない |
 * |---|---|
 * | **実態が `recorded` に変わり、バナーの条件が偽になった**（正しい） | ⭕ |
 * | **バナーそのものを消した**（誤り） | ⭕ |
 *
 * ⟹ ⭐ **だから「`deterministic` では依然としてバナーが出る」を別に固定する。**
 * この歯が緑である限り、バナーは生きている——既定の画面から消えたのは、
 * 条件が偽になったからだと言える。
 *
 * ⛔ **`qualityClaimable` の真偽値だけを見る歯では足りない。** 画面に出る側
 * （この関数が返す文字列そのもの）まで通っていることを確かめる必要がある
 * ——ADR 0051 の「⚠『黙って別のものへ倒れない』は、表示層まで及ばないと
 * 意味が無い」と同じ線である。
 */
describe("formatAnswerQualityBanner — 陽性対照（バナーは廃止されていない）", () => {
  it("⭐ deterministic では ⛔⛔⛔ バナーが出る（これが偽になったら、バナーが壊れている）", () => {
    const banner = formatAnswerQualityBanner("deterministic");
    expect(banner).not.toBe("");
    expect(banner).toContain("⛔⛔⛔");
    expect(banner).toContain("回答品質は測っていない");
    expect(banner).toContain("llmMode=deterministic");
  });

  it("recorded ではバナーが出ない（記録は実 API 由来なので、品質を主張してよい）", () => {
    expect(formatAnswerQualityBanner("recorded")).toBe("");
  });

  it("openai でもバナーが出ない", () => {
    expect(formatAnswerQualityBanner("openai")).toBe("");
  });
});

/**
 * `formatAnswerInputReduction` の見出しと値の向き。
 * 【実測 2026-09-27、空の DB で `run answer`】以前は「入力量の削減率 … chars -26.3%
 * （合計 3924 → 4956）」と出ていた——値は定義（`(naive - mnemora) / naive`）どおりだが、
 * mnemora のほうが26%多いのに「削減率 -26.3%」と読めるので、「26%削った」と読み違えやすい。
 * ⟹ 見出しに差の向き（mnemora − 全文。負なら mnemora が少ない）を書き、値にも言葉を添える。
 * どちらの向きでも正しく読めることを見る。
 */
describe("formatAnswerInputReduction — 差の向きを読み違えない", () => {
  const results = (naiveChars: number, mnemoraChars: number) =>
    [
      {
        naive: { inputChars: naiveChars, inputEstimatedTokens: naiveChars },
        mnemora: { inputChars: mnemoraChars, inputEstimatedTokens: mnemoraChars },
      },
    ] as never;

  it("見出しに差の向き（mnemora − 全文、負なら mnemora が少ない）を書く", () => {
    const text = formatAnswerInputReduction(results(3924, 4956));
    expect(text).toContain("mnemora − 全文");
    expect(text).toContain("負なら mnemora が少ない");
    expect(text).not.toContain("削減率");
  });

  it("mnemora が多いときは +差 と「多い」", () => {
    const text = formatAnswerInputReduction(results(3924, 4956));
    expect(text).toContain("3924 → 4956");
    expect(text).toContain("+1032");
    expect(text).toContain("mnemora が 26.3% 多い");
  });

  it("mnemora が少ないときは −差 と「少ない」", () => {
    const text = formatAnswerInputReduction(results(1000, 250));
    expect(text).toContain("-750");
    expect(text).toContain("mnemora が 75.0% 少ない");
  });

  it("同じなら「同じ」", () => {
    const text = formatAnswerInputReduction(results(500, 500));
    expect(text).toContain("±0");
    expect(text).toContain("同じ");
  });
});

/**
 * `answer` の導入文。ADR 0260 により、記録の再生（`recorded`）と実 API（`openai`）は
 * 品質を主張してよいモードで、⛔⛔⛔ バナーも出ない（上の陽性対照）。
 * 【実測 2026-09-27、鍵なしの既定の道＝`recorded`】以前の導入文は、モードに関係なく
 * 「これは配線の検査であり、回答品質は測っていない」と言いながら、表には ✅/❌ の判定が
 * 並んでいた——画面の中で言っていることが食い違っていた。⟹ モードで出し分ける。
 */
describe("formatAnswerIntro — 品質を主張できるかで出し分ける", () => {
  it("deterministic では「配線の検査であり、回答品質は測っていない」と言う", () => {
    const text = formatAnswerIntro("deterministic");
    expect(text).toContain("配線の検査であり、回答品質は測っていない");
  });

  it.each(["recorded", "openai"] as const)(
    "%s では「測っていない」と言わず、判定がどの LLM の回答によるかを言う",
    (mode) => {
      const text = formatAnswerIntro(mode);
      expect(text).not.toContain("回答品質は測っていない");
      expect(text).toContain(`llmMode=${mode}`);
      expect(text).toContain("正誤");
    },
  );
});

// Issue #1776 の #699 のコメント（ADR 0665）: `formatAnswerContentPreservation` を
// `must-abstain` 入りの結果で見る歯が無く、分母に must-abstain を含める変異が緑だった。
describe("formatAnswerContentPreservation: 分母は must-abstain 類を除いた件数（#699）", () => {
  const path = (applicable: boolean, preserved: boolean) =>
    ({ contentPreservation: { applicable, preserved, matchedAcceptTerms: [] } }) as never;
  const results = [
    { naive: path(true, true), mnemora: path(true, false) },
    { naive: path(true, true), mnemora: path(true, true) },
    { naive: path(false, true), mnemora: path(false, true) }, // must-abstain
  ] as never;

  it("naive 2/2・mnemora 1/2（must-abstain の1件は分母にも分子にも入らない）", () => {
    const line = formatAnswerContentPreservation(results);
    expect(line).toContain("naive 2/2 件");
    expect(line).toContain("mnemora 1/2 件");
    expect(line).toContain("分母は must-abstain 類を除いた 2 件");
  });
});
