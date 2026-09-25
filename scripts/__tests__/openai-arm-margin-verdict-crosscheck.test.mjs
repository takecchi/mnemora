import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGIN_DROP_OPTIONS,
  decideMarginDropVerdict,
} from "../../examples/chat/src/verdict-candidate-margin.ts";
import { computeMarginStats } from "../../examples/chat/src/identifier-arm.ts";
import {
  MARGIN_VERDICT_OPTIONS,
  computeMarginStatsShadow,
  decideMarginShadowVerdict,
} from "../openai-arm-summary-lib.mjs";

/**
 * ADR 0333 §2・§4.1・§4.3「A」の後続作業(クローン miku の判断)。
 *
 * `scripts/openai-arm-summary-lib.mjs` の `decideMarginShadowVerdict`/
 * `computeMarginStatsShadow` は、正本 `examples/chat/src/verdict-candidate-margin.ts`
 * (`decideMarginDropVerdict`)・`examples/chat/src/identifier-arm.ts`
 * (`computeMarginStats`)の**手複製**である(`.mjs` は `tsx` を通さず CI で直接 `node`
 * 実行されるため TS を import できない——`openai-arm-summary-lib.mjs` 冒頭の
 * docstring・`MRR_DROP_THRESHOLD` と同じ事情)。
 *
 * **この歯は、その手複製が実際に同じ入力で同じ出力を返すことを検査する。**
 * ADR 0316 側の手複製(`decideShadowVerdict`/`decideEmbeddingDriftVerdict`)には
 * 同種の歯が無い——`openai-arm-summary-lib.mjs` 自身の docstring がそれを
 * 「検出できていない負債」と明記している。この歯は、margin基準の候補についてだけ、
 * その負債を埋める。
 *
 * ⚠ **「同じ入力」の作り方が両者で少し違う**——TS側 `decideMarginDropVerdict` は
 * 呼び出し側が既に揃えた同順の `(number|null)[]` を受け取る前提だが、`.mjs` 側
 * `decideMarginShadowVerdict` は `probeId` をキーに交差を取ってから比べる
 * (`OpenAiArmProbeMarginJson[]` を読むため)。**この歯は、`.mjs` 側と同じ `probeId`
 * 交差をこの場で組み立ててから TS側へ渡す**——「同じ入力」を保証した上で
 * 出力を突き合わせる。
 */

function makeProbeMargins(overrides = {}) {
  const base = { p1: 0.1, p2: 0.12, p3: 0.08, p4: 0.11, p5: 0.09 };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).map(([probeId, margin]) => ({ probeId, margin }));
}

/** `.mjs` 側と同じ`probeId`交差を、TS側の位置合わせ配列として組み立てる。 */
function toAlignedArrays(measuredProbeMargins, baselineProbeMargins) {
  const baselineByProbe = new Map(baselineProbeMargins.map((p) => [p.probeId, p.margin]));
  const measuredAligned = [];
  const baselineAligned = [];
  for (const m of measuredProbeMargins) {
    if (!baselineByProbe.has(m.probeId)) continue;
    measuredAligned.push(m.margin);
    baselineAligned.push(baselineByProbe.get(m.probeId));
  }
  return { measuredAligned, baselineAligned };
}

function crossCheck(measuredProbeMargins, baselineProbeMargins, options) {
  const { measuredAligned, baselineAligned } = toAlignedArrays(
    measuredProbeMargins,
    baselineProbeMargins,
  );
  const tsVerdict = decideMarginDropVerdict(measuredAligned, baselineAligned, options);
  const shadowVerdict = decideMarginShadowVerdict(
    { probeMargins: measuredProbeMargins },
    { probeMargins: baselineProbeMargins },
    options,
  );
  return { tsVerdict, shadowVerdict };
}

describe("TS↔mjs 突き合わせ: computeMarginStats", () => {
  it("同じ margin 配列から同じ MarginStats(count/mean/stdDev/min)を返す", () => {
    const margins = [0.1, 0.12, 0.08, 0.11, 0.09, null, -0.02];
    expect(computeMarginStatsShadow(margins)).toEqual(computeMarginStats(margins));
  });

  it("count<2(n=0,1)でも stdDev=null で揃う", () => {
    expect(computeMarginStatsShadow([])).toEqual(computeMarginStats([]));
    expect(computeMarginStatsShadow([0.5])).toEqual(computeMarginStats([0.5]));
  });

  it("全部同じ値(stdDev=0)でも揃う", () => {
    const margins = [0.2, 0.2, 0.2];
    expect(computeMarginStatsShadow(margins)).toEqual(computeMarginStats(margins));
  });
});

