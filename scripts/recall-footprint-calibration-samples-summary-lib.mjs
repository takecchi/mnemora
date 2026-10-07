/**
 * ⛔ 門にしない。この bench は CI で複数回一致することをまだ実測していない。`--baseline` を渡しても相違では落とさない(exit 0)。
 * 非0になるのは入力そのものが壊れているときだけ。門にするかは別の判断(ADR 0133 の実測・決定の手順を要る)。
 */

const REQUIRED_TOP_STRING_FIELDS = ["llmMode", "embeddingMode"];

const REQUIRED_ROW_NUMBER_FIELDS = [
  "fillerPairs",
  "recallLimit",
  "turnCount",
  "totalInScope",
  "returnedCount",
  "mnemoraChars",
  "bandEntryCount",
  "rawIndexJsonLength",
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
  if (!isObject(row.rawIndex)) {
    problems.push(`${label}.rawIndex がオブジェクトでない`);
  }
  return problems;
}

function rowKey(row) {
  return `${row.fillerPairs}:${row.recallLimit}`;
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
      if (isObject(row)) {
        const key = rowKey(row);
        if (seen.has(key)) {
          problems.push(`rows に (fillerPairs, recallLimit)=${key} が2件以上ある`);
        }
        seen.add(key);
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
    if (!isObject(row)) {
      problems.push(`rows[${i}] がオブジェクトでない`);
      return;
    }
    const key = rowKey(row);
    if (seen.has(key)) {
      problems.push(`rows に (fillerPairs, recallLimit)=${key} が2件以上ある`);
      return;
    }
    seen.add(key);
    problems.push(...findRowFieldProblems(row, `rows[${i}](${key})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の rows が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ rows: Record<string, unknown>[] }} */ (data) };
}

const DIFF_FIELDS = [
  "turnCount",
  "totalInScope",
  "returnedCount",
  "mnemoraChars",
  "bandEntryCount",
  "rawIndexJsonLength",
];

/**
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} [baseline]
 * @returns {string}
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [];
  lines.push("## recall-footprint 較正の補助標本(Issue #340 フォローアップ、ADR 0314)");
  lines.push("");
  lines.push(
    `llmMode=${measured.llmMode} / embeddingMode=${measured.embeddingMode} / rowCount=${measured.rowCount}`,
  );
  lines.push("");
  lines.push(
    "| fillerPairs | limit | turnCount | totalInScope | bandEntryCount | mnemoraChars | rawIndexJsonLength |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  const rows = /** @type {any[]} */ (measured.rows);
  for (const row of rows) {
    lines.push(
      `| ${row.fillerPairs} | ${row.recallLimit} | ${row.turnCount} | ${row.totalInScope} | ` +
        `${row.bandEntryCount} | ${row.mnemoraChars} | ${row.rawIndexJsonLength} |`,
    );
  }

  if (baseline === undefined) {
    lines.push("");
    lines.push(
      "⚠ `--baseline` が渡されていない——CI artifact での2回以上一致をまだ実測して" +
        "いないため、この bench にはまだ基準値ファイルが無い(ADR 0314 §2)。",
    );
    return lines.join("\n");
  }

  const baselineByKey = new Map(baseline.rows.map((r) => [rowKey(/** @type {any} */ (r)), r]));
  const measuredKeys = new Set(rows.map((r) => rowKey(r)));
  const staleRows = [];
  for (const row of rows) {
    const base = /** @type {Record<string, any> | undefined} */ (baselineByKey.get(rowKey(row)));
    if (!base) {
      staleRows.push({ key: rowKey(row), reason: "基準値に無い(新しい設計点)" });
      continue;
    }
    const fieldDiffs = DIFF_FIELDS.filter((field) => base[field] !== row[field]);
    if (fieldDiffs.length > 0) {
      staleRows.push({ key: rowKey(row), reason: `相違: ${fieldDiffs.join(", ")}` });
    }
  }
  const missingFromMeasured = [...baselineByKey.keys()].filter((key) => !measuredKeys.has(key));

  lines.push("");
  if (staleRows.length === 0 && missingFromMeasured.length === 0) {
    lines.push("✅ 基準値と一致(差分なし)。");
  } else {
    lines.push("⚠ 基準値と相違した設計点がある(⛔ 門ではない——exit codeは変えない):");
    for (const stale of staleRows) {
      lines.push(`- (fillerPairs:recallLimit)=${stale.key}: ${stale.reason}`);
    }
    for (const key of missingFromMeasured) {
      lines.push(`- (fillerPairs:recallLimit)=${key}: 実測に無い(基準値にだけある設計点)`);
    }
  }
  return lines.join("\n");
}
