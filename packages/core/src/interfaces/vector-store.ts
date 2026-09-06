import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";

/**
 * `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る
 * （docs/architecture.md §5.2）。
 *
 * **各フィールドは adapter が実際に適用しなければならない（ADR 0034）。**
 * 「絞ってもよいが絞らなくてもよい」という緩い契約ではない——`packages/testkit` の
 * `vector-store-conformance.ts` がこれを adapter 非依存の歯として検査する
 * （`status` に無いものは返らない・一致しない `subjectId` は返らない・
 * `decayFloorAtAfter` 以前のものは返らない、を同一の適合テストで postgres / in-memory
 * 両方に対して走らせる）。
 *
 * **⚠ 後段の多層防御は、ここの全フィールドを覆ってはいない。**
 * `packages/core/src/recall-runtime.ts` は段1のあとに `subjectId`（と period・
 * `excludeProvenanceKinds`）を改めて見るが、**`status` と `decayFloorAtAfter` は見ない**。
 * ⟹ `status` については、ここの契約を adapter が守ることが**唯一の防衛線**である
 * （実測: `FakeVectorStore` の `status` の絞りを落とす変異で、`recall-pipeline.test.ts` の
 * 既存の歯が実際に赤くなる。`subjectId` を落とす変異では赤くならない——後段が救うため）。
 * 後段フィルタが在ることは、どの場合も「filter を無視してよい」ことの根拠ではない。
 */
export interface VectorFilter {
  tenantId: string;
  status?: MemoryStatus[];
  /**
   * **狭義の `>`。** `decayFloorAt` が境界と*ちょうど同じ* Memory は含まれない
   * （`packages/postgres/src/vector-store.ts` の `m.decay_floor_at > ${decayFloorAtAfter}`
   * がこの意味論の基準）。`>=` にすると忘却の境界上にある記憶が想起され続けてしまう
   * （ADR 0004 の「忘却をクエリ時に算出する」設計と整合させるため）。
   */
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
