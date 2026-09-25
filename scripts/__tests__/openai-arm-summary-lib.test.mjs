import { describe, expect, it } from "vitest";
import {
  MRR_DROP_THRESHOLD,
  buildSummaryMarkdown,
  buildMarginShadowVerdictSection,
  decideMarginShadowVerdict,
  decideShadowVerdict,
  diffGroup,
  validateBaseline,
  validateMeasured,
} from "../openai-arm-summary-lib.mjs";

/**
 * Issue #109 後半: `openai-arm-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * ⭐ **最重要の検査**: 基準値と比べていること・一致なら1行で黙り違うときだけ展開すること
 * (`identifier-probe-summary-lib.test.mjs` と同じ規律)。
 * ⭐ **この集合固有の検査**: 「並走の判定」(`decideShadowVerdict`)が
 * `examples/chat/src/openai-arm-verdict.ts` の `decideEmbeddingDriftVerdict` と
 * 同じ規則で動くこと、かつ**この判定は `buildSummaryMarkdown` の出力に現れるだけで
 * exit code には影響しないこと**(この歯は純粋にオブジェクトの戻り値だけを見る——
 * exit code の検査は CLI を子プロセスで起動する歯の範囲外にある)。
 */

function makeGroup(overrides = {}) {
  return {
    group: "identifiersSparse",
    label:
      "identifier-probes/identifiers-sparse(llm=deterministic, embedding=recorded/text-embedding-3-small/256次元, haystack=sparse)",
    llmMode: "deterministic",
    embeddingMode: "recorded",
    embeddingSpace: { provider: "openai", model: "text-embedding-3-small", dimensions: 256 },
    haystackKind: "sparse",
    mrrOverall: 0.84,
    hit1Count: 21,
    hit10Count: 30,
    probeCount: 30,
    ...overrides,
  };
}

function makeMeasured(groups) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    groups,
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true", () => {
    const result = validateMeasured(makeMeasured([makeGroup()]));
    expect(result.ok).toBe(true);
  });

  it("status が measured 以外は ok:false", () => {
    const result = validateMeasured({ ...makeMeasured([makeGroup()]), status: "unknown" });
    expect(result.ok).toBe(false);
  });

  it("groups が配列でなければ ok:false", () => {
    const result = validateMeasured({ ...makeMeasured([makeGroup()]), groups: {} });
    expect(result.ok).toBe(false);
  });

  it("群の必須項目が欠けていれば ok:false", () => {
    const bad = makeGroup();
    delete bad.mrrOverall;
    const result = validateMeasured(makeMeasured([bad]));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mrrOverall/);
  });

  it("group 名の重複は ok:false", () => {
    const result = validateMeasured(makeMeasured([makeGroup(), makeGroup()]));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2件以上/);
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true", () => {
    const result = validateBaseline({ groups: [makeGroup()] });
    expect(result.ok).toBe(true);
  });

  it("groups が無ければ ok:false", () => {
    const result = validateBaseline({});
    expect(result.ok).toBe(false);
  });
});

describe("diffGroup", () => {
  it("完全一致なら matches:true", () => {
    const g = makeGroup();
    const diff = diffGroup(g, g);
    expect(diff.matches).toBe(true);
  });

  it("基準値が無ければ missingBaseline:true, matches:false", () => {
    const diff = diffGroup(makeGroup(), undefined);
    expect(diff.missingBaseline).toBe(true);
    expect(diff.matches).toBe(false);
  });

  it("mrrOverall が違えば fieldDiffs に載る", () => {
    const baseline = makeGroup();
    const measured = makeGroup({ mrrOverall: 0.5 });
    const diff = diffGroup(measured, baseline);
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.some((d) => d.field === "mrrOverall")).toBe(true);
  });

  it("label だけが違っても検出する(ADR 0094 §8.1 の再発を防ぐ)", () => {
    const baseline = makeGroup({ label: "a" });
    const measured = makeGroup({ label: "b" });
    const diff = diffGroup(measured, baseline);
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.some((d) => d.field === "label")).toBe(true);
  });
});

