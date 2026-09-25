/**
 * `scripts/recall-footprint-calibration-samples-summary.mjs`(CI の Job Summary に載せる
 * Markdown を組み立てる CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を
 * 一切持たない——`consolidation-cost-summary-lib.mjs`/`archive-sweep-cost-summary-lib.mjs`
 * と同じ分担(Issue #340 フォローアップ、ADR 0314)。
 *
 * `examples/chat` の `recall-footprint-calibration-samples` サブコマンド
 * (`MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON` が吐く JSON、
 * `examples/chat/src/recall-footprint-calibration-samples-json.ts` の
 * `RecallFootprintCalibrationSamplesRunJson`)を Markdown へ変換する。
 *
 * ## ⛔ 門にしない(いまのところ基準値ファイルも無い)
 *
 * `compare`(ADR 0133)と違い、この bench はまだ CI で複数回一致することを実測して
 * いない——ADR 0314 §2 の決定どおり、`examples/chat/compare-baseline.json` のような
 * ⭐門の CI-sourcing 手順(ADR 0119/0121/0133、artifact を2回以上取り、一致した値だけを
 * 基準値にする)を、この bench ではまだ踏めていない(手元の作業環境から CI artifact を
 * 取得する経路が無い——ADR 0314「引き受けた負債2」)。⟹ 他5本(retrieval-quality等)と
 * 同じ非ゲートの形を踏襲する: `--baseline` を渡しても相違では落とさない(exit 0)。
 * 非0になるのは入力そのものが壊れているときだけ。
 *
 * 基準値ファイルができた後(CI artifact で2回以上一致を確認した後)は、`--baseline` に
 * それを渡せば相違が Job Summary に出る——**その時点でもまだ門にするかどうかは
 * 別の判断**(ADR 0133 が `compare` について行ったのと同じ実測・決定の手順を要る)。
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

/** `(fillerPairs, recallLimit)` を1つの文字列キーにする。`compare` の `turnCount` に相当。 */
function rowKey(row) {
  return `${row.fillerPairs}:${row.recallLimit}`;
}

/**
 * `MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON` が吐いた JSON(パース済み)の
 * 形を検査する。
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
 * 基準値ファイル(パース済み)の形を検査する。実測と同じ必須項目を要求する。
 * ⚠ **いまのところこの形の基準値ファイルは存在しない**(冒頭 docstring)——
 * この関数自体は将来のために用意してある。
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

/** Job Summary の差分節で比べる項目(門にはしない。冒頭 docstring 参照)。 */
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
