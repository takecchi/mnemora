import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, RelationStore } from "@mnemora/core";

/** {@link describeRelationStoreConformance} に渡す設定。 */
export interface RelationStoreConformanceOptions {
  /** 見出し（`describe` の名前）に出す adapter の名前。 */
  name: string;
  /** 新しい store を返す関数。各 `it` の中で1回ずつ呼ぶので、テストケースごとに独立した状態を持つ store を返すこと。 */
  createStore: () => RelationStore | Promise<RelationStore>;
  /**
   * `packages/postgres` の `memory_relations` テーブルは `from_memory_id`/`to_memory_id`
   * を `memories(id)` への外部キーにしている（`migrations/0026_memory_relations.sql`）。
   * この適合テストは `RelationStore` 単体を検査するが、外部キーを持つ adapter のために
   * 「実在の Memory の id を用意する」フックを持つ（`vector-store-conformance.ts` の
   * `prepareMemoryId` と同じ理由）。**省略可のオプションにしない**——同じ理由。
   */
  prepareMemoryId: (ctx: Ctx) => Promise<MemoryId> | MemoryId;
}

/**
 * `RelationStore`（Issue #207/#933 PR2、ADR 0292 決定1-c、ADR 0381）の adapter 非依存の
 * 適合テスト。`link`/`unlink`/`listRelated` の契約を Postgres・in-memory 両方に対して
 * 走らせる。
 */
export function describeRelationStoreConformance(options: RelationStoreConformanceOptions): void {
  const { name, createStore, prepareMemoryId } = options;

  describe(`RelationStore conformance (${name})`, () => {
    it("link した相手を listRelated が返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);

      await store.link(ctx, "contradicts", a, b);
      const related = await store.listRelated(ctx, a);
      expect(related.map((r) => r.memoryId)).toEqual([b]);
      expect(related[0]?.kind).toBe("contradicts");
      expect(related[0]?.createdAt).toBeInstanceOf(Date);
    });

    it("link は片方向のみ——逆向きは自動的には張られない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);

      await store.link(ctx, "contradicts", a, b);
      const fromB = await store.listRelated(ctx, b);
      expect(fromB).toEqual([]);
    });

    it("link は冪等——同じ組を2回呼んでも例外にならず、listRelated は1件のまま", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);

      await store.link(ctx, "contradicts", a, b);
      await store.link(ctx, "contradicts", a, b);
      const related = await store.listRelated(ctx, a);
      expect(related.map((r) => r.memoryId)).toEqual([b]);
    });

    it("unlink はその組の行だけを消す——他の組・逆向きには触れない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      const c = await prepareMemoryId(ctx);

      await store.link(ctx, "contradicts", a, b);
      await store.link(ctx, "contradicts", b, a);
      await store.link(ctx, "contradicts", a, c);

      await store.unlink(ctx, "contradicts", a, b);

      expect((await store.listRelated(ctx, a)).map((r) => r.memoryId).sort()).toEqual([c]);
      expect((await store.listRelated(ctx, b)).map((r) => r.memoryId)).toEqual([a]);
    });

    it("unlink は存在しない行を指定しても例外にしない（冪等）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);

      await expect(store.unlink(ctx, "contradicts", a, b)).resolves.toBeUndefined();
    });

    it("listRelated は関係の無い Memory に対して空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);

      expect(await store.listRelated(ctx, a)).toEqual([]);
    });

    it("listRelated は kind を渡すとその種類だけに絞る（今日は 'contradicts' の1種類のみ）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);

      await store.link(ctx, "contradicts", a, b);
      const related = await store.listRelated(ctx, a, "contradicts");
      expect(related.map((r) => r.memoryId)).toEqual([b]);
    });

    it("クロステナントの関係は返さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a = await prepareMemoryId(ctxA);
      const bInTenantB = await prepareMemoryId(ctxB);

      // 別テナントの id へ link しても、そのテナントの listRelated には出ない
      // （postgres は tenant_id をそのまま書くだけで検査しない——呼び出し側が同じ ctx で
      // 確かめた id しか渡さない前提。`EventStore` の同種の契約と同じ形）。
      await store.link(ctxA, "contradicts", a, bInTenantB);
      expect(await store.listRelated(ctxB, bInTenantB)).toEqual([]);
    });

    it("N件の完全グラフ（3件）を双方向で張ると、どのメンバーからも残り2件が引ける", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      const c = await prepareMemoryId(ctx);

      for (const [from, to] of [
        [a, b],
        [b, a],
        [a, c],
        [c, a],
        [b, c],
        [c, b],
      ] as const) {
        await store.link(ctx, "contradicts", from, to);
      }

      expect((await store.listRelated(ctx, a)).map((r) => r.memoryId).sort()).toEqual(
        [b, c].sort(),
      );
      expect((await store.listRelated(ctx, b)).map((r) => r.memoryId).sort()).toEqual(
        [a, c].sort(),
      );
      expect((await store.listRelated(ctx, c)).map((r) => r.memoryId).sort()).toEqual(
        [a, b].sort(),
      );
    });
  });
}
