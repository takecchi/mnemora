/**
 * `scripts/openai-arm-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる CLI)
 * の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/identifier-probe-summary-lib.mjs` と同じ分担・同じ理由(Issue #109 後半)。
 *
 * `identifier-probes`/`numeral-token-probes` サブコマンドが**追加で**書き出す OpenAI
 * 実埋め込み(`recorded` provider 再生)の JSON(`examples/chat/src/openai-arm-json.ts`
 * の `OpenAiArmRunJson`。`groups` 配列)を Markdown へ変換する。
 *
 * `identifier-probe-summary-lib.mjs` と違い、**群の集合を固定 union にしない**
 * ——`identifier-probes` ジョブは4群、`numeral-token-probes` ジョブは2群を渡すため、
 * `--title` で見出しを変え、群は `groups` 配列をそのまま読む(名前は基準値ファイルの
 * `group` と突き合わせる)。
 *
 * ## ⛔ 門にしない。ただし「並走の判定」を1行出す(Issue #109 後半 決めたこと3)
 *
 * `examples/chat/src/openai-arm-verdict.ts` の `decideEmbeddingDriftVerdict` と
 * **同じ規則**(測定前に固定した閾値: hit@1 が基準値未満、または MRR が基準値から
 * `MRR_DROP_THRESHOLD` 以上落ちたら red)を、ここでも評価して Job Summary に出す。
 *
 * ⚠ **この `.mjs` は `tsx` を通さないため、TS 側の定数を import できない**
 * (`identifier-probe-summary-lib.mjs` の `WEIGHTS_UNAVAILABLE_PHRASE` や
 * `retrieval-quality-shadow-verdict.ts` の `SHADOW_MRR_THRESHOLD` と同じ制約)。
 * **二重管理であることを認めて書いておく**——値を変えるときは両方(この定数と
 * `openai-arm-verdict.ts` の `DEFAULT_MRR_DROP_THRESHOLD`)を直すこと。歯
 * (`scripts/__tests__/openai-arm-summary-lib.test.mjs` と
 * `examples/chat/src/__tests__/openai-arm-verdict.test.ts`)は別々に両方の値を
 * 検査しているので、片方だけ変えれば数字が食い違う(ただし片方だけ変えても
 * どちらの歯も「赤くならない」——これは検出できていない負債であり、下の
 * ADR に明記する)。
 *
 * **⛔ この判定は CI を落とさない。**`decideRetrievalQualityShadowVerdict`
 * (ADR 0276)と同じ形——判定を出力に記録するだけで、`openai-arm-summary.mjs` の
 * exit code には一切反映しない。
 */

/** `examples/chat/src/openai-arm-verdict.ts` の `DEFAULT_MRR_DROP_THRESHOLD` と同じ値
 *  (二重管理。上の docstring 参照)。 */
export const MRR_DROP_THRESHOLD = 0.01;

const REQUIRED_GROUP_STRING_FIELDS = ["group", "label", "llmMode", "embeddingMode", "haystackKind"];
const REQUIRED_GROUP_NUMBER_FIELDS = ["mrrOverall", "hit1Count", "hit10Count", "probeCount"];

/**
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
  return problems;
}

/**
 * `groups` 配列(実測または基準値)の形を検査する。名前(`group`)の重複は許さない。
 *
 * @param {unknown} groups
 * @param {string} label
 * @returns {string[]}
 */
function findGroupsArrayProblems(groups, label) {
  if (!Array.isArray(groups)) {
    return [`${label}.groups が配列でない`];
  }
  const problems = [];
  const seen = new Set();
  groups.forEach((group, i) => {
    const groupName = /** @type {any} */ (group)?.group;
    if (typeof groupName !== "string" || groupName === "") {
      problems.push(`${label}.groups[${i}].group が文字列でない、または空`);
      return;
    }
    if (seen.has(groupName)) {
      problems.push(`${label}.groups に ${groupName} が2件以上ある`);
      return;
    }
    seen.add(groupName);
    problems.push(...findGroupFieldProblems(group, `${label}.groups[${i}](${groupName})`));
  });
  return problems;
}

