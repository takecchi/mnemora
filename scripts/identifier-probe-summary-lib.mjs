/**
 * 🔴 `status` で最初に分岐する。`"weights_unavailable"` のときはメトリクスの表も基準値との比較も出さない。
 * ⛔ 「測れなかった」を「基準値と違う」に化けさせない。
 *
 * 基準値とは比べる(ADR 0088 §3)が、⛔ 門にはしない。相違で非0を返さない。識別子 probe・日本語 probe は
 * 母数が小さく、閾値の門に足る母数ではない(ADR 0033 §3)。なぜ「今は」門にしないか: probe を増やした後に、
 * その母数で偽陽性が出ないかを測ってから別途決める。非0になるのは入力そのものが壊れているときだけ。
 *
 * 🔴 比べるのは数字だけではない。`embeddingSpace`(`provider`/`model`/`dimensions`)と `haystackKind` も比べる。
 * 数字だけだと、空間や haystack 条件が変わったのに数字が同じ場合を「一致」と出してしまう
 * (`local` の256次元と `openai` の256次元は、次元数が同じでも別の空間)。
 */

/**
 * ⛔ 群の同一性は `label` ではなく群の名前で取る。`label` は条件を埋めた文字列で、モデルを差し替えると
 * label ごと変わる。鍵にすると「`embeddingSpace.model` が変わった」ではなく「基準値に無い群が現れ、
 * 基準値にしか無い群が残った」になり、何が変わったのか読めなくなる。
 */
const GROUP_KEYS = [
  "japanese",
  "identifiersSparse",
  "identifiersDense",
  "japaneseNamesSparse",
  "japaneseNamesDense",
];

const REQUIRED_GROUP_STRING_FIELDS = ["label", "llmMode", "embeddingMode", "haystackKind"];
const REQUIRED_GROUP_NUMBER_FIELDS = ["mrrOverall", "hit1Count", "hit10Count", "probeCount"];

/**
 * 🔴 `examples/chat/src/local-embedding-warmup.ts` の `WEIGHTS_UNAVAILABLE_PREFIX` と同じ文言を逐語で持つ。
 * `detail` に含まれているから出る、という形にしない。`detail` は bench が投げてきたデータで、文言が変われば消える。
 * ⚠ TS 側の定数は import できない(素の `.mjs` で、Job Summary の段は `tsx` を通さない)ので二重管理。
 * 文言を変えるときは両方を直すこと。歯が両側で逐語を検査しているので、片方だけ変えれば赤くなる。
 */
const WEIGHTS_UNAVAILABLE_PHRASE = "重みを取得できなかったので、値は測っていない";

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
 * 壊れていると判定するのは、JSON がオブジェクトでない・`status` が未知・`"measured"` なのに群の必須項目が欠けている場合だけ。
 * `"weights_unavailable"` それ自体は壊れた入力ではない。
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
 * ⚠ 配列の順番を同一性の根拠にしない。並べ替えただけで別の群と突き合わせて「一致」を出さないよう、
 * 名前で突き合わせ、名前が無ければ入力が壊れていると言う。
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

function formatFraction(count, total) {
  return `${count}/${total}`;
}

function formatMrr(value) {
  return /** @type {number} */ (value).toFixed(3);
}

/**
 * 次元数だけでは区別できない(`text-embedding-3-small` も256次元)ので、必ず3つ揃えて出す。
 */
function formatSpace(space) {
  return `${space.provider}/${space.model}/${space.dimensions}次元`;
}

/**
 * @param {Record<string, any>} group
 */
function buildGroupRow(group) {
  return (
    `| ${group.label} | ${group.llmMode} | ${formatSpace(group.embeddingSpace)} | ` +
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

/**
 * @param {Record<string, any> | undefined} obj
 * @param {string} path
 */
function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * @param {string} groupName `japanese`/`identifiersSparse`/`identifiersDense`
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
 * 一致なら1行、違うときだけ展開する(ADR 0088 §3-3)。常に同じ量を出す観測口は読まれない。
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
      "✅ 一致（差分なし）。3群すべてで label / llmMode / embeddingMode / " +
        "embeddingSpace(provider, model, dimensions) / haystackKind / MRR / hit@1 / hit@10 / " +
        "probe件数 が `examples/chat/identifier-probe-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した群が ${mismatched.length} 件ある` +
      "（🔴 これは失敗ではない——コードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること）。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.groupName}`);
    if (diff.missingBaseline) {
      lines.push("", "この群には基準値が無い（新しい群か、基準値がまだ追随していない）。");
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
      "### 基準値にのみ存在する群（今回の実測には無い）",
      "",
      ...extraBaselineGroups.map((group) => `- ${/** @type {any} */ (group).group}`),
    );
  }
  return lines.join("\n");
}

/**
 * 呼び出し側は必ず validate 済みの値を渡すこと。`status: "weights_unavailable"` のときは、
 * `baseline` が渡されていても比較を1つも出さない。
 *
 * @param {{ measured: Record<string, any>, baseline?: { groups: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# identifier-probes（Issue #109 / #106）"];

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
    "| 群 | llmMode | embeddingSpace(provider/model/dimensions) | haystack | MRR | hit@1 | hit@10 |",
    "|---|---|---|---|---|---|---|",
    buildGroupRow(measured.japanese),
    buildGroupRow(measured.identifiersSparse),
    buildGroupRow(measured.identifiersDense),
    buildGroupRow(measured.japaneseNamesSparse),
    buildGroupRow(measured.japaneseNamesDense),
    "",
  );
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  }
  // 件数をここに書き写さず、測った値そのものから出す。書き写すと、probe を増やしたとき注記だけが古い件数を主張し続ける(ADR 0068)。
  const japaneseCount = measured.japanese.probeCount;
  const identifierCount = measured.identifiersSparse.probeCount;
  lines.push(
    `⚠ ADR 0033 §3: 標本${japaneseCount}件・${identifierCount}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
    "",
    `⚠ \`identifiersSparse\`/\`identifiersDense\` は同じ${identifierCount} probe・同じ埋め込み空間で、` +
      "haystack(識別子の密度)だけが違う——2つを混ぜた単一の MRR ではない。",
  );
  return lines.join("\n");
}
