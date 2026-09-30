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
   *
   * `link` は両端の記憶が `ctx` のテナントに在ることを入口で確かめる（ADR 0398）。⟹ このフックが返す id は
   * `createStore()` が返した store から見て実在する記憶で、かつ渡した `ctx` のテナントの記憶であること。
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

    it("listRelated は別テナントの ctx では、同じ id を起点にしても関係を返さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a1 = await prepareMemoryId(ctxA);
      const a2 = await prepareMemoryId(ctxA);

      await store.link(ctxA, "contradicts", a1, a2);
      expect((await store.listRelated(ctxA, a1)).map((r) => r.memoryId)).toEqual([a2]);
      expect(await store.listRelated(ctxB, a1)).toEqual([]);
    });

    it("listRelated は kind を渡した場合も、別テナントの ctx では関係を返さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a1 = await prepareMemoryId(ctxA);
      const a2 = await prepareMemoryId(ctxA);

      await store.link(ctxA, "contradicts", a1, a2);
      expect((await store.listRelated(ctxA, a1, "contradicts")).map((r) => r.memoryId)).toEqual([
        a2,
      ]);
      expect(await store.listRelated(ctxB, a1, "contradicts")).toEqual([]);
    });

    it("unlink は別テナントの ctx からは、同じ組を指定してもその行を消さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a1 = await prepareMemoryId(ctxA);
      const a2 = await prepareMemoryId(ctxA);

      await store.link(ctxA, "contradicts", a1, a2);
      await store.unlink(ctxB, "contradicts", a1, a2);
      expect((await store.listRelated(ctxA, a1)).map((r) => r.memoryId)).toEqual([a2]);
    });

    it("ctx のテナントに属さない記憶を from に取る link は拒まれ、行は書かれない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a = await prepareMemoryId(ctxA);
      const bInTenantB = await prepareMemoryId(ctxB);

      await expect(store.link(ctxA, "contradicts", bInTenantB, a)).rejects.toThrow(
        /memory not found for tenant/,
      );
      expect(await store.listRelated(ctxA, bInTenantB)).toEqual([]);
      expect(await store.listRelated(ctxB, bInTenantB)).toEqual([]);
      expect(await store.listRelated(ctxA, a)).toEqual([]);
    });

    it("ctx のテナントに属さない記憶を to に取る link は拒まれ、行は書かれない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a = await prepareMemoryId(ctxA);
      const bInTenantB = await prepareMemoryId(ctxB);

      await expect(store.link(ctxA, "contradicts", a, bInTenantB)).rejects.toThrow(
        /memory not found for tenant/,
      );
      expect(await store.listRelated(ctxA, a)).toEqual([]);
      expect(await store.listRelated(ctxB, bInTenantB)).toEqual([]);
    });

    // 存在しない id は2通り: uuid の形をしているもの（Postgres では外部キー違反になる形）と、
    // uuid の形でないもの（Postgres では型変換エラーになる形）。どちらも DB 由来の生の
    // エラーではなく、同じ「memory not found for tenant」で拒まれること。
    const missingIds: Array<[string, string]> = [
      ["uuid の形をした存在しない id", "00000000-0000-4000-8000-000000000000"],
      ["uuid の形でない id", "does-not-exist"],
    ];
    for (const [label, missing] of missingIds) {
      for (const end of ["from", "to"] as const) {
        it(`存在しない記憶（${label}）を ${end} に取る link は拒まれ、行は書かれない`, async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          const a = await prepareMemoryId(ctx);
          const m = missing as MemoryId;

          const error = await (
            end === "from"
              ? store.link(ctx, "contradicts", m, a)
              : store.link(ctx, "contradicts", a, m)
          ).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/memory not found for tenant/);
          expect((error as Error).message).not.toMatch(/Failed query|foreign key|invalid input/i);
          expect(await store.listRelated(ctx, a)).toEqual([]);
        });
      }
    }

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
