/**
 * `scripts/north-star-default-probe.mjs`（Issue #387 / ADR 0216 決定7「段1: 一覧を印字
 * するだけ」）の純関数の側。ファイル I/O・`Runtime` の構築・`process.exit` を一切持たない
 * ——`identifier-probe-summary-lib.mjs`/`association-summary-lib.mjs` と同じ分担。
 *
 * ## このファイルが持つ3つの役目
 *
 * 1. **登録簿**（`NORTH_STAR_ITEM_REGISTRY`）—— 北極星「目指す姿」7項目それぞれの
 *    「類（甲/乙/丙）」と「出典」。**類の割り当ては [ADR 0216](../docs/decisions/0216-north-star-shipped-only-measurement.md)
 *    決定1の表をそのまま写した**（甲: 1・2・5・6 / 乙: 7 / 丙: 3・4）。この場で新しい
 *    割り当てを決めない——「正典と実装が食い違ったら、バグなのは実装のほう」
 *    （`AGENTS.md`）。
 * 2. **登録簿と正典の突き合わせ**（`buildRegistryReport`）—— `docs/north-star.md` の
 *    「## 目指す姿」箇条を実行時に読み、逐語一致で登録簿の行と対応付ける。**文面は
 *    ここに複製しない**（`AGENTS.md`「ここに北極星の要約を置かない」）——登録簿が
 *    持つのは「類」と「出典」だけであり、文面そのものは常に `docs/north-star.md` から
 *    読み直す。正典側に登録簿に無い項目があれば「未割り当て」、登録簿側の項目が正典に
 *    見つからなければ「文面が変わった可能性」として、どちらも推測で埋めずに一覧へ出す。
 * 3. **ADOPTER-SUPPLIED の集計**（`countAdopterSuppliedMarks`）—— ADR 0216 決定4-2
 *    「probe が『出荷物の外から持ち込んだもの』を、コード上の印で明示する規律」の実装。
 *    probe 本体（`north-star-default-probe.mjs`）のソースを渡すと、
 *    `// ADOPTER-SUPPLIED(itemN): 配線|データ|判定` の形式のコメントを数える。
 *    **判定はしない**——件数と種別を数えるだけ。
 *
 * 4. **Markdown の組み立て**（`buildSummaryMarkdown`）—— 上3つと、実際に走らせた観測の
 *    結果（CLI 側が組み立てた `itemResults`）を受け取り、Job Summary 用の Markdown を返す。
 *
 * ⛔ **このファイルは1つも `判定` をしない。** 差が出た/出なかった/観測に失敗した、という
 * 事実だけを文字列として運ぶ。「満たす/満たさない/半分」という語はここにもCLI側にも出さない
 * ——7項目の充足判定は `docs/roadmap.md` が正であり続ける（ADR 0216 決定8）。
 */

// ---------------------------------------------------------------------------
// 1. 登録簿 —— ADR 0216 決定1 の表をそのまま写す
// ---------------------------------------------------------------------------

/**
 * @typedef {{ item: number, excerpt: string, class: "甲" | "乙" | "丙", source: string }} RegistryEntry
 */

/**
 * 北極星「目指す姿」7項目の登録簿。
 *
 * `excerpt` は `docs/north-star.md`「## 目指す姿」の箇条から、太字部分（`**...**`）を
 * **逐語**で写したもの（`extractGoalStatements` が実行時に抽出する形と完全一致する必要が
 * ある——一致しないと「文面が変わった可能性」として出る。これは検出の対象であって
 * バグではない。ADR 0216 決定1「⚠ どの項目がどの類かは、`docs/north-star.md` の文面が
 * 決める。⛔ 実装が決めるのではない」への実装上の対応）。
 *
 * `class` は ADR 0216 決定1の表そのもの:
 * - 甲（既定で起きること）: 1・2・5・6
 * - 乙（使う側が渡せることが充足）: 7
 * - 丙（採用者が外の情報を渡すことを前提にする。機械に載せない）: 3・4
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

// ---------------------------------------------------------------------------
// 2. 正典（docs/north-star.md）からの抽出と、登録簿との突き合わせ
// ---------------------------------------------------------------------------

const GOAL_SECTION_HEADING = "## 目指す姿";

/**
 * `docs/north-star.md` の全文から「## 目指す姿」節の箇条書きを抽出する。
 *
 * **文面はここに複製しない**——呼び出し側が `readFileSync` した内容をそのまま渡す
 * ことを前提にする（`AGENTS.md`「ここに北極星の要約を置かない」）。
 *
 * 箇条は `- **本文**...` の形（`docs/north-star.md` の実際の書式）を前提にし、
 * 最初の `**...**` の中身だけを取り出す（末尾の「——補足」部分は含めない——ADR 0216
 * 決定1の表が引いている逐語もこの部分までである）。
 *
 * 見出しが見つからない、または箇条が1つも取れない場合は `ok: false` を返す
 * （黙って空配列を「一致した」と誤読させないため）。
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
 * 登録簿（`registry`）と、正典から抽出した文面（`canonStatements`）を逐語で突き合わせる。
 *
 * - `rows`: 登録簿の各行 + その文面が正典に実在するか。
 * - `unassignedCanonStatements`: 正典にあるが、登録簿のどの行の `excerpt` とも一致しない
 *   文面。**推測で類を埋めない**——そのまま「未割り当て」として一覧に出すための材料。
 * - `registryEntriesMissingFromCanon`: 登録簿にあるが、いまの正典のどの箇条とも一致しない
 *   行。「文面が変わった可能性がある」ことの材料（類の割り当てはオーナー専権のまま動かさない
 *   ——ADR 0216 決定1）。
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

// ---------------------------------------------------------------------------
// 3. ADOPTER-SUPPLIED の集計（ADR 0216 決定4-2）
// ---------------------------------------------------------------------------

/** `// ADOPTER-SUPPLIED(itemN): 配線|データ|判定` の形式を数える正規表現。 */
const ADOPTER_SUPPLIED_PATTERN = /ADOPTER-SUPPLIED\((item\d+)\):\s*(配線|データ|判定)/g;

