/**
 * `scripts/correction-candidate-probe-summary.mjs`(CI の Job Summary に載せる Markdown を
 * 組み立てる CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/numeral-token-probe-summary-lib.mjs`/`scripts/identifier-probe-summary-lib.mjs`
 * と同じ分担・同じ理由（ADR 0291 §7-3、ADR 0321、Issue #109）。
 *
 * `examples/chat` の `correction-candidates` サブコマンド
 * （`MNEMORA_CORRECTION_CANDIDATE_JSON` が吐く JSON、
 * `examples/chat/src/correction-candidate-json.ts` の `CorrectionCandidateProbeRunJson`）を
 * Markdown へ変換する。
 *
 * ⛔ **`scripts/identifier-probe-summary-lib.mjs`/`scripts/numeral-token-probe-summary-lib.mjs`
 * とは別の道具・別の入力である**——既存の識別子・数詞索引 probe の要約には1文字も触れていない。
 *
 * **群は1つだけ**（`identifier-probes`/`numeral-token-probes` の sparse/dense のような
 * haystack 条件の分岐がこの arm には無い。A群/B群という別の軸を持つが、それは
 * `summary` オブジェクトのフィールドとして表現する）。
 *
 * 🔴 **`status` で最初に分岐する。**`"weights_unavailable"` と `"measured"` を
 * 同じ顔で出さない（既存2つの summary-lib と同じ理由）。
 *
 * ## ⛔ 門にはしない
 *
 * 相違で非0を返さない。標本53件（A群21・B群32）は ADR 0033 §3 の規律に照らして
 * 閾値の門に足る母数ではない（ADR 0291 §4 決定7、ADR 0232 決定文「n=8 では偽陽性率に
 * 上限を置けない」）。非0になるのは**入力そのものが壊れているとき**だけである。
 *
 * ## 🔴 比べるのは数字だけではない
 *
 * `embeddingSpace`（`provider`/`model`/`dimensions`）・`llmMode`/`embeddingMode`・
 * `caseSet` に加え、**`marginStats`/`intrusionMarginStats`（count/mean/stdDev/min）も
 * 比べる**——ADR 0291 §5.5 の核心である margin/intrusionMargin の分布が、
 * 基準値と実測でずれていないかを見る。
 *
 * ## 🧊 `protectionMargin`（ADR 0333 §3.2 案2）は影で並べるだけ——`DIFF_FIELDS` には入れない
 *
 * `intrusionMargin` を凍結したまま並べて出す後継 `protectionMargin`
 * （`summary.protectionMarginStats`）を、**`DIFF_FIELDS`（基準値との一致/相違判定）には
 * 加えていない**——既存の判定を1つも変えないため。measured 側の値は本文の表に
 * intrusionMargin と並べて出す。基準値側に `protectionMarginStats` があれば、
 * 「参考（差分判定には使っていない）」と明記した別節で並べて出す（`exit code` は変えない）。
 */

const REQUIRED_SUMMARY_NUMBER_FIELDS = [
  "hitCount",
  "mrr",
  "distractorBeatsGoldCount",
  "abstainCount",
  "protectedAtTopCount",
  "shallowMisfireCount",
  "abstainedCount",
];

/**
 * `marginStats`/`intrusionMarginStats`（`{ count, mean, stdDev, min }`）が正しい形かを
 * 検査する。`mean`/`stdDev`/`min` は `count` によって `null` でもよい
 * （`computeMarginStats` の契約）。
 *
 * @param {unknown} stats
 * @param {string} label
 * @returns {string[]}
 */
function findMarginStatsProblems(stats, label) {
  if (typeof stats !== "object" || stats === null) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  const s = /** @type {Record<string, unknown>} */ (stats);
  if (typeof s.count !== "number" || Number.isNaN(s.count)) {
    problems.push(`${label}.count が数値でない`);
  }
  for (const field of ["mean", "stdDev", "min"]) {
    const value = s[field];
    if (value !== null && (typeof value !== "number" || Number.isNaN(value))) {
      problems.push(`${label}.${field} が数値でも null でもない`);
    }
  }
  return problems;
}

