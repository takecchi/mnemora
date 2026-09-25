import { describe, expect, it } from "vitest";
import {
  computeIntrusionMargin,
  computeProtectionMargin,
  maxNonProtectedScore,
} from "../correction-candidate-arm.js";

/**
 * ADR 0333 §4.2「推奨（案2）」——`protectionMargin`（`correction-candidate-arm.ts` に
 * 追加した新フィールド）の純関数の歯。DB もネットワークも要らない
 * （`correction-candidate-arm-margin.test.ts` と同じ規律で値を手で組み立てる）。
 *
 * ⛔ **`correction-candidate-arm-margin.test.ts`（ADR 0321 の回帰テスト）は1文字も
 * 変えていない**——このファイルは別ファイルとして追加した。下の
 * `describe("computeIntrusionMargin は変わっていない")` は、その回帰テストと
 * 独立に、`intrusionMargin` がこの変更で1つも動いていないことを重ねて固定する。
 *
 * ⭐ **この歯が実際に噛むことを、変異試験で示した**（報告に記録。`cp` で退避 →
 * 変異 → 赤を確認 → `cp` で戻す → 緑に戻ることを確認、という
 * `AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」の手順に従った）。
 */

describe("computeProtectionMargin", () => {
  it("深い誤爆側（保護対象が最有力の非保護候補より高い）は正の値", () => {
    // ADR 0333 §3.1 実測: 深い誤爆20件は全件正（mean≈+0.037452）。
    expect(computeProtectionMargin(0.9, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("誤爆(浅)側（非保護候補が保護対象より高い）は負の値", () => {
    // ADR 0333 §3.1 実測: 誤爆(浅)4件は全件負（mean≈-0.006089）。
    expect(computeProtectionMargin(0.6, 0.8)).toBeCloseTo(-0.2, 10);
  });

  it("protectedFactScore が null（保護対象が0件・棄権）なら null", () => {
    // ADR 0333 §3.1: protectedFacts=[] の vague ケース(8件)は定義されない。
    expect(computeProtectionMargin(null, 0.8)).toBeNull();
  });

  it("topNonProtectedScore が null（非保護候補が1件も返らなかった）なら null", () => {
    expect(computeProtectionMargin(0.6, null)).toBeNull();
  });

  it("両方 null でも null", () => {
    expect(computeProtectionMargin(null, null)).toBeNull();
  });

  it("同点なら0", () => {
    expect(computeProtectionMargin(0.5, 0.5)).toBe(0);
  });
});

describe("maxNonProtectedScore", () => {
  it("protectedIds に含まれない候補のうち最大スコアを返す", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.5 } }];
    const externalIds = ["protected", "intruder"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.5, 10);
  });

  it("複数の非保護候補があれば最大を選ぶ", () => {
    const memories = [
      { score: { total: 0.9 } },
      { score: { total: 0.5 } },
      { score: { total: 0.7 } },
    ];
    const externalIds = ["protected", "intruder-weak", "intruder-strong"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeCloseTo(0.7, 10);
  });

  it("全件が保護対象なら null", () => {
    const memories = [{ score: { total: 0.9 } }];
    const externalIds = ["protected"];
    expect(maxNonProtectedScore(memories, externalIds, ["protected"])).toBeNull();
  });

  it("空配列なら null", () => {
    expect(maxNonProtectedScore([], [], ["a"])).toBeNull();
  });
});

/**
 * ⭐ この変更が `intrusionMargin` に触れていないことを、`correction-candidate-arm.ts`
 * から直接 import して重ねて確認する（`computeIntrusionMargin` はこの PR で1文字も
 * 変えていない——`correction-candidate-arm-margin.test.ts` と同じ assertion）。
 */
describe("computeIntrusionMargin は変わっていない", () => {
  it("深い誤爆のとき topScore - protectedFactScore を返す", () => {
    expect(computeIntrusionMargin(0.9, true, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("protectedFacts が1件だけの深い誤爆では0になる", () => {
    expect(computeIntrusionMargin(0.85, true, 0.85)).toBe(0);
  });

  it("誤爆(浅)のときは null（protectionMargin は同じ入力で非nullになる、という対比）", () => {
    expect(computeIntrusionMargin(0.9, false, 0.7)).toBeNull();
    expect(computeProtectionMargin(0.7, 0.9)).toBeCloseTo(-0.2, 10);
  });
});
