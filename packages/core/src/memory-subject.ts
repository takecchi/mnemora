import type { Memory } from "./memory.js";

/**
 * 新しく作る Memory の `subjectId` を決める規則（内部用。`index.ts` からは公開しない）。
 *
 * これらの規則は、`Memory` を組み立てる純関数（`extraction.ts` の `buildNewMemoryFromCandidate`・
 * `strategies/consolidate.ts` の `buildConsolidatedMemory`・`strategies/reflect.ts` の
 * `buildReflectedMemory`）と、その **組み立ての前に** 活動時計の「いま」を Memory 自身の
 * subject の `T + S_x` で解く `runtime.ts`（[ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)）
 * の両方が使う。規則が2箇所にあると食い違い、起点が別の subject の値で書かれるので、1箇所にまとめる。
 */

/**
 * 抽出候補の `subjectId`（Issue #608 項目①）。候補の値を優先し、`undefined`（省略・未指定）の
 * ときだけ observation の値へ落ちる。`null`（明示的な「主題なし」）は observation の値が
 * あってもそのまま通す。どちらも無ければ `null`。
 */
export function resolveCandidateSubjectId(
  candidate: { subjectId?: string | null | undefined },
  observation: { subjectId?: string | null | undefined },
): string | null {
  return candidate.subjectId !== undefined ? candidate.subjectId : (observation.subjectId ?? null);
}

/**
 * consolidate・reflect の結果の `subjectId`: eligible 全件が一致すればその値、割れていれば `null`
 * （`{ memoryIds }` 形・`{ seedMemoryId }` 形とも同じ）。
 */
export function resolveCommonSubjectId(
  eligible: readonly Pick<Memory, "subjectId">[],
): string | null {
  const subjectIds = new Set(eligible.map((m) => m.subjectId ?? null));
  return subjectIds.size === 1 ? [...subjectIds][0]! : null;
}
