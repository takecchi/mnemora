/**
 * `lexical-tie-density` ベンチの純関数部分。測定であり判定ではないので、どの数字が出ても exit code は変えない。
 * DB 無しで歯を書けるよう、タイの数え上げだけを DB 接続を要する側から切り出してある。
 */

export interface LexicalCandidateRow {
  memoryId: string;
  coverage: number;
  rank: number;
}

/** `coverage`/`rank` が完全一致する連続行のまとまり。`rows` は `ORDER BY coverage DESC, rank DESC` と同じ順序で渡すこと。 */
export interface TieGroup {
  coverage: number;
  rank: number;
  count: number;
  startIndex: number;
  endIndex: number;
}

/** 連続する同値行をグループ化する。ここでソートしない: 独自にソートし直すと、SQL の `ORDER BY` とこの集計がずれたときに気づけなくなる。 */
export function groupTiesByScore(rows: readonly LexicalCandidateRow[]): TieGroup[] {
  const groups: TieGroup[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.coverage === row.coverage && last.rank === row.rank) {
      last.count += 1;
      last.endIndex = i;
    } else {
      groups.push({ coverage: row.coverage, rank: row.rank, count: 1, startIndex: i, endIndex: i });
    }
  }
  return groups;
}

export interface TieDensityMeasurement {
  queryLabel: string;
  query: string;
  limit: number;
  totalCandidates: number;
  tieGroups: TieGroup[];
  boundaryGroup: TieGroup | undefined;
  truncatedWithinTie: boolean;
}

/**
 * `limit` 件に切ったときのタイの状態を計算する。`rows` は切り詰めない——呼び出し側は本番の `limit` より
 * 十分大きい limit で取得して渡すこと（LIMIT の外にタイがどれだけ続くかが測れなくなる）。
 */
export function measureTieDensityFromRows(
  queryLabel: string,
  query: string,
  limit: number,
  rows: readonly LexicalCandidateRow[],
): TieDensityMeasurement {
  const tieGroups = groupTiesByScore(rows);
  const totalCandidates = rows.length;

  if (totalCandidates <= limit) {
    return {
      queryLabel,
      query,
      limit,
      totalCandidates,
      tieGroups,
      boundaryGroup: undefined,
      truncatedWithinTie: false,
    };
  }

  const boundaryIndex = limit - 1;
  const boundaryGroup = tieGroups.find(
    (g) => g.startIndex <= boundaryIndex && boundaryIndex <= g.endIndex,
  );
  const truncatedWithinTie = boundaryGroup !== undefined && boundaryGroup.endIndex > boundaryIndex;

  return {
    queryLabel,
    query,
    limit,
    totalCandidates,
    tieGroups,
    boundaryGroup,
    truncatedWithinTie,
  };
}

export function renderTieDensityReport(measurements: readonly TieDensityMeasurement[]): string {
  const lines: string[] = [];
  lines.push("| label | query | 総候補数 | タイ集団数 | 最大タイ集団 | LIMIT境界で分断 |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const m of measurements) {
    const maxGroup = m.tieGroups.reduce((max, g) => Math.max(max, g.count), 0);
    const truncated =
      m.totalCandidates <= m.limit
        ? "n/a（LIMIT未到達）"
        : m.truncatedWithinTie
          ? "🔴 はい"
          : "いいえ";
    lines.push(
      `| ${m.queryLabel} | \`${m.query}\` | ${m.totalCandidates} | ${m.tieGroups.length} | ${maxGroup} | ${truncated} |`,
    );
  }
  return lines.join("\n");
}
