import { describe, expect, it } from "vitest";
import { formatAnswerQualityBanner } from "../answer-format.js";

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
