import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus } from "../memory.js";

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
 */
export type ReextractSkip =
  | { kind: "status_not_active"; memoryId: MemoryId; status: Exclude<MemoryStatus, "active"> }
  | { kind: "unchanged"; memoryId: MemoryId }
  | { kind: "not_examined"; reason: "llm_failed_whole_observation" | "no_candidates" };

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
