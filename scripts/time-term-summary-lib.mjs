/**
 * 純関数の側。ファイル I/O・`process.argv`・`process.exit` を持たない。
 *
 * ⛔ 門にしない。標本は8 probe で、閾値判定に足る母数ではない(ADR 0088 §2.1、ADR 0033 §3)。
 * 非0にするのは入力が壊れているときだけ。
 *
 * 🔴 `freshnessRatio`/`decayRatio`/`totalRatio` は基準値と比べない。実行ごとの壁時計時間に依存する連続値で、
 * 厳密等価では毎回「相違あり」になる(ADR 0088 §2、§3-3)。比べるのは離散値の `outcome`/`totalInScope`/`omittedKinds` だけ。
 * 連続値は JSON にそのまま残す(丸めない)。
 *
 * `--baseline` は任意。渡さなければ差分節そのものを出さない。
 */

const KNOWN_OUTCOMES = [
  "newer-ranked-higher",
  "older-ranked-higher",
  "tied",
  "newer-not-returned",
  "older-not-returned",
  "neither-returned",
  "collapsed",
];

const REQUIRED_TOP_STRING_FIELDS = ["armLabel", "llmMode", "embeddingMode"];

/**
 * @param {unknown} probe
 * @param {string} label
 * @returns {string[]}
 */
function findProbeFieldProblems(probe, label) {
  if (typeof probe !== "object" || probe === null) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  if (typeof probe.probeId !== "string" || probe.probeId === "") {
    problems.push(`${label}.probeId が文字列でない、または空`);
  }
  if (typeof probe.outcome !== "string" || !KNOWN_OUTCOMES.includes(probe.outcome)) {
    problems.push(`${label}.outcome が既知の値でない(実際: ${JSON.stringify(probe.outcome)})`);
  }
  if (typeof probe.totalInScope !== "number" || Number.isNaN(probe.totalInScope)) {
    problems.push(`${label}.totalInScope が数値でない`);
  }
  if (!Array.isArray(probe.omittedKinds) || probe.omittedKinds.some((k) => typeof k !== "string")) {
    problems.push(`${label}.omittedKinds が文字列配列でない`);
  }
  return problems;
}

