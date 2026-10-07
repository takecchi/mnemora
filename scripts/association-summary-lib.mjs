/**
 * ⛔ 門にしない。非0になるのは入力そのものが壊れているとき(読めない・parse できない・必須項目欠落・型違い・参照整合性の破れ)だけ。
 * probe は12件で、閾値判定の門を置くには足りない標本(ADR 0033 §3、ADR 0088 §2.1)。
 * 悪化した arm を目立たせるのも検出だけで、exit code には触れない(ADR 0385)。
 *
 * ⛔ hit@10 は連想枠の効果を測れない。連想枠の候補は recall 本体の limit 件の後ろに連結されるため。
 * 読み違えを防ぐ注記 `HIT10_CAVEAT_NOTE` を必ず出す。
 *
 * ⚠ arm の同一性の鍵に `armLabel` を使わない。実装の `armLabel` は埋め込み条件を文字列に埋めており、
 * 条件が変わると丸ごと変わる。表示にだけ使い、鍵は `armShortKey(arm)` を使う。
 */

/**
 * ⚠ 増減するときは `WORSENED_TOLERANCE` も合わせて見直すこと。
 */
const WORSENED_METRICS = [
  { field: "goldReturnedCount", label: "gold" },
  { field: "hit1Count", label: "hit@1" },
  { field: "hit10Count", label: "hit@10" },
  { field: "mrr", label: "MRR" },
];

/**
 * ⚠ 値の唯一の出所は ADR 0385。ここでは妥当性を判断しない。
 */
export const WORSENED_TOLERANCE = {
  goldReturnedCount: 0,
  hit1Count: 0,
  hit10Count: 0,
  mrr: 0,
};

const ARM_COUNT = 4;
const DELTA_COUNT = 3;
const CATEGORIES = ["ascii-id", "proper-noun", "common-noun"];

const TOP_STRING_FIELDS = ["measuredAt", "llmMode"];
const TOP_NUMBER_FIELDS = ["schemaVersion", "probeCount", "haystackSize", "recallLimit"];

const ARM_STRING_FIELDS = ["armLabel"];
const ARM_NUMBER_FIELDS = [
  "probeCount",
  "ingestedCount",
  "goldReturnedCount",
  "hit1Count",
  "hit10Count",
  "goldViaAssociationCount",
  "mrr",
  "returnedMemoryTotal",
  "memoryCharsTotal",
  "associationCharsTotal",
  "repeatFrameIdenticalCount",
  "repeatGoldRankSameCount",
];
const ARM_BOOLEAN_FIELDS = ["associationEnabled"];

const PROBE_STRING_FIELDS = ["probeId"];
const PROBE_NUMBER_FIELDS = ["returnedCount", "memoryChars", "associationChars", "reciprocalRank"];
const PROBE_BOOLEAN_FIELDS = [
  "hit1",
  "hit10",
  "goldReturned",
  "goldAnchoredOnProbeAnchor",
  "repeatFrameIdentical",
  "repeatGoldRankSame",
];

const ASSOCIATION_FRAME_ROLE_VALUES = [
  "own-gold",
  "own-anchor",
  "own-distractor",
  "other-probe",
  "haystack",
  "unknown",
];

const DELTA_STRING_FIELDS = ["baselineArmLabel", "againstArmLabel"];
const DELTA_NUMBER_FIELDS = [
  "goldReturnedCount",
  "goldViaAssociationCount",
  "mrr",
  "hit10Count",
  "memoryCharsTotal",
];

/**
 * @param {unknown} obj
 * @param {string} path
 * @param {{ stringFields?: string[], numberFields?: string[], booleanFields?: string[] }} spec
 * @returns {string[]}
 */
function findScalarFieldProblems(obj, path, spec) {
  if (typeof obj !== "object" || obj === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of spec.stringFields ?? []) {
    if (typeof obj[field] !== "string" || obj[field] === "") {
      problems.push(`${path}.${field} が文字列でない、または空`);
    }
  }
  for (const field of spec.numberFields ?? []) {
    if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
      problems.push(`${path}.${field} が数値でない`);
    }
  }
  for (const field of spec.booleanFields ?? []) {
    if (typeof obj[field] !== "boolean") {
      problems.push(`${path}.${field} が真偽値でない`);
    }
  }
  return problems;
}

