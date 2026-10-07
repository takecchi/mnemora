/**
 * ⛔ 性能の絶対値が良いか悪いかは判定しない。縛るのは、実体から機械的に数え直せるもの
 * （本数・件数・群数）だけ。
 */

/** @typedef {{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrr: number }} BaselineGroupSummary */
/** @typedef {{ group: string, probeCount: number, hit1: number, hit1Total: number, hit10: number, hit10Total: number, mrr: number }} ReadmeResultRow */

/**
 * @param {string} readmeText
 * @returns {string} 見出しが見つからなければ空文字列
 */
export function extractIdentifierProbesSection(readmeText) {
  const headingIndex = readmeText.search(/^## `identifier-probes`:/m);
  if (headingIndex === -1) {
    return "";
  }
  const afterHeading = readmeText.slice(headingIndex);
  const nextTopHeading = afterHeading.slice(1).search(/^## `/m);
  return nextTopHeading === -1 ? afterHeading : afterHeading.slice(0, nextTopHeading + 1);
}

/**
 * @param {string} readmeText
 * @returns {number | null} 見つからなければ null
 */
export function extractGroupCountClaim(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const match = section.match(/###\s*(\d+)群を別々に集計する/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

/**
 * @param {string} readmeText
 * @returns {string[]}
 */
export function extractGroupOverviewTableNames(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const headingIndex = section.search(/###\s*\d+群を別々に集計する/);
  if (headingIndex === -1) {
    return [];
  }
  const afterHeading = section.slice(headingIndex);
  const tableEnd = afterHeading.search(/\n###\s/);
  const tableSection = tableEnd === -1 ? afterHeading : afterHeading.slice(0, tableEnd);
  const names = [];
  for (const line of tableSection.split("\n")) {
    const rowMatch = line.match(/^\|\s*`([a-zA-Z]+)`\s*\|/);
    if (rowMatch) {
      names.push(rowMatch[1]);
    }
  }
  return names;
}

/**
 * ⚠ README には「実測結果」見出しの節が他にも在る。まず `identifier-probes` 節だけに絞ってから探す。
 *
 * @param {string} readmeText
 * @returns {ReadmeResultRow[]}
 */
export function extractResultsTable(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const headingIndex = section.search(/###\s*実測結果/);
  if (headingIndex === -1) {
    return [];
  }
  const afterHeading = section.slice(headingIndex);
  const tableEnd = afterHeading.search(/\n###\s/);
  const tableSection = tableEnd === -1 ? afterHeading : afterHeading.slice(0, tableEnd);
  const rowPattern =
    /^\|\s*(?:🔴\s*)?`([a-zA-Z]+)`\((\d+)件\)\s*\|[^|]*\|[^|]*\|\s*\*\*([\d.]+)\*\*\s*\|\s*(\d+)\/(\d+)\s*\|\s*(\d+)\/(\d+)\s*\|/;
  /** @type {ReadmeResultRow[]} */
  const rows = [];
  for (const line of tableSection.split("\n")) {
    const match = line.match(rowPattern);
    if (!match) {
      continue;
    }
    const [, group, probeCountStr, mrrStr, hit1Str, hit1TotalStr, hit10Str, hit10TotalStr] = match;
    rows.push({
      group,
      probeCount: Number(probeCountStr),
      mrr: Number(mrrStr),
      hit1: Number(hit1Str),
      hit1Total: Number(hit1TotalStr),
      hit10: Number(hit10Str),
      hit10Total: Number(hit10TotalStr),
    });
  }
  return rows;
}

/**
 * @param {{ groups: Array<{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrrOverall: number }> }} baseline
 * @returns {BaselineGroupSummary[]}
 */
export function extractBaselineSummary(baseline) {
  return baseline.groups.map((g) => ({
    group: g.group,
    probeCount: g.probeCount,
    hit1Count: g.hit1Count,
    hit10Count: g.hit10Count,
    mrr: g.mrrOverall,
  }));
}

/**
 * @param {number} value
 * @returns {number}
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {string} readmeText
 * @param {{ groups: Array<{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrrOverall: number }> }} baseline
 * @returns {string[]}
 */
export function checkReadmeMatchesBaseline(readmeText, baseline) {
  /** @type {string[]} */
  const problems = [];
  const baselineGroups = extractBaselineSummary(baseline);
  const baselineGroupCount = baselineGroups.length;

  const claimedCount = extractGroupCountClaim(readmeText);
  if (claimedCount === null) {
    problems.push("見出し「N群を別々に集計する」が見つからない");
  } else if (claimedCount !== baselineGroupCount) {
    problems.push(
      `見出しは「${claimedCount}群」と書いているが、基準値には${baselineGroupCount}群ある`,
    );
  }

  const overviewNames = extractGroupOverviewTableNames(readmeText);
  const baselineNames = baselineGroups.map((g) => g.group);
  for (const name of baselineNames) {
    if (!overviewNames.includes(name)) {
      problems.push(`群一覧表に基準値の群「${name}」が無い`);
    }
  }
  for (const name of overviewNames) {
    if (!baselineNames.includes(name)) {
      problems.push(`群一覧表に基準値に無い群「${name}」がある`);
    }
  }

  const resultRows = extractResultsTable(readmeText);
  const resultRowsByGroup = new Map(resultRows.map((r) => [r.group, r]));
  for (const baselineGroup of baselineGroups) {
    const row = resultRowsByGroup.get(baselineGroup.group);
    if (!row) {
      problems.push(`実測結果の表に基準値の群「${baselineGroup.group}」の行が無い`);
      continue;
    }
    if (row.probeCount !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: probe件数がREADME=${row.probeCount}件、基準値=${baselineGroup.probeCount}件`,
      );
    }
    if (row.hit1 !== baselineGroup.hit1Count || row.hit1Total !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: hit@1がREADME=${row.hit1}/${row.hit1Total}、` +
          `基準値=${baselineGroup.hit1Count}/${baselineGroup.probeCount}`,
      );
    }
    if (row.hit10 !== baselineGroup.hit10Count || row.hit10Total !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: hit@10がREADME=${row.hit10}/${row.hit10Total}、` +
          `基準値=${baselineGroup.hit10Count}/${baselineGroup.probeCount}`,
      );
    }
    if (row.mrr !== round3(baselineGroup.mrr)) {
      problems.push(
        `${baselineGroup.group}: MRRがREADME=${row.mrr}、基準値=${round3(baselineGroup.mrr)}（丸め後）`,
      );
    }
  }
  for (const row of resultRows) {
    if (!baselineNames.includes(row.group)) {
      problems.push(`実測結果の表に基準値に無い群「${row.group}」の行がある`);
    }
  }

  return problems;
}
