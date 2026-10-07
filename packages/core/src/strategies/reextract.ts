import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus } from "../memory.js";
import { isMemoryStatusConflictError } from "../interfaces/memory-store.js";

/**
 * `runtime.reextract` が既存 Memory を supersede しなかった理由（ADR 0029）。`ReextractResult.skipped` の要素型。
 *
 * **件数の欄を持たせない**（`recall.ts` の `StageSkippedOmission` に倣う）。
 *
 * `status_changed_concurrently` の `observedStatus` は `MemoryStatus | null`。`status_not_active` の
 * `status` は `classifyReextractTargets` 自身が読んだ値なので `"active"` を除いた型で閉じられるが、
 * こちらは adapter が競合を検知した**後**に読み直した値（`MemoryStatusConflictError.observedStatus`）で、
 * 読み直した時点で対象行が消えている可能性を型として排除できないため `null` を許す。
 */
export type ReextractSkip =
  | { kind: "status_not_active"; memoryId: MemoryId; status: Exclude<MemoryStatus, "active"> }
  | { kind: "unchanged"; memoryId: MemoryId }
  | { kind: "not_examined"; reason: "llm_failed_whole_observation" | "no_candidates" }
  | {
      kind: "status_changed_concurrently";
      memoryId: MemoryId;
      observedStatus: MemoryStatus | null;
    };

/**
 * `updateStatus` に投げられた例外が `MemoryStatusConflictError`（`expectedStatus: "active"` の CAS が破れた）
 * なら `ReextractSkip` を返す純関数（ADR 0030）。呼び出し側（`runtime.ts`）は `skipped` に積み、
 * `supersededMemoryIds` には入れず、`superseded` イベントも積まない。
 *
 * **それ以外の例外（DB 接続断・想定外のバグ等）には必ず `null` を返す。**呼び出し側はそれをそのまま
 * 再送出する。競合でない例外を skip に化けさせて飲み込むと、無関係な例外の握り潰しという別の穴を開ける。
 */
export function classifySupersedeFailure(memoryId: MemoryId, error: unknown): ReextractSkip | null {
  if (isMemoryStatusConflictError(error)) {
    return {
      kind: "status_changed_concurrently",
      memoryId,
      observedStatus: error.observedStatus,
    };
  }
  return null;
}

/**
 * `reextract` の supersede 判定そのものを純関数として切り出したもの（ADR 0029）。I/O は呼び出し側の責務。
 *
 * `existing` は「今回作る前」に読んだ既存 Memory の一覧（`MemoryStore.listBySourceObservation`）。
 * `contentHashes` は今回の抽出で作られた（または冪等に既存だった）Memory の content_hash の集合。
 */
export function classifyReextractTargets(
  existing: Memory[],
  contentHashes: ReadonlySet<string>,
): { toSupersede: Memory[]; skipped: ReextractSkip[] } {
  const toSupersede: Memory[] = [];
  const skipped: ReextractSkip[] = [];
  for (const memory of existing) {
    if (memory.status !== "active") {
      // forgotten は絶対に触らず、contested も対象外（ADR 0028）。飛ばしたことは status 付きで必ず出す（ADR 0029）。
      skipped.push({ kind: "status_not_active", memoryId: memory.id, status: memory.status });
      continue;
    }
    if (contentHashes.has(memory.contentHash)) {
      skipped.push({ kind: "unchanged", memoryId: memory.id });
      continue;
    }
    toSupersede.push(memory);
  }
  return { toSupersede, skipped };
}