/**
 * `summary` オブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
 * @param {unknown} summary
 * @returns {string[]}
 */
function findSummaryFieldProblems(summary) {
  if (typeof summary !== "object" || summary === null) {
    return ["summary がオブジェクトでない"];
  }
  const problems = [];
  const s = /** @type {Record<string, unknown>} */ (summary);
  for (const field of REQUIRED_SUMMARY_NUMBER_FIELDS) {
    if (typeof s[field] !== "number" || Number.isNaN(s[field])) {
      problems.push(`summary.${field} が数値でない`);
    }
  }
  const hitAtK = s.hitAtK;
  if (typeof hitAtK !== "object" || hitAtK === null) {
    problems.push("summary.hitAtK がオブジェクトでない");
  } else {
    for (const k of ["1", "3", "5", "10"]) {
      if (typeof (/** @type {any} */ (hitAtK)[k]) !== "number") {
        problems.push(`summary.hitAtK.${k} が数値でない`);
      }
    }
  }
  problems.push(...findMarginStatsProblems(s.marginStats, "summary.marginStats"));
  problems.push(...findMarginStatsProblems(s.intrusionMarginStats, "summary.intrusionMarginStats"));
  // ADR 0333 §3.2 案2: `protectionMarginStats` は追加フィールドであり、旧い実測 JSON・
  // 旧い基準値には存在しない。⟹ **在るときだけ**形を検査する（無いこと自体は問題にしない
  // ——`REQUIRED_SUMMARY_NUMBER_FIELDS` と違い必須項目に昇格させない）。
  if (s.protectionMarginStats !== undefined) {
    problems.push(
      ...findMarginStatsProblems(s.protectionMarginStats, "summary.protectionMarginStats"),
    );
  }
  return problems;
}

/**
 * `MNEMORA_CORRECTION_CANDIDATE_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.status === "weights_unavailable") {
    if (typeof d.detail !== "string" || d.detail === "") {
      return { ok: false, error: "weights_unavailable な JSON に detail が無い、または空" };
    }
    return { ok: true, value: d };
  }
  if (d.status !== "measured") {
    return { ok: false, error: `status が不明な値である(実際: ${JSON.stringify(d.status)})` };
  }
  const problems = [];
  for (const field of ["llmMode", "embeddingMode", "caseSet"]) {
    if (typeof d[field] !== "string" || d[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  const space = /** @type {any} */ (d).embeddingSpace;
  if (typeof space !== "object" || space === null) {
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
  problems.push(...findSummaryFieldProblems(d.summary));
  if (!Array.isArray(d.hits)) {
    problems.push("hits が配列でない");
  }
  if (!Array.isArray(d.abstains)) {
    problems.push("abstains が配列でない");
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: d };
}

