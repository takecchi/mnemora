/**
 * ⛔ 門にしない。基準値との diff は Job Summary に出すが、相違では落とさない（exit 0）。
 * 標本が probe 7件で、閾値の門を置くには足りない。非0は入力が壊れているときだけ。
 * ⛔ 縮み率（round 間の比）は、診断表を除いて計算しない。基準値と比べるのは各 round のその場の値だけ。
 * ⛔ 「gold を載せるのに要った最小予算」の表は、基準値と比べない。JSON が持たない値で、
 * 常に測定 JSON から計算し直す。
 */

const REQUIRED_STORE_FIELDS = [
  "activeCount",
  "supersededCount",
  "activeContentChars",
  "activeContentTokens",
  "activeDigestChars",
  "activeDigestTokens",
  "allContentChars",
];

const REQUIRED_MEAN_FIELDS = [
  "carriedCount",
  "carriedDigestTokens",
  "usageChars",
  "usageEstimatedTokens",
  "usageIndexChars",
  "totalInScope",
  "recalledActiveShare",
];

// `ConsolidateOutcome` の全値と1対1で揃える。
const REQUIRED_CONSOLIDATION_OUTCOME_FIELDS = [
  "consolidated",
  "nothing_to_consolidate",
  "not_examined",
  "llm_failed",
  "dry_run",
  "aborted_source_forgotten",
  "aborted_source_status_changed",
];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function findFieldProblems(obj, fields, label) {
  if (!isObject(obj)) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of fields) {
    if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
      problems.push(`${label}.${field} が数値でない`);
    }
  }
  return problems;
}

function findMeanProblems(mean, label) {
  const problems = findFieldProblems(mean, REQUIRED_MEAN_FIELDS, label);
  if (!isObject(mean)) {
    return problems;
  }
  if (mean.goldRank !== null && typeof mean.goldRank !== "number") {
    problems.push(`${label}.goldRank が数値でも null でもない`);
  }
  if (typeof mean.goldRankExcludedCount !== "number") {
    problems.push(`${label}.goldRankExcludedCount が数値でない`);
  }
  return problems;
}

function findConsolidationProblems(consolidation, label) {
  if (consolidation === null) {
    return [];
  }
  if (!isObject(consolidation)) {
    return [`${label} がオブジェクトでも null でもない`];
  }
  const problems = [];
  for (const field of ["groups", "llmCalls", "newMemoryCount"]) {
    if (typeof consolidation[field] !== "number") {
      problems.push(`${label}.${field} が数値でない`);
    }
  }
  problems.push(
    ...findFieldProblems(
      consolidation.outcomes,
      REQUIRED_CONSOLIDATION_OUTCOME_FIELDS,
      `${label}.outcomes`,
    ),
  );
  problems.push(
    ...findFieldProblems(
      consolidation.embeddingStatus,
      ["ok", "pending", "failed"],
      `${label}.embeddingStatus`,
    ),
  );
  if (!Array.isArray(consolidation.embeddingFailureKinds)) {
    problems.push(`${label}.embeddingFailureKinds が配列でない`);
  }
  return problems;
}

function findRoundProblems(round, i, { requireProbes }) {
  if (!isObject(round)) {
    return [`rounds[${i}] がオブジェクトでない`];
  }
  const problems = [];
  if (typeof round.round !== "number") {
    problems.push(`rounds[${i}].round が数値でない`);
  }
  problems.push(...findConsolidationProblems(round.consolidation, `rounds[${i}].consolidation`));
  problems.push(...findFieldProblems(round.store, REQUIRED_STORE_FIELDS, `rounds[${i}].store`));

  const recall = round.recall;
  if (!isObject(recall)) {
    problems.push(`rounds[${i}].recall がオブジェクトでない`);
    return problems;
  }
  if (!isObject(recall.unbudgeted)) {
    problems.push(`rounds[${i}].recall.unbudgeted がオブジェクトでない`);
  } else {
    problems.push(
      ...findMeanProblems(recall.unbudgeted.mean, `rounds[${i}].recall.unbudgeted.mean`),
    );
    if (requireProbes && !Array.isArray(recall.unbudgeted.probes)) {
      problems.push(`rounds[${i}].recall.unbudgeted.probes が配列でない`);
    }
  }
  if (!Array.isArray(recall.budgeted)) {
    problems.push(`rounds[${i}].recall.budgeted が配列でない`);
  } else {
    recall.budgeted.forEach((rung, j) => {
      const rungLabel = `rounds[${i}].recall.budgeted[${j}]`;
      if (typeof rung.budgetTokens !== "number") {
        problems.push(`${rungLabel}.budgetTokens が数値でない`);
      }
      problems.push(...findMeanProblems(rung.mean, `${rungLabel}.mean`));
      if (requireProbes && !Array.isArray(rung.probes)) {
        problems.push(`${rungLabel}.probes が配列でない`);
      }
    });
  }
  return problems;
}

