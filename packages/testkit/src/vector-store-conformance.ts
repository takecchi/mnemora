import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, MemoryId, MemoryStatus, VectorStore } from "@mnemora/core";

/**
 * `prepareMemoryId` が用意する Memory の属性。指定しなかった属性が何になるかは
 * adapter の裁量に委ねる（`packages/testkit` の `buildNewMemoryFixture` 相当の既定値、
 * 具体的には `status: "active"` / `subjectId: null` / `decayFloorAt` は
 * `defaultDecayStrategy.floorAt` の計算結果、を想定しているが、この適合テストの
 * `filter` の歯は指定した属性だけを見るため、他の既定値には依存しない）。
 */
export interface PrepareMemoryIdAttrs {
  status?: MemoryStatus;
  subjectId?: string;
  decayFloorAt?: Date;
}

export interface VectorStoreConformanceOptions {
  name: string;
  createStore: () => VectorStore | Promise<VectorStore>;
  /**
   * `packages/postgres` の `memory_embeddings_<space>` テーブルは `memory_id` を
   * `memories(id)` への外部キーにしている（docs/memory-model.md §10）。この適合テストは
   * `VectorStore` 単体を検査するが、外部キーを持つ adapter のために「実在の Memory の id を
   * 用意する」フックを持つ。
   *
   * **`attrs` を渡したときは、指定した属性を持つ Memory を用意すること。** `attrs` を
   * 渡さなかったときにどんな属性になるかは adapter の裁量（`PrepareMemoryIdAttrs` の
   * doc コメント参照。この適合テストの `filter` の歯は指定した属性だけを見るため、
   * 未指定時の既定値がどうであれ歯の結果には影響しない）。
   *
   * `filter.status` / `filter.subjectId` / `filter.decayFloorAtAfter` の契約（ADR 0034、
   * `packages/core/src/interfaces/vector-store.ts`）を検査するには、`VectorStore.search` の
   * 相手になる Memory がどんな属性を持つかをテスト側から指定できる必要がある——
   * `memory-store-conformance.ts` の `listEventsForMemory`、`outbox-store-conformance.ts` の
   * `seedJob` と同じ理由（`MemoryStore`/`VectorStore` それ自体には無い操作を、適合テストの
   * ためだけに adapter へ用意させるフック）。
   *
   * **省略可のオプションにしないこと。** 省略できると「`filter` を実際に検査できる
   * adapter」と「検査できない adapter」が同じ緑色の出力になる——このリポジトリが
   * ADR 0011/0025/0027/0028 で繰り返した族の失敗を、フックの省略という形で
   * 再現することになる。`listEventsForMemory` の doc コメントに同じ理由が書いてある。
   */
  prepareMemoryId: (ctx: Ctx, attrs?: PrepareMemoryIdAttrs) => Promise<MemoryId> | MemoryId;
}

const space: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };

/**
 * `VectorStore` の適合テスト（docs/architecture.md §5.2）。
 *
 * ここで検査するのは `VectorStore` の基本契約——upsert/search/delete の往復、
 * テナント分離、limit の遵守、そして `filter`（`status`/`subjectId`/`decayFloorAtAfter`）が
 * 実際に効くこと（ADR 0034）——である。`EXPLAIN` で HNSW 索引が使われることの検査
 * （roadmap.md 段階2の完了条件）は pgvector 固有の関心事であり、`packages/postgres` 側の
 * テスト（生 SQL・`EXPLAIN` を直接扱う）に置く。
 */
export function describeVectorStoreConformance(options: VectorStoreConformanceOptions): void {
  const { name, createStore, prepareMemoryId } = options;

  describe(`VectorStore conformance (${name})`, () => {
    it("upsert した vector が search で見つかる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.map((hit) => hit.memoryId)).toContain(memoryId);
    });

    it("同じ memoryId に対する2度目の upsert は行を増やさず、ベクトルを更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);
      await store.upsert(ctx, space, memoryId, [0, 1, 0]);

      const hits = await store.search(ctx, space, [0, 1, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });
      const matches = hits.filter((hit) => hit.memoryId === memoryId);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.distance).toBeCloseTo(0, 5);
    });

    it("クロステナントの search には他テナントの vector が現れない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const memoryId = await prepareMemoryId(ctxA);

      await store.upsert(ctxA, space, memoryId, [1, 0, 0]);

      const hitsB = await store.search(ctxB, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-b" },
      });

      expect(hitsB).toEqual([]);
    });

    it("delete した vector は search に現れなくなる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);
      await store.delete(ctx, space, memoryId);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.map((hit) => hit.memoryId)).not.toContain(memoryId);
    });

    it("search は limit を超えない件数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId1 = await prepareMemoryId(ctx);
      const memoryId2 = await prepareMemoryId(ctx);
      const memoryId3 = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId1, [1, 0, 0]);
      await store.upsert(ctx, space, memoryId2, [0, 1, 0]);
      await store.upsert(ctx, space, memoryId3, [0, 0, 1]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 2,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const activeId = await prepareMemoryId(ctx, { status: "active" });
      const archivedId = await prepareMemoryId(ctx, { status: "archived" });

      await store.upsert(ctx, space, activeId, [1, 0, 0]);
      await store.upsert(ctx, space, archivedId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
    });

    it("filter.subjectId: 別の subject の Memory は返らず、一致する subject の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const matchingId = await prepareMemoryId(ctx, { subjectId: "subject-a" });
      const otherId = await prepareMemoryId(ctx, { subjectId: "subject-b" });

      await store.upsert(ctx, space, matchingId, [1, 0, 0]);
      await store.upsert(ctx, space, otherId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(matchingId);
      expect(ids).not.toContain(otherId);
    });

    it("filter.decayFloorAtAfter: 境界と*ちょうど同じ* decayFloorAt は除外され、境界より後は返る（狭義の `>`）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const onBoundaryId = await prepareMemoryId(ctx, { decayFloorAt: boundary });
      const afterBoundaryId = await prepareMemoryId(ctx, {
        decayFloorAt: new Date(boundary.getTime() + 1000),
      });

      await store.upsert(ctx, space, onBoundaryId, [1, 0, 0]);
      await store.upsert(ctx, space, afterBoundaryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", decayFloorAtAfter: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).not.toContain(onBoundaryId);
      expect(ids).toContain(afterBoundaryId);
    });

    it("filter は複数同時に渡すと AND になる（どれか1つが不一致なら返らない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const bothMatchId = await prepareMemoryId(ctx, { status: "active", subjectId: "subject-a" });
      const statusOnlyMatchId = await prepareMemoryId(ctx, {
        status: "active",
        subjectId: "subject-b",
      });
      const subjectOnlyMatchId = await prepareMemoryId(ctx, {
        status: "archived",
        subjectId: "subject-a",
      });

      await store.upsert(ctx, space, bothMatchId, [1, 0, 0]);
      await store.upsert(ctx, space, statusOnlyMatchId, [1, 0, 0]);
      await store.upsert(ctx, space, subjectOnlyMatchId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"], subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(bothMatchId);
      expect(ids).not.toContain(statusOnlyMatchId);
      expect(ids).not.toContain(subjectOnlyMatchId);
    });
  });
}
