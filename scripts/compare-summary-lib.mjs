/**
 * 純関数の側。ファイル I/O・`process.argv`・`process.exit` を持たない。
 *
 * ⛔ 退行の判定は `mnemoraShareOfNaiveChars` の悪化と `factStatementSurvived` の true→false の2欄だけ。
 * 全欄の厳密一致を門にしない(`naiveChars` のような北極星と無関係な欄で赤くなるため。ADR 0133)。
 *
 * ⛔ 新しい会話長・消えた会話長は退行ではなく `indeterminate`。黙って読み飛ばすと
 * 「比較していない」が「退行が無い」と同じ顔で緑になる。
 *
 * ⚠ 本来の会話長の母集合は TypeScript の `DEFAULT_COMPARE_SEQUENCE` にあり、この lib から import できない。
 * 下限は実測側の集合から取り、件数をここに書かない。
 */

const REQUIRED_TOP_STRING_FIELDS = ["llmMode", "embeddingMode"];

const REQUIRED_ROW_NUMBER_FIELDS = [
  "fillerPairs",
  "turnCount",
  "naiveChars",
  "naiveTokens",
  "mnemoraChars",
  "mnemoraTokens",
  "mnemoraShareOfNaiveChars",
  "totalInScope",
  "returnedCount",
  "annCandidateCount",
];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} row
 * @param {string} label
 * @returns {string[]}
 */