const REQUIRED_TOP_STRING_FIELDS = ["llmMode", "embeddingMode", "stopReason"];
const REQUIRED_TOP_NUMBER_FIELDS = [
  "probeCount",
  "haystackSize",
  "groupSize",
  "recallLimit",
  "stoppedAfterRound",
];

function findTopLevelProblems(data) {
  if (!isObject(data)) {
    return ["JSON がオブジェクトでない"];
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_TOP_NUMBER_FIELDS) {
    if (typeof data[field] !== "number") {
      problems.push(`${field} が数値でない`);
    }
  }
  if (!Array.isArray(data.budgetLadder) || data.budgetLadder.some((v) => typeof v !== "number")) {
    problems.push("budgetLadder が数値配列でない");
  }
  const space = data.embeddingSpace;
  if (!isObject(space)) {
    problems.push("embeddingSpace がオブジェクトでない");
  } else {
    for (const field of ["provider", "model"]) {
      if (typeof space[field] !== "string" || space[field] === "") {
        problems.push(`embeddingSpace.${field} が文字列でない、または空`);
      }
    }
    if (typeof space.dimensions !== "number") {
      problems.push("embeddingSpace.dimensions が数値でない");
    }
  }
  return problems;
}

/**
 * 🔴 `examples/chat/src/local-embedding-warmup.ts` の `WEIGHTS_UNAVAILABLE_PREFIX` と同じ文言を逐語で持つ。
 * TS 側の定数は import できない（素の `.mjs` で、`tsx` を通さない）。
 */