/**
 * `MNEMORA_IDENTIFIER_PROBE_OPENAI_JSON`/`MNEMORA_NUMERAL_TOKEN_OPENAI_JSON` が吐いた
 * JSON(パース済み)の形を検査する。**この群は `weights_unavailable` を持たない**
 * (`recorded` provider はモデル重み取得に依存しない)——`status` は常に `"measured"`。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const status = /** @type {{ status?: unknown }} */ (data).status;
  if (status !== "measured") {
    return { ok: false, error: `status が想定と違う(実際: ${JSON.stringify(status)})` };
  }
  const problems = findGroupsArrayProblems(/** @type {any} */ (data).groups, "実測 JSON");
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON の群に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(`*-baseline.openai.json`、パース済み)の形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { groups: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const problems = findGroupsArrayProblems(/** @type {any} */ (data).groups, "基準値 JSON");
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の群が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ groups: Record<string, unknown>[] }} */ (data) };
}

function formatFraction(count, total) {
  return `${count}/${total}`;
}

function formatMrr(value) {
  return /** @type {number} */ (value).toFixed(3);
}

function formatSpace(space) {
  return `${space.provider}/${space.model}/${space.dimensions}次元`;
}

function buildGroupRow(group) {
  return (
    `| ${group.group} | ${group.label} | ${group.llmMode} | ${formatSpace(group.embeddingSpace)} | ` +
    `${group.haystackKind} | ${formatMrr(group.mrrOverall)} | ` +
    `${formatFraction(group.hit1Count, group.probeCount)} | ` +
    `${formatFraction(group.hit10Count, group.probeCount)} |`
  );
}

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
];

function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * @param {Record<string, any>} measuredGroup
 * @param {Record<string, any> | undefined} baselineGroup
 */