describe("decideShadowVerdict(⛔ 門ではない。並走の判定)", () => {
  it("基準値と完全一致なら green", () => {
    const baseline = makeGroup();
    const verdict = decideShadowVerdict(baseline, baseline);
    expect(verdict.red).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("hit@1 が基準値未満なら red", () => {
    const baseline = makeGroup({ hit1Count: 21 });
    const measured = makeGroup({ hit1Count: 20, mrrOverall: 0.84 - 0.001 });
    const verdict = decideShadowVerdict(measured, baseline);
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.some((r) => r.includes("hit@1"))).toBe(true);
  });

  it(`MRR が基準値から ${MRR_DROP_THRESHOLD} 以上落ちれば red`, () => {
    const baseline = makeGroup({ mrrOverall: 0.84 });
    const measured = makeGroup({ mrrOverall: 0.84 - MRR_DROP_THRESHOLD });
    const verdict = decideShadowVerdict(measured, baseline);
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.some((r) => r.includes("MRR"))).toBe(true);
  });

  it(`MRR の落ち幅が ${MRR_DROP_THRESHOLD} 未満なら green`, () => {
    const baseline = makeGroup({ mrrOverall: 0.84 });
    const measured = makeGroup({ mrrOverall: 0.84 - MRR_DROP_THRESHOLD / 2 });
    const verdict = decideShadowVerdict(measured, baseline);
    expect(verdict.red).toBe(false);
  });

  it("基準値が無ければ red にしない(比較できないは悪化ではない)", () => {
    const verdict = decideShadowVerdict(makeGroup(), undefined);
    expect(verdict.red).toBe(false);
  });
});

describe("buildSummaryMarkdown", () => {
  it("基準値と一致するときは差分節が1行で黙る", () => {
    const group = makeGroup();
    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([group]),
      baseline: { groups: [group] },
    });
    expect(markdown).toContain("✅ 一致");
    expect(markdown).toContain("並走の判定");
    expect(markdown).toContain("✅ 0/1 群が red");
  });

  it("red のときは並走の判定節に🔴が出る", () => {
    const baseline = makeGroup();
    const measured = makeGroup({ hit1Count: 20 });
    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([measured]),
      baseline: { groups: [baseline] },
    });
    expect(markdown).toContain("🔴 1/1 群が red");
  });

  it("baseline を渡さなければ比較節も並走の判定節も出さない", () => {
    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([makeGroup()]),
    });
    expect(markdown).not.toContain("基準値との差分");
    expect(markdown).not.toContain("並走の判定");
  });

  it("baseline を渡すと参考節(margin基準)も出る——「判定には使っていない」の文言を含む", () => {
    const group = makeGroup();
    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([group]),
      baseline: { groups: [group] },
    });
    expect(markdown).toContain("参考: margin基準の判定候補");
    expect(markdown).toContain("判定には使っていない");
    expect(markdown).toContain("ADR 0333");
  });

  it("baseline を渡さなければ参考節(margin基準)も出さない", () => {
    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([makeGroup()]),
    });
    expect(markdown).not.toContain("参考: margin基準の判定候補");
  });
});

/**
 * `decideMarginShadowVerdict`/`buildMarginShadowVerdictSection` の歯(ADR 0333 §2・§4.1・
 * §4.3「A」。⛔ 参考であり判定には使っていない)。
 *
 * baseline の5probeの margin([0.10, 0.12, 0.08, 0.11, 0.09])は
 * mean=0.10・標本標準偏差(n-1)=0.01581138830...(電卓で検算済み)——
 * `3×stdDev`≈0.04743 なので、0.05 縮めれば確実に閾値を超える。
 */
function makeProbeMargins(overrides = {}) {
  const base = {
    p1: 0.1,
    p2: 0.12,
    p3: 0.08,
    p4: 0.11,
    p5: 0.09,
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).map(([probeId, margin]) => ({ probeId, margin }));
}

function makeGroupWithMargins(probeMarginOverrides = {}, groupOverrides = {}) {
  return makeGroup({ probeMargins: makeProbeMargins(probeMarginOverrides), ...groupOverrides });
}