/**
 * @typedef {{ 配線: number, データ: number, 判定: number }} AdopterSuppliedCounts
 */

/**
 * probe 本体のソーステキストから `// ADOPTER-SUPPLIED(itemN): 配線|データ|判定` の
 * 印を数える。**判定はしない**——項目ごとの件数と種別だけを返す（ADR 0216 決定4-2）。
 *
 * 印の付いていない実行（項目3・4はそもそも実行しない。ADR 0216 決定4）は、この集計には
 * 現れない——それ自体が「機械に載せていない」ことの表現である。
 *
 * @param {string} sourceText
 * @returns {Map<string, AdopterSuppliedCounts>} item id（`"item1"` 等）→ 種別ごとの件数
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

// ---------------------------------------------------------------------------
// 4. Markdown の組み立て
// ---------------------------------------------------------------------------

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
 * 登録簿セクションの Markdown（表 + 未割り当て/文面相違の警告）。
 *
 * @param {RegistryReport} registryReport
 * @param {string[] | null} canonError `extractGoalStatements` が `ok:false` を返した場合の
 *   理由。`null` なら正典は正常に読めている。
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
 * 観測結果セクションの Markdown。
 *
 * @param {ItemResult[]} itemResults
 * @param {RegistryReport} registryReport 見出しに文面を添えるための参照。**正典に実在が
 *   確認できた行（`foundInCanon`）だけ文面を出す**——確認できていない項目に推測で
 *   文面を添えない。
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

/**
 * ADOPTER-SUPPLIED 集計セクションの Markdown。
 *
 * @param {Map<string, AdopterSuppliedCounts>} tally
 */
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
 * `north-star-default-probe.mjs` の出力全体（Job Summary 向け Markdown）を組み立てる。
 *
 * @param {{
 *   registryReport: RegistryReport,
 *   canonError: string | null,
 *   itemResults: ItemResult[],
 *   adopterSuppliedTally: Map<string, AdopterSuppliedCounts>,
 *   generatedAt: string,
 * }} input
 */
export function buildSummaryMarkdown({
  registryReport,
  canonError,
  itemResults,
  adopterSuppliedTally,
  generatedAt,
}) {
  const lines = [
    "# 北極星7項目・既定差分の一覧（段1、Issue #387 / ADR 0216）",
    "",
    "⚠ **段1: ワークスペース解決で測っている。出荷物（tarball）で測ったとは名乗らない**" +
      "（ADR 0216 決定7）。ワークスペース内から `@mnemora/core` / `@mnemora/testkit` の" +
      "公開入口だけを import して組んだ `Runtime` に対する観測であり、`pnpm pack` で作った" +
      "tarball を install した状態（段2、まだ実装していない）ではない。段1が通っても段2が" +
      "落ちることはありうる。",
    "",
    "⛔ **これは判定ではない。** 7項目の充足判定は `docs/roadmap.md` が正であり続ける" +
      "（ADR 0216 決定8）。以下は「差が出た/出なかった/観測に失敗した」という事実だけを書く" +
      "——「満たす/満たさない/半分」とは書かない。件数（在る◯／半分◯）もここには焼き込まない" +
      "——それは `docs/roadmap.md` の唯一の出所を指すべき数である。",
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
    "",
    "## このスクリプトが確かめていないこと",
    "",
    "- 実時間ではなく、注入した `Clock` を進めて観測している（ADR 0216 測定4「実時間を待つ" +
      "形にしない」）。実際の壁時計での挙動そのものは確認していない。",
    "- 項目2・5・7 の一部は、`VectorStore.upsert` で決定的にベクトルを上書きして再現性を" +
      "作っている（`DeterministicEmbeddingProvider` 自体のハッシュ挙動には依存しない）。" +
      "これは probe 側の試験用の配線であり、ADOPTER-SUPPLIED の集計対象ではない。",
    "- 項目3・4は実行していない（ADR 0216 決定4）。人手の監査は `docs/roadmap.md` §7.4 の" +
      "表が持つ。",
    "- 項目6は `result.omitted` が空でないことだけを見ている。`Omission.kind`（11種の" +
      "union）の型網羅は実行時には測れないため、この段では測らない。",
    "- テナントは項目ごとに1つずつ（複数テナント分離は見ていない）。`packages/postgres` の" +
      "適合テスト・2テナント分離の検査はこの probe の範囲外。",
    "- `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` は使っていない" +
      "——`DeterministicLLMProvider` / `DeterministicEmbeddingProvider` による配線・契約の" +
      "検査であり、想起の質については何も言わない（AGENTS.md「provider は4層ある」）。",
  ];
  return lines.join("\n");
}

/**
 * トップレベル（import 失敗を含む致命的なエラー）で握ったときの、最小限の Markdown。
 * **常に exit 0** で終えるための最後の砦——この関数自体は決して throw しない。
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