function findRowFieldProblems(row, label) {
  if (!isObject(row)) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of REQUIRED_ROW_NUMBER_FIELDS) {
    if (typeof row[field] !== "number" || Number.isNaN(row[field])) {
      problems.push(`${label}.${field} が数値でない`);
    }
  }
  if (typeof row.factStatementSurvived !== "boolean") {
    problems.push(`${label}.factStatementSurvived が真偽値でない`);
  }
  if (!Array.isArray(row.omitted)) {
    problems.push(`${label}.omitted が配列でない`);
  }
  return problems;
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof (/** @type {any} */ (data)[field]) !== "string") {
      problems.push(`${field} が文字列でない`);
    }
  }
  const rows = /** @type {{ rows?: unknown }} */ (data).rows;
  if (!Array.isArray(rows)) {
    problems.push("rows 配列が無い");
  } else if (rows.length === 0) {
    problems.push("rows が空配列である(bench が1件も測れなかった)");
  } else {
    const seen = new Set();
    rows.forEach((row, i) => {
      problems.push(...findRowFieldProblems(row, `rows[${i}]`));
      const turnCount = /** @type {any} */ (row)?.turnCount;
      if (typeof turnCount === "number") {
        if (seen.has(turnCount)) {
          problems.push(`rows に turnCount ${turnCount} が2件以上ある`);
        }
        seen.add(turnCount);
      }
    });
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: { rows: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (!isObject(data)) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const rows = /** @type {{ rows?: unknown }} */ (data).rows;
  if (!Array.isArray(rows)) {
    return { ok: false, error: "基準値 JSON に rows 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const turnCount = /** @type {any} */ (row)?.turnCount;
    if (typeof turnCount !== "number") {
      problems.push(`rows[${i}].turnCount が数値でない`);
      return;
    }
    if (seen.has(turnCount)) {
      problems.push(`rows に turnCount ${turnCount} が2件以上ある`);
      return;
    }
    seen.add(turnCount);
    problems.push(...findRowFieldProblems(row, `rows[${i}](turnCount=${turnCount})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の rows が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ rows: Record<string, unknown>[] }} */ (data) };
}

const DIFF_FIELDS = [
  "naiveChars",
  "naiveTokens",
  "mnemoraChars",
  "mnemoraTokens",
  "mnemoraShareOfNaiveChars",
  "totalInScope",
  "returnedCount",
  "annCandidateCount",
  "factStatementSurvived",
  "omitted",
];

/**
 * 🔴 `computeComparison` の判定を変えたらここも揃える。
 * `FRESHNESS_FIELDS` は `DIFF_FIELDS` から導出し、欄名の出所を増やさない。
 */
const GATE_FIELDS = ["mnemoraShareOfNaiveChars", "factStatementSurvived"];

const FRESHNESS_FIELDS = DIFF_FIELDS.filter((field) => !GATE_FIELDS.includes(field));

/**
 * @param {Record<string, any>} row
 * @param {string} field
 */
function readDiffField(row, field) {
  if (field === "omitted") {
    return JSON.stringify(row.omitted ?? []);
  }
  return row[field];
}

/**
 * @param {number} turnCount
 * @param {Record<string, any>} measuredRow
 * @param {Record<string, any> | undefined} baselineRow
 */
export function diffRow(turnCount, measuredRow, baselineRow) {
  if (!baselineRow) {
    return { turnCount, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readDiffField(baselineRow, field);
    const measured = readDiffField(measuredRow, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline: baselineRow[field], measured: measuredRow[field] });
    }
  }
  return { turnCount, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * ⛔ 退行の配列だけを返す関数は意図的に残さない。空配列が「比較して0件」と「比較していない」を区別できない。
 *
 * ⚠ 合否は決めない(`evaluateCompare` と CLI の役目)。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 * @returns {{
 *   comparedTurnCounts: number[],
 *   regressions: { turnCount: number, reasons: string[] }[],
 *   measuredOnlyTurnCounts: number[],
 *   baselineOnlyTurnCounts: number[],
 * }}
 */
export function computeComparison(measured, baseline) {
  const baselineByTurn = new Map(baseline.rows.map((r) => [/** @type {any} */ (r).turnCount, r]));
  const measuredTurnCounts = new Set(measured.rows.map((r) => r.turnCount));
  /** @type {number[]} */
  const comparedTurnCounts = [];
  /** @type {number[]} */
  const measuredOnlyTurnCounts = [];
  /** @type {{ turnCount: number, reasons: string[] }[]} */
  const regressions = [];
  for (const row of measured.rows) {
    const base = /** @type {Record<string, any> | undefined} */ (baselineByTurn.get(row.turnCount));
    if (!base) {
      // ⛔ ここで黙って読み飛ばさない。「比較していない」として数える。
      measuredOnlyTurnCounts.push(row.turnCount);
      continue;
    }
    comparedTurnCounts.push(row.turnCount);
    const reasons = [];
    if (row.mnemoraShareOfNaiveChars > base.mnemoraShareOfNaiveChars) {
      reasons.push(
        `mnemoraShareOfNaiveChars が悪化: 基準値 ${base.mnemoraShareOfNaiveChars} → 実測 ${row.mnemoraShareOfNaiveChars}`,
      );
    }
    if (base.factStatementSurvived === true && row.factStatementSurvived === false) {
      reasons.push("factStatementSurvived が true → false に退行(冒頭の事実が失われた)");
    }
    if (reasons.length > 0) {
      regressions.push({ turnCount: row.turnCount, reasons });
    }
  }
  const baselineOnlyTurnCounts = [...baselineByTurn.keys()].filter(
    (turnCount) => !measuredTurnCounts.has(turnCount),
  );
  const ascending = (/** @type {number} */ a, /** @type {number} */ b) => a - b;
  return {
    comparedTurnCounts: [...comparedTurnCounts].sort(ascending),
    regressions,
    measuredOnlyTurnCounts: [...measuredOnlyTurnCounts].sort(ascending),
    baselineOnlyTurnCounts: [...baselineOnlyTurnCounts].sort(ascending),
  };
}

/**
 * ⚠ `pending` という語は使わない。再試行で直る意味に読めるが、基準値の取りこぼしは
 * 基準値を更新するか実測側を戻すかの判断が要る。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 * @returns {{
 *   verdict: "pass" | "fail" | "indeterminate",
 *   reason: string,
 *   comparedTurnCounts: number[],
 *   regressions: { turnCount: number, reasons: string[] }[],
 *   measuredOnlyTurnCounts: number[],
 *   baselineOnlyTurnCounts: number[],
 * }}
 */
export function evaluateCompare(measured, baseline) {
  const comparison = computeComparison(measured, baseline);
  const { comparedTurnCounts, regressions, measuredOnlyTurnCounts, baselineOnlyTurnCounts } =
    comparison;

  /** @type {"pass" | "fail" | "indeterminate"} */
  let verdict;
  let reason;

  const notComparedParts = [];
  if (measuredOnlyTurnCounts.length > 0) {
    notComparedParts.push(
      `実測に在って基準値に無い会話長(1度も比較していない): turnCount=${measuredOnlyTurnCounts.join(", ")}`,
    );
  }
  if (baselineOnlyTurnCounts.length > 0) {
    notComparedParts.push(
      `基準値に在って実測に無い会話長(測る点が黙って減った): turnCount=${baselineOnlyTurnCounts.join(", ")}`,
    );
  }

  if (comparedTurnCounts.length === 0) {
    verdict = "indeterminate";
    reason =
      "1会話長も比較していない(実測と基準値で共通する turnCount が1つも無い)。" +
      (notComparedParts.length > 0 ? `${notComparedParts.join("; ")}。` : "") +
      "⟹ 退行の有無について何も言えない——「退行0件」ではない(Issue #477)。";
  } else if (notComparedParts.length > 0) {
    verdict = "indeterminate";
    reason =
      `実測と基準値の turnCount 集合が一致しない——比較できたのは ${comparedTurnCounts.length} 会話長だけである。` +
      `${notComparedParts.join("; ")}。` +
      (regressions.length > 0
        ? `⚠ 比較できた範囲だけでも ${regressions.length} 会話長が退行している。`
        : "") +
      "⟹ 比較していない会話長について退行の有無を言えないので、判定不能にする(Issue #477)。" +
      "意図して会話長の構成を変えたのなら、`examples/chat/compare-baseline.json` を更新すること。";
  } else if (regressions.length > 0) {
    verdict = "fail";
    reason =
      `${comparedTurnCounts.length} 会話長すべてを比較し、うち ${regressions.length} 会話長で` +
      "北極星の物差しが退行した(ADR 0133 の判定基準)。";
  } else {
    verdict = "pass";
    reason =
      `実測と基準値の turnCount 集合が一致し(${comparedTurnCounts.length} 会話長)、` +
      "そのすべてで退行が無かった。";
  }

  return { verdict, reason, ...comparison };
}

/**
 * ⛔ 判定ではない。終了コードを変えない。⭐門が見ない欄の食い違いを並べて言うだけ。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[], provenance?: unknown }} baseline
 * @returns {{
 *   declaration: { commit: unknown, measuredAt: unknown, repeatRuns: unknown, ciJob: unknown } | null,
 *   current: { commit: unknown, measuredAt: unknown },
 *   sameCommit: boolean,
 *   comparedTurnCounts: number[],
 *   staleRows: { turnCount: number, fields: string[] }[],
 *   staleFieldNames: string[],
 *   isStale: boolean,
 * }}
 */
export function evaluateBaselineFreshness(measured, baseline) {
  const provenance = /** @type {any} */ (baseline).provenance;
  const declaration = isObject(provenance)
    ? {
        commit: provenance.commit,
        measuredAt: provenance.measuredAt,
        repeatRuns: provenance.repeatRuns,
        ciJob: provenance.ciJob,
      }
    : null;
  const current = { commit: measured.commit, measuredAt: measured.measuredAt };
  const sameCommit =
    declaration !== null &&
    typeof declaration.commit === "string" &&
    typeof current.commit === "string" &&
    declaration.commit === current.commit;

  const measuredByTurn = new Map(measured.rows.map((r) => [r.turnCount, r]));
  const baselineByTurn = new Map(baseline.rows.map((r) => [/** @type {any} */ (r).turnCount, r]));
  const comparedTurnCounts = [...measuredByTurn.keys()]
    .filter((turnCount) => baselineByTurn.has(turnCount))
    .sort((a, b) => a - b);

  /** @type {{ turnCount: number, fields: string[] }[]} */
  const staleRows = [];
  for (const turnCount of comparedTurnCounts) {
    const diff = diffRow(turnCount, measuredByTurn.get(turnCount), baselineByTurn.get(turnCount));
    const fields = diff.fieldDiffs
      .map((fieldDiff) => fieldDiff.field)
      .filter((field) => FRESHNESS_FIELDS.includes(field));
    if (fields.length > 0) {
      staleRows.push({ turnCount, fields });
    }
  }

  const staleFieldNames = FRESHNESS_FIELDS.filter((field) =>
    staleRows.some((row) => row.fields.includes(field)),
  );

  return {
    declaration,
    current,
    sameCommit,
    comparedTurnCounts,
    staleRows,
    staleFieldNames,
    isStale: staleRows.length > 0,
  };
}

/**
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const measuredByTurn = new Map(measured.rows.map((r) => [r.turnCount, r]));
  const baselineByTurn = new Map(baseline.rows.map((r) => [/** @type {any} */ (r).turnCount, r]));
  const diffs = [...measuredByTurn.keys()].map((turnCount) =>
    diffRow(turnCount, measuredByTurn.get(turnCount), baselineByTurn.get(turnCount)),
  );
  const extraBaselineRows = [...baselineByTurn.keys()].filter((t) => !measuredByTurn.has(t));
  const evaluation = evaluateCompare(measured, baseline);
  const { regressions } = evaluation;
  const regressedTurnCounts = new Set(regressions.map((r) => r.turnCount));

  const lines = ["## 基準値との差分", ""];
  if (evaluation.verdict === "pass" && diffs.every((diff) => diff.matches)) {
    lines.push(
      `✅ 一致(差分なし)。${evaluation.comparedTurnCounts.length} 会話長すべてを基準値と` +
        "突き合わせ、北極星の物差し(mnemoraShareOfNaiveChars 他)が" +
        " `examples/chat/compare-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  if (evaluation.verdict === "indeterminate") {
    lines.push(`🔴 **判定不能(比較していない会話長が在る)**: ${evaluation.reason}`, "");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した会話長が ${mismatched.length} 件ある` +
      (regressions.length > 0
        ? `(🔴 うち ${regressions.length} 件は退行——ADR 0133 の判定基準` +
          "(mnemoraShareOfNaiveChars の悪化 / factStatementSurvived の true→false)" +
          "に当たる。このベンチは⭐門である——このステップは非0で終わる)。"
        : evaluation.verdict === "indeterminate"
          ? "(退行の判定基準に当たる相違は無いが、上のとおり判定不能である" +
            "——このベンチは⭐門であり、このステップは非0(exit 2)で終わる)。"
          : "(ただし退行の判定基準には当たらない相違のみ。このベンチは⭐門だが、" +
            "この相違だけでは exit 0 のまま——下の内訳を読み、意図した変化かを確認すること)。"),
  );
  for (const diff of mismatched) {
    const regressed = regressedTurnCounts.has(diff.turnCount);
    lines.push("", `### turnCount = ${diff.turnCount}${regressed ? " 🔴 退行" : ""}`);
    if (diff.missingBaseline) {
      lines.push(
        "",
        "🔴 **この会話長は比較していない**——基準値にこの turnCount が無い。" +
          "⟹ 退行したかどうかについて、この行は何も言っていない(Issue #477)。",
      );
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(
        `| ${fieldDiff.field} | ${JSON.stringify(fieldDiff.baseline)} | ${JSON.stringify(fieldDiff.measured)} |`,
      );
    }
  }
  if (extraBaselineRows.length > 0) {
    lines.push(
      "",
      "### 🔴 基準値にのみ存在する会話長(今回の実測に無い——比較していない)",
      "",
      "測る点が黙って減っている。**この会話長について、退行したかどうかは何も言っていない**" +
        "(Issue #477)。",
      "",
      ...extraBaselineRows.map((t) => `- turnCount = ${t}`),
    );
  }
  return lines.join("\n");
}

function buildRowLine(row) {
  const ratio = `${(row.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
  const survived = row.factStatementSurvived ? "✅" : "❌";
  return (
    `| ${row.turnCount} | ${row.naiveChars} | ${row.mnemoraChars} | ${ratio} | ` +
    `${row.totalInScope} | ${row.annCandidateCount} | ${row.returnedCount} | ${survived} |`
  );
}

/** @param {ReturnType<typeof evaluateBaselineFreshness>["declaration"]} declaration */
function formatDeclarationLine(declaration) {
  if (declaration === null) {
    return (
      "🔴 基準値の宣言: この基準値は出所を名乗っていない(`provenance` 欄が無い)" +
      "⟹ 鮮度を言えない。"
    );
  }
  const commit = typeof declaration.commit === "string" ? `\`${declaration.commit}\`` : "不明";
  const measuredAt = declaration.measuredAt ?? "不明";
  const repeatRuns = declaration.repeatRuns ?? "不明";
  const ciJob = declaration.ciJob ?? "不明";
  return (
    `基準値の宣言: commit ${commit}` +
    `(measuredAt=${measuredAt}、repeatRuns=${repeatRuns}、ciJob=${ciJob})`
  );
}

/** @param {ReturnType<typeof evaluateBaselineFreshness>["current"]} current */
function formatCurrentLine(current) {
  const commit =
    typeof current.commit === "string" ? `\`${current.commit}\`` : "不明(commit 欄が無い)";
  const measuredAt = current.measuredAt ?? "不明(measuredAt 欄が無い)";
  return `いま実測したもの: commit ${commit}(measuredAt=${measuredAt})`;
}

/**
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[], provenance?: unknown }} baseline
 */
function buildFreshnessSection(measured, baseline) {
  const freshness = evaluateBaselineFreshness(measured, baseline);
  const lines = ["## 基準値の鮮度(⛔ 門ではない)", ""];
  lines.push(formatDeclarationLine(freshness.declaration), "");
  lines.push(formatCurrentLine(freshness.current), "");

  if (freshness.declaration !== null && !freshness.sameCommit) {
    const declCommit =
      typeof freshness.declaration.commit === "string"
        ? `\`${freshness.declaration.commit}\``
        : "不明";
    const curCommit =
      typeof freshness.current.commit === "string" ? `\`${freshness.current.commit}\`` : "不明";
    lines.push(
      `commit: 基準値の宣言(${declCommit})といま実測したもの(${curCommit})は一致していない` +
        "(main は毎 commit 動くので、commit 相違それ自体は常態であり警告ではない)。",
      "",
    );
  }

  if (!freshness.isStale) {
    lines.push(
      `✅ ⭐門が見ない欄も、比較した ${freshness.comparedTurnCounts.length} 会話長すべてで` +
        "基準値と一致している。",
    );
    return lines.join("\n");
  }

  lines.push(
    `⚠ ⭐門が見ない欄が ${freshness.staleRows.length} 会話長で基準値と相違している` +
      `(turnCount=${freshness.staleRows.map((row) => row.turnCount).join(", ")}、` +
      `欄: ${freshness.staleFieldNames.join(", ")})。`,
    "",
    ...freshness.staleRows.map((row) => `- turnCount = ${row.turnCount}: ${row.fields.join(", ")}`),
    "",
    "⛔ これは退行ではない——門は緑のままである" +
      "(ADR 0133 の判定基準(mnemoraShareOfNaiveChars の悪化 / factStatementSurvived の " +
      "true→false)に当たらない)。",
    "🔴 判定に使わない欄は、誰も直す義務を負わないまま出続ける" +
      "——それが Issue #403 で実際に起きたことである。",
    "⟹ 意図した変化なら、基準値を更新すること(手順は `examples/chat/README.md` の " +
      "`compare` 節)。",
  );
  return lines.join("\n");
}

/** @param {{ measured: Record<string, any>, baseline?: { rows: Record<string, unknown>[] } }} input */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# compare(北極星の物差し): mnemora/naive の比が実測でどう動いたか(Issue #242)",
    "",
    `provider: llm=${measured.llmMode} / embedding=${measured.embeddingMode}`,
    "",
    "| 会話ターン数 | naive chars | mnemora chars | mnemora/naive | スコープ内 | ANN候補 | 返った件数 | 冒頭の事実 |",
    "|---|---|---|---|---|---|---|---|",
    ...measured.rows.map(buildRowLine),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
    lines.push(buildFreshnessSection(measured, baseline), "");
  } else {
    lines.push(
      "⚠ 基準値ファイルがまだ無い(`examples/chat/compare-baseline.json`)。" +
        "--baseline 無しではこのベンチは門として機能しない(exit 0 のまま)。",
      "",
    );
  }
  lines.push(
    "⭐ ADR 0133: このベンチは他5本と異なり門である——同一commitでのCI再実行が" +
      "measuredAtを除いて完全一致したことを実測で確認したため、" +
      "`mnemoraShareOfNaiveChars` の悪化と `factStatementSurvived` の退行(true→false)を" +
      "検知すると exit 1 になる。それ以外の相違(`naiveChars` 等)は報告のみ。",
    "",
    "⭐ Issue #477: **判定は、実測と基準値の turnCount 集合が一致したときだけ行う。**" +
      "一致しなければ緑を出さず、判定不能(exit 2)にする" +
      "——「比較していない」を「退行が無い」と同じ顔で出さないため。",
  );
  return lines.join("\n");
}
