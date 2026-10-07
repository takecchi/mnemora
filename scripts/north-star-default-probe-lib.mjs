/**
 * 段1・段2が共有する純関数の側。ファイル I/O・`Runtime` の構築・`process.exit` を持たない。
 *
 * ⛔ 判定しない。事実を文字列として運ぶだけで、「満たす/満たさない/半分」という語を出さない
 * (充足判定は `docs/north-star-paths.md`。ADR 0216 決定8)。
 *
 * ⛔ 登録簿の類の割り当ては ADR 0216 決定1の表のまま。ここで新しく決めない(食い違うときバグなのは実装)。
 *
 * ⛔ 北極星の文面をここに複製しない。`docs/north-star.md` から実行時に読み直す。
 * 正典に登録簿に無い項目は「未割り当て」、登録簿の項目が正典に無ければ「文面が変わった可能性」として出し、推測で埋めない。
 */

/** @typedef {{ item: number, excerpt: string, class: "甲" | "乙" | "丙", source: string }} RegistryEntry */

/**
 * `excerpt` は `docs/north-star.md` の太字部分の逐語。一致しなければ「文面が変わった可能性」として出る
 * (検出の対象でありバグではない)。類は文面が決め、実装が決めない(ADR 0216 決定1)。
 *
 * @type {RegistryEntry[]}
 */
export const NORTH_STAR_ITEM_REGISTRY = [
  {
    item: 1,
    excerpt: "言ったことを、次の日も覚えている。",
    class: "甲",
    source: "ADR 0216 決定1",
  },
  {
    item: 2,
    excerpt: "聞かれていないことを、自分から思い出す。",
    class: "甲",
    source: "ADR 0216 決定1",
  },
  {
    item: 3,
    excerpt: "なぜそれを思い出したのかを、後から説明できる。",
    class: "丙",
    source: "ADR 0216 決定1",
  },
  {
    item: 4,
    excerpt: "使われない記憶が、静かに遠ざかる。",
    class: "丙",
    source: "ADR 0216 決定1",
  },
  {
    item: 5,
    excerpt: "間違いを正すと、古いほうが先に出てこなくなる。",
    class: "甲",
    source: "ADR 0216 決定1",
  },
  {
    item: 6,
    excerpt: "知らないことを、知らないと言える。",
    class: "甲",
    source: "ADR 0216 決定1",
  },
  {
    item: 7,
    excerpt: "どれだけ載せるかを、使う側が決められる。",
    class: "乙",
    source: "ADR 0216 決定1",
  },
];

const GOAL_SECTION_HEADING = "## 目指す姿";

/**
 * ⛔ 見出しが見つからない・箇条が1つも取れないときは `ok: false`。黙って空配列を「一致した」と誤読させない。
 *
 * @param {string} northStarMarkdown
 * @returns {{ ok: true, statements: string[] } | { ok: false, error: string }}
 */
export function extractGoalStatements(northStarMarkdown) {
  const lines = northStarMarkdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === GOAL_SECTION_HEADING);
  if (headingIndex === -1) {
    return {
      ok: false,
      error: `docs/north-star.md に「${GOAL_SECTION_HEADING}」の見出しが見つからない`,
    };
  }
  /** @type {string[]} */
  const statements = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      break; // 次の見出しで節が終わる
    }
    const match = line.match(/^-\s+\*\*(.+?)\*\*/);
    if (match) {
      statements.push(match[1]);
    }
  }
  if (statements.length === 0) {
    return {
      ok: false,
      error: `「${GOAL_SECTION_HEADING}」節に箇条（- **...**）が1つも見つからない`,
    };
  }
  return { ok: true, statements };
}

/**
 * @typedef {{
 *   entry: RegistryEntry,
 *   foundInCanon: boolean,
 * }} RegistryRow
 */

/**
 * @typedef {{
 *   rows: RegistryRow[],
 *   unassignedCanonStatements: string[],
 *   registryEntriesMissingFromCanon: RegistryEntry[],
 * }} RegistryReport
 */

/**
 * ⛔ 推測で類を埋めない。類の割り当てはオーナー専権(ADR 0216 決定1)。
 *
 * @param {string[]} canonStatements
 * @param {RegistryEntry[]} registry
 * @returns {RegistryReport}
 */
export function buildRegistryReport(canonStatements, registry) {
  const canonSet = new Set(canonStatements);
  const registryExcerpts = new Set(registry.map((entry) => entry.excerpt));

  const rows = registry.map((entry) => ({
    entry,
    foundInCanon: canonSet.has(entry.excerpt),
  }));
  const unassignedCanonStatements = canonStatements.filter(
    (statement) => !registryExcerpts.has(statement),
  );
  const registryEntriesMissingFromCanon = registry.filter((entry) => !canonSet.has(entry.excerpt));

  return { rows, unassignedCanonStatements, registryEntriesMissingFromCanon };
}

const ADOPTER_SUPPLIED_PATTERN = /ADOPTER-SUPPLIED\((item\d+)\):\s*(配線|データ|判定)/g;

