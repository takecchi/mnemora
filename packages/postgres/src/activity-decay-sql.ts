import { sql, type SQL } from "drizzle-orm";

/**
 * 行の `subjectIdExpr` に対応する `tenant_subject_activity.activity_seq`（`S_x`）を相関サブクエリで引く。
 * 行が無い・`subjectIdExpr` が `NULL`（主題なしの記憶）なら `0`。
 *
 * 読む側と書く側（`reinforce`/`reinforceMany`。ADR 0394）が同じ式を使う。引き方が食い違うと、
 * 起点と「いま」が別の subject の値になる。
 */
export function subjectActivitySeqOrZero(tenantIdExpr: SQL, subjectIdExpr: SQL): SQL {
  return sql`COALESCE((
    SELECT sa.activity_seq FROM tenant_subject_activity sa
    WHERE sa.tenant_id = ${tenantIdExpr} AND sa.subject_id = ${subjectIdExpr}
  ), 0)`;
}

/**
 * ADR 0394: 強化される行の活動時計の「いま」= `tenantSeq`（`T`）+ その行自身の subject の `S_x`。
 * `tenantSeq` は SQL の式（単一行の UPDATE では bind 済みの値、`reinforceMany` では VALUES の列）。
 */
export function ownSubjectActivityNow(params: {
  tenantSeq: SQL;
  tenantIdExpr: SQL;
  subjectIdExpr: SQL;
}): SQL {
  return sql`(${params.tenantSeq}::bigint + ${subjectActivitySeqOrZero(params.tenantIdExpr, params.subjectIdExpr)})`;
}

/**
 * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md): 活動時計の忘却ゲート（生存側）述語。
 * `vector-store.ts`（段1）・`memory-store.ts`（`aggregateScope`・`archiveDecayed`）が同じ式をこの1箇所から得る
 * （実装が複数あると食い違うため。ADR 0038）。
 *
 * `usesSubjectCounters` が `false`（既定）のときは `T` のみの比較で、`tenant_subject_activity` を参照しない。
 * `true` のときは `tenantSeq + COALESCE(S_x, 0)` と比較する。主題なしの記憶は `T` のみと比較される。
 *
 * `tenantIdExpr`/`subjectIdExpr` は呼び出し元のテーブルエイリアスに応じて渡す。
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
  const effectiveNow = sql`(${decayFloorSeqAfter} + ${subjectActivitySeqOrZero(tenantIdExpr, subjectIdExpr)})`;
  return sql`(${floorSeqExpr} IS NULL OR ${floorSeqExpr} > ${effectiveNow})`;
}

/**
 * `activityFloorSeqAliveCondition` の否定側。`archiveDecayed`（掃引）が対象を選ぶのに使う。
 * 境界は含む（`<=`）。ゲート側（狭義の `>`）とは非対称で、これは意図（ADR 0165）。
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
  const effectiveNow = sql`(${nowSeq} + ${subjectActivitySeqOrZero(tenantIdExpr, subjectIdExpr)})`;
  return sql`(${floorSeqExpr} IS NOT NULL AND ${floorSeqExpr} <= ${effectiveNow})`;
}