/**
 * 基準値ファイル（`examples/chat/correction-candidate-probe-baseline.json`、パース済み）の
 * 形を検査する。`measured` と同じ shape のスナップショットを1つ持つだけ（群は1つなので
 * `groups` 配列にしていない）。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const snapshot = /** @type {{ snapshot?: unknown } } */ (data).snapshot;
  if (typeof snapshot !== "object" || snapshot === null) {
    return { ok: false, error: "基準値 JSON に snapshot オブジェクトが無い" };
  }
  const validated = validateMeasured(snapshot);
  if (!validated.ok) {
    return { ok: false, error: `基準値 JSON の snapshot が使えない: ${validated.error}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/** `4/7` の形。 */
function formatFraction(count, total) {
  return `${count}/${total}`;
}

function formatMrr(value) {
  return /** @type {number} */ (value).toFixed(4);
}

function formatSpace(space) {
  return `${space.provider}/${space.model}/${space.dimensions}次元`;
}

/** `identifier-arm.ts` の `formatMarginStats` と同じ桁数の表示に揃える。 */
function formatMargin(stats) {
  if (!stats || stats.count === 0) {
    return "(測れた件が0件)";
  }
  const stdDevText = stats.stdDev === null ? "(n<2)" : stats.stdDev.toExponential(3);
  return `n=${stats.count} mean=${stats.mean.toExponential(3)} stdDev=${stdDevText} min=${stats.min.toExponential(3)}`;
}

/**
 * 基準値と突き合わせる項目。`readPath` の入れ子パス記法を使う。
 */
const DIFF_FIELDS = [
  "llmMode",
  "embeddingMode",
  "caseSet",
  "embeddingSpace.provider",
  "embeddingSpace.model",
  "embeddingSpace.dimensions",
  "summary.hitCount",
  "summary.hitAtK.1",
  "summary.hitAtK.3",
  "summary.hitAtK.5",
  "summary.hitAtK.10",
  "summary.mrr",
  "summary.distractorBeatsGoldCount",
  "summary.abstainCount",
  "summary.protectedAtTopCount",
  "summary.shallowMisfireCount",
  "summary.abstainedCount",
  "summary.marginStats.count",
  "summary.marginStats.mean",
  "summary.marginStats.stdDev",
  "summary.marginStats.min",
  "summary.intrusionMarginStats.count",
  "summary.intrusionMarginStats.mean",
  "summary.intrusionMarginStats.stdDev",
  "summary.intrusionMarginStats.min",
];

/**
 * `"summary.hitAtK.1"` のような入れ子のパスを読む。
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
 * @param {Record<string, any>} measured
 * @param {Record<string, any>} baselineSnapshot
 * @returns {{ matches: boolean, fieldDiffs: { field: string, baseline: unknown, measured: unknown }[] }}
 */
export function diffSnapshot(measured, baselineSnapshot) {
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readPath(baselineSnapshot, field);
    const value = readPath(measured, field);
    if (baseline !== value) {
      fieldDiffs.push({ field, baseline, measured: value });
    }
  }
  return { matches: fieldDiffs.length === 0, fieldDiffs };
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**（ADR 0088 §3-3 と同じ規律）。
 *
 * @param {Record<string, any>} measured
 * @param {Record<string, any>} baseline
 */
function buildDiffSection(measured, baseline) {
  const lines = ["## 基準値との差分", ""];
  if (baseline.snapshot.status === "weights_unavailable") {
    lines.push("基準値が `weights_unavailable` のスナップショットのため、比較はできない。");
    return lines.join("\n");
  }
  const diff = diffSnapshot(measured, baseline.snapshot);
  if (diff.matches) {
    lines.push(
      "✅ 一致(差分なし)。llmMode / embeddingMode / caseSet / embeddingSpace / " +
        "hit@1,3,5,10 / MRR / distractor逆転 / 誤爆(深/浅) / 棄権 / " +
        "margin(count,mean,stdDev,min) / intrusionMargin(count,mean,stdDev,min) が " +
        "`examples/chat/correction-candidate-probe-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }
  lines.push(
    `⚠ 基準値と相違した項目が ${diff.fieldDiffs.length} 件ある` +
      "(🔴 これは失敗ではない——コードやケース集合の変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること)。",
    "",
    "| 項目 | 基準値 | 実測 |",
    "|---|---|---|",
  );
  for (const fieldDiff of diff.fieldDiffs) {
    lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
  }
  return lines.join("\n");
}

/**
 * `protectionMargin`（ADR 0333 §3.2 案2）の基準値との突き合わせを、**参考としてだけ**
 * 出す節。🔴 **`DIFF_FIELDS`/`diffSnapshot` には一切関わらない**——ここで測定と基準値の
 * 値が違っても `matches`/exit code は動かない。基準値に無い（旧い基準値、または
 * 何らかの理由で欠けている）ときは、その旨を書いて終える。
 *
 * @param {Record<string, any>} measured
 * @param {Record<string, any>} baseline
 */