/**
 * ⚠ `armLabel` ではなくこちらを同一性の鍵にする(冒頭参照)。
 *
 * @param {{ associationEnabled: boolean, associationMaxCount: number | null }} arm
 */
function armShortKey(arm) {
  return arm.associationEnabled ? `on(max=${arm.associationMaxCount})` : "off";
}

function isStringOrNull(value) {
  return value === null || typeof value === "string";
}
function isNumberOrNull(value) {
  return value === null || (typeof value === "number" && !Number.isNaN(value));
}

const PROBE_CATEGORY_VALUES = CATEGORIES;

/**
 * ⚠ 門にしない。形だけ見て、内容は問わない。
 *
 * @param {unknown} entry
 * @param {string} path
 * @returns {string[]}
 */
function findAssociationFrameEntryProblems(entry, path) {
  if (typeof entry !== "object" || entry === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  if (typeof entry.externalId !== "string" || entry.externalId === "") {
    problems.push(`${path}.externalId が文字列でない、または空`);
  }
  if (typeof entry.rank !== "number" || Number.isNaN(entry.rank)) {
    problems.push(`${path}.rank が数値でない`);
  }
  if (!ASSOCIATION_FRAME_ROLE_VALUES.includes(entry.role)) {
    problems.push(
      `${path}.role が ${ASSOCIATION_FRAME_ROLE_VALUES.join("/")} のいずれでもない` +
        `(実際: ${JSON.stringify(entry.role)})`,
    );
  }
  if (!isStringOrNull(entry.anchorExternalId)) {
    problems.push(`${path}.anchorExternalId が文字列でも null でもない`);
  }
  return problems;
}

/**
 * @param {unknown} probe
 * @param {string} path
 * @returns {string[]}
 */
function findProbeFieldProblems(probe, path) {
  const problems = findScalarFieldProblems(probe, path, {
    stringFields: PROBE_STRING_FIELDS,
    numberFields: PROBE_NUMBER_FIELDS,
    booleanFields: PROBE_BOOLEAN_FIELDS,
  });
  if (typeof probe !== "object" || probe === null) {
    return problems;
  }
  if (!PROBE_CATEGORY_VALUES.includes(probe.category)) {
    problems.push(
      `${path}.category が ${PROBE_CATEGORY_VALUES.join("/")} のいずれでもない` +
        `(実際: ${JSON.stringify(probe.category)})`,
    );
  }
  if (!isNumberOrNull(probe.goldRank)) {
    problems.push(`${path}.goldRank が数値でも null でもない`);
  }
  if (!isNumberOrNull(probe.anchorRank)) {
    problems.push(`${path}.anchorRank が数値でも null でもない`);
  }
  if (!isNumberOrNull(probe.distractorRank)) {
    problems.push(`${path}.distractorRank が数値でも null でもない`);
  }
  if (!isStringOrNull(probe.goldRetrievedVia)) {
    problems.push(`${path}.goldRetrievedVia が文字列でも null でもない`);
  }
  if (!isStringOrNull(probe.goldAssociationOf)) {
    problems.push(`${path}.goldAssociationOf が文字列でも null でもない`);
  }
  if (!isStringOrNull(probe.stageSkipped)) {
    problems.push(`${path}.stageSkipped が文字列でも null でもない`);
  }
  if (!Array.isArray(probe.associationFrame)) {
    problems.push(`${path}.associationFrame が配列でない`);
  } else {
    probe.associationFrame.forEach((entry, i) => {
      problems.push(...findAssociationFrameEntryProblems(entry, `${path}.associationFrame[${i}]`));
    });
  }
  return problems;
}

/**
 * @param {unknown} arm
 * @param {string} path
 * @param {number} topProbeCount
 * @returns {string[]}
 */
function findArmFieldProblems(arm, path, topProbeCount) {
  const problems = findScalarFieldProblems(arm, path, {
    stringFields: ARM_STRING_FIELDS,
    numberFields: ARM_NUMBER_FIELDS,
    booleanFields: ARM_BOOLEAN_FIELDS,
  });
  if (typeof arm !== "object" || arm === null) {
    return problems;
  }
  if (!isNumberOrNull(arm.associationMaxCount)) {
    problems.push(`${path}.associationMaxCount が数値でも null でもない`);
  }
  if (
    typeof arm.stageSkippedReasons !== "object" ||
    arm.stageSkippedReasons === null ||
    Array.isArray(arm.stageSkippedReasons)
  ) {
    problems.push(`${path}.stageSkippedReasons がオブジェクトでない`);
  } else {
    for (const [reason, count] of Object.entries(arm.stageSkippedReasons)) {
      if (typeof count !== "number" || Number.isNaN(count)) {
        problems.push(`${path}.stageSkippedReasons.${reason} が数値でない`);
      }
    }
  }
  if (
    typeof arm.associationFrameRoles !== "object" ||
    arm.associationFrameRoles === null ||
    Array.isArray(arm.associationFrameRoles)
  ) {
    problems.push(`${path}.associationFrameRoles がオブジェクトでない`);
  } else {
    for (const [role, count] of Object.entries(arm.associationFrameRoles)) {
      if (typeof count !== "number" || Number.isNaN(count)) {
        problems.push(`${path}.associationFrameRoles.${role} が数値でない`);
      }
    }
  }
  if (!Array.isArray(arm.probes)) {
    problems.push(`${path}.probes が配列でない`);
    return problems;
  }
  // 🔴 件数を書き写さない。probes 配列長と突き合わせる(書き写した数字は probe を増やしても古いまま緑になる)。
  if (typeof arm.probeCount === "number" && arm.probes.length !== arm.probeCount) {
    problems.push(
      `${path}.probes の長さ(${arm.probes.length})が ${path}.probeCount(${arm.probeCount})と一致しない`,
    );
  }
  if (typeof arm.probeCount === "number" && arm.probeCount !== topProbeCount) {
    problems.push(
      `${path}.probeCount(${arm.probeCount})がトップレベルの probeCount(${topProbeCount})と一致しない`,
    );
  }
  arm.probes.forEach((probe, i) => {
    problems.push(...findProbeFieldProblems(probe, `${path}.probes[${i}]`));
  });
  return problems;
}

/**
 * @param {unknown} delta
 * @param {string} path
 * @returns {string[]}
 */
function findDeltaFieldProblems(delta, path) {
  const problems = findScalarFieldProblems(delta, path, {
    stringFields: DELTA_STRING_FIELDS,
    numberFields: DELTA_NUMBER_FIELDS,
  });
  if (typeof delta !== "object" || delta === null) {
    return problems;
  }
  if (!isNumberOrNull(delta.charsPerAdditionalGold)) {
    problems.push(`${path}.charsPerAdditionalGold が数値でも null でもない`);
  }
  return problems;
}

/**
 * @param {unknown} embedding
 * @param {string} path
 * @returns {string[]}
 */
function findEmbeddingFieldProblems(embedding, path) {
  if (typeof embedding !== "object" || embedding === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of ["provider", "model"]) {
    if (typeof embedding[field] !== "string" || embedding[field] === "") {
      problems.push(`${path}.${field} が文字列でない、または空`);
    }
  }
  if (typeof embedding.dimensions !== "number") {
    problems.push(`${path}.dimensions が数値でない`);
  }
  return problems;
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = findScalarFieldProblems(data, "測定結果", {
    stringFields: TOP_STRING_FIELDS,
    numberFields: TOP_NUMBER_FIELDS,
  });
  if (!isStringOrNull(/** @type {any} */ (data).commit)) {
    problems.push("測定結果.commit が文字列でも null でもない");
  }
  problems.push(
    ...findEmbeddingFieldProblems(/** @type {any} */ (data).embedding, "測定結果.embedding"),
  );

  const warmup = /** @type {any} */ (data).warmup;
  if (typeof warmup !== "object" || warmup === null) {
    problems.push("測定結果.warmup がオブジェクトでない");
  } else {
    if (typeof warmup.ok !== "boolean") {
      problems.push("測定結果.warmup.ok が真偽値でない");
    }
    if (!isStringOrNull(warmup.detail)) {
      problems.push("測定結果.warmup.detail が文字列でも null でもない");
    }
  }

  const topProbeCount = /** @type {any} */ (data).probeCount;
  const arms = /** @type {any} */ (data).arms;
  /** @type {string[]} */
  const armLabels = [];
  if (!Array.isArray(arms)) {
    problems.push("測定結果.arms が配列でない");
  } else {
    if (arms.length !== ARM_COUNT) {
      problems.push(`測定結果.arms の本数が ${ARM_COUNT} でない(実際: ${arms.length})`);
    }
    const seenLabels = new Set();
    const seenArmKeys = new Set();
    arms.forEach((arm, i) => {
      problems.push(...findArmFieldProblems(arm, `測定結果.arms[${i}]`, topProbeCount));
      const label = /** @type {any} */ (arm)?.armLabel;
      if (typeof label === "string" && label !== "") {
        if (seenLabels.has(label)) {
          problems.push(`測定結果.arms に armLabel「${label}」が2件以上ある`);
        }
        seenLabels.add(label);
        armLabels.push(label);
      }
      // armLabel だけでは「同じ arm が2件」を見落とすため、構造化フィールドの鍵でも重複を見る。
      if (typeof arm === "object" && arm !== null && typeof arm.associationEnabled === "boolean") {
        const armKey = armShortKey(arm);
        if (seenArmKeys.has(armKey)) {
          problems.push(
            `測定結果.arms に arm「${armKey}」(associationEnabled/associationMaxCount)が2件以上ある`,
          );
        }
        seenArmKeys.add(armKey);
      }
    });
  }

  const deltas = /** @type {any} */ (data).deltas;
  if (!Array.isArray(deltas)) {
    problems.push("測定結果.deltas が配列でない");
  } else {
    if (deltas.length !== DELTA_COUNT) {
      problems.push(`測定結果.deltas の本数が ${DELTA_COUNT} でない(実際: ${deltas.length})`);
    }
    deltas.forEach((delta, i) => {
      problems.push(...findDeltaFieldProblems(delta, `測定結果.deltas[${i}]`));
      if (typeof delta === "object" && delta !== null) {
        // 順番ではなく名前で突き合わせる(識別子誤字を検出するため)。
        for (const field of ["baselineArmLabel", "againstArmLabel"]) {
          const label = delta[field];
          if (typeof label === "string" && label !== "" && !armLabels.includes(label)) {
            problems.push(
              `測定結果.deltas[${i}].${field}(${JSON.stringify(label)})が arms のどの armLabel とも一致しない`,
            );
          }
        }
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
 * @returns {{ ok: true, value: { embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const problems = [];
  problems.push(
    ...findEmbeddingFieldProblems(/** @type {any} */ (data).embedding, "基準値.embedding"),
  );
  if (
    typeof (/** @type {any} */ (data).llmMode) !== "string" ||
    /** @type {any} */ (data).llmMode === ""
  ) {
    problems.push("基準値.llmMode が文字列でない、または空");
  }
  const arms = /** @type {any} */ (data).arms;
  if (!Array.isArray(arms)) {
    problems.push("基準値.arms が配列でない");
  } else {
    const seenLabels = new Set();
    const seenArmKeys = new Set();
    arms.forEach((arm, i) => {
      const path = `基準値.arms[${i}]`;
      const armProblems = findScalarFieldProblems(arm, path, {
        stringFields: ARM_STRING_FIELDS,
        numberFields: ARM_NUMBER_FIELDS,
        booleanFields: ARM_BOOLEAN_FIELDS,
      });
      problems.push(...armProblems);
      if (typeof arm === "object" && arm !== null && !isNumberOrNull(arm.associationMaxCount)) {
        problems.push(`${path}.associationMaxCount が数値でも null でもない`);
      }
      const label = /** @type {any} */ (arm)?.armLabel;
      if (typeof label === "string" && label !== "") {
        if (seenLabels.has(label)) {
          problems.push(`基準値.arms に armLabel「${label}」が2件以上ある`);
        }
        seenLabels.add(label);
      }
      // measured 側と同じ理由で、構造化フィールドの鍵でも重複を見る。
      if (typeof arm === "object" && arm !== null && typeof arm.associationEnabled === "boolean") {
        const armKey = armShortKey(arm);
        if (seenArmKeys.has(armKey)) {
          problems.push(
            `基準値.arms に arm「${armKey}」(associationEnabled/associationMaxCount)が2件以上ある`,
          );
        }
        seenArmKeys.add(armKey);
      }
    });
  }
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON が使えない: ${problems.join("; ")}` };
  }
  return {
    ok: true,
    value:
      /** @type {{ embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] }} */ (
        data
      ),
  };
}

function formatMrr(value) {
  return Number(value).toFixed(3);
}

function formatFraction(count, total) {
  return `${count}/${total}`;
}

function formatSignedInt(diff) {
  return diff > 0 ? `+${diff}` : `${diff}`;
}

function formatSignedMrr(diff) {
  const fixed = Math.abs(diff).toFixed(3);
  if (diff > 0) return `+${fixed}`;
  if (diff < 0) return `-${fixed}`;
  return fixed;
}

function formatEmbeddingSpace(embedding) {
  return `${embedding.provider}/${embedding.model}/${embedding.dimensions}次元`;
}

function hit10CaveatNote() {
  return (
    "⚠ **`hit@10` は連想枠の効果を測れない。**連想枠が拾った候補は recall() 本体の" +
    " limit 件の後ろへ連結されて返るため(ADR 0151)、連想由来の gold は11位以降にしか" +
    "現れない。`hit@10` が動いていないことを「連想枠が効いていない」と読み違えないこと" +
    "——見るべきは goldReturnedCount / goldRank / mrr である。"
  );
}

function indexBaselineArms(baseline) {
  const byKey = new Map();
  for (const arm of baseline?.arms ?? []) {
    byKey.set(armShortKey(arm), arm);
  }
  return byKey;
}

function buildConditionsLine(measured) {
  return (
    `embedding: ${formatEmbeddingSpace(measured.embedding)} ・ llmMode: ${measured.llmMode} ・ ` +
    `probeCount: ${measured.probeCount} ・ haystackSize: ${measured.haystackSize} ・ ` +
    `recallLimit: ${measured.recallLimit} ・ measuredAt: ${measured.measuredAt} ・ ` +
    `commit: ${measured.commit ?? "(なし)"}`
  );
}

function buildWarmupWarningLines(measured) {
  if (measured.warmup.ok) {
    return [];
  }
  return [
    "",
    "## 🔴 warmup に失敗している——以下の値は測定として成立していない",
    "",
    "`warmup.ok` が `false` だった。ローカル埋め込みモデルの前準備(重みの取得・初回" +
      "推論)に失敗した可能性があり、下の全ての表の数字を実測値として読まないこと。",
    "",
    "detail:",
    "",
    "```",
    measured.warmup.detail ?? "(detail なし)",
    "```",
  ];
}

/**
 * @param {Record<string, any>} arm
 * @param {Record<string, any> | undefined} baselineArm
 * @returns {{ field: string, label: string, baselineValue: number, measuredValue: number, diff: number }[]}
 */
function findWorsenedFields(arm, baselineArm) {
  if (!baselineArm) {
    return [];
  }
  const worsened = [];
  for (const { field, label } of WORSENED_METRICS) {
    const tolerance = WORSENED_TOLERANCE[field] ?? 0;
    const diff = arm[field] - baselineArm[field];
    if (diff < -tolerance) {
      worsened.push({
        field,
        label,
        baselineValue: baselineArm[field],
        measuredValue: arm[field],
        diff,
      });
    }
  }
  return worsened;
}

/**
 * 門ではない。検出するだけで exit code に反映しない。
 *
 * @param {Record<string, any>} measured
 * @param {{ arms: Record<string, unknown>[] } | undefined} baseline
 * @returns {{ arm: Record<string, any>, worsenedFields: ReturnType<typeof findWorsenedFields> }[]}
 */
function findWorsenedArms(measured, baseline) {
  if (!baseline) {
    return [];
  }
  const baselineArms = indexBaselineArms(baseline);
  const results = [];
  for (const arm of measured.arms) {
    const worsenedFields = findWorsenedFields(arm, baselineArms.get(armShortKey(arm)));
    if (worsenedFields.length > 0) {
      results.push({ arm, worsenedFields });
    }
  }
  return results;
}

/**
 * 悪化が無ければ `undefined`。常に同じ節を出すと定型文として読み飛ばされる。
 *
 * @param {ReturnType<typeof findWorsenedArms>} worsenedArms
 */
function buildWorsenedArmsSection(worsenedArms) {
  if (worsenedArms.length === 0) {
    return undefined;
  }
  const lines = [
    "## ⚠ 基準値より悪い値がある（門ではない）",
    "",
    "🔴 これは失敗ではない——このベンチは required ではなく(ADR 0158)、相違しても" +
      " exit code は変えない。下の arm ごとの差を読み、意図した変化かどうかを人が判断すること。",
    "",
  ];
  for (const { arm, worsenedFields } of worsenedArms) {
    const fieldSummaries = worsenedFields.map(
      ({ field, label, baselineValue, measuredValue, diff }) => {
        const diffText = field === "mrr" ? formatSignedMrr(diff) : formatSignedInt(diff);
        return `${label}: 基準値${baselineValue} → 実測${measuredValue}(${diffText})`;
      },
    );
    lines.push(`- **${arm.armLabel}**: ${fieldSummaries.join(" / ")}`);
  }
  return lines.join("\n");
}

function formatArmBaselineDiff(arm, baselineArm) {
  if (!baselineArm) {
    return "基準値なし";
  }
  const goldDiff = arm.goldReturnedCount - baselineArm.goldReturnedCount;
  const hit1Diff = arm.hit1Count - baselineArm.hit1Count;
  const hit10Diff = arm.hit10Count - baselineArm.hit10Count;
  const mrrDiff = arm.mrr - baselineArm.mrr;
  const worsened = findWorsenedFields(arm, baselineArm);
  const prefix = worsened.length > 0 ? "⚠ " : "";
  return (
    `${prefix}gold${formatSignedInt(goldDiff)} / hit1${formatSignedInt(hit1Diff)} / ` +
    `hit10${formatSignedInt(hit10Diff)} / MRR${formatSignedMrr(mrrDiff)}`
  );
}

function buildArmSummaryTable(measured, baseline) {
  const baselineArms = baseline ? indexBaselineArms(baseline) : undefined;
  const header = baseline
    ? "| armLabel | 連想枠 | gold(N/probeCount) | うち連想由来 | hit@1 | hit@10 | MRR | 積んだ文字数 | うち連想枠 | 基準値との差 |"
    : "| armLabel | 連想枠 | gold(N/probeCount) | うち連想由来 | hit@1 | hit@10 | MRR | 積んだ文字数 | うち連想枠 |";
  const divider = baseline
    ? "|---|---|---|---|---|---|---|---|---|---|"
    : "|---|---|---|---|---|---|---|---|---|";
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const assocLabel = arm.associationEnabled ? `on(maxCount=${arm.associationMaxCount})` : "off";
    const cells = [
      arm.armLabel,
      assocLabel,
      formatFraction(arm.goldReturnedCount, arm.probeCount),
      formatFraction(arm.goldViaAssociationCount, arm.goldReturnedCount),
      formatFraction(arm.hit1Count, arm.probeCount),
      formatFraction(arm.hit10Count, arm.probeCount),
      formatMrr(arm.mrr),
      String(arm.memoryCharsTotal),
      String(arm.associationCharsTotal),
    ];
    if (baseline) {
      cells.push(formatArmBaselineDiff(arm, baselineArms.get(armShortKey(arm))));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildDeltaTable(measured) {
  const lines = [
    "| 基準arm | 対象arm | Δgold件数 | Δ連想由来件数 | ΔMRR | Δhit@10件数 | Δ文字数 | 1件多く思い出すのに要した文字数 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const delta of measured.deltas) {
    const charsPer =
      delta.charsPerAdditionalGold === null ? "-" : delta.charsPerAdditionalGold.toFixed(1);
    lines.push(
      `| ${delta.baselineArmLabel} | ${delta.againstArmLabel} | ` +
        `${formatSignedInt(delta.goldReturnedCount)} | ` +
        `${formatSignedInt(delta.goldViaAssociationCount)} | ` +
        `${formatSignedMrr(delta.mrr)} | ${formatSignedInt(delta.hit10Count)} | ` +
        `${formatSignedInt(delta.memoryCharsTotal)} | ${charsPer} |`,
    );
  }
  return lines.join("\n");
}

function buildCategoryTable(measured) {
  const header = `| カテゴリ | ${measured.arms.map((arm) => arm.armLabel).join(" | ")} |`;
  const divider = `|---|${measured.arms.map(() => "---").join("|")}|`;
  const lines = [header, divider];
  for (const category of CATEGORIES) {
    const cells = measured.arms.map((arm) => {
      const probesInCategory = arm.probes.filter((probe) => probe.category === category);
      const hit = probesInCategory.filter((probe) => probe.goldReturned).length;
      return formatFraction(hit, probesInCategory.length);
    });
    lines.push(`| ${category} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildProbeDetailTable(measured) {
  const arms = measured.arms;
  const header = [
    "probeId",
    "category",
    ...arms.flatMap((arm) => {
      const key = armShortKey(arm);
      return [`${key}:goldRank`, `${key}:連想由来`, `${key}:anchor経由`];
    }),
  ];
  const divider = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];

  const referenceArm = arms[0];
  for (const referenceProbe of referenceArm.probes) {
    const row = [referenceProbe.probeId, referenceProbe.category];
    for (const arm of arms) {
      const probe = arm.probes.find((p) => p.probeId === referenceProbe.probeId);
      if (!probe) {
        row.push("-", "-", "-");
        continue;
      }
      row.push(
        probe.goldRank === null ? "-" : String(probe.goldRank),
        probe.goldRetrievedVia === "association" ? "○" : "-",
        probe.goldAnchoredOnProbeAnchor ? "○" : "-",
      );
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildStageSkippedSection(measured) {
  const armsWithReasons = measured.arms.filter(
    (arm) => Object.keys(arm.stageSkippedReasons).length > 0,
  );
  if (armsWithReasons.length === 0) {
    return undefined;
  }
  const lines = ["## stageSkippedReasons の内訳", ""];
  for (const arm of armsWithReasons) {
    lines.push(`### ${arm.armLabel}`, "");
    for (const [reason, count] of Object.entries(arm.stageSkippedReasons)) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildAssociationFrameRolesTable(measured) {
  const roles = new Set();
  for (const arm of measured.arms) {
    for (const role of Object.keys(arm.associationFrameRoles ?? {})) {
      roles.add(role);
    }
  }
  const roleList = [...roles].sort();
  if (roleList.length === 0) {
    return "(どの arm の連想枠にも候補が入らなかった)";
  }
  const header = `| armLabel | ${roleList.join(" | ")} |`;
  const divider = `|---|${roleList.map(() => "---").join("|")}|`;
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const cells = roleList.map((role) => String(arm.associationFrameRoles?.[role] ?? 0));
    lines.push(`| ${arm.armLabel} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildRepeatConsistencyTable(measured) {
  const header = "| armLabel | 連想枠 | 枠が一致した probe 数 | goldRank が一致した probe 数 |";
  const divider = "|---|---|---|---|";
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const assocLabel = arm.associationEnabled ? `on(maxCount=${arm.associationMaxCount})` : "off";
    lines.push(
      `| ${arm.armLabel} | ${assocLabel} | ` +
        `${formatFraction(arm.repeatFrameIdenticalCount, arm.probeCount)} | ` +
        `${formatFraction(arm.repeatGoldRankSameCount, arm.probeCount)} |`,
    );
  }
  return lines.join("\n");
}

function findMaxAssociationCountArm(measured) {
  let best;
  for (const arm of measured.arms) {
    if (!arm.associationEnabled) {
      continue;
    }
    if (!best || (arm.associationMaxCount ?? -1) > (best.associationMaxCount ?? -1)) {
      best = arm;
    }
  }
  return best;
}

function formatAssociationFrameEntry(entry) {
  return `${entry.rank}:${entry.role}(${entry.externalId})`;
}

function buildMissedGoldFrameSection(measured) {
  const arm = findMaxAssociationCountArm(measured);
  if (!arm) {
    return undefined;
  }
  const missed = arm.probes.filter((probe) => !probe.goldReturned);
  const lines = [
    `## maxCount 最大の arm(${arm.armLabel})で gold が返らなかった probe の連想枠`,
    "",
  ];
  if (missed.length === 0) {
    lines.push("(この arm では、gold が返らなかった probe は無い)");
    return lines.join("\n");
  }
  lines.push("| probeId | 連想枠の中身(順位:role(externalId)、返った順) |", "|---|---|");
  for (const probe of missed) {
    const frame =
      probe.associationFrame.length > 0
        ? probe.associationFrame.map(formatAssociationFrameEntry).join(", ")
        : "(連想枠に候補が1件も入らなかった)";
    lines.push(`| ${probe.probeId} | ${frame} |`);
  }
  return lines.join("\n");
}

/** @param {{ measured: Record<string, any>, baseline?: { embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] } }} input */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# association-probes（連想枠 / ADR 0151・Issue #291）", ""];
  lines.push(buildConditionsLine(measured));
  lines.push(...buildWarmupWarningLines(measured));

  const worsenedArms = findWorsenedArms(measured, baseline);
  const worsenedArmsSection = buildWorsenedArmsSection(worsenedArms);
  if (worsenedArmsSection) {
    lines.push("", worsenedArmsSection);
  }

  lines.push(
    "",
    "## arm 別まとめ",
    "",
    buildArmSummaryTable(measured, baseline),
    "",
    hit10CaveatNote(),
    "",
    "## 基準 off との差分",
    "",
    buildDeltaTable(measured),
    "",
    "## カテゴリ別(gold が返った件数 / カテゴリ内 probe 数)",
    "",
    buildCategoryTable(measured),
    "",
    "## probe 別の明細",
    "",
    buildProbeDetailTable(measured),
    "",
    "## 連想枠の中身(role 別。北極星の問い3「なぜそれを思い出したのかを説明できるか」)",
    "",
    buildAssociationFrameRolesTable(measured),
    "",
    "## 同一ストアで引き直したとき枠が一致した probe 数(Issue #291 フォローアップ)",
    "",
    "同じ ingest 結果に対して同じクエリで `recall()` をもう一度呼び、連想枠/goldRank が" +
      "一致したかを見る(CI 再実行間の非決定性が、ingest 側(HNSW 索引の構築など)に" +
      "局在するのか、同じストアへの引き直しでも起きるのかを切り分けるための計測)。",
    "",
    buildRepeatConsistencyTable(measured),
  );

  const missedGoldFrameSection = buildMissedGoldFrameSection(measured);
  if (missedGoldFrameSection) {
    lines.push("", missedGoldFrameSection);
  }

  const stageSkippedSection = buildStageSkippedSection(measured);
  if (stageSkippedSection) {
    lines.push("", stageSkippedSection);
  }

  lines.push(
    "",
    `⚠ ADR 0033 §3: 標本${measured.probeCount}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この母数のうち何件成立したか」までである。",
  );

  if (baseline) {
    if (
      baseline.embedding.provider !== measured.embedding.provider ||
      baseline.embedding.model !== measured.embedding.model ||
      baseline.embedding.dimensions !== measured.embedding.dimensions ||
      baseline.llmMode !== measured.llmMode
    ) {
      lines.push(
        "",
        "⚠ 基準値と実測で embedding/llmMode の条件が違う——数字だけを比べても" +
          `意味がない(基準値: ${formatEmbeddingSpace(baseline.embedding)}/${baseline.llmMode}、` +
          `実測: ${formatEmbeddingSpace(measured.embedding)}/${measured.llmMode})。`,
      );
    }
  } else {
    lines.push(
      "",
      "ℹ️ 基準値ファイルが渡されていない——`examples/chat/association-baseline.json`" +
        "（ADR 0385）は存在するが、この呼び出しには `--baseline` が渡されなかった" +
        "(手元実行や単体テストではよくある。CI の `ci.yml` は渡している)。",
    );
  }

  return lines.join("\n");
}
