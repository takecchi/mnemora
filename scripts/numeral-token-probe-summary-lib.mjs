/**
 * `scripts/numeral-token-probe-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/identifier-probe-summary-lib.mjs` と同じ分担・同じ理由(ADR 0135、Issue #109)。
 *
 * `examples/chat` の `numeral-token-probes` サブコマンド
 * (`MNEMORA_NUMERAL_TOKEN_JSON` が吐く JSON、`examples/chat/src/numeral-token-json.ts` の
 * `NumeralTokenProbeRunJson`)を Markdown へ変換する。
 *
 * ⛔ **`scripts/identifier-probe-summary-lib.mjs`/`examples/chat/identifier-probe-baseline.json`
 * とは別の道具・別の入力である**——既存の識別子・日本語固有名詞 probe の要約には
 * 1文字も触れていない。
 *
 * 群は **`sparse`/`dense` の2つだけ**(識別子集合の5群とは違う——ADR 0135 は
 * `lexicalControl`/日本語固有名詞に相当する第3の比較対象を持たない、§5.3)。
 *
 * 🔴 **`status` で最初に分岐する。**`"weights_unavailable"` と `"measured"` を
 * 同じ顔で出さない(`identifier-probe-summary-lib.mjs` と同じ理由)。
 *
 * ## ⛔ 門にはしない
 *
 * 相違で非0を返さない。標本18件は ADR 0033 §3 の規律に照らして閾値の門に足る母数
 * ではない(ADR 0135 §4-8)。非0になるのは**入力そのものが壊れているとき**だけである。
 *
 * ## 🔴 比べるのは数字だけではない
 *
 * `embeddingSpace`(`provider`/`model`/`dimensions`)と `haystackKind` に加え、
 * **`marginStats`(count/mean/stdDev/min)も比べる**——ADR 0135 §5.5 の核心である
 * margin の分布が、基準値と実測でずれていないかを見る。
 */

/** 群の同一性は群の名前(`sparse`/`dense`)で取る(`identifier-probe-summary-lib.mjs` と同じ理由)。 */
const GROUP_KEYS = ["sparse", "dense"];

const REQUIRED_GROUP_STRING_FIELDS = ["label", "llmMode", "embeddingMode", "haystackKind"];
const REQUIRED_GROUP_NUMBER_FIELDS = ["mrrOverall", "hit1Count", "hit10Count", "probeCount"];

/**
 * 🔴 **`examples/chat/src/local-embedding-warmup.ts` の `WEIGHTS_UNAVAILABLE_PREFIX` と
 * 同じ文言をここに逐語で持つ**(`identifier-probe-summary-lib.mjs` と同じ二重管理。
 * 文言を変えるときは両方を直すこと)。
 */
const WEIGHTS_UNAVAILABLE_PHRASE = "重みを取得できなかったので、値は測っていない";

/**
 * `marginStats`(`{ count, mean, stdDev, min }`)が正しい形かを検査する。
 * `mean`/`stdDev`/`min` は `count` によって `null` でもよい(`computeMarginStats` の契約)
 * ——ここでは「数値または null」であることまでしか見ない(値の整合はこの歯の対象外)。
 *
 * @param {unknown} stats
 * @param {string} groupName
 * @returns {string[]}
 */
function findMarginStatsProblems(stats, groupName) {
  if (typeof stats !== "object" || stats === null) {
    return [`${groupName}.marginStats がオブジェクトでない`];
  }
  const problems = [];
  const s = /** @type {Record<string, unknown>} */ (stats);
  if (typeof s.count !== "number" || Number.isNaN(s.count)) {
    problems.push(`${groupName}.marginStats.count が数値でない`);
  }
  for (const field of ["mean", "stdDev", "min"]) {
    const value = s[field];
    if (value !== null && (typeof value !== "number" || Number.isNaN(value))) {
      problems.push(`${groupName}.marginStats.${field} が数値でも null でもない`);
    }
  }
  return problems;
}

/**
 * 1群(`sparse`/`dense`)のオブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
 * @param {unknown} group
 * @param {string} groupName
 * @returns {string[]}
 */