describe("TS↔mjs 突き合わせ: decideMarginDropVerdict / decideMarginShadowVerdict", () => {
  it("既定の閾値(stdDevMultiplier=3, minShrunkProbes=2)が両ファイルで一致する", () => {
    expect(MARGIN_VERDICT_OPTIONS).toEqual(DEFAULT_MARGIN_DROP_OPTIONS);
  });

  it("2件が3σ以上縮む入力で、両者とも red・同じ shrunkProbeCount/comparableProbeCount", () => {
    const baseline = makeProbeMargins();
    const measured = makeProbeMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline);
    expect(shadowVerdict.red).toBe(tsVerdict.red);
    expect(shadowVerdict.red).toBe(true);
    expect(shadowVerdict.shrunkProbeCount).toBe(tsVerdict.shrunkProbeCount);
    expect(shadowVerdict.comparableProbeCount).toBe(tsVerdict.comparableProbeCount);
    expect(shadowVerdict.baselineMarginStats).toEqual(tsVerdict.baselineMarginStats);
  });

  it("1件だけ縮む入力で、両者とも green(red:false)で一致する", () => {
    const baseline = makeProbeMargins();
    const measured = makeProbeMargins({ p1: 0.1 - 0.05 });
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline);
    expect(shadowVerdict.red).toBe(tsVerdict.red);
    expect(shadowVerdict.red).toBe(false);
    expect(shadowVerdict.shrunkProbeCount).toBe(tsVerdict.shrunkProbeCount);
  });

  it("baseline の標本標準偏差が定義できない(全部同じ値)入力で、両者とも red にしない", () => {
    const baseline = makeProbeMargins({ p1: 0.1, p2: 0.1, p3: 0.1, p4: 0.1, p5: 0.1 });
    const measured = makeProbeMargins({ p1: -0.5, p2: -0.5 });
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline);
    expect(tsVerdict.red).toBe(false);
    expect(shadowVerdict.red).toBe(false);
    expect(shadowVerdict.comparable).toBe(false);
  });

  it("変異(stdDevMultiplier=30)を両側に同時に与えても一致し続ける(閾値だけを動かした比較)", () => {
    const baseline = makeProbeMargins();
    const measured = makeProbeMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const options = { stdDevMultiplier: 30, minShrunkProbes: 2 };
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline, options);
    expect(shadowVerdict.red).toBe(tsVerdict.red);
    expect(shadowVerdict.red).toBe(false);
  });

  it("変異(minShrunkProbes=1)を両側に同時に与えても一致し続ける", () => {
    const baseline = makeProbeMargins();
    const measured = makeProbeMargins({ p1: 0.1 - 0.05 });
    const options = { stdDevMultiplier: 3, minShrunkProbes: 1 };
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline, options);
    expect(shadowVerdict.red).toBe(tsVerdict.red);
    expect(shadowVerdict.red).toBe(true);
  });

  it("実測(コミット済みカセット再生)相当の実データでも一致する(識別子2群相当の分布)", () => {
    // examples/chat/identifier-probe-baseline.openai.json の identifiersSparse 群
    // 相当の margin 分布(実際にこのブランチで recorded 再生して得た値の先頭6件)。
    const baseline = [
      { probeId: "a", margin: 0.20959781014893664 },
      { probeId: "b", margin: 0.046534273081364264 },
      { probeId: "c", margin: -0.024731066499266707 },
      { probeId: "d", margin: 0.0230066454177279 },
      { probeId: "e", margin: -0.00828738134105178 },
      { probeId: "f", margin: -0.11793100320731442 },
    ];
    const measured = baseline.map((p) => ({ ...p })); // 変化なし(基準値と同じ再生)
    const { tsVerdict, shadowVerdict } = crossCheck(measured, baseline);
    expect(shadowVerdict.red).toBe(tsVerdict.red);
    expect(shadowVerdict.red).toBe(false);
    expect(shadowVerdict.baselineMarginStats).toEqual(tsVerdict.baselineMarginStats);
  });
});
