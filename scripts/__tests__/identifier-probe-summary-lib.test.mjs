import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  diffGroup,
  validateBaseline,
  validateMeasured,
} from "../identifier-probe-summary-lib.mjs";

function makeGroup(overrides = {}) {
  return {
    label:
      "identifier-probes/identifiers-sparse(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    haystackKind: "sparse",
    mrrOverall: 1,
    hit1Count: 12,
    hit10Count: 12,
    probeCount: 12,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "abc123",
    japanese: makeGroup({
      label:
        "identifier-probes/japanese(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
      haystackKind: "sparse",
      mrrOverall: 0.81,
      hit1Count: 5,
      probeCount: 7,
      hit10Count: 7,
    }),
    identifiersSparse: makeGroup({ haystackKind: "sparse" }),
    identifiersDense: makeGroup({
      label:
        "identifier-probes/identifiers-dense(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=dense)",
      haystackKind: "dense",
    }),
    japaneseNamesSparse: makeGroup({
      label:
        "identifier-probes/japanese-names-sparse(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
      haystackKind: "sparse",
      probeCount: 12,
      hit1Count: 12,
      hit10Count: 12,
    }),
    japaneseNamesDense: makeGroup({
      label:
        "identifier-probes/japanese-names-dense(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=dense)",
      haystackKind: "dense",
      probeCount: 12,
      hit1Count: 12,
      hit10Count: 12,
    }),
    ...overrides,
  };
}

function baselineFrom(measured) {
  return {
    groups: [
      { group: "japanese", ...structuredClone(measured.japanese) },
      { group: "identifiersSparse", ...structuredClone(measured.identifiersSparse) },
      { group: "identifiersDense", ...structuredClone(measured.identifiersDense) },
      { group: "japaneseNamesSparse", ...structuredClone(measured.japaneseNamesSparse) },
      { group: "japaneseNamesDense", ...structuredClone(measured.japaneseNamesDense) },
    ],
  };
}

