import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as lib from "../compare-summary-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const {
  buildSummaryMarkdown,
  computeComparison,
  evaluateBaselineFreshness,
  evaluateCompare,
  validateBaseline,
} = lib;

/**
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G7 のうち、PR #493（ADR 0222）・PR #513
 * （ADR 0231）の `compare` の門に対して、変異を当てて見つかった「すり抜け」だけを固定する歯。
 *
 * 既存の `compare-summary-lib.test.mjs` / `compare-summary.test.mjs` /
 * `ci-yml-compare-wiring.test.mjs` が既に守っているものは、ここへ重ねていない。
 * 各 `it` の名前の末尾の記号（C2・F4 など）は、Issue #1812 のコメントの変異表の番号である。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../compare-summary.mjs", import.meta.url));

function makeRow(overrides = {}) {
  return {
    fillerPairs: 4,
    turnCount: 10,
    naiveChars: 243,
    naiveTokens: 120,
    mnemoraChars: 232,
    mnemoraTokens: 110,
    mnemoraShareOfNaiveChars: 232 / 243,
    totalInScope: 10,
    omitted: [],
    returnedCount: 8,
    annCandidateCount: 10,
    factStatementSurvived: true,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    rowCount: 2,
    rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), makeRow({ turnCount: 10, fillerPairs: 4 })],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return { rows: measured.rows.map((r) => structuredClone(r)) };
}

describe("compare の門の判定基準（ADR 0133 の基準を ADR 0222 が変えていないこと）", () => {
  it("C4: 基準値の時点で factStatementSurvived が false なら、実測も false でも退行ではない（true→false だけが退行）", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.rows[1].factStatementSurvived = false;
    const measured = makeMeasured();
    measured.rows[1].factStatementSurvived = false;
    const evaluation = evaluateCompare(measured, baseline);
    expect(evaluation.regressions).toEqual([]);
    expect(evaluation.verdict).toBe("pass");
  });

  it("C2: mnemoraShareOfNaiveChars は、基準値をわずかでも超えたら退行（許容幅を持たない）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars += 0.001;
    const evaluation = evaluateCompare(measured, baseline);
    expect(evaluation.verdict).toBe("fail");
    expect(evaluation.regressions.map((r) => r.turnCount)).toEqual([10]);
  });

  it("C13: 集合が一致せず、比較できた範囲に退行が在るとき、reason が退行の件数を名指しする（退行が無ければ名指ししない）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars += 0.5;
    measured.rows.push(makeRow({ turnCount: 999 }));
    const withRegression = evaluateCompare(measured, baseline);
    expect(withRegression.verdict).toBe("indeterminate");
    expect(withRegression.reason).toMatch(/比較できた範囲だけでも 1 会話長が退行している/);

    const clean = makeMeasured();
    clean.rows.push(makeRow({ turnCount: 999 }));
    const withoutRegression = evaluateCompare(clean, baseline);
    expect(withoutRegression.verdict).toBe("indeterminate");
    expect(withoutRegression.reason).not.toContain("比較できた範囲だけでも");
  });

  it("C20: 退行の配列だけを返す computeRegressions は残していない（ADR 0222 決定1）", () => {
    expect(lib.computeRegressions).toBeUndefined();
    expect(typeof computeComparison).toBe("function");
  });

  it("C24: 基準値に同じ turnCount が2件在れば、validateBaseline が落とす（後勝ちで黙って1行にしない）", () => {
    const baseline = {
      rows: [makeRow({ turnCount: 10 }), makeRow({ turnCount: 10, naiveChars: 1 })],
    };
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("turnCount 10");
  });
});

describe("基準値の鮮度（ADR 0231 決定3）。⛔ 門ではない", () => {
  const NON_GATE_FIELDS = [
    ["naiveChars", 9999],
    ["naiveTokens", 9999],
    ["mnemoraChars", 9999],
    ["mnemoraTokens", 9999],
    ["totalInScope", 9999],
    ["returnedCount", 9999],
    ["annCandidateCount", 9999],
    ["omitted", [{ kind: "ann_unreached" }]],
  ];

  it.each(NON_GATE_FIELDS)(
    "F2: ⭐門が見ない欄 %s が相違すれば、会話長と欄名を名指しして stale にする",
    (field, value) => {
      const baseline = baselineFrom(makeMeasured());
      const measured = makeMeasured();
      measured.rows[1][field] = value;
      const result = evaluateBaselineFreshness(measured, baseline);
      expect(result.isStale).toBe(true);
      expect(result.staleRows).toEqual([{ turnCount: 10, fields: [field] }]);
      expect(result.staleFieldNames).toEqual([field]);
    },
  );

  it("F4: sameCommit は両方の commit が文字列で在って一致するときだけ true（両方欠けていても true にしない）", () => {
    const measured = makeMeasured();
    delete measured.commit;
    const bothMissing = evaluateBaselineFreshness(measured, {
      ...baselineFrom(measured),
      provenance: { measuredAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(bothMissing.sameCommit).toBe(false);

    const nonString = evaluateBaselineFreshness(
      { ...makeMeasured(), commit: 7 },
      { ...baselineFrom(makeMeasured()), provenance: { commit: 7 } },
    );
    expect(nonString.sameCommit).toBe(false);

    const same = evaluateBaselineFreshness(
      { ...makeMeasured(), commit: "abc" },
      { ...baselineFrom(makeMeasured()), provenance: { commit: "abc" } },
    );
    expect(same.sameCommit).toBe(true);
  });

  it("F8: staleRows は turnCount 昇順（実測の行の並びに引きずられない）", () => {
    const measured = makeMeasured({
      rows: [
        makeRow({ turnCount: 42, omitted: [{ kind: "a" }] }),
        makeRow({ turnCount: 2, omitted: [{ kind: "a" }] }),
        makeRow({ turnCount: 10, omitted: [{ kind: "a" }] }),
      ],
    });
    const baseline = baselineFrom(measured);
    for (const row of baseline.rows) {
      row.omitted = [];
    }
    const result = evaluateBaselineFreshness(measured, baseline);
    expect(result.staleRows.map((row) => row.turnCount)).toEqual([2, 10, 42]);
    expect(result.comparedTurnCounts).toEqual([2, 10, 42]);
  });

  it("F10: fields と staleFieldNames は、欄の定義順（DIFF_FIELDS の順）で返る", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].omitted = [{ kind: "a" }];
    measured.rows[1].naiveChars = 9999;
    measured.rows[0].totalInScope = 9999;
    const result = evaluateBaselineFreshness(measured, baseline);
    expect(result.staleRows).toEqual([
      { turnCount: 2, fields: ["totalInScope"] },
      { turnCount: 10, fields: ["naiveChars", "omitted"] },
    ]);
    expect(result.staleFieldNames).toEqual(["naiveChars", "totalInScope", "omitted"]);
  });

  it("M6・M7: Job Summary は、commit が違うときだけ「commit 相違は常態で警告ではない」と言い、同じなら言わない", () => {
    const measured = makeMeasured();
    const differ = buildSummaryMarkdown({
      measured,
      baseline: { ...baselineFrom(measured), provenance: { commit: "deadbeef" } },
    });
    expect(differ).toContain("commit 相違それ自体は常態であり警告ではない");

    const same = buildSummaryMarkdown({
      measured,
      baseline: { ...baselineFrom(measured), provenance: { commit: "abc123" } },
    });
    expect(same).not.toContain("commit 相違それ自体は常態");
  });

  it("M11: 全欄一致の ✅ の行は、実際に比較した会話長の数を言う", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(measured) });
    expect(markdown).toContain("比較した 2 会話長すべてで");
  });

  it("M10: 鮮度の警告は、基準値の更新手順の在りか（examples/chat/README.md の compare 節）を指す", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    measured.rows[1].omitted = [{ kind: "a" }];
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("examples/chat/README.md");
  });
});

describe("compare-summary.mjs（子プロセス）の stderr", () => {
  let workDir;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  function writeJson(name, data) {
    workDir ??= mkdtempSync(join(tmpdir(), "compare-summary-recheck-0917-"));
    const path = join(workDir, name);
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
    return path;
  }

  function run(measured, baseline) {
    return spawnSyncWithDeadline(
      process.execPath,
      [
        script,
        "--measured",
        writeJson("m.json", measured),
        "--baseline",
        writeJson("b.json", baseline),
      ],
      { encoding: "utf8" },
    );
  }

  it("S4: 判定不能（exit 2）で早期終了するときも、基準値の鮮度の警告を出す", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.rows.pop();
    const measured = makeMeasured();
    measured.rows[0].omitted = [{ kind: "a" }];
    baseline.rows[0].omitted = [];
    const result = run(measured, baseline);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("基準値の鮮度");
    expect(result.stderr).toContain("turnCount=2");
  });

  it("S5: 鮮度に問題が無ければ、基準値の鮮度の警告を出さない", () => {
    const measured = makeMeasured();
    const result = run(measured, baselineFrom(measured));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("基準値の鮮度");
  });

  it("S8・S9・S13: 判定不能の stderr が、比較した会話長・実測だけの会話長・基準値だけの会話長を別々に名指しする", () => {
    const baseline = {
      rows: [makeRow({ turnCount: 2 }), makeRow({ turnCount: 4 })],
    };
    const measured = makeMeasured({
      rows: [makeRow({ turnCount: 2 }), makeRow({ turnCount: 10 })],
    });
    const result = run(measured, baseline);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("比較した会話長: 1 件(turnCount=2)");
    expect(result.stderr).toContain(
      "比較していない会話長(実測に在って基準値に無い) 1 件: turnCount=10",
    );
    expect(result.stderr).toContain(
      "比較していない会話長(基準値に在って実測に無い) 1 件: turnCount=4",
    );
  });

  it("S10: 判定不能でも、比較できた範囲の退行は stderr に名指しする", () => {
    const baseline = {
      rows: [makeRow({ turnCount: 2 }), makeRow({ turnCount: 4 })],
    };
    const measured = makeMeasured({
      rows: [makeRow({ turnCount: 2, mnemoraShareOfNaiveChars: 0.99 }), makeRow({ turnCount: 10 })],
    });
    const result = run(measured, baseline);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("比較できた範囲での退行 turnCount=2");
  });

  it("S15: --baseline の中身の形が壊れているとき、理由を stderr に出して exit 1 で終わる（未捕捉の例外で落ちない）", () => {
    const measured = makeMeasured();
    const result = run(measured, { rows: [{ naiveChars: 1 }] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("基準値 JSON の rows が使えない");
    expect(result.stderr).not.toContain("TypeError");
  });
});

describe("ci.yml の compare の門の段が、赤を黄色に落とされないこと（ADR 0222 決定5。配線）", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const lines = workflow.split("\n");

  /** コメント行を除き、`continue-on-error` を真として宣言している行を返す。 */
  function continueOnErrorLines(blockLines) {
    return blockLines.filter(
      (line) => !/^\s*#/.test(line) && /^\s*continue-on-error:\s*(?!false\s*$)\S/.test(line),
    );
  }

  function jobLines(jobId) {
    const start = lines.findIndex((line) => line === `  ${jobId}:`);
    expect(start, `${jobId} ジョブが無い`).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  }

  function stepLines(block, predicate) {
    const starts = block
      .map((line, i) => (/^ {6}- name:/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    for (let k = 0; k < starts.length; k += 1) {
      const slice = block.slice(starts[k], starts[k + 1] ?? block.length);
      if (predicate(slice.join("\n"))) {
        return { index: k, lines: slice };
      }
    }
    return undefined;
  }

  it("（検出器の陽性対照）continue-on-error: true の行を拾い、コメントと false は拾わない", () => {
    expect(continueOnErrorLines(["    continue-on-error: true"])).toHaveLength(1);
    expect(continueOnErrorLines(["        continue-on-error: ${{ true }}"])).toHaveLength(1);
    expect(continueOnErrorLines(["        # continue-on-error: true"])).toHaveLength(0);
    expect(continueOnErrorLines(["        continue-on-error: false"])).toHaveLength(0);
  });

  it("W7: example-chat ジョブ自体が continue-on-error を宣言していない", () => {
    expect(continueOnErrorLines(jobLines("example-chat"))).toEqual([]);
  });

  it("W2: compare-summary.mjs を打つ段が continue-on-error を宣言していない。bench の段より後ろに在る", () => {
    const job = jobLines("example-chat");
    const summary = stepLines(job, (text) => text.includes("node scripts/compare-summary.mjs"));
    const bench = stepLines(job, (text) => text.includes("MNEMORA_COMPARE_JSON:"));
    expect(summary, "compare-summary.mjs を打つ段が無い").toBeDefined();
    expect(bench, "MNEMORA_COMPARE_JSON を渡す段が無い").toBeDefined();
    expect(continueOnErrorLines(summary.lines)).toEqual([]);
    expect(summary.index).toBeGreaterThan(bench.index);
  });
});
