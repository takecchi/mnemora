import { sql, type SQL } from "drizzle-orm";

/**
 * [ADR 0348](../../../docs/decisions/0348-activity-counting-per-call.md)
 * （Issue #338）: 活動時計の忘却ゲート（生存側）述語を組み立てる共通ヘルパー。
 * `packages/postgres/src/vector-store.ts`（段1）・`memory-store.ts`（`aggregateScope`・
 * `archiveDecayed`）の3箇所が、この関数を通して同じ式を書く——`ADR 0038`「実装が2つ
 * あると食い違う」を避けるための1箇所である。
 *
 * `usesSubjectCounters` が `false`（既定）のときは、**今日どおり `T` のみの単一
 * パラメータ比較**（`decayFloorSeq IS NULL OR decayFloorSeq > tenantSeq`）——
 * `tenant_subject_activity` を一切参照しない。EXPLAIN のプラン族は本 ADR 以前と
 * 1バイトも変わらない。
 *
 * `true` のときは、行の `subjectIdExpr` に対応する `tenant_subject_activity.
 * activity_seq`（`S_x`）を相関サブクエリで引き、`tenantSeq + COALESCE(S_x, 0)` と
 * 比較する。`subjectIdExpr` が `NULL`（主題なしの記憶）の行は、相関サブクエリが
 * 0件になり `COALESCE(..., 0)` で `0` になる——結果として `tenantSeq` のみと比較
 * される（ADR 0348「読み取りは常に T + S_x（subjectId が無い記憶は T のみ）」）。
 *
 * `tenantIdExpr`/`subjectIdExpr` は呼び出し元のテーブルエイリアスに応じて渡す
 * （段1は `m.tenant_id`/`m.subject_id`、`aggregateScope`/`archiveDecayed` は
 * エイリアス無しの `tenant_id`/`subject_id`）。
 */
export function activityFloorSeqAliveCondition(params: {
  decayFloorSeqAfter: number | undefined;
  usesSubjectCounters: boolean;
  floorSeqExpr: SQL;
  tenantIdExpr: SQL;
  subjectIdExpr: SQL;
}): SQL | undefined {
  const { decayFloorSeqAfter, usesSubjectCounters, floorSeqExpr, tenantIdExpr, subjectIdExpr } =
    params;
  if (decayFloorSeqAfter === undefined) {
    return undefined;
  }
  if (!usesSubjectCounters) {
    return sql`(${floorSeqExpr} IS NULL OR ${floorSeqExpr} > ${decayFloorSeqAfter})`;
  }
  const effectiveNow = sql`(${decayFloorSeqAfter} + COALESCE((
    SELECT sa.activity_seq FROM tenant_subject_activity sa
    WHERE sa.tenant_id = ${tenantIdExpr} AND sa.subject_id = ${subjectIdExpr}
  ), 0))`;
  return sql`(${floorSeqExpr} IS NULL OR ${floorSeqExpr} > ${effectiveNow})`;
}

/**
 * [ADR 0348](../../../docs/decisions/0348-activity-counting-per-call.md)
 * （Issue #338）: `activityFloorSeqAliveCondition` の否定側——`MemoryStore.
 * archiveDecayed`（掃引）が対象を選ぶときに使う。**境界は含む（`<=`）**——ゲート側
 * （狭義の `>`）とは非対称であり、これは ADR 0165 決めたこと14 が既に意図した
 * ものをそのまま subject 単位のカウンタにも写す。
 */
export function activityFloorSeqDeadCondition(params: {
  nowSeq: number;
  usesSubjectCounters: boolean;
  floorSeqExpr: SQL;
  tenantIdExpr: SQL;
  subjectIdExpr: SQL;
}): SQL {
  const { nowSeq, usesSubjectCounters, floorSeqExpr, tenantIdExpr, subjectIdExpr } = params;
  if (!usesSubjectCounters) {
    return sql`(${floorSeqExpr} IS NOT NULL AND ${floorSeqExpr} <= ${nowSeq})`;
  }
  const effectiveNow = sql`(${nowSeq} + COALESCE((
    SELECT sa.activity_seq FROM tenant_subject_activity sa
    WHERE sa.tenant_id = ${tenantIdExpr} AND sa.subject_id = ${subjectIdExpr}
  ), 0))`;
  return sql`(${floorSeqExpr} IS NOT NULL AND ${floorSeqExpr} <= ${effectiveNow})`;
}