const WEIGHTS_UNAVAILABLE_PHRASE = "重みを取得できなかったので、値は測っていない";

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  if (data.status === "weights_unavailable") {
    if (typeof data.detail !== "string" || data.detail === "") {
      return { ok: false, error: "weights_unavailable な JSON に detail が無い、または空" };
    }
    return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
  }
  if (data.status !== "measured") {
    return { ok: false, error: `status が不明な値である(実際: ${JSON.stringify(data.status)})` };
  }
  const problems = findTopLevelProblems(data);
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が壊れている: ${problems.join("; ")}` };
  }
  const rounds = /** @type {any} */ (data).rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { ok: false, error: "実測 JSON に rounds 配列が無い、または空である" };
  }
  const roundProblems = rounds.flatMap((round, i) =>
    findRoundProblems(round, i, { requireProbes: true }),
  );
  if (roundProblems.length > 0) {
    return { ok: false, error: `実測 JSON の round が使えない: ${roundProblems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (!isObject(data)) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  if (data.status !== "measured") {
    return {
      ok: false,
      error: `基準値 JSON の status は "measured" であること(実際: ${JSON.stringify(data.status)})`,
    };
  }
  const problems = findTopLevelProblems(data);
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON が壊れている: ${problems.join("; ")}` };
  }
  const rounds = /** @type {any} */ (data).rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    return { ok: false, error: "基準値 JSON に rounds 配列が無い、または空である" };
  }
  const roundProblems = rounds.flatMap((round, i) =>
    findRoundProblems(round, i, { requireProbes: false }),
  );
  if (roundProblems.length > 0) {
    return { ok: false, error: `基準値 JSON の round が使えない: ${roundProblems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

const TOP_DIFF_FIELDS = [
  "llmMode",
  "embeddingMode",
  "probeCount",
  "haystackSize",
  "groupSize",
  "recallLimit",
  "stoppedAfterRound",
  "stopReason",
];

function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

const STORE_DIFF_FIELDS = REQUIRED_STORE_FIELDS.map((f) => `store.${f}`);
const MEAN_DIFF_FIELDS = [...REQUIRED_MEAN_FIELDS, "goldRank", "goldRankExcludedCount"];
const CONSOLIDATION_DIFF_FIELDS = [
  "consolidation.groups",
  "consolidation.llmCalls",
  "consolidation.newMemoryCount",
  ...REQUIRED_CONSOLIDATION_OUTCOME_FIELDS.map((f) => `consolidation.outcomes.${f}`),
  "consolidation.embeddingStatus.ok",
  "consolidation.embeddingStatus.pending",
  "consolidation.embeddingStatus.failed",
];

function embeddingFailureKindsOf(round) {
  const kinds = round?.consolidation?.embeddingFailureKinds;
  return Array.isArray(kinds) ? [...kinds].sort().join(",") : "";
}

/**
 * @param {Record<string, any>} measuredRound
 * @param {Record<string, any> | undefined} baselineRound
 */
export function diffRound(measuredRound, baselineRound) {
  const round = measuredRound.round;
  if (!baselineRound) {
    return { round, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of STORE_DIFF_FIELDS) {
    const baseline = readPath(baselineRound, field);
    const measured = readPath(measuredRound, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline, measured });
    }
  }
  if (measuredRound.consolidation === null || baselineRound.consolidation === null) {
    if (measuredRound.consolidation !== baselineRound.consolidation) {
      fieldDiffs.push({
        field: "consolidation",
        baseline: baselineRound.consolidation,
        measured: measuredRound.consolidation,
      });
    }
  } else {
    for (const field of CONSOLIDATION_DIFF_FIELDS) {
      const baseline = readPath(baselineRound, field);
      const measured = readPath(measuredRound, field);
      if (baseline !== measured) {
        fieldDiffs.push({ field, baseline, measured });
      }
    }
    const baselineKinds = embeddingFailureKindsOf(baselineRound);
    const measuredKinds = embeddingFailureKindsOf(measuredRound);
    if (baselineKinds !== measuredKinds) {
      fieldDiffs.push({
        field: "consolidation.embeddingFailureKinds",
        baseline: baselineKinds,
        measured: measuredKinds,
      });
    }
  }
  for (const field of MEAN_DIFF_FIELDS) {
    const path = `recall.unbudgeted.mean.${field}`;
    const baseline = readPath(baselineRound, path);
    const measured = readPath(measuredRound, path);
    if (baseline !== measured) {
      fieldDiffs.push({ field: path, baseline, measured });
    }
  }
  // budgetTokens の値で対応付ける（順序では対応付けない）。
  const baselineRungsByTokens = new Map(
    (baselineRound.recall?.budgeted ?? []).map((r) => [r.budgetTokens, r]),
  );
  const measuredRungs = measuredRound.recall?.budgeted ?? [];
  for (const rung of measuredRungs) {
    const baselineRung = baselineRungsByTokens.get(rung.budgetTokens);
    if (!baselineRung) {
      fieldDiffs.push({
        field: `recall.budgeted[budgetTokens=${rung.budgetTokens}]`,
        baseline: undefined,
        measured: "(基準値に無い budget 段)",
      });
      continue;
    }
    for (const field of MEAN_DIFF_FIELDS) {
      const baseline = readPath(baselineRung.mean, field);
      const measured = readPath(rung.mean, field);
      if (baseline !== measured) {
        fieldDiffs.push({
          field: `recall.budgeted[budgetTokens=${rung.budgetTokens}].${field}`,
          baseline,
          measured,
        });
      }
    }
  }

  return { round, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

function buildTopLevelDiff(measured, baseline) {
  const diffs = [];
  for (const field of TOP_DIFF_FIELDS) {
    if (measured[field] !== baseline[field]) {
      diffs.push({ field, baseline: baseline[field], measured: measured[field] });
    }
  }
  const ladderMeasured = JSON.stringify(measured.budgetLadder);
  const ladderBaseline = JSON.stringify(baseline.budgetLadder);
  if (ladderMeasured !== ladderBaseline) {
    diffs.push({ field: "budgetLadder", baseline: ladderBaseline, measured: ladderMeasured });
  }
  for (const field of ["provider", "model", "dimensions"]) {
    const baselineValue = baseline.embeddingSpace?.[field];
    const measuredValue = measured.embeddingSpace?.[field];
    if (baselineValue !== measuredValue) {
      diffs.push({
        field: `embeddingSpace.${field}`,
        baseline: baselineValue,
        measured: measuredValue,
      });
    }
  }
  return diffs;
}

function buildDiffSection(measured, baseline) {
  const topDiffs = buildTopLevelDiff(measured, baseline);
  const baselineByRound = new Map((baseline.rounds ?? []).map((r) => [r.round, r]));
  const roundDiffs = (measured.rounds ?? []).map((r) => diffRound(r, baselineByRound.get(r.round)));
  const measuredRoundNumbers = new Set((measured.rounds ?? []).map((r) => r.round));
  const extraBaselineRounds = (baseline.rounds ?? []).filter(
    (r) => !measuredRoundNumbers.has(r.round),
  );

  const allMatch =
    topDiffs.length === 0 && roundDiffs.every((d) => d.matches) && extraBaselineRounds.length === 0;

  const lines = ["## 基準値との差分", ""];
  if (allMatch) {
    lines.push("✅ 一致(差分なし)。");
    return lines.join("\n");
  }

  const mismatchedRounds = roundDiffs.filter((d) => !d.matches);
  lines.push(
    `⚠ 基準値と相違した箇所がある(トップレベル ${topDiffs.length} 件・round ${mismatchedRounds.length} 件)` +
      "(🔴 これは失敗ではない——コードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら基準値ファイルを更新すること)。",
  );
  if (topDiffs.length > 0) {
    lines.push("", "### トップレベル", "", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const diff of topDiffs) {
      lines.push(`| ${diff.field} | ${diff.baseline} | ${diff.measured} |`);
    }
  }
  for (const diff of mismatchedRounds) {
    lines.push("", `### round ${diff.round}`);
    if (diff.missingBaseline) {
      lines.push("", "この round には基準値が無い(新しい round か、基準値がまだ追随していない)。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  if (extraBaselineRounds.length > 0) {
    lines.push(
      "",
      "### 基準値にのみ存在する round(今回の実測には無い)",
      "",
      ...extraBaselineRounds.map((r) => `- round ${r.round}`),
    );
  }
  return lines.join("\n");
}

/**
 * @param {Record<string, any>} round
 * @returns {{ probeId: string, minBudgetForGold: number | null }[]}
 */
export function computeMinBudgetForGold(round) {
  const probeIds = (round.recall?.unbudgeted?.probes ?? []).map((p) => p.probeId);
  const rungs = round.recall?.budgeted ?? [];
  return probeIds.map((probeId) => {
    const candidateBudgets = rungs
      .filter((rung) => rung.probes.some((p) => p.probeId === probeId && p.goldRank !== null))
      .map((rung) => rung.budgetTokens);
    return {
      probeId,
      minBudgetForGold: candidateBudgets.length === 0 ? null : Math.min(...candidateBudgets),
    };
  });
}

export function buildMinBudgetForGoldSection(measured) {
  const rounds = measured.rounds ?? [];
  const probeIds = (rounds[0]?.recall?.unbudgeted?.probes ?? []).map((p) => p.probeId);
  const perRound = rounds.map((round) => ({
    round: round.round,
    entries: computeMinBudgetForGold(round),
  }));

  const header = ["round", ...probeIds, "無し件数"];
  const sep = header.map(() => "---");
  const rows = perRound.map(({ round, entries }) => {
    const byProbe = new Map(entries.map((e) => [e.probeId, e.minBudgetForGold]));
    const neverCount = entries.filter((e) => e.minBudgetForGold === null).length;
    const cells = probeIds.map((probeId) => {
      const value = byProbe.get(probeId);
      return value === null || value === undefined ? "(無し)" : String(value);
    });
    return [String(round), ...cells, String(neverCount)];
  });

  return [
    "## gold を載せるのに要った最小予算(budgetLadder のうち。基準値とは比べない)",
    "",
    "⚠ **`(無し)` は「このラウンドで用意した budgetLadder のどの段でも gold が載らなかった」" +
      "ことを意味する。0 やラダーの最大値で埋めていない——「載らなかった」ことそのものを読むこと。**",
    "",
    `| ${header.join(" | ")} |`,
    `|${sep.join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/** 1.0 ちょうどでなくても平均を取る過程で丸め誤差が乗るので、僅かに余裕を持たせてある。 */
const DEGENERATE_SHARE_THRESHOLD = 0.999;

/**
 * @param {Record<string, any>} measured
 * @returns {{ round: number, label: string, recalledActiveShare: number }[]}
 */
export function findDegenerateRecalledActiveShareRows(measured) {
  const rows = [];
  for (const round of measured.rounds ?? []) {
    const unbudgetedShare = round.recall?.unbudgeted?.mean?.recalledActiveShare;
    if (typeof unbudgetedShare === "number" && unbudgetedShare >= DEGENERATE_SHARE_THRESHOLD) {
      rows.push({ round: round.round, label: "unbudgeted", recalledActiveShare: unbudgetedShare });
    }
    for (const rung of round.recall?.budgeted ?? []) {
      const share = rung.mean?.recalledActiveShare;
      if (typeof share === "number" && share >= DEGENERATE_SHARE_THRESHOLD) {
        rows.push({
          round: round.round,
          label: `budget=${rung.budgetTokens}`,
          recalledActiveShare: share,
        });
      }
    }
  }
  return rows;
}

/**
 * @param {Record<string, any>} measured
 */
export function buildDegenerateShareSection(measured) {
  const rows = findDegenerateRecalledActiveShareRows(measured);
  const lines = ["## 退化検出(recalledActiveShare が 1.0 に近い行)", ""];
  if (rows.length === 0) {
    lines.push("該当なし(全 round・全 budget 段で recalledActiveShare は 1.0 未満)。");
    return lines.join("\n");
  }
  lines.push(
    "⚠ **以下の行は `recalledActiveShare` が 1.0 に近く、「全部載せる」に退化している" +
      "——budget を上げても対象を絞れておらず、この段と他の段を比較しても意味を持たない。**",
    "",
    "| round | 段 | recalledActiveShare |",
    "|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.round} | ${r.label} | ${r.recalledActiveShare.toFixed(3)} ⚠ 退化(全部load)＝比較不能 |`,
    ),
  );
  return lines.join("\n");
}

function buildCautionSection() {
  return [
    "## 読み方の注意",
    "",
    "- ⚠ **LLM は擬似(`deterministic`)であり、統合結果の `content`/`digest` の長さは" +
      "擬似物の性質である。**`content` はプロンプト全文(統合対象の `content`/`digest` を" +
      "連結したもの)であり必ず育つ。`digest` は先頭40字+`…`に切られ、必ず41字以下になる。" +
      "この非対称は測定の目的そのものであり、本物の LLM の要約性能について何も言っていない。",
    "- ⚠ **標本は probe 7件である。ここから率を主張しない**" +
      "([ADR 0033](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3)。",
    "- ⚠ **件数が減ったこと自体は良し悪しを言わない。**`activeCount` が減っても、" +
      "`allContentChars`(active+superseded の合計)は増え続ける——" +
      "「載る記憶の件数」と「実際に保持している文字量」は別の軸である。",
    "",
  ].join("\n");
}

/**
 * 🔴 `status` で最初に分岐する。`"weights_unavailable"` のときは基準値との比較を行わない
 * （`--baseline` を渡していても無視する）。「測れなかった」を「基準値と違う」に化けさせない。
 *
 * @param {{ measured: Record<string, any>, baseline?: Record<string, any> }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const title =
    "# consolidation-cost bench の実測(Runtime.consolidate() が「載る量」に効くかの実測。Issue #136)";

  if (measured.status === "weights_unavailable") {
    return [
      title,
      "",
      `## 🔴 ${WEIGHTS_UNAVAILABLE_PHRASE} — メトリクスは1件も出さない`,
      "",
      "前回の値・既定値・`0` のいずれへも倒していない。**基準値との比較も1つも" +
        "行っていない**——測っていない値を「基準値と違う」に化けさせないためである。",
      "",
      "以下は実際に投げられた理由である:",
      "",
      "```",
      String(measured.detail),
      "```",
    ].join("\n");
  }

  const lines = [
    title,
    "",
    `provider: llm=${measured.llmMode} embedding=${measured.embeddingMode}/` +
      `${measured.embeddingSpace?.model}/${measured.embeddingSpace?.dimensions}次元`,
    `probeCount=${measured.probeCount} haystackSize=${measured.haystackSize} ` +
      `groupSize=${measured.groupSize} recallLimit=${measured.recallLimit} ` +
      `stoppedAfterRound=${measured.stoppedAfterRound} stopReason=${measured.stopReason}`,
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  }
  lines.push(buildMinBudgetForGoldSection(measured), "");
  lines.push(buildDegenerateShareSection(measured), "");
  lines.push(buildCautionSection());
  return lines.join("\n");
}
