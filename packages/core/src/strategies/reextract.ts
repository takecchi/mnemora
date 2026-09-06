import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus } from "../memory.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";

/**
 * `runtime.reextract` が既存 Memory を supersede しなかった理由（ADR 0029）。
 *
 * `runtime.reextract`（`../runtime.js`）の `ReextractResult.skipped` の要素型。ADR 0028 の
 * 「引き受ける負債」——`status !== 'active'` で飛ばしたことがどこにも出ず、`contested` で
 * 飛ばした・`forgotten` で飛ばした・そもそも置き換えるものが無かった、の3つが
 * `supersededMemoryIds: []` という同じ顔になっていた——を解消する。
 *
 * **件数の欄を持たせない**（`count` も `countKind` も無い。`recall.ts` の
 * `StageSkippedOmission` に倣った形。ADR 0029 参照: 「contested が1件か5件か」で
 * 次の一手は変わらない）。
 *
 * PR「update-status-compare-and-swap」（安全弁3、ADR 0030）で `status_changed_concurrently`
 * を追加した: `classifyReextractTargets` が「今回作る前」に読んだ時点では `active` だった
 * Memory でも、実際に `updateStatus` を撃つまでの間（TOCTOU の窓）に他の書き込みで
 * status が変わっていることがある（例: 利用者が同じ Memory を `forgotten` にする）。
 * `status_not_active` の `status: Exclude<MemoryStatus, "active">` と違い、こちらの
 * `observedStatus` は `MemoryStatus | null` である——**この非対称は構造的に保証できない
 * ことの反映**。`status_not_active` は `classifyReextractTargets` 自身が読んだ
 * `Memory.status` をそのまま運ぶので `"active"` を除いた型で閉じられるが、
 * `status_changed_concurrently` は adapter（`packages/postgres`）が競合を検知した**後**に
 * 読み直した値（`MemoryStatusConflictError.observedStatus`）をそのまま運ぶ。読み直した
 * 時点で対象行が消えている可能性は型として排除できない——だから `null` を許す。
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
 * `reextract` が既存 Memory を supersede しようとして `updateStatus` に投げられた例外を
 * 判定する純関数（安全弁3、ADR 0030）。
 *
 * `MemoryStatusConflictError`（`expectedStatus: "active"` の CAS が破れた）を受け取ったら
 * `ReextractSkip` を返す——呼び出し側（`runtime.ts`）はこれを `skipped` に積み、
 * `supersededMemoryIds` には入れず、`superseded` イベントも積まない。
 *
 * **⚠ ここが芯である**: それ以外の例外（DB 接続断・想定外のバグ等）に対しては
 * **必ず `null` を返す**。`null` を受け取った呼び出し側はその例外をそのまま再送出する
 * ——競合でない例外を skip に化けさせて飲み込むと、今まさに塞いでいる「TOCTOU で
 * 安全弁が破れたことが誰にも見えない」という穴を、別の場所（無関係な例外の握り潰し）に
 * 開け直すことになる。
 */
export function classifySupersedeFailure(memoryId: MemoryId, error: unknown): ReextractSkip | null {
  if (error instanceof MemoryStatusConflictError) {
    return {
      kind: "status_changed_concurrently",
      memoryId,
      observedStatus: error.observedStatus,
    };
  }
  return null;
}

/**
 * `reextract` の supersede 判定そのものを純関数として切り出したもの（ADR 0029）。
 *
 * DB を持たないここ（`packages/core`）で手元の値に対して直接変異を撃てるようにする、という
 * リポジトリの「純関数の戦略」（`./decay.ts`・`./scoring.ts`）に倣う。`reextract` 本体は
 * 呼び出し順・supersede される対象・積むイベントの中身を一切変えない——この関数はその
 * 判定部分だけを取り出したものであり、`existing` を渡す前後の I/O は呼び出し側の責務のまま。
 *
 * `existing` は「今回作る前」に読んだ既存 Memory の一覧（呼び出し側が
 * `MemoryStore.listBySourceObservation` で取得したもの）。`contentHashes` は今回の抽出で
 * 実際に作られた（または冪等に既存だった）Memory の content_hash の集合。
 */
export function classifyReextractTargets(
  existing: Memory[],
  contentHashes: ReadonlySet<string>,
): { toSupersede: Memory[]; skipped: ReextractSkip[] } {
  const toSupersede: Memory[] = [];
  const skipped: ReextractSkip[] = [];
  for (const memory of existing) {
    if (memory.status !== "active") {
      // 🔴 forgotten を絶対に触らない・contested も対象外（ADR 0028 参照）。
      // ADR 0029: 飛ばしたこと自体は必ず出す——status 付きで。
      skipped.push({ kind: "status_not_active", memoryId: memory.id, status: memory.status });
      continue;
    }
    if (contentHashes.has(memory.contentHash)) {
      // 今回の抽出でも変わらず作られた内容——置き換えられていないので supersede しない。
      skipped.push({ kind: "unchanged", memoryId: memory.id });
      continue;
    }
    toSupersede.push(memory);
  }
  return { toSupersede, skipped };
}
