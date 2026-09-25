import { describe, expect, it } from "vitest";
import {
  MRR_DROP_THRESHOLD,
  buildSummaryMarkdown,
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
});