describe("validateMeasured", () => {
  it("正しい measured の形は ok:true を返す", () => {
    expect(validateMeasured(makeMeasured()).ok).toBe(true);
  });

  it("正しい weights_unavailable の形は ok:true を返す", () => {
    const result = validateMeasured({
      schemaVersion: 2,
      status: "weights_unavailable",
      measuredAt: "2026-09-10T00:00:00.000Z",
      commit: "abc123",
      detail: "重みを取得できなかったので、値は測っていない: simulated",
    });
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("status が不明な値なら落ちる", () => {
    const result = validateMeasured({ status: "something-else" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("status");
  });

  it("weights_unavailable なのに detail が無ければ落ちる", () => {
    const result = validateMeasured({ status: "weights_unavailable" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("detail");
  });

  it("measured なのに群の必須項目が欠けていれば落ちる", () => {
    const broken = makeMeasured();
    delete broken.identifiersDense.haystackKind;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("identifiersDense.haystackKind");
  });

  it("measured なのに embeddingSpace が欠けていれば落ちる", () => {
    const broken = makeMeasured();
    delete broken.japanese.embeddingSpace;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("japanese.embeddingSpace");
  });
});

describe("validateBaseline", () => {
  it("正しい基準値の形は ok:true を返す", () => {
    expect(validateBaseline(baselineFrom(makeMeasured())).ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateBaseline(null).ok).toBe(false);
    expect(validateBaseline("not an object").ok).toBe(false);
  });

  it("groups 配列が無ければ落ちる", () => {
    const result = validateBaseline({ schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("groups");
  });

  it("🔴 群に group キーが無ければ落ちる（配列の順番を同一性の根拠にしない）", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.groups[1].group;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("groups[1].group");
  });

  it("group キーが既知の3つ以外なら落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.groups[0].group = "japanse"; // 打ち間違い
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("japanse");
  });

  it("同じ group が2件あれば落ちる（どちらと比べたのか言えなくなる）", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.groups[2].group = "japanese";
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上");
  });

  it("群の必須項目が欠けていれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.groups[0].mrrOverall;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mrrOverall");
  });
});

describe("diffGroup", () => {
  it("同じなら matches:true・fieldDiffs は空", () => {
    const group = makeGroup();
    const diff = diffGroup("identifiersSparse", group, structuredClone(group));
    expect(diff.matches).toBe(true);
    expect(diff.fieldDiffs).toEqual([]);
  });

  it("基準値が無ければ missingBaseline:true（matches:false）", () => {
    const diff = diffGroup("identifiersSparse", makeGroup(), undefined);
    expect(diff.matches).toBe(false);
    expect(diff.missingBaseline).toBe(true);
  });

  it("🔴 数字が同じでも embeddingSpace.model が違えば相違になる", () => {
    const measured = makeGroup({
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/other", dimensions: 256 },
    });
    const diff = diffGroup("identifiersSparse", measured, makeGroup());
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("embeddingSpace.model");
  });

  it("🔴 数字が同じでも embeddingSpace.provider が違えば相違になる", () => {
    const measured = makeGroup({
      embeddingSpace: { provider: "openai", model: "ruri-v3-30m/sym", dimensions: 256 },
    });
    const diff = diffGroup("identifiersSparse", measured, makeGroup());
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("embeddingSpace.provider");
  });

  it("🔴 数字が同じでも haystackKind が違えば相違になる", () => {
    const diff = diffGroup(
      "identifiersSparse",
      makeGroup({ haystackKind: "dense" }),
      makeGroup({ haystackKind: "sparse" }),
    );
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("haystackKind");
  });
});

describe("buildSummaryMarkdown", () => {
  it("weights_unavailable のときはメトリクスの数字を1つも出さない", () => {
    const markdown = buildSummaryMarkdown({
      measured: {
        status: "weights_unavailable",
        detail: "重みを取得できなかったので、値は測っていない: simulated network failure",
      },
    });
    expect(markdown).toContain("重みを取得できなかった");
    expect(markdown).toContain("simulated network failure");
    expect(markdown).not.toContain("MRR");
    expect(markdown).not.toContain("hit@1");
    expect(markdown).not.toContain("hit@10");
  });

  it("🔴 weights_unavailable のときは、基準値を渡しても比較の節を1つも出さない", () => {
    const markdown = buildSummaryMarkdown({
      measured: {
        status: "weights_unavailable",
        detail: "ネットワークに繋がらなかった(この歯が渡した detail)",
      },
      baseline: baselineFrom(makeMeasured()),
    });
    expect(markdown).not.toContain("## 基準値との差分");
    expect(markdown).not.toContain("一致（差分なし）");
    expect(markdown).not.toContain("相違した群");
    expect(markdown).not.toContain("0.810");
    expect(markdown).not.toContain("ruri-v3-30m/sym");
    expect(markdown).not.toContain("sparse");
  });

  it("🔴 weights_unavailable のときは、指定の文言をこの要約自体が出す（detail 由来ではない）", () => {
    // 足場が測定対象と同じ文字列を含むと偽陽性になるので、`detail` にはわざと指定の文言を含めない。
    const markdown = buildSummaryMarkdown({
      measured: { status: "weights_unavailable", detail: "HTTP 503 from the model host" },
    });
    expect(markdown).toContain("重みを取得できなかったので、値は測っていない");
  });

  it("measured のときは3群すべてに arm名・(provider,model,dimensions)・haystackKind を添える", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("identifier-probes/identifiers-sparse");
    expect(markdown).toContain("local/ruri-v3-30m/sym/256次元");
    expect(markdown).toContain("| sparse |");
    expect(markdown).toContain("| dense |");
    expect(markdown).toContain("MRR");
  });

  it("measured のときも「重みを取得できなかった」という文言は出さない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("重みを取得できなかった");
  });

  it("基準値を渡さなければ、差分の節そのものが出ない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("基準値との差分");
  });

  it("⭐ 一致していれば1行で黙る（群ごとの内訳の表を出さない）", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(measured) });
    expect(markdown).toContain("## 基準値との差分");
    expect(markdown).toContain("一致（差分なし）");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).not.toContain("### japanese");
  });

  it("⭐ 相違していれば展開し、どの群のどの項目がどう違うかを出す", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[0].hit1Count = 4; // japanese の hit@1 が 5 → 4 に動いた
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した群が 1 件ある");
    expect(markdown).toContain("### japanese");
    expect(markdown).toContain("| hit1Count | 4 | 5 |");
    expect(markdown).not.toContain("### identifiersSparse");
    expect(markdown).not.toContain("### identifiersDense");
    expect(markdown).not.toContain("一致（差分なし）");
  });

  it("複数の群が相違すれば、その件数と群がすべて出る", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[1].mrrOverall = 0.5;
    baseline.groups[2].hit10Count = 11;
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した群が 2 件ある");
    expect(markdown).toContain("### identifiersSparse");
    expect(markdown).toContain("### identifiersDense");
    expect(markdown).not.toContain("### japanese");
  });

  it("🔴 embeddingSpace だけが違うときも相違として展開される（数字は同じ）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[2].embeddingSpace.model = "text-embedding-3-small";
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した群が 1 件ある");
    expect(markdown).toContain("### identifiersDense");
    expect(markdown).toContain(
      "| embeddingSpace.model | text-embedding-3-small | ruri-v3-30m/sym |",
    );
  });

  it("🔴 haystackKind だけが違うときも相違として展開される（数字は同じ）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[1].haystackKind = "dense";
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した群が 1 件ある");
    expect(markdown).toContain("### identifiersSparse");
    expect(markdown).toContain("| haystackKind | dense | sparse |");
  });

  it("実測にある群が基準値に無ければ、その旨を出す", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups = baseline.groups.filter((group) => group.group !== "identifiersDense");
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("### identifiersDense");
    expect(markdown).toContain("この群には基準値が無い");
  });

  it("相違の内訳より後ろにも、標本の小ささの注意書きが残る", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[0].hit1Count = 4;
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("ADR 0033 §3");
    expect(markdown).toContain("統計的に主張しない");
  });
});