/** @typedef {{ 配線: number, データ: number, 判定: number }} AdopterSuppliedCounts */

/**
 * 判定しない。印の付いていない実行(項目3・4)は集計に現れず、それ自体が「機械に載せていない」ことの表現。
 *
 * @param {string} sourceText
 * @returns {Map<string, AdopterSuppliedCounts>}
 */
export function countAdopterSuppliedMarks(sourceText) {
  /** @type {Map<string, AdopterSuppliedCounts>} */
  const byItem = new Map();
  for (const match of sourceText.matchAll(ADOPTER_SUPPLIED_PATTERN)) {
    const itemId = match[1];
    const kind = /** @type {"配線" | "データ" | "判定"} */ (match[2]);
    if (!byItem.has(itemId)) {
      byItem.set(itemId, { 配線: 0, データ: 0, 判定: 0 });
    }
    byItem.get(itemId)[kind] += 1;
  }
  return byItem;
}

/**
 * @typedef {{
 *   item: number,
 *   mode: "measured" | "not-measured" | "print-failed",
 *   fact: string,
 * }} ItemResult
 */

function classLabel(klass) {
  switch (klass) {
    case "甲":
      return "甲（既定で起きること）";
    case "乙":
      return "乙（使う側が渡せることが充足）";
    case "丙":
      return "丙（採用者が外の情報を渡すことを前提にする。機械に載せない）";
    default:
      return klass;
  }
}

/**
 * @param {RegistryReport} registryReport
 * @param {string[] | null} canonError
 */
function buildRegistrySection(registryReport, canonError) {
  const lines = ["## 登録簿（7項目 × 類 × 出典）", ""];

  if (canonError) {
    lines.push(
      `🔴 **docs/north-star.md から文面を読めなかった**: ${canonError}`,
      "⟹ 以下の「正典に在るか」列はすべて判定不能として扱う。",
      "",
    );
  }

  lines.push("| # | 類 | 出典 | 正典（docs/north-star.md）に在るか |", "|---|---|---|---|");
  for (const row of registryReport.rows) {
    const presence = canonError ? "判定不能" : row.foundInCanon ? "在る" : "🔴 見つからない";
    lines.push(
      `| ${row.entry.item} | ${classLabel(row.entry.class)} | ${row.entry.source} | ${presence} |`,
    );
  }

  if (!canonError) {
    if (registryReport.unassignedCanonStatements.length > 0) {
      lines.push(
        "",
        "### 未割り当て（正典に在るが、登録簿のどの行の文面とも一致しない）",
        "",
        "**推測で類を埋めない**（AGENTS.md）。以下の文面は登録簿に対応する行が無い:",
        "",
        ...registryReport.unassignedCanonStatements.map((statement) => `- 「${statement}」`),
      );
    }
    if (registryReport.registryEntriesMissingFromCanon.length > 0) {
      lines.push(
        "",
        "### 登録簿にあるが、正典の現在の文面には見つからない",
        "",
        "文面が変わった可能性がある。**類の割り当てはオーナー専権**（ADR 0216 決定1）——",
        "この一覧はそのまま動かさず、次の項目を報告するだけである:",
        "",
        ...registryReport.registryEntriesMissingFromCanon.map(
          (entry) => `- 項目${entry.item}（登録簿の文面: 「${entry.excerpt}」）`,
        ),
      );
    }
  }

  return lines.join("\n");
}

/**
 * 確認できた行(`foundInCanon`)だけ文面を出す。確認できていない項目に推測で文面を添えない。
 *
 * @param {ItemResult[]} itemResults
 * @param {RegistryReport} registryReport
 */
function buildObservationsSection(itemResults, registryReport) {
  const rowByItem = new Map(registryReport.rows.map((row) => [row.entry.item, row]));
  const lines = ["## 観測（甲・乙は実行、丙は機械に載せない）", ""];
  for (const result of itemResults) {
    const modeLabel =
      result.mode === "not-measured"
        ? "（機械に載せない）"
        : result.mode === "print-failed"
          ? "🔴（印字に失敗した）"
          : "";
    const row = rowByItem.get(result.item);
    const heading =
      row && row.foundInCanon
        ? `### 項目${result.item}「${row.entry.excerpt}」 ${modeLabel}`
        : `### 項目${result.item} ${modeLabel}`;
    lines.push(heading.trimEnd(), "", result.fact, "");
  }
  return lines.join("\n").trimEnd();
}

