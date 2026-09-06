import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";

/**
 * `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る
 * （docs/architecture.md §5.2）。
 */
export interface VectorFilter {
  tenantId: string;
  status?: MemoryStatus[];
  decayFloorAtAfter?: Date;
  /**
   * subject の等値一致（`docs/vision.md` の「Tenant と Subject を混同しない」区別における
   * テナント内の整理の単位）。等値比較なので上のクラス doc の「索引で表現できる形」に
   * そのまま当たる——`period`（`occurredAfter`/`occurredBefore`）のような連続値の範囲比較とは
   * 事情が異なる（`docs/recall.md` が指摘する partial index の離散値向き制約は period 側の話）。
   */
  subjectId?: string;
}

export interface VectorHit {
  memoryId: MemoryId;
  distance: number;
}

/**
 * VectorStore — Phase 1（docs/architecture.md §5.2）。
 *
 * 契約:
 * - MemoryStore が真実の源であり、VectorStore は再構築可能な派生索引である
 *   （非対称。VectorStore を失っても MemoryStore から再 embed して復旧できるが逆はできない）。
 * - `ORDER BY` を距離式にしない、という規約は adapter 実装の責務であり、`testkit` は
 *   `EXPLAIN` で索引が使われることを検査する。
 * - 埋め込みが未完了の Memory は `Memory.embeddingStatus` を持ち、recall は
 *   `omitted.kind = 'not_indexed'` としてこれを報告する。
 */
export interface VectorStore {
  upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]>;
  delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
}