function findGroupFieldProblems(group, groupName) {
  if (typeof group !== "object" || group === null) {
    return [`${groupName} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of REQUIRED_GROUP_STRING_FIELDS) {
    if (typeof group[field] !== "string" || group[field] === "") {
      problems.push(`${groupName}.${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_GROUP_NUMBER_FIELDS) {
    if (typeof group[field] !== "number" || Number.isNaN(group[field])) {
      problems.push(`${groupName}.${field} が数値でない`);
    }
  }
  const space = group.embeddingSpace;
  if (typeof space !== "object" || space === null) {
    problems.push(`${groupName}.embeddingSpace がオブジェクトでない`);
  } else {
    for (const field of ["provider", "model"]) {
      if (typeof space[field] !== "string" || space[field] === "") {
        problems.push(`${groupName}.embeddingSpace.${field} が文字列でない、または空`);
      }
    }
    if (typeof space.dimensions !== "number") {
      problems.push(`${groupName}.embeddingSpace.dimensions が数値でない`);
    }
  }
  problems.push(...findMarginStatsProblems(group.marginStats, groupName));
  return problems;
}

/**
 * `MNEMORA_NUMERAL_TOKEN_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const status = /** @type {{ status?: unknown }} */ (data).status;
  if (status === "weights_unavailable") {
    const detail = /** @type {{ detail?: unknown }} */ (data).detail;
    if (typeof detail !== "string" || detail === "") {
      return { ok: false, error: "weights_unavailable な JSON に detail が無い、または空" };
    }
    return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
  }
  if (status !== "measured") {
    return { ok: false, error: `status が不明な値である(実際: ${JSON.stringify(status)})` };
  }
  const problems = [];
  for (const groupName of GROUP_KEYS) {
    problems.push(...findGroupFieldProblems(/** @type {any} */ (data)[groupName], groupName));
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON の群に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(`examples/chat/numeral-token-probe-baseline.json`、パース済み)の形を
 * 検査する。`groups` 配列の各要素は `group`(`sparse`/`dense`)を持つこと。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { groups: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const groups = /** @type {{ groups?: unknown }} */ (data).groups;
  if (!Array.isArray(groups)) {
    return { ok: false, error: "基準値 JSON に groups 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  groups.forEach((group, i) => {
    const groupName = /** @type {any} */ (group)?.group;
    if (typeof groupName !== "string" || !GROUP_KEYS.includes(groupName)) {
      problems.push(
        `groups[${i}].group が ${GROUP_KEYS.join("/")} のいずれでもない` +
          `(実際: ${JSON.stringify(groupName)})`,
      );
      return;
    }
    if (seen.has(groupName)) {
      problems.push(`groups に ${groupName} が2件以上ある`);
      return;
    }
    seen.add(groupName);
    problems.push(...findGroupFieldProblems(group, `groups[${i}](${groupName})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の群が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ groups: Record<string, unknown>[] }} */ (data) };
}

/** `4/7` の形。 */
function formatFraction(count, total) {
  return `${count}/${total}`;
}

/** MRR を既存のベンチの表示(`toFixed(3)`)に揃える。 */
function formatMrr(value) {
  return /** @type {number} */ (value).toFixed(3);
}

/** `(provider, model, dimensions)` を1つの文字列にする。 */
function formatSpace(space) {
  return `${space.provider}/${space.model}/${space.dimensions}次元`;
}

/** `n=18 mean=+3.747e-2 stdDev=1.902e-2 min=+1.048e-2` の形(`formatMarginStats`
 *  と同じ桁数、`identifier-arm.ts` の表示に揃える)。`count===0` は専用の文言にする。 */
function formatMargin(stats) {
  if (!stats || stats.count === 0) {
    return "(測れた probe が0件)";
  }
  const stdDevText = stats.stdDev === null ? "(n<2)" : stats.stdDev.toExponential(3);
  return `n=${stats.count} mean=${stats.mean.toExponential(3)} stdDev=${stdDevText} min=${stats.min.toExponential(3)}`;
}

/**
 * @param {Record<string, any>} group
 */
function buildGroupRow(group) {
  return (
    `| ${group.label} | ${group.llmMode} | ${formatSpace(group.embeddingSpace)} | ` +
    `${group.haystackKind} | ${formatMrr(group.mrrOverall)} | ` +
    `${formatFraction(group.hit1Count, group.probeCount)} | ` +
    `${formatFraction(group.hit10Count, group.probeCount)} | ` +
    `${formatMargin(group.marginStats)} |`
  );
}

/**
 * 基準値と突き合わせる項目。`embeddingSpace` の3項目・`haystackKind`・`label` に加え、
 * `marginStats` の4項目も含む(ADR 0135 §5.5)。
 */
const DIFF_FIELDS = [
  "label",
  "llmMode",
  "embeddingMode",
  "embeddingSpace.provider",
  "embeddingSpace.model",
  "embeddingSpace.dimensions",
  "haystackKind",
  "mrrOverall",
  "hit1Count",
  "hit10Count",
  "probeCount",
  "marginStats.count",
  "marginStats.mean",
  "marginStats.stdDev",
  "marginStats.min",
];

/**
 * `"embeddingSpace.provider"` のような入れ子のパスを読む。
 *
 * @param {Record<string, any> | undefined} obj
 * @param {string} path
 */
function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * 実測の1群と、対応する基準値の1群(無ければ `undefined`)を比べる。
 *
 * @param {string} groupName `sparse`/`dense`
 * @param {Record<string, any>} measuredGroup
 * @param {Record<string, any> | undefined} baselineGroup
 * @returns {{ groupName: string, matches: boolean, missingBaseline: boolean, fieldDiffs: { field: string, baseline: unknown, measured: unknown }[] }}
 */
export function diffGroup(groupName, measuredGroup, baselineGroup) {
  if (!baselineGroup) {
    return { groupName, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readPath(baselineGroup, field);
    const measured = readPath(measuredGroup, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline, measured });
    }
  }
  return { groupName, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(ADR 0088 §3-3と同じ規律)。
 *
 * @param {Record<string, any>} measured
 * @param {{ groups: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const baselineByGroup = new Map(
    baseline.groups.map((group) => [/** @type {any} */ (group).group, group]),
  );
  const diffs = GROUP_KEYS.map((groupName) =>
    diffGroup(groupName, measured[groupName], baselineByGroup.get(groupName)),
  );
  const extraBaselineGroups = baseline.groups.filter(
    (group) => !GROUP_KEYS.includes(/** @type {any} */ (group).group),
  );

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((diff) => diff.matches) && extraBaselineGroups.length === 0) {
    lines.push(
      "✅ 一致(差分なし)。sparse/dense の両群で label / llmMode / embeddingMode / " +
        "embeddingSpace(provider, model, dimensions) / haystackKind / MRR / hit@1 / hit@10 / " +
        "probe件数 / margin(count, mean, stdDev, min) が " +
        "`examples/chat/numeral-token-probe-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した群が ${mismatched.length} 件ある` +
      "(🔴 これは失敗ではない——コードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること)。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.groupName}`);
    if (diff.missingBaseline) {
      lines.push("", "この群には基準値が無い(新しい群か、基準値がまだ追随していない)。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  if (extraBaselineGroups.length > 0) {
    lines.push(
      "",
      "### 基準値にのみ存在する群(今回の実測には無い)",
      "",
      ...extraBaselineGroups.map((group) => `- ${/** @type {any} */ (group).group}`),
    );
  }
  return lines.join("\n");
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと。**
 *
 * @param {{ measured: Record<string, any>, baseline?: { groups: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# numeral-token-probes(ADR 0135 / Issue #109)"];

  if (measured.status === "weights_unavailable") {
    lines.push(
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
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "✅ 測定できた。",
    "",
    "| 群 | llmMode | embeddingSpace(provider/model/dimensions) | haystack | MRR | hit@1 | hit@10 | margin(n/mean/stdDev/min) |",
    "|---|---|---|---|---|---|---|---|",
    buildGroupRow(measured.sparse),
    buildGroupRow(measured.dense),
    "",
  );
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  }
  const probeCount = measured.sparse.probeCount;
  lines.push(
    `⚠ ADR 0033 §3: 標本${probeCount}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
    "",
    `⚠ \`sparse\`/\`dense\` は同じ${probeCount} probe・同じ埋め込み空間で、` +
      "haystack(数詞・記号索引の密度)だけが違う——2つを混ぜた単一の MRR ではない。",
    "",
    "⚠ margin(似た gold/distractor 対の similarity 差)は hit@1 と別の情報を持つ" +
      "(ADR 0135 §5.5)——同じ会話に同居する別セルの probe が hit@1 を奪っても、" +
      "登録した distractor 自体には負けていなければ margin は正のままである。",
  );
  return lines.join("\n");
}