function buildProtectionMarginReferenceSection(measured, baseline) {
  const lines = ["## 参考: protectionMargin(ADR 0333 案2、差分判定には使っていない)", ""];
  const measuredStats = measured.summary?.protectionMarginStats;
  const baselineStats = baseline.snapshot.summary?.protectionMarginStats;
  lines.push(`実測: ${formatMargin(measuredStats)}`);
  if (baselineStats === undefined) {
    lines.push(
      "基準値に `protectionMarginStats` が無い(旧い基準値、または未計測)。" +
        "🔴 この節は参考であり、`DIFF_FIELDS` による一致/相違判定には元から含まれていない。",
    );
    return lines.join("\n");
  }
  lines.push(`基準値: ${formatMargin(baselineStats)}`);
  lines.push(
    "⚠ 上の実測/基準値が一致しなくても、このスクリプトの exit code・" +
      "「基準値との差分」節の判定には影響しない(この節は参考専用)。",
  );
  return lines.join("\n");
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと。**
 *
 * @param {{ measured: Record<string, any>, baseline?: Record<string, any> }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# correction-candidate-probes(ADR 0291 / ADR 0321、Issue #109)"];

  if (measured.status === "weights_unavailable") {
    lines.push(
      "",
      "## 🔴 重みを取得できなかったので、値は測っていない — メトリクスは1件も出さない",
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

  const s = measured.summary;
  lines.push(
    "",
    `✅ 測定できた（ケース集合 = ${measured.caseSet}、` +
      `provider: llm=${measured.llmMode} / embedding=${measured.embeddingMode} / ` +
      `${formatSpace(measured.embeddingSpace)}）。`,
    "",
    "## A群（訂正すべき相手が実在する。n=" + String(s.hitCount) + "）",
    "",
    "| hit@1 | hit@3 | hit@5 | hit@10 | MRR | distractor逆転 | margin(n/mean/stdDev/min) |",
    "|---|---|---|---|---|---|---|",
    `| ${formatFraction(s.hitAtK["1"], s.hitCount)} | ${formatFraction(s.hitAtK["3"], s.hitCount)} | ` +
      `${formatFraction(s.hitAtK["5"], s.hitCount)} | ${formatFraction(s.hitAtK["10"], s.hitCount)} | ` +
      `${formatMrr(s.mrr)} | ${formatFraction(s.distractorBeatsGoldCount, s.hitCount)} | ` +
      `${formatMargin(s.marginStats)} |`,
    "",
    "## B群（⛔ 訂正してはいけない。n=" + String(s.abstainCount) + "）",
    "",
    "| 棄権 | 🔴 誤爆・深 | 誤爆・浅 | intrusionMargin(n/mean/stdDev/min、深い誤爆のみ、🧊凍結) | " +
      "protectionMargin(n/mean/stdDev/min、深い誤爆+誤爆(浅)、ADR 0333) |",
    "|---|---|---|---|---|",
    `| ${formatFraction(s.abstainedCount, s.abstainCount)} | ` +
      `${formatFraction(s.protectedAtTopCount, s.abstainCount)} | ` +
      `${formatFraction(s.shallowMisfireCount, s.abstainCount)} | ` +
      `${formatMargin(s.intrusionMarginStats)} | ` +
      `${formatMargin(s.protectionMarginStats)} |`,
    "",
  );
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
    lines.push(buildProtectionMarginReferenceSection(measured, baseline), "");
  }
  lines.push(
    `⚠ ADR 0033 §3・ADR 0232「引き受けた負債」2: 標本(A群${s.hitCount}件・B群${s.abstainCount}件)` +
      "からは失敗率も成功率も統計的に主張しない。ここで言えるのは「今回、この母数のうち" +
      "何件がどうなったか」までである。この bench は⛔ 門ではない（相違しても exit 0）。",
    "",
    "⚠ この母集合に代表性は無い(すべて手書き)。B群のほうが件数が多いのは、危険の非対称性" +
      "（ADR 0232 が実測した深い誤爆の実害）を反映した結果であり、行列（索引型×kind）を" +
      "先に決めた結果として付いてきた件数である(ADR 0291 §5.4)。",
  );
  return lines.join("\n");
}