describe("decideMarginShadowVerdict(⛔ 参考。判定には使っていない)", () => {
  it("2件が3σ以上縮むと参考red", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(true);
    expect(verdict.red).toBe(true);
    expect(verdict.shrunkProbeCount).toBe(2);
  });

  it("1件だけ3σ以上縮んでも参考green(minShrunkProbes=2)", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(true);
    expect(verdict.red).toBe(false);
    expect(verdict.shrunkProbeCount).toBe(1);
  });

  it("基準値にこの群の probeMargins が無ければ比較できない(red にしない)", () => {
    const baseline = makeGroup(); // probeMargins 無し
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(false);
    expect(verdict.red).toBe(false);
  });

  it("実測 JSON にこの群の probeMargins が無ければ比較できない(red にしない)", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroup(); // probeMargins 無し
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(false);
    expect(verdict.red).toBe(false);
  });

  it("probeId が1件も突き合わなければ比較できない(red にしない)", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroup({
      probeMargins: [
        { probeId: "unrelated-a", margin: -1 },
        { probeId: "unrelated-b", margin: -1 },
      ],
    });
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(false);
    expect(verdict.red).toBe(false);
  });

  it("baseline margin の標本標準偏差が定義できない(全部同じ値)なら比較できない", () => {
    const baseline = makeGroupWithMargins({ p1: 0.1, p2: 0.1, p3: 0.1, p4: 0.1, p5: 0.1 });
    const measured = makeGroupWithMargins({ p1: -0.5, p2: -0.5 });
    const verdict = decideMarginShadowVerdict(measured, baseline);
    expect(verdict.comparable).toBe(false);
    expect(verdict.red).toBe(false);
  });

  it("基準値にこの群が無ければ比較できない(red にしない)", () => {
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, undefined);
    expect(verdict.comparable).toBe(false);
    expect(verdict.red).toBe(false);
  });

  it("変異: stdDevMultiplier を大きくすると同じ縮み幅では red にならない", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, baseline, {
      stdDevMultiplier: 30,
      minShrunkProbes: 2,
    });
    expect(verdict.red).toBe(false);
  });

  it("変異: minShrunkProbes を1にすると1件の縮みだけで red になる", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05 });
    const verdict = decideMarginShadowVerdict(measured, baseline, {
      stdDevMultiplier: 3,
      minShrunkProbes: 1,
    });
    expect(verdict.red).toBe(true);
  });

  it("変異: 比較の向きを反転させる(measured−baseline)と、縮んでいるのに red が消える", () => {
    // ここでの「向きの反転」変異は、実装の `drop = b - m`(baseline−measured)を
    // `m - b`(measured−baseline)に入れ替えたときと同じ効果を、呼び出し側の入力を
    // 入れ替えることで再現する——baseline と measured を丸ごと入れ替えて渡すと、
    // 「縮んだ」はずの2 probe が符号反転して「伸びた」side になり、red が消える。
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const forwardVerdict = decideMarginShadowVerdict(measured, baseline);
    expect(forwardVerdict.red).toBe(true);
    const reversedVerdict = decideMarginShadowVerdict(baseline, measured);
    expect(reversedVerdict.red).toBe(false);
  });
});

describe("buildMarginShadowVerdictSection(⛔ 参考。判定には使っていない)", () => {
  it("参考redでも、見出し・本文に「判定には使っていない」が明記される", () => {
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const section = buildMarginShadowVerdictSection([measured], [baseline]);
    expect(section).toContain("🔴");
    expect(section).toContain("判定には使っていない");
    expect(section).toContain("ADR 0333");
  });

  it("per-probe margin が無い baseline では「比較できない」を出す(赤にしない)", () => {
    const baseline = makeGroup();
    const measured = makeGroupWithMargins();
    const section = buildMarginShadowVerdictSection([measured], [baseline]);
    expect(section).toContain("比較できない");
    expect(section).not.toContain("🔴");
  });

  it("参考節が red でも、既存の並走の判定(decideShadowVerdict)の結果は変わらない", () => {
    // 並走の判定(ADR 0316)は hit1Count/mrrOverall だけを見る——margin(参考節)を
    // どれだけ動かしても、既存の判定は影響を受けない(⛔ 判定を混ぜていないことの直接確認)。
    const baseline = makeGroupWithMargins();
    const measured = makeGroupWithMargins({ p1: 0.1 - 0.05, p2: 0.12 - 0.05 });
    const marginVerdict = decideMarginShadowVerdict(measured, baseline);
    expect(marginVerdict.red).toBe(true);

    const shadowVerdict = decideShadowVerdict(measured, baseline);
    expect(shadowVerdict.red).toBe(false); // hit1Count/mrrOverall は makeGroup の既定値のまま

    const markdown = buildSummaryMarkdown({
      title: "テスト",
      measured: makeMeasured([measured]),
      baseline: { groups: [baseline] },
    });
    expect(markdown).toContain("✅ 0/1 群が red"); // 既存の並走の判定は green のまま
    expect(markdown).toContain("🔴(参考)"); // 参考節だけが red
  });
});
