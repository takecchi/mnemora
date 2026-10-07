/**
 * 純関数の側。ファイル I/O・`process.argv`・`process.exit` を持たない。
 *
 * ⛔ 基準値との相違で non-zero を返さない(門にしない)。decay/freshness が実行間で揺れ、
 * 相違自体は異常ではない(ADR 0088 §2)。non-zero にするのは入力が壊れているときだけ。
 *
 * ⛔ 数値は許容誤差なしで比べる。「2回一致した」は決定的である証明ではない
 * (decay/freshness は時刻依存で、similarity が押し切っているだけ)。
 * 許容誤差が要るなら、先に揺れの実測を取ってから閾値を入れること。
 *
 * ⛔ 表組みなどの依存を足さない(依存追加はオーナー専権。`docs/autonomy.md`)。
 */

const REQUIRED_ARM_STRING_FIELDS = ["armLabel", "llmMode", "embeddingMode"];
const REQUIRED_ARM_NUMBER_FIELDS = [
  "mrrOverall",
  "mrrLexicalControl",
  "mrrNonLexical",
  "hit1Count",
  "hit10Count",
  "probeCount",
];

/**
 * @param {unknown} arm
 * @returns {string[]}
 */
function findArmFieldProblems(arm) {
  if (typeof arm !== "object" || arm === null) {
    return ["arm がオブジェクトでない"];
  }
  const problems = [];
  for (const field of REQUIRED_ARM_STRING_FIELDS) {
    if (typeof arm[field] !== "string" || arm[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_ARM_NUMBER_FIELDS) {
    if (typeof arm[field] !== "number" || Number.isNaN(arm[field])) {
      problems.push(`${field} が数値でない`);
    }
  }
  return problems;
}

/**
 * ⛔ 「壊れている」とする条件はここに限る。基準値との相違では落とさない。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const arms = /** @type {{ arms?: unknown }} */ (data).arms;
  if (!Array.isArray(arms) || arms.length === 0) {
    return { ok: false, error: "実測 JSON に arms 配列が無い、または空である" };
  }
  const problems = [];
  arms.forEach((arm, i) => {
    const armProblems = findArmFieldProblems(arm);
    if (armProblems.length > 0) {
      problems.push(`arms[${i}]: ${armProblems.join(" / ")}`);
    }
  });
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON の arm に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ arms: Record<string, unknown>[] }} */ (data) };
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: { arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const arms = /** @type {{ arms?: unknown }} */ (data).arms;
  if (!Array.isArray(arms)) {
    return { ok: false, error: "基準値 JSON に arms 配列が無い" };
  }
  const problems = [];
  arms.forEach((arm, i) => {
    const armProblems = findArmFieldProblems(arm);
    if (armProblems.length > 0) {
      problems.push(`arms[${i}]: ${armProblems.join(" / ")}`);
    }
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の arm に必須項目が無い: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ arms: Record<string, unknown>[] }} */ (data) };
}

function formatFraction(count, total) {
  return `${count}/${total}`;
}

function formatMrr(value) {
  return value.toFixed(3);
}

const DIFF_FIELDS = [
  "llmMode",
  "embeddingMode",
  "mrrOverall",
  "mrrLexicalControl",
  "mrrNonLexical",
  "hit1Count",
  "hit10Count",
  "probeCount",
];

/**
 * ⛔ `armLabel` の完全一致で対応付ける。別ラベルの arm 同士は突き合わせない。
 *
 * @param {Record<string, unknown>} measuredArm
 * @param {Record<string, unknown> | undefined} baselineArm
 * @returns {{ armLabel: string, matches: boolean, missingBaseline: boolean, fieldDiffs: { field: string, baseline: unknown, measured: unknown }[] }}
 */
