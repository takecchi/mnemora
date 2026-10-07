/**
 * `consolidation-cost` サブコマンドが、統合の対象をどう群へ分けるかを決める純関数だけを置く。
 * DB にも LLM にも触れない部分を切り出し、契約を歯で固定する。
 */

export interface ConsolidationGroups {
  groups: string[][];
  /**
   * 末尾に残った、群にできなかった id（0件または1件）。この round では統合しない。
   * 1件を1件に「統合」しないのは `runtime.consolidate()` 自身の規律と同じ。次の round の候補プールへ持ち越す。
   */
  leftover: string[];
}

/**
 * `ids` を先頭から `groupSize` 件ずつの連続した群へ切る。
 *
 * `groupSize` 未満の最終群は群として扱わず `leftover` に回す。並べ替えない。
 * `ids` は呼び出し側が既に id の安定した順で渡している前提。
 *
 * @throws {Error} `groupSize` が2未満のとき。1件の群は定義上「群」ではない。
 */
export function splitIntoConsolidationGroups(
  ids: readonly string[],
  groupSize: number,
): ConsolidationGroups {
  if (!Number.isInteger(groupSize) || groupSize < 2) {
    throw new Error(
      `splitIntoConsolidationGroups: groupSize は2以上の整数である必要がある(実際: ${groupSize})`,
    );
  }
  const groups: string[][] = [];
  let i = 0;
  while (i < ids.length) {
    const chunk = ids.slice(i, i + groupSize);
    i += groupSize;
    if (chunk.length < 2) {
      return { groups, leftover: chunk };
    }
    groups.push(chunk);
  }
  return { groups, leftover: [] };
}
