/**
 * `lexical-tie-density` ベンチ（`src/bench/lexical-tie-density-bench.ts`）の純関数部分。
 *
 * Issue #394 が「次に測るべきこと」の1番として名指しした「`retrieval` ベンチの語彙
 * チャンネル構成（[ADR 0148](../../../docs/decisions/0148-bench-lexical-channel-selectable-default-unchanged.md)）
 * で、返ってきた候補のタイ密度を数える」を実装する。
 *
 * ⛔ **これは測定であり、判定ではない。** どの数字が出ても exit code は変えない
 * （`embedding-fingerprint`/`scale-bench` と同じ規律）。
 *
 * DB 接続を要する部分（`../bench/lexical-tie-density-bench.ts`）から、タイの数え上げ
 * ロジックだけを切り出してある——DB 無しで歯を書けるようにするため
 * （`retrieval-quality.ts` の `parseBenchChannels` と同じ切り出しの理由）。
 */

/** `buildLexicalSearchSelect` が返す1行（`@mnemora/postgres` の `LexicalHit` と同じ形）。 */
export interface LexicalCandidateRow {
  memoryId: string;
  coverage: number;
  rank: number;
}

/**
 * `coverage`/`rank` が完全一致する連続行のまとまり。
 *
 * **前提**: `rows` は `buildLexicalSearchSelect` の `ORDER BY coverage DESC, rank DESC, ...`
 * と同じ順序で渡されること（`recorded_at`/`id` はタイの判定に使わない——Issue #394
 * 本文が問うているのは「`coverage`/`rank` に分解能があるか」であり、その先の
 * tie-break 列は ADR 0175 が既に決定的にしている）。
 */
export interface TieGroup {
  coverage: number;
  rank: number;
  /** 同じ (coverage, rank) を持つ行数。 */
  count: number;
  /** `rows` の中での開始位置（0始まり、両端含む）。 */
  startIndex: number;
  endIndex: number;
}

/**
 * 連続する同値行をグループ化する。`rows` が事前にソートされていることを前提とする
 * （このファイルはソートしない——ソートは SQL の `ORDER BY` の責務であり、ここで
 * 独自にソートし直すと `ORDER BY` の実装とこの集計がずれたときに気づけなくなる）。
 */
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

/** 1クエリ分の測定結果。 */
export interface TieDensityMeasurement {
  queryLabel: string;
  query: string;
  /** この測定で境界として使った LIMIT（`buildLexicalTieDensityQueries` 呼び出し側が決める）。 */
  limit: number;
  /** `rows` の総数（`buildLexicalSearchSelect` に渡した `opts.limit` が実際の母集団より
   * 大きければ、これがそのままクエリにヒットした全行数になる——呼び出し側が
   * 「母集団を切り詰めない大きな limit」で SQL を実行する責務を負う）。 */
  totalCandidates: number;
  tieGroups: TieGroup[];
  /** `limit` の境界（0始まりで index `limit - 1`）を含むタイ集団。無ければ `undefined`
   * （`totalCandidates <= limit` で LIMIT が母集団を切り詰めていない場合）。 */
  boundaryGroup: TieGroup | undefined;
  /**
   * `boundaryGroup` が `limit` の境界をまたいで存在する（＝タイ集団の**途中**で
   * LIMIT が切っている）かどうか。Issue #394 が問うている現象そのもの——
   * 「同点の母集団が LIMIT を超える」がここで `true` になる。
   */
  truncatedWithinTie: boolean;
}

/**
 * `rows`（`ORDER BY coverage DESC, rank DESC` 順、母集団を切り詰めない大きな limit で
 * 取得したもの）から、`limit` 件に切ったときのタイの状態を計算する。
 *
 * **`rows` そのものは切り詰めない**——呼び出し側が本番の `LIMIT`（`limit` 引数）より
 * 十分大きい `opts.limit` で SQL を実行し、母集団全体をこの関数に渡すこと。
 * そうしないと「LIMIT の外にどれだけタイが続いているか」が測れない
 * （Issue #394 本文の「400件のタイから50件を選んでいる」の「400」に当たる数を失う）。
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

/** 複数クエリの測定結果を、人間が読む Markdown 表にする。⛔ 判定を含めない（数字だけ）。 */
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
