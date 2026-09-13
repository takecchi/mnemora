import { describe, expect, it } from "vitest";
import {
  buildConstantTermSection,
  buildLexicalChannelWarningSection,
  buildSummaryMarkdown,
  diffArm,
  validateBaseline,
  validateMeasured,
} from "../retrieval-quality-summary-lib.mjs";

/**
 * `retrieval-quality-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * `retrieval-quality-summary.test.mjs`(本物のスクリプトを子プロセスで起動する歯)とは
 * 別の観点——ここは「組み立てのロジックそのもの」だけを見る。
 */

function makeArm(overrides = {}) {
  return {
    armLabel: "A: 擬似LLM+擬似埋め込み",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    mrrOverall: 0.018,
    mrrLexicalControl: 0,
    mrrNonLexical: 0.021,
    hit1Count: 0,
    hit10Count: 1,
    probeCount: 7,
    ...overrides,
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    const result = validateMeasured({ arms: [makeArm()] });
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("arms が無ければ落ちる", () => {
    const result = validateMeasured({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/arms/);
  });

  it("arms が空配列でも落ちる(measured は必ず arm を持つはず)", () => {
    const result = validateMeasured({ arms: [] });
    expect(result.ok).toBe(false);
  });

  it("arms が配列でなければ落ちる", () => {
    expect(validateMeasured({ arms: "not-an-array" }).ok).toBe(false);
  });

  for (const field of [
    "armLabel",
    "llmMode",
    "embeddingMode",
    "mrrOverall",
    "mrrLexicalControl",
    "mrrNonLexical",
    "hit1Count",
    "hit10Count",
    "probeCount",
  ]) {
    it(`arm から ${field} が欠けていれば落ちる`, () => {
      const arm = makeArm();
      delete arm[field];
      const result = validateMeasured({ arms: [arm] });
      expect(result.ok, `${field} が無いのに ok:true になった`).toBe(false);
      expect(result.error).toContain(field);
    });
  }

  it("数値項目が文字列など違う型なら落ちる", () => {
    const result = validateMeasured({ arms: [makeArm({ mrrOverall: "0.018" })] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mrrOverall");
  });

  it("armLabel が空文字なら落ちる", () => {
    const result = validateMeasured({ arms: [makeArm({ armLabel: "" })] });
    expect(result.ok).toBe(false);
  });

  it("複数 arm のうち1件だけ壊れていても検出する", () => {
    const result = validateMeasured({ arms: [makeArm(), { ...makeArm(), hit1Count: undefined }] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("arms[1]");
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateBaseline({ arms: [makeArm()] }).ok).toBe(true);
  });

  it("arms が空配列でも ok(基準値がまだ無い状態を許す)", () => {
    expect(validateBaseline({ arms: [] }).ok).toBe(true);
  });

  it("arms が無ければ落ちる", () => {
    expect(validateBaseline({}).ok).toBe(false);
  });

  it("arm の必須項目が欠けていれば落ちる", () => {
    const arm = makeArm();
    delete arm.mrrOverall;
    expect(validateBaseline({ arms: [arm] }).ok).toBe(false);
  });
});

describe("diffArm", () => {
  it("完全一致なら matches:true", () => {
    const arm = makeArm();
    const result = diffArm(arm, { ...arm });
    expect(result.matches).toBe(true);
    expect(result.fieldDiffs).toEqual([]);
  });

  it("基準値に対応する arm が無ければ missingBaseline:true", () => {
    const result = diffArm(makeArm(), undefined);
    expect(result.matches).toBe(false);
    expect(result.missingBaseline).toBe(true);
  });

  it("値が違う項目だけを fieldDiffs に載せる", () => {
    const measured = makeArm({ mrrOverall: 0.02, hit1Count: 1 });
    const baseline = makeArm();
    const result = diffArm(measured, baseline);
    expect(result.matches).toBe(false);
    const fields = result.fieldDiffs.map((d) => d.field).sort();
    expect(fields).toEqual(["hit1Count", "mrrOverall"]);
    const mrrDiff = result.fieldDiffs.find((d) => d.field === "mrrOverall");
    expect(mrrDiff).toEqual({ field: "mrrOverall", baseline: 0.018, measured: 0.02 });
  });

  it("armLabel 自体は比較対象に含めない(呼び出し側がラベルで対応付け済み)", () => {
    const measured = makeArm({ armLabel: "違うラベル" });
    const baseline = makeArm();
    const result = diffArm(measured, baseline);
    expect(result.fieldDiffs.some((d) => d.field === "armLabel")).toBe(false);
  });
});

describe("buildSummaryMarkdown", () => {
  const measured = {
    arms: [makeArm(), makeArm({ armLabel: "B", mrrOverall: 0.714, hit1Count: 4, hit10Count: 6 })],
  };

  it("arm・モード・MRR/hit@1/hit@10 が同一行に出る(ADR 0068 ②の形)", () => {
    const markdown = buildSummaryMarkdown({ measured });
    const rowA = markdown.split("\n").find((line) => line.includes("A: 擬似LLM+擬似埋め込み"));
    expect(rowA).toBeDefined();
    expect(rowA).toContain("deterministic");
    expect(rowA).toContain("0.018");
    expect(rowA).toContain("0/7");
    expect(rowA).toContain("1/7");
  });

  it("baseline を省略すると差分節そのものを出さない", () => {
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).not.toContain("基準値との差分");
  });

  it("baseline と一致すれば1行で済ませる", () => {
    const markdown = buildSummaryMarkdown({ measured, baseline: measured });
    expect(markdown).toContain("基準値との差分");
    expect(markdown).toContain("一致（差分なし）");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("baseline と相違すれば展開する", () => {
    const baseline = { arms: [makeArm({ mrrOverall: 0.02 }), measured.arms[1]] };
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した arm が 1 件ある");
    expect(markdown).toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).toContain("mrrOverall");
  });

  it("3つの読み方の注意書きをすべて含む", () => {
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("similarity");
    expect(markdown).toContain("probe 7件");
    expect(markdown).toContain("否定・時制・矛盾");
  });
});

describe("buildLexicalChannelWarningSection — 向きを反転させた警告(ADR 0108)", () => {
  it("lexicalMatchRows が0の arm があれば警告節を返す", () => {
    const arms = [makeArm({ lexicalMatchRows: 0, recalledRows: 70 })];
    const section = buildLexicalChannelWarningSection(arms);
    expect(section).not.toBeNull();
    expect(section).toContain("語彙チャンネルが1行も通っていない");
    expect(section).toContain("lexicalMatchRows=0");
    expect(section).toContain("recalledRows=70");
    expect(section).toContain("ADR 0108");
    // 🔑 赤の意味(コードを読まずに分かること)。
    expect(section).toContain("これは失敗ではない");
    expect(section).toContain("測り直すこと");
  });

  it("lexicalMatchRows が1件でも正の arm があれば、その arm は警告に含めない", () => {
    const arms = [
      makeArm({ armLabel: "A", lexicalMatchRows: 0, recalledRows: 70 }),
      makeArm({ armLabel: "B", lexicalMatchRows: 5, recalledRows: 70 }),
    ];
    const section = buildLexicalChannelWarningSection(arms);
    expect(section).toContain("A");
    expect(section).not.toContain("- B:");
  });

  it("全 arm の lexicalMatchRows が正なら null(警告なし)", () => {
    const arms = [makeArm({ lexicalMatchRows: 3, recalledRows: 70 })];
    expect(buildLexicalChannelWarningSection(arms)).toBeNull();
  });

  it("欄自体が無い(この PR 以前の古い実測 JSON)なら null——0 だったと偽らない", () => {
    const arms = [makeArm()];
    expect(arms[0].lexicalMatchRows).toBeUndefined();
    expect(buildLexicalChannelWarningSection(arms)).toBeNull();
  });

  it("buildSummaryMarkdown に配線されている", () => {
    const measured = { arms: [makeArm({ lexicalMatchRows: 0, recalledRows: 70 })] };
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("語彙チャンネルが1行も通っていない");
  });

  it("欄が無い measured では buildSummaryMarkdown に警告節が現れない(⛔ 門ではない・0とは偽らない)", () => {
    const measured = { arms: [makeArm()] };
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).not.toContain("語彙チャンネルが1行も通っていない");
  });
});

/** `termDistinct` を持つ arm を作る補助(ADR 0109)。 */
function makeArmWithTermDistinct(overrides = {}) {
  return makeArm({
    termDistinct: [
      { term: "similarity", presentRows: 10, minDistinctPerProbe: 10, maxDistinctPerProbe: 10, min: 0.1, max: 0.9 },
      { term: "decay", presentRows: 10, minDistinctPerProbe: 10, maxDistinctPerProbe: 10, min: 0.99, max: 1 },
      { term: "tagMatch", presentRows: 10, minDistinctPerProbe: 1, maxDistinctPerProbe: 1, min: 1, max: 1 },
      { term: "freshness", presentRows: 10, minDistinctPerProbe: 10, maxDistinctPerProbe: 10, min: 0.99, max: 1 },
      { term: "strength", presentRows: 10, minDistinctPerProbe: 1, maxDistinctPerProbe: 1, min: 1, max: 1 },
    ],
    decayFreshnessEqualRows: 10,
    decayFreshnessDifferentRows: 0,
    ...overrides,
  });
}

describe("buildConstantTermSection — 非門の節(ADR 0109)", () => {
  it("maxDistinctPerProbe===1 の項があれば節を返し、項名を列挙する", () => {
    const arms = [makeArmWithTermDistinct()];
    const section = buildConstantTermSection(arms);
    expect(section).not.toBeNull();
    expect(section).toContain("候補間で値が動いていない項がある");
    expect(section).toContain("tagMatch");
    expect(section).toContain("strength");
    // similarity/decay/freshness は1通りではないので列挙されない。
    const armLine = section
      .split("\n")
      .find((line) => line.startsWith(`- ${arms[0].armLabel}:`) && line.includes("tagMatch"));
    expect(armLine).toBeDefined();
    expect(armLine).not.toContain("similarity");
  });

  it("decayFreshnessDifferentRows===0(かつ行数>0)なら、decay/freshness の等価も併記する", () => {
    const arms = [makeArmWithTermDistinct()];
    const section = buildConstantTermSection(arms);
    expect(section).toContain("decay と freshness は全行(10行)で厳密に等価だった");
  });

  it("decayFreshnessDifferentRows>0 なら、decay/freshness の等価は併記しない", () => {
    const arms = [
      makeArmWithTermDistinct({ decayFreshnessEqualRows: 8, decayFreshnessDifferentRows: 2 }),
    ];
    const section = buildConstantTermSection(arms);
    expect(section).not.toContain("厳密に等価だった");
  });

  it("maxDistinctPerProbe が全項で1より大きければ null(報告すべきことが無い)", () => {
    const arms = [
      makeArm({
        termDistinct: [
          { term: "similarity", presentRows: 10, minDistinctPerProbe: 5, maxDistinctPerProbe: 10, min: 0.1, max: 0.9 },
        ],
        decayFreshnessEqualRows: 5,
        decayFreshnessDifferentRows: 5,
      }),
    ];
    expect(buildConstantTermSection(arms)).toBeNull();
  });

  it("欄自体が無い(この変更以前の古い実測JSON)なら null——0だったと偽らない", () => {
    const arms = [makeArm()];
    expect(arms[0].termDistinct).toBeUndefined();
    expect(buildConstantTermSection(arms)).toBeNull();
  });

  it("失敗の意味(⛔ これを消すだけにしない)が文面に含まれる", () => {
    const section = buildConstantTermSection([makeArmWithTermDistinct()]);
    expect(section).toContain("これは失敗ではない");
    expect(section).toContain("測り直すこと");
  });

  it("buildSummaryMarkdown に配線されている", () => {
    const measured = { arms: [makeArmWithTermDistinct()] };
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("候補間で値が動いていない項がある");
  });

  it("欄が無い measured では buildSummaryMarkdown に節が現れない", () => {
    const measured = { arms: [makeArm()] };
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).not.toContain("候補間で値が動いていない項がある");
  });

  it("exit code には触れない(呼び出し側の契約——このテストは文字列を返すだけであることの確認)", () => {
    // buildConstantTermSection は process.exit を一切呼ばない純関数である。
    // 呼べば副作用としてテストプロセスごと落ちるはずなので、正常に return することが
    // 「exit code に触れていない」ことの検査になる。
    expect(() => buildConstantTermSection([makeArmWithTermDistinct()])).not.toThrow();
  });
});