/** @param {Map<string, AdopterSuppliedCounts>} tally */
function buildAdopterSuppliedSection(tally) {
  const lines = [
    "## ADOPTER-SUPPLIED の集計（ADR 0216 決定4-2）",
    "",
    "probe の中で採用者役として供給した定数の印を、件数と種別だけ数える。**判定はしない**" +
      "——判定の印が1件でも付いた項目は、その項目が「半分」である候補として人へ上がる" +
      "（ADR 0216 決定4-2）。この段では判定の印は無い（項目3・4を機械に載せていないため、" +
      "候補6「供給物の種類」自体を機械では評価していない）。",
    "",
  ];
  if (tally.size === 0) {
    lines.push("（印が1件も見つからなかった）");
    return lines.join("\n");
  }
  lines.push("| 項目 | 配線 | データ | 判定 |", "|---|---|---|---|");
  for (const [itemId, counts] of [...tally.entries()].sort()) {
    lines.push(`| ${itemId} | ${counts.配線} | ${counts.データ} | ${counts.判定} |`);
  }
  return lines.join("\n");
}

/**
 * @param {{
 *   stage: { label: string, scopeNote: string },
 *   registryReport: RegistryReport,
 *   canonError: string | null,
 *   itemResults: ItemResult[],
 *   adopterSuppliedTally: Map<string, AdopterSuppliedCounts>,
 *   generatedAt: string,
 *   extraSections?: string[],
 *   extraCaveats?: string[],
 * }} input
 */
export function buildSummaryMarkdown({
  stage,
  registryReport,
  canonError,
  itemResults,
  adopterSuppliedTally,
  generatedAt,
  extraSections = [],
  extraCaveats = [],
}) {
  const lines = [
    `# 北極星7項目・既定差分の一覧（${stage.label}、Issue #387 / ADR 0216）`,
    "",
    stage.scopeNote,
    "",
    "⛔ **これは判定ではない。** 7項目の充足判定は `docs/north-star-paths.md` が持つ" +
      "（ADR 0216 決定8。当初の `docs/roadmap.md` §7 は #762 で削除した）。" +
      "以下は「差が出た/出なかった/観測に失敗した」という事実だけを書く" +
      "——「満たす/満たさない/半分」とは書かない。件数（在る◯／半分◯）もここには焼き込まない" +
      "——それは `docs/north-star-paths.md` の唯一の出所を指すべき数である。",
    "",
    "⛔ **門ではない。常に exit 0。** 個々の観測が失敗しても、このスクリプト自体は失敗を" +
      "報告として出すだけで、CI を落とさない。",
    "",
    "🔴 **`packages/postgres` は1バイトも測らない**（ADR 0216 決定6）。ここで使っているのは" +
      "`@mnemora/testkit/fixtures` の in-memory プレースホルダであり、本物の Postgres / " +
      "pgvector の適合テスト（`postgres` ジョブ）の代わりにはならない。",
    "",
    `生成時刻（実時間、probe 内部で使う注入済み Clock とは別）: ${generatedAt}`,
    "",
    buildRegistrySection(registryReport, canonError),
    "",
    buildObservationsSection(itemResults, registryReport),
    "",
    buildAdopterSuppliedSection(adopterSuppliedTally),
    ...(extraSections.length > 0 ? ["", ...extraSections] : []),
    "",
    "## このスクリプトが確かめていないこと",
    "",
    "- 実時間ではなく、注入した `Clock` を進めて観測している（ADR 0216 測定4「実時間を待つ" +
      "形にしない」）。実際の壁時計での挙動そのものは確認していない。",
    "- 項目2・5・7 の一部は、`VectorStore.upsert` で決定的にベクトルを上書きして再現性を" +
      "作っている（`DeterministicEmbeddingProvider` 自体のハッシュ挙動には依存しない）。" +
      "これは probe 側の試験用の配線であり、ADOPTER-SUPPLIED の集計対象ではない。",
    "- 項目3・4は実行していない（ADR 0216 決定4）。人手の監査は `docs/roadmap.md` §7.4 の" +
      "表が持つ（⚠ 同§は 2026-09-29 に削除（#762）。当時の表は 635c93d の版、現在形は" +
      " `docs/north-star-paths.md`）。",
    "- 項目6は `result.omitted` が空でないことだけを見ている。`Omission.kind`（11種の" +
      "union）の型網羅は実行時には測れないため、この段では測らない。",
    "- テナントは項目ごとに1つずつ（複数テナント分離は見ていない）。`packages/postgres` の" +
      "適合テスト・2テナント分離の検査はこの probe の範囲外。",
    "- `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` は使っていない" +
      "——`DeterministicLLMProvider` / `DeterministicEmbeddingProvider` による配線・契約の" +
      "検査であり、想起の質については何も言わない（AGENTS.md「provider は4層ある」）。",
    ...extraCaveats.map((caveat) => `- ${caveat}`),
  ];
  return lines.join("\n");
}

/**
 * ⛔ 常に exit 0 で終えるための最後の砦。この関数は決して throw しない。
 *
 * @param {unknown} error
 */
export function buildFatalFallbackMarkdown(error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return [
    "# 北極星7項目・既定差分の一覧（段1、Issue #387 / ADR 0216）",
    "",
    "🔴 **印字に失敗した（トップレベル）。** このスクリプトは門ではないため、この失敗で",
    "CI を落とさない——`continue-on-error: true` に加えて、ここでも exit 0 を返す。",
    "",
    "```",
    message,
    "```",
  ].join("\n");
}
