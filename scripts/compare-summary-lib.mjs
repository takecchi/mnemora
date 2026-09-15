/**
 * `scripts/compare-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる CLI)の
 * 純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`time-term-summary-lib.mjs`/`archive-sweep-cost-summary-lib.mjs` と同じ分担・
 * 同じ理由(Issue #242)。
 *
 * `examples/chat` の `compare` サブコマンド(`MNEMORA_COMPARE_JSON` が吐く JSON、
 * `examples/chat/src/compare-json.ts` の `CompareRunJson`)を Markdown へ変換する。
 *
 * ## 何を測っているか(docs/north-star.md / Issue #242)
 *
 * `compare` は北極星の物差しそのもの——`mnemoraShareOfNaiveChars`
 * (mnemora が焼く文字数 / naive が焼く文字数)が「使う側が会話ログを全部プロンプトへ
 * 積むのをやめられたか」に直接答える値である。他5本の基準値ファイル
 * (`retrieval-baseline.json`/`identifier-probe-baseline.json`/`time-term-baseline.json`/
 * `consolidation-baseline.json`/`archive-sweep-baseline.json`)には対応する基準値が
 * 無く、この bench だけが退行を機械で見ていなかった(Issue #242)。
 *
 * ## ⛔ 門にしない理由(ADR 0133)
 *
 * 一見すると `compare` は `deterministic` provider で走り、会話は
 * `buildConversation()` が生成する固定の filler 列であるため決定論的に見える。
 * **しかし ADR 0133 が実測したとおり、`recall()` の既定の上位 `DEFAULT_RECALL_LIMIT`
 * 件への絞り込みは `score.total`(similarity × decay × tagMatch × freshness × strength)
 * の順位で行われ、`decay`/`freshness` は `now()` を読む——ADR 0088 §2 が
 * `retrieval-quality` について実測したのと同じ「壁時計時間にわずかに依存する」項が
 * ここにも乗っている。**同一 commit を CI で複数回実行して比較した結果は
 * ADR 0133「測ったこと」に実測のとおり記録してある。⟹ 標本7件(ADR 0033 §3)に加えて
 * この壁時計依存も、他5本と同じ「⛔ 門にしない」判断を支持する。非0になるのは
 * **入力そのものが壊れているとき**だけである。
 *
 * ## 比べる項目
 *
 * `turnCount` をキーに、`CompareRowJson` の全欄(`naiveChars`/`naiveTokens`/
 * `mnemoraChars`/`mnemoraTokens`/`mnemoraShareOfNaiveChars`/`totalInScope`/
 * `returnedCount`/`annCandidateCount`/`factStatementSurvived`/`omitted`)を
 * 厳密等価で比べる(`time-term-summary-lib.mjs` の `diffProbe` と同じ形)。
 * ⚠ ADR 0133 が実測したとおり、これらの欄が実際に run 間で揺れることが**ある**
 * ——揺れても赤くしない(上記「⛔ 門にしない理由」)。揺れた欄は差分として
 * Job Summary にそのまま出す(隠さない)。
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
 * 1 row のオブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
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
 * `MNEMORA_COMPARE_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
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
 * 基準値ファイル(パース済み)の形を検査する。実測と同じ必須項目を、`rows` 配列の
 * 各要素に要求する。
 *
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

/** 比べる項目(冒頭 docstring 参照。連続値も含めすべて比べるが、相違しても落とさない)。 */
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
 * 実測の1 row と、対応する基準値の1 row(無ければ `undefined`)を比べる。
 *
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
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(ADR 0088 §3-3)。
 *
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

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((diff) => diff.matches) && extraBaselineRows.length === 0) {
    lines.push(
      "✅ 一致(差分なし)。全会話長で北極星の物差し(mnemoraShareOfNaiveChars 他)が" +
        " `examples/chat/compare-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した会話長が ${mismatched.length} 件ある` +
      "(🔴 これは失敗ではない——ADR 0133 が実測したとおり、この bench の一部の欄は" +
      "壁時計時間にわずかに依存して run ごとに揺れうる。下の内訳を読み、意図した変化か" +
      "揺れの範囲内かを人が判断し、意図した変化なら基準値ファイルを更新すること)。",
  );
  for (const diff of mismatched) {
    lines.push("", `### turnCount = ${diff.turnCount}`);
    if (diff.missingBaseline) {
      lines.push("", "この会話長には基準値が無い(新しい会話長か、基準値がまだ追随していない)。");
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
      "### 基準値にのみ存在する会話長(今回の実測には無い)",
      "",
      ...extraBaselineRows.map((t) => `- turnCount = ${t}`),
    );
  }
  return lines.join("\n");
}

/** 1 row を表の1行にする。 */
function buildRowLine(row) {
  const ratio = `${(row.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
  const survived = row.factStatementSurvived ? "✅" : "❌";
  return (
    `| ${row.turnCount} | ${row.naiveChars} | ${row.mnemoraChars} | ${ratio} | ` +
    `${row.totalInScope} | ${row.annCandidateCount} | ${row.returnedCount} | ${survived} |`
  );
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと**
 * (`time-term-summary-lib.mjs`/`archive-sweep-cost-summary-lib.mjs` と同じ分担)。
 *
 * `baseline` は任意——`--baseline` を渡さなければ差分節そのものを出さない。
 *
 * @param {{ measured: Record<string, any>, baseline?: { rows: Record<string, unknown>[] } }} input
 */
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
  } else {
    lines.push(
      "⚠ 基準値ファイルがまだ無い(`examples/chat/compare-baseline.json`)。" +
        "この CI 実行の artifact を、後続 PR で基準値にする。",
      "",
    );
  }
  lines.push(
    "⚠ ADR 0033 §3: 標本(会話長)の数が少ない。ここで言えるのは「今回、この会話長で" +
      "この値だったか」までである。",
    "",
    "⚠ ADR 0133: 一部の欄(`recall()` の既定の上限による絞り込みを経由する値)は" +
      "壁時計時間にわずかに依存して run ごとに揺れうる——相違があっても、それだけでは" +
      "退行と断定しない。",
  );
  return lines.join("\n");
}