/**
 * ⛔ 「壊れている」とする条件はここに限る。`probes` の連続値欄は、型が崩れていても致命傷と見なさない(要約が使わない欄のため)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof (/** @type {any} */ (data)[field]) !== "string") {
      problems.push(`${field} が文字列でない`);
    }
  }
  const probes = /** @type {{ probes?: unknown }} */ (data).probes;
  if (!Array.isArray(probes)) {
    problems.push("probes 配列が無い");
  } else if (probes.length === 0) {
    problems.push("probes が空配列である(bench が1件も測れなかった)");
  } else {
    const seen = new Set();
    probes.forEach((probe, i) => {
      problems.push(...findProbeFieldProblems(probe, `probes[${i}]`));
      const id = /** @type {any} */ (probe)?.probeId;
      if (typeof id === "string") {
        if (seen.has(id)) {
          problems.push(`probes に probeId "${id}" が2件以上ある`);
        }
        seen.add(id);
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
 * @returns {{ ok: true, value: { probes: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const probes = /** @type {{ probes?: unknown }} */ (data).probes;
  if (!Array.isArray(probes)) {
    return { ok: false, error: "基準値 JSON に probes 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  probes.forEach((probe, i) => {
    const id = /** @type {any} */ (probe)?.probeId;
    if (typeof id !== "string" || id === "") {
      problems.push(`probes[${i}].probeId が文字列でない、または空`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`probes に probeId "${id}" が2件以上ある`);
      return;
    }
    seen.add(id);
    problems.push(...findProbeFieldProblems(probe, `probes[${i}](${id})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の probes が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ probes: Record<string, unknown>[] }} */ (data) };
}

/**
 * 比べる項目。連続値(`*Ratio`/`*GapWithinPair`)は含めない(冒頭参照)。
 */
const DIFF_FIELDS = ["outcome", "totalInScope", "omittedKinds"];

/**
 * @param {Record<string, any>} probe
 * @param {string} field
 */
function readDiffField(probe, field) {
  if (field === "omittedKinds") {
    return JSON.stringify([...(probe.omittedKinds ?? [])].sort());
  }
  return probe[field];
}

/**
 * @param {string} probeId
 * @param {Record<string, any>} measuredProbe
 * @param {Record<string, any> | undefined} baselineProbe
 */
export function diffProbe(probeId, measuredProbe, baselineProbe) {
  if (!baselineProbe) {
    return { probeId, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readDiffField(baselineProbe, field);
    const measured = readDiffField(measuredProbe, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline: baselineProbe[field], measured: measuredProbe[field] });
    }
  }
  return { probeId, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * @param {Record<string, any>} measured
 * @param {{ probes: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const measuredById = new Map(measured.probes.map((p) => [p.probeId, p]));
  const baselineById = new Map(baseline.probes.map((p) => [/** @type {any} */ (p).probeId, p]));
  const diffs = [...measuredById.keys()].map((probeId) =>
    diffProbe(probeId, measuredById.get(probeId), baselineById.get(probeId)),
  );
  const extraBaselineProbes = [...baselineById.keys()].filter((id) => !measuredById.has(id));

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((diff) => diff.matches) && extraBaselineProbes.length === 0) {
    lines.push(
      "✅ 一致(差分なし)。全 probe で outcome / totalInScope / omittedKinds が" +
        " `examples/chat/time-term-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した probe が ${mismatched.length} 件ある` +
      "(🔴 これは失敗ではない——コードの変更で outcome が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること)。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.probeId}`);
    if (diff.missingBaseline) {
      lines.push("", "この probe には基準値が無い(新しい probe か、基準値がまだ追随していない)。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(
        `| ${fieldDiff.field} | ${JSON.stringify(fieldDiff.baseline)} | ${JSON.stringify(fieldDiff.measured)} |`,
      );
    }
  }
  if (extraBaselineProbes.length > 0) {
    lines.push(
      "",
      "### 基準値にのみ存在する probe(今回の実測には無い)",
      "",
      ...extraBaselineProbes.map((id) => `- ${id}`),
    );
  }
  return lines.join("\n");
}

function buildProbeRow(probe) {
  return (
    `| ${probe.probeId} | ${probe.outcome} | ${probe.totalInScope} | ` +
    `${probe.omittedKinds.length === 0 ? "-" : probe.omittedKinds.join(",")} |`
  );
}

/** @param {{ measured: Record<string, any>, baseline?: { probes: Record<string, unknown>[] } }} input */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# time-term(ADR 0058 / Issue #217): freshness/decay が順位を動かすかの実測",
    "",
    `provider: llm=${measured.llmMode} / embedding=${measured.embeddingMode}`,
    "",
    "| probe | outcome | totalInScope | omitted |",
    "|---|---|---|---|",
    ...measured.probes.map(buildProbeRow),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  } else {
    lines.push(
      "⚠ 基準値ファイルがまだ無い(`examples/chat/time-term-baseline.json`)。" +
        "この CI 実行の artifact を、後続 PR で基準値にする。",
      "",
    );
  }
  lines.push(
    `⚠ ADR 0033 §3: 標本${measured.probes.length}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この probe で outcome が何だったか」までである。",
    "",
    "⚠ `freshnessRatio`/`decayRatio`/`totalRatio` は artifact(機械可読 JSON)には残るが、" +
      "この要約・基準値との比較には含めない——壁時計時間にわずかに依存する連続値であり、" +
      "厳密等価で比べると常に「相違あり」になる(ADR 0088 §2 が `retrieval-quality` の" +
      "`decay`/`freshness` について実測したのと同じ種類の揺れ)。",
  );
  return lines.join("\n");
}