export function diffGroup(measuredGroup, baselineGroup) {
  const groupName = measuredGroup.group;
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
 * 群ごとの「並走の判定」(⛔ 門ではない。上の docstring 参照)。
 * `examples/chat/src/openai-arm-verdict.ts` の `decideEmbeddingDriftVerdict` と
 * 同じ規則を、この `.mjs` の中だけで再実装したもの(二重管理。上の docstring 参照)。
 *
 * @param {Record<string, any>} measuredGroup
 * @param {Record<string, any> | undefined} baselineGroup
 */
export function decideShadowVerdict(measuredGroup, baselineGroup) {
  if (!baselineGroup) {
    return { red: false, reasons: ["基準値にこの群が無い(比較していない)"] };
  }
  const reasons = [];
  if (measuredGroup.hit1Count < baselineGroup.hit1Count) {
    reasons.push(
      `hit@1 ${formatFraction(measuredGroup.hit1Count, measuredGroup.probeCount)} が基準値 ` +
        `${formatFraction(baselineGroup.hit1Count, baselineGroup.probeCount)} を下回った`,
    );
  }
  const mrrDrop = baselineGroup.mrrOverall - measuredGroup.mrrOverall;
  if (mrrDrop >= MRR_DROP_THRESHOLD) {
    reasons.push(
      `MRR ${formatMrr(measuredGroup.mrrOverall)} が基準値 ${formatMrr(baselineGroup.mrrOverall)} から ` +
        `${mrrDrop.toFixed(6)} 落ちた(閾値 ${MRR_DROP_THRESHOLD})`,
    );
  }
  return { red: reasons.length > 0, reasons };
}

function buildDiffSection(measuredGroups, baselineGroups) {
  const baselineByGroup = new Map(baselineGroups.map((g) => [g.group, g]));
  const diffs = measuredGroups.map((g) => diffGroup(g, baselineByGroup.get(g.group)));
  const measuredNames = new Set(measuredGroups.map((g) => g.group));
  const extraBaselineGroups = baselineGroups.filter((g) => !measuredNames.has(g.group));

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((d) => d.matches) && extraBaselineGroups.length === 0) {
    lines.push(
      "✅ 一致(差分なし)。すべての群で label / llmMode / embeddingMode / " +
        "embeddingSpace(provider, model, dimensions) / haystackKind / MRR / hit@1 / hit@10 / " +
        "probe件数 が基準値ファイルと同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((d) => !d.matches);
  lines.push(
    `⚠ 基準値と相違した群が ${mismatched.length} 件ある` +
      "(🔴 これは失敗ではない——実 API の埋め込みは呼び出しをまたいで完全には決定的でない" +
      "(ADR を見ること)。意図した変化かどうかを人が判断し、意図した変化なら基準値ファイルを更新すること)。",
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
      ...extraBaselineGroups.map((g) => `- ${g.group}`),
    );
  }
  return lines.join("\n");
}

/**
 * ## 参考節 — margin基準の判定候補(ADR 0333 §2・§4.1・§4.3「A」)
 *
 * **クローン miku の判断であり、オーナーの決定ではない**(ADR 0333 冒頭の注記と同じ立場)。
 * ADR 0333 が候補案1(margin基準、`stdDevMultiplier=3`・`minShrunkProbes=2`、
 * 識別子2群の実測を見る前に固定した閾値)を「次の候補として推す」とした——
 * その候補を、**参考としてこの Job Summary に並べて出す。**
 *
 * ⛔ **これは判定に使っていない。**上の `decideShadowVerdict`/`buildShadowVerdictSection`
 * (ADR 0316 のまま、既存の・唯一の「並走の判定」)には1文字も触れていない。
 * `buildSummaryMarkdown` の exit code・既存の判定結果は、この節の red/green が
 * 何であっても変わらない(`openai-arm-summary.mjs` は元々 parse/validate 失敗時にしか
 * 非0にしない——この節の追加でその経路は増えていない)。
 *
 * ⭐ **正本は `examples/chat/src/verdict-candidate-margin.ts`
 * (`DEFAULT_MARGIN_DROP_OPTIONS`・`decideMarginDropVerdict`)である。**
 * この `.mjs` は TS を import できないため、ここは**手複製**——上の `MRR_DROP_THRESHOLD`
 * と同じ事情(二重管理。値を変えるときは両方直すこと)。
 * 歯 `scripts/__tests__/openai-arm-margin-verdict-crosscheck.test.mjs` が、同じ入力を
 * TS 側 `decideMarginDropVerdict` とこの `.mjs` 側の両方に通し、同じ出力になることを
 * 検査する——ADR 0316 側の手複製(`decideShadowVerdict`)には無い歯である。
 *
 * ⚠ **`probeId` で突き合わせる。**TS側 `decideMarginDropVerdict` は呼び出し側が
 * 既に揃えた同順の配列(`(number|null)[]`)を受け取る前提だが、ここは JSON から読んだ
 * `probeMargins`(`OpenAiArmProbeMarginJson[]`、`examples/chat/src/openai-arm-json.ts`)を
 * 扱うため、**`probeId` をキーにして対応する値だけを比べる**——順序が保証されない
 * 入力に対しても正しく突き合わせるための、この `.mjs` 側だけの追加のロバスト性である
 * (突き合わせテストは、TS側へ渡す配列をこの `.mjs` と同じ `probeId` 交差で組み立ててから
 * 比較する——「同じ入力」を確保するため)。
 *
 * ⛔ **`per-probe margin が無い`・`probeId が1件も突き合わない`・
 * `baseline margin の標本標準偏差が定義できない`(count<2 または stdDev===0)ときは
 * red にしない。**「比較できない」を「悪化した」と同じ顔にしない
 * (`decideMarginDropVerdict` 本体と同じ規律。ADR 0008)。
 */
export const MARGIN_VERDICT_OPTIONS = { stdDevMultiplier: 3, minShrunkProbes: 2 };

/**
 * `examples/chat/src/identifier-arm.ts` の `computeMarginStats` の手複製
 * (上の docstring 参照。正本は TS 側)。**export しているのは突き合わせテスト用**
 * (`scripts/__tests__/openai-arm-margin-verdict-crosscheck.test.mjs` が TS側の
 * `computeMarginStats` と同じ入力で同じ出力になることを検査する)。
 *
 * @param {readonly (number | null | undefined)[]} margins
 */
export function computeMarginStatsShadow(margins) {
  const present = margins.filter((m) => typeof m === "number" && !Number.isNaN(m));
  if (present.length === 0) {
    return { count: 0, mean: null, stdDev: null, min: null };
  }
  const mean = present.reduce((sum, v) => sum + v, 0) / present.length;
  const min = Math.min(...present);
  let stdDev = null;
  if (present.length >= 2) {
    const variance = present.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (present.length - 1);
    stdDev = Math.sqrt(variance);
  }
  return { count: present.length, mean, stdDev, min };
}

/**
 * 1群ぶんの margin基準の参考判定(上の docstring 参照。⛔ 判定には使っていない)。
 *
 * @param {Record<string, any>} measuredGroup
 * @param {Record<string, any> | undefined} baselineGroup
 * @param {{ stdDevMultiplier: number, minShrunkProbes: number }} options
 */
export function decideMarginShadowVerdict(
  measuredGroup,
  baselineGroup,
  options = MARGIN_VERDICT_OPTIONS,
) {
  if (!baselineGroup) {
    return { comparable: false, red: false, reasons: ["基準値にこの群が無い(比較していない)"] };
  }
  const baselineMargins = baselineGroup.probeMargins;
  if (!Array.isArray(baselineMargins) || baselineMargins.length === 0) {
    return {
      comparable: false,
      red: false,
      reasons: ["基準値にこの群の probeMargins が無い(比較できない)"],
    };
  }
  const measuredMargins = measuredGroup.probeMargins;
  if (!Array.isArray(measuredMargins) || measuredMargins.length === 0) {
    return {
      comparable: false,
      red: false,
      reasons: ["実測 JSON にこの群の probeMargins が無い(比較できない)"],
    };
  }

  const baselineStats = computeMarginStatsShadow(baselineMargins.map((p) => p.margin));
  const unit = baselineStats.stdDev;
  if (unit === null || unit === 0) {
    return {
      comparable: false,
      red: false,
      reasons: [
        `baseline margin の標本標準偏差が定義できない(count=${baselineStats.count}, ` +
          `stdDev=${baselineStats.stdDev})——判定不能につき red にしない`,
      ],
    };
  }

  const baselineByProbe = new Map(baselineMargins.map((p) => [p.probeId, p.margin]));
  let shrunkProbeCount = 0;
  let comparableProbeCount = 0;
  for (const m of measuredMargins) {
    if (!baselineByProbe.has(m.probeId)) {
      continue;
    }
    const b = baselineByProbe.get(m.probeId);
    if (typeof b !== "number" || typeof m.margin !== "number") {
      continue;
    }
    comparableProbeCount += 1;
    const drop = b - m.margin;
    if (drop >= options.stdDevMultiplier * unit) {
      shrunkProbeCount += 1;
    }
  }

  if (comparableProbeCount === 0) {
    return {
      comparable: false,
      red: false,
      reasons: ["probeId が1件も突き合わなかった(比較できない)"],
    };
  }

  const red = shrunkProbeCount >= options.minShrunkProbes;
  const reasons = [];
  if (red) {
    reasons.push(
      `margin が baseline 標準偏差×${options.stdDevMultiplier}` +
        `(=${(unit * options.stdDevMultiplier).toFixed(6)})以上縮んだ probe が` +
        `${shrunkProbeCount}件(閾値${options.minShrunkProbes}件、比較できたprobe${comparableProbeCount}件)`,
    );
  }
  return {
    comparable: true,
    red,
    shrunkProbeCount,
    comparableProbeCount,
    baselineMarginStats: baselineStats,
    reasons,
  };
}

/**
 * margin基準の参考節そのもの(⛔ 判定には使っていない。上の docstring 参照)。
 *
 * @param {Record<string, any>[]} measuredGroups
 * @param {Record<string, any>[]} baselineGroups
 * @param {{ stdDevMultiplier: number, minShrunkProbes: number }} options
 */
export function buildMarginShadowVerdictSection(
  measuredGroups,
  baselineGroups,
  options = MARGIN_VERDICT_OPTIONS,
) {
  const baselineByGroup = new Map(baselineGroups.map((g) => [g.group, g]));
  const verdicts = measuredGroups.map((g) => ({
    group: g.group,
    ...decideMarginShadowVerdict(g, baselineByGroup.get(g.group), options),
  }));
  const anyRed = verdicts.some((v) => v.red);
  const comparableVerdicts = verdicts.filter((v) => v.comparable);
  const lines = [
    "## 参考: margin基準の判定候補(ADR 0333 §2・§4.1・§4.3「A」)",
    "",
    "⚠ **これは参考であり、判定には使っていない。**上の「並走の判定」" +
      "(ADR 0316 のまま、既存の・唯一の判定)がこのジョブの唯一の判定であり、" +
      "exit code にも実際の判定にも、ここの red/green は一切反映しない。" +
      "**クローン miku の判断であり、オーナーの決定ではない**(ADR 0333)。",
    "",
    `測定前に固定した閾値(ADR 0333 §2.2): stdDevMultiplier=${options.stdDevMultiplier}、` +
      `minShrunkProbes=${options.minShrunkProbes}。baseline margin の標本標準偏差の` +
      `${options.stdDevMultiplier}倍以上縮んだ probe が${options.minShrunkProbes}件以上あれば参考red。`,
    "",
  ];
  if (comparableVerdicts.length === 0) {
    lines.push(
      "⚪ 比較できない(全群で per-probe margin が無い、または probeId が突き合わない、" +
        "または baseline margin の標本標準偏差が定義できない)。",
    );
  } else {
    lines.push(
      `${anyRed ? "🔴" : "✅"}(参考) ${verdicts.filter((v) => v.red).length}/` +
        `${comparableVerdicts.length} 群が参考red(比較できた群のうち)。`,
    );
  }
  for (const v of verdicts) {
    const mark = !v.comparable ? "⚪" : v.red ? "🔴" : "✅";
    lines.push(
      `- ${mark} \`${v.group}\`${v.reasons.length > 0 ? `: ${v.reasons.join("; ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

function buildShadowVerdictSection(measuredGroups, baselineGroups) {
  const baselineByGroup = new Map(baselineGroups.map((g) => [g.group, g]));
  const verdicts = measuredGroups.map((g) => ({
    group: g.group,
    ...decideShadowVerdict(g, baselineByGroup.get(g.group)),
  }));
  const anyRed = verdicts.some((v) => v.red);
  const lines = [
    "## 並走の判定(Issue #109 後半。⛔ 門ではない——このジョブを落とさない)",
    "",
    "測定前に決めた規則: hit@1 が基準値(round 0)未満、または MRR が基準値から " +
      `${MRR_DROP_THRESHOLD} 以上落ちたら red。`,
    "",
  ];
  lines.push(
    `${anyRed ? "🔴" : "✅"} ${verdicts.filter((v) => v.red).length}/${verdicts.length} 群が red。`,
  );
  for (const v of verdicts) {
    lines.push(
      `- ${v.red ? "🔴" : "✅"} \`${v.group}\`${v.reasons.length > 0 ? `: ${v.reasons.join("; ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {{ title: string, measured: Record<string, any>, baseline?: { groups: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ title, measured, baseline }) {
  const lines = [`# ${title}(Issue #109 後半——OpenAI 実埋め込み、recorded provider 再生)`];
  const measuredGroups = /** @type {Record<string, any>[]} */ (measured.groups);

  lines.push(
    "",
    "✅ 測定できた。",
    "",
    "| group | 群 | llmMode | embeddingSpace(provider/model/dimensions) | haystack | MRR | hit@1 | hit@10 |",
    "|---|---|---|---|---|---|---|---|",
    ...measuredGroups.map(buildGroupRow),
    "",
  );
  if (baseline) {
    lines.push(buildDiffSection(measuredGroups, baseline.groups), "");
    lines.push(buildShadowVerdictSection(measuredGroups, baseline.groups), "");
    lines.push(buildMarginShadowVerdictSection(measuredGroups, baseline.groups), "");
  }
  lines.push(
    "⚠ ADR 0033 §3: この群の母数からは失敗率も成功率も統計的に主張しない。" +
      "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
  );
  return lines.join("\n");
}
