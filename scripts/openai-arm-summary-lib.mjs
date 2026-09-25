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
  lines.push(`${anyRed ? "🔴" : "✅"} ${verdicts.filter((v) => v.red).length}/${verdicts.length} 群が red。`);
  for (const v of verdicts) {
    lines.push(`- ${v.red ? "🔴" : "✅"} \`${v.group}\`${v.reasons.length > 0 ? `: ${v.reasons.join("; ")}` : ""}`);
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
  }
  lines.push(
    "⚠ ADR 0033 §3: この群の母数からは失敗率も成功率も統計的に主張しない。" +
      "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
  );
  return lines.join("\n");
}