export function diffArm(measuredArm, baselineArm) {
  const armLabel = /** @type {string} */ (measuredArm.armLabel);
  if (!baselineArm) {
    return { armLabel, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    if (measuredArm[field] !== baselineArm[field]) {
      fieldDiffs.push({ field, baseline: baselineArm[field], measured: measuredArm[field] });
    }
  }
  return { armLabel, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/** @param {Record<string, unknown>[]} arms */
function buildArmTable(arms) {
  const header =
    "| arm | llmMode | embeddingMode | MRR(全体) | MRR(lexicalControl) | MRR(非語彙) | hit@1 | hit@10 |";
  const sep = "|---|---|---|---|---|---|---|---|";
  const rows = arms.map((arm) => {
    const mrrOverall = formatMrr(/** @type {number} */ (arm.mrrOverall));
    const mrrLexical = formatMrr(/** @type {number} */ (arm.mrrLexicalControl));
    const mrrNonLexical = formatMrr(/** @type {number} */ (arm.mrrNonLexical));
    const hit1 = formatFraction(arm.hit1Count, arm.probeCount);
    const hit10 = formatFraction(arm.hit10Count, arm.probeCount);
    return (
      `| ${arm.armLabel} | ${arm.llmMode} | ${arm.embeddingMode} | ${mrrOverall} | ` +
      `${mrrLexical} | ${mrrNonLexical} | ${hit1} | ${hit10} |`
    );
  });
  return [header, sep, ...rows].join("\n");
}

/**
 * @param {Record<string, unknown>[]} measuredArms
 * @param {Record<string, unknown>[]} baselineArms
 */
function buildDiffSection(measuredArms, baselineArms) {
  const baselineByLabel = new Map(baselineArms.map((arm) => [arm.armLabel, arm]));
  const measuredLabels = new Set(measuredArms.map((arm) => arm.armLabel));
  const diffs = measuredArms.map((arm) => diffArm(arm, baselineByLabel.get(arm.armLabel)));
  const extraBaselineArms = baselineArms.filter((arm) => !measuredLabels.has(arm.armLabel));

  const allMatch = diffs.every((d) => d.matches) && extraBaselineArms.length === 0;

  const lines = ["## 基準値との差分", ""];
  if (allMatch) {
    lines.push("✅ 一致（差分なし）。");
    return lines.join("\n");
  }

  const mismatched = diffs.filter((d) => !d.matches);
  lines.push(
    `⚠ 基準値と相違した arm が ${mismatched.length} 件ある` +
      "（🔴 これは失敗ではない——decay/freshness やコードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断すること）。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.armLabel}`);
    if (diff.missingBaseline) {
      lines.push("", "この arm には基準値が無い（新しい arm か、基準値がまだ追随していない）。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  if (extraBaselineArms.length > 0) {
    lines.push(
      "",
      `### 基準値にのみ存在する arm（今回の実測には無い）`,
      "",
      ...extraBaselineArms.map((arm) => `- ${arm.armLabel}`),
    );
  }
  return lines.join("\n");
}

/**
 * ADR への参照を相対パスのリンクにしない。出力先は `$GITHUB_STEP_SUMMARY` で、
 * リポジトリのファイルツリーの上に立っておらず、相対リンクは死ぬ。絶対 URL(`main`)にする。
 */
const REPO_BLOB_BASE = "https://github.com/takecchi/mnemora/blob/main/docs/decisions";

function buildCautionSection() {
  return [
    "## 読み方の注意",
    "",
    "- ⚠ **動いているのは `similarity` ただ1項である。**このベンチの呼び方" +
      "（`recall(ctx, {text})` のみ）では、候補集合の上で `tagMatch`/`strength` は" +
      "厳密に1通りしか値を取らず順位に構造上ゼロ寄与し、`decay` の変域は `similarity` より" +
      "約10⁶〜10⁷倍小さく、`freshness` は `decay` の行ごと厳密な複製である" +
      `（[ADR 0081](${REPO_BLOB_BASE}/0081-similarity-is-the-only-term-that-ranks.md) §1・§2）。`,
    "- ⚠ **標本は probe 7件である。ここから失敗率も成功率も主張しない**" +
      `（[ADR 0033](${REPO_BLOB_BASE}/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3）。`,
    "- ⚠ **埋め込みは否定・時制・矛盾を解かない。**実測例: 「紅茶よりコーヒーが好き」と" +
      "「コーヒーより紅茶が好き」は意味が逆だが、コサイン類似度は 0.996 である。" +
      "⟹ **この値が上がっても「精度が上がった」と一言でまとめてはいけない。**",
    "",
  ].join("\n");
}

/**
 * ⛔ 門ではない(exit code に触れない)。省略可能欄が無い古い実測 JSON では何も警告しない
 * (測れないことを「0 だった」と偽らない)。
 *
 * @param {Record<string, unknown>[]} arms
 * @returns {string | null}
 */
export function buildLexicalChannelWarningSection(arms) {
  const measurable = arms.filter((arm) => typeof arm.lexicalMatchRows === "number");
  if (measurable.length === 0) {
    return null;
  }
  const silent = measurable.filter((arm) => arm.lexicalMatchRows === 0);
  if (silent.length === 0) {
    return null;
  }
  const lines = [
    "## ⚠ 語彙チャンネルが1行も通っていない",
    "",
    "🔴 **これは直ったら消える警告である。**次の arm で、返ってきた候補行のうち" +
      "`score.lexicalMatch` 欄を持つ行が **0 行**だった:",
    "",
  ];
  for (const arm of silent) {
    const recalled = typeof arm.recalledRows === "number" ? arm.recalledRows : "?";
    lines.push(`- ${arm.armLabel}: lexicalMatchRows=0 / recalledRows=${recalled}`);
  }
  lines.push(
    "",
    "⚠ **これは失敗ではない。**`examples/chat` の retrieval ベンチは `recall()` に" +
      '`channels` を渡しておらず、既定 `DEFAULT_RECALL_CHANNELS`(`["ann"]`)だけで' +
      "recall している——`LexicalStore` が配線されていないという、**このベンチの構成**の" +
      `反映である（[ADR 0108](${REPO_BLOB_BASE}/0108-retrieval-bench-does-not-exercise-lexical-channel.md)）。`,
    "",
    "⟹ **この警告が消えたら、それはベンチの構成が変わったという意味である**" +
      '（`channels` に `"lexical"` を足す、または同等の変更）。' +
      "**そのときは `hit@1` を測り直すこと**（それがこの警告の目的である）。" +
      "⛔ この警告を消すだけにしないこと。",
  );
  return lines.join("\n");
}

/**
 * ⛔ 門ではない(exit code に触れない)。省略可能欄が無い古い実測 JSON では何も言わない
 * (測れないことを「0 だった」と偽らない)。
 *
 * @param {Record<string, unknown>[]} arms
 * @returns {string | null}
 */
export function buildConstantTermSection(arms) {
  const measurable = arms.filter((arm) => Array.isArray(arm.termDistinct));
  if (measurable.length === 0) {
    return null;
  }

  const armLines = [];
  for (const arm of measurable) {
    const constantTerms = /** @type {{ term: string, maxDistinctPerProbe: number }[]} */ (
      arm.termDistinct
    ).filter((t) => t.maxDistinctPerProbe === 1);
    if (constantTerms.length > 0) {
      armLines.push(
        `- ${arm.armLabel}: ${constantTerms.map((t) => t.term).join(", ")} は、` +
          "どの probe でも候補間に1通りしか値を取らなかった " +
          "⟹ この重みをいくら触っても順位は動かない。",
      );
    }
    const equalRows = arm.decayFreshnessEqualRows;
    const differentRows = arm.decayFreshnessDifferentRows;
    if (
      typeof equalRows === "number" &&
      typeof differentRows === "number" &&
      differentRows === 0 &&
      equalRows > 0
    ) {
      armLines.push(
        `- ${arm.armLabel}: decay と freshness は全行(${equalRows}行)で厳密に等価だった ` +
          "（＝独立した項として効いていない）。",
      );
    }
  }

  if (armLines.length === 0) {
    return null;
  }

  return [
    "## ⚠ 候補間で値が動いていない項がある",
    "",
    "🔴 **これは直ったら消える警告である。**" +
      `（[ADR 0081](${REPO_BLOB_BASE}/0081-similarity-is-the-only-term-that-ranks.md) §1 の実測と同じ形の計装）:`,
    "",
    ...armLines,
    "",
    "⚠ **これは失敗ではない。**このベンチの呼び方(`recall(ctx, {text})` のみ)・" +
      "記憶の作られ方(抽出が常に `strength: 1` を書く等)が、現状こうなっているという" +
      "構成の反映である(ADR 0109)。",
    "",
    "⟹ **この警告が消えたら、それはベンチの前提が変わったという意味である**" +
      "(`recall()` に `tags` が渡されるようになった／`Memory.strength` に 1 以外が" +
      "書かれるようになった／`occurredAt` か `lastReinforcedAt` が埋まるようになった" +
      "＝ `decay`/`freshness` の起点が分かれた)。**そのときは順位を測り直すこと**" +
      "（それがこの警告の目的である）。⛔ この警告を消すだけにしないこと。",
  ].join("\n");
}

/**
 * @param {{ measured: { arms: Record<string, unknown>[] }, baseline?: { arms: Record<string, unknown>[] } }} input
 * @returns {string}
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# retrieval bench の実測（記録した実 API 応答の再生・機械可読サマリ）",
    "",
    "## arm ごとの結果",
    "",
    buildArmTable(measured.arms),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured.arms, baseline.arms), "");
  }
  const lexicalWarning = buildLexicalChannelWarningSection(measured.arms);
  if (lexicalWarning) {
    lines.push(lexicalWarning, "");
  }
  const constantTermSection = buildConstantTermSection(measured.arms);
  if (constantTermSection) {
    lines.push(constantTermSection, "");
  }
  lines.push(buildCautionSection());
  return lines.join("\n");
}
