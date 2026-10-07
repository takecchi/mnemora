/**
 * ⚠ 索引の更新は、ADR を追加する PR の側で `node scripts/generate-adr-index.mjs` を実行して索引も一緒にコミットする。
 * ADR 0137 の当初の文面(README を触らない)とは違う。
 *
 * ⛔ ファイル名の番号と見出しの番号が食い違ったら、黙って片方を信じず生成を失敗させる。
 * マーカーが無い・2組以上あるときも、間違った場所へ書くより原因を名指しして落とす。
 *
 * 状態欄の見出し語は、ハードコードした語彙リストを持たず、先頭の空白・丸括弧の手前までを抜き出す。
 */

export const ADR_FILENAME_RE = /^(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/;

/**
 * ⚠ ここに足すときは README の手引きも直すこと。
 */
export const ALLOWED_NON_ADR_MARKDOWN = ["README.md", "TEMPLATE.md"];

/**
 * @param {string[]} filenames
 * @returns {string[]}
 */
export function findMalformedAdrFilenames(filenames) {
  return filenames.filter(
    (name) =>
      /\.md$/i.test(name) && !isAdrFilename(name) && !ALLOWED_NON_ADR_MARKDOWN.includes(name),
  );
}

/** @param {string[]} filenames */
export function assertWellFormedAdrFilenames(filenames) {
  const malformed = findMalformedAdrFilenames(filenames);
  if (malformed.length > 0) {
    throw new Error(
      `ADR のファイル名の形から外れています（\`NNNN-slug.md\`。slug は小文字の英数字とハイフンだけで、ドットは使えません。ADR ではない \`.md\` は ${ALLOWED_NON_ADR_MARKDOWN.join("・")} だけ）: ${malformed.join(", ")}`,
    );
  }
}

const TITLE_HEADING_RE = /^# ADR (\d{4}): (.+)\r?$/;

const STATE_LINE_RE = /^- \**状態\**:\s*(.+?)\s*$/m;

const DATE_LINE_RE = /^- \**日付\**:\s*(.+?)\s*$/m;

const STATE_KEYWORD_RE = /^\**([^\s(（]+)/;

const INLINE_DATE_RE = /^\**[^\s(（]+\s*[(（](\d{4}-\d{2})/;

const DATE_VALUE_RE = /^(\d{4}-\d{2})/;

export const GENERATED_START_MARKER = "<!-- ADR-INDEX:GENERATED:START -->";
export const GENERATED_END_MARKER = "<!-- ADR-INDEX:GENERATED:END -->";

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isAdrFilename(filename) {
  return ADR_FILENAME_RE.test(filename);
}

/**
 * @param {string} stateText
 * @param {string | undefined} dateLineText
 * @returns {string}
 */
export function formatStateCell(stateText, dateLineText) {
  const keywordMatch = STATE_KEYWORD_RE.exec(stateText);
  const keyword = keywordMatch ? keywordMatch[1] : stateText.trim();

  const inlineDateMatch = INLINE_DATE_RE.exec(stateText);
  let date = inlineDateMatch ? inlineDateMatch[1] : null;

  if (date === null && dateLineText !== undefined) {
    const dateValueMatch = DATE_VALUE_RE.exec(dateLineText.trim());
    if (dateValueMatch) date = dateValueMatch[1];
  }

  const label = date ? `${keyword} (${date})` : keyword;
  return keyword === "採用" ? label : `**${label}**`;
}

/**
 * 壊れた入力は、黙ってそれらしい値を返さず例外を投げる。
 *
 * @param {string} filename
 * @param {string} content
 * @returns {{ number: string, filename: string, title: string, stateCell: string }}
 */
export function parseAdrEntry(filename, content) {
  const filenameMatch = ADR_FILENAME_RE.exec(filename);
  if (!filenameMatch) {
    throw new Error(`ADR ファイル名の形にマッチしません: ${filename}`);
  }
  const numberFromFilename = filenameMatch[1];

  const firstLine = content.split("\n", 1)[0] ?? "";
  const titleMatch = TITLE_HEADING_RE.exec(firstLine);
  if (!titleMatch) {
    throw new Error(
      `${filename}: 1行目が "# ADR NNNN: <題>" の形ではありません（見出し: ${JSON.stringify(firstLine)}）`,
    );
  }
  const [, numberFromHeading, title] = titleMatch;
  if (numberFromHeading !== numberFromFilename) {
    throw new Error(
      `${filename}: ファイル名の番号（${numberFromFilename}）と見出しの番号（${numberFromHeading}）が食い違っています`,
    );
  }

  const stateMatch = STATE_LINE_RE.exec(content);
  if (!stateMatch) {
    throw new Error(`${filename}: "- **状態**: ..." 行が見つかりません`);
  }
  const dateMatch = DATE_LINE_RE.exec(content);

  const stateCell = formatStateCell(stateMatch[1], dateMatch ? dateMatch[1] : undefined);

  return {
    number: numberFromFilename,
    filename,
    title: title.replaceAll("|", "\\|"),
    stateCell,
  };
}

/**
 * ADR らしくない名前(README・テンプレート等)は黙って無視する。
 * 同じ4桁番号が2本以上あれば例外にする。番号の取り合いは着地した時点で確定するため、生成のたびに検査する。
 *
 * @param {{ filename: string, content: string }[]} files
 * @returns {ReturnType<typeof parseAdrEntry>[]}
 */
export function buildAdrEntries(files) {
  assertWellFormedAdrFilenames(files.map((f) => f.filename));
  const entries = files
    .filter((f) => isAdrFilename(f.filename))
    .map((f) => parseAdrEntry(f.filename, f.content))
    .sort((a, b) => a.number.localeCompare(b.number));

  const filenamesByNumber = new Map();
  for (const entry of entries) {
    const filenames = filenamesByNumber.get(entry.number) ?? [];
    filenames.push(entry.filename);
    filenamesByNumber.set(entry.number, filenames);
  }
  for (const [number, filenames] of filenamesByNumber) {
    if (filenames.length > 1) {
      throw new Error(
        `ADR 番号 ${number} を複数のファイルが名乗っています: ${filenames.join(", ")}`,
      );
    }
  }

  return entries;
}

/**
 * ⛔ 列の桁揃え(padding)をしない。揃えると1行足すたびに全行の空白量が変わり、衝突面が増える。
 *
 * @param {ReturnType<typeof parseAdrEntry>[]} entries
 * @returns {string}
 */
export function buildIndexTable(entries) {
  const lines = ["| 番号 | 題 | 状態 |", "| --- | --- | --- |"];
  for (const entry of entries) {
    lines.push(`| [${entry.number}](./${entry.filename}) | ${entry.title} | ${entry.stateCell} |`);
  }
  return lines.join("\n");
}

/**
 * @param {string} readmeText
 * @returns {{ startIndex: number, endIndex: number }}
 */
function locateMarkers(readmeText) {
  const startIndex = readmeText.indexOf(GENERATED_START_MARKER);
  const endIndex = readmeText.indexOf(GENERATED_END_MARKER);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `docs/decisions/README.md に ${GENERATED_START_MARKER} / ${GENERATED_END_MARKER} のマーカーが見つかりません`,
    );
  }
  if (
    readmeText.indexOf(GENERATED_START_MARKER, startIndex + 1) !== -1 ||
    readmeText.indexOf(GENERATED_END_MARKER, endIndex + 1) !== -1
  ) {
    throw new Error("docs/decisions/README.md のマーカーが2組以上あります");
  }
  if (endIndex < startIndex) {
    throw new Error("docs/decisions/README.md の END マーカーが START より前にあります");
  }
  return { startIndex, endIndex };
}

/**
 * @param {string} readmeText
 * @param {string} tableMarkdown
 * @returns {string}
 */
export function spliceGeneratedIndex(readmeText, tableMarkdown) {
  const { startIndex, endIndex } = locateMarkers(readmeText);
  const before = readmeText.slice(0, startIndex + GENERATED_START_MARKER.length);
  const after = readmeText.slice(endIndex);
  return `${before}\n\n${tableMarkdown}\n\n${after}`;
}

/**
 * @param {string} readmeText
 * @returns {string}
 */
export function extractGeneratedIndex(readmeText) {
  const { startIndex, endIndex } = locateMarkers(readmeText);
  return readmeText.slice(startIndex + GENERATED_START_MARKER.length, endIndex).trim();
}

/**
 * @param {string} tableMarkdown
 * @returns {string[]}
 */
export function extractIndexedNumbers(tableMarkdown) {
  return [...tableMarkdown.matchAll(/^\|\s*\[(\d{4})\]/gm)].map((m) => m[1]);
}
