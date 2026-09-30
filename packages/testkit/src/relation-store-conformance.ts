import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, RelationStore } from "@mnemora/core";
import {
  expectMalformedIdentifierRejection,
  MALFORMED_IDENTIFIER_CASES,
} from "./malformed-identifier-cases.js";

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
  /**
   * この adapter が任意メソッド `listRelatedMany?` を実装していると宣言する（Issue #1449、ADR 0402）。
   * `true` のとき、実装が無ければ赤にする。省略・`false` のとき、実装が無ければ `listRelatedMany` の節は skip する
   * （実装していない adapter に、既存の判定より厳しいものを課さない）。実装が有れば、宣言に依らず節はかかる。
   */
  implementsListRelatedMany?: boolean;
}

/**
 * `RelationStore`（Issue #207/#933 PR2、ADR 0292 決定1-c、ADR 0381）の adapter 非依存の
 * 適合テスト。`link`/`unlink`/`listRelated` の契約を Postgres・in-memory 両方に対して
 * 走らせる。
 */
export function describeRelationStoreConformance(options: RelationStoreConformanceOptions): void {
  const { name, createStore, prepareMemoryId, implementsListRelatedMany = false } = options;

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

    // -----------------------------------------------------------------
    // `listRelatedMany?`（任意メソッド、Issue #1449、ADR 0402）。**実装した adapter にだけかける**——
    // 実装していない adapter（`store.listRelatedMany === undefined`）ではこの節の it は skip する
    // （既存の判定を厳しくしない。`docs/migration-v1.md` の規律）。ただし `implementsListRelatedMany: true` を
    // 宣言した adapter が実装していなければ、skip ではなく赤にする（「実装したつもりで skip され続ける」を防ぐ）。
    // 契約は `RelationStore.listRelatedMany` の doc のとおり: `result[i]` は `listRelated(ids[i])` と同じ集合。
    // -----------------------------------------------------------------
    it.skipIf(!implementsListRelatedMany)(
      "listRelatedMany を実装していると宣言した adapter は、実際に実装している",
      async () => {
        const store = await createStore();
        expect(typeof store.listRelatedMany).toBe("function");
      },
    );

    /** `listRelatedMany` が無い adapter では skip して `undefined` を返す。 */
    async function createManyStore(t: { skip: () => never }) {
      const store = await createStore();
      if (store.listRelatedMany === undefined) {
        // 宣言があるのに無い場合は、上の it が赤にする。ここは skip でよい。
        return t.skip();
      }
      return store as RelationStore & Required<Pick<RelationStore, "listRelatedMany">>;
    }
    /** 比較用: 順序を規定しないので、相手側の id と kind で整列した形にする。 */
    const norm = (rs: Array<{ memoryId: string; kind: string }>) =>
      rs.map((r) => `${r.kind}:${r.memoryId}`).sort();

    it("listRelatedMany は起点ごとに listRelated と同じ集合を、起点と同じ位置に返す", async (t) => {
      const store = await createManyStore(t);
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      const c = await prepareMemoryId(ctx);
      const d = await prepareMemoryId(ctx);
      const lonely = await prepareMemoryId(ctx);
      for (const [from, to] of [
        [a, b],
        [b, a],
        [a, c],
        [c, a],
        [b, c],
        [c, b],
        [d, a],
      ] as const) {
        await store.link(ctx, "contradicts", from, to);
      }

      const ids = [c, lonely, a, d, b];
      const many = await store.listRelatedMany(ctx, ids);
      expect(many).toHaveLength(ids.length);
      for (const [i, id] of ids.entries()) {
        expect(norm(many[i]!)).toEqual(norm(await store.listRelated(ctx, id)));
      }
      // 位置の対応を直接も縛る（同じ集合を返す実装が位置を取り違えると、上は通っても下で落ちる）。
      expect(many[1]).toEqual([]);
      expect(many[3]!.map((r) => r.memoryId)).toEqual([a]);
      expect(norm(many[2]!)).toEqual(
        norm([b, c].map((m) => ({ memoryId: m, kind: "contradicts" }))),
      );
      expect(many[0]![0]?.createdAt).toBeInstanceOf(Date);
    });

    it("listRelatedMany は kind を渡しても省略しても、listRelated と同じ集合を返す", async (t) => {
      const store = await createManyStore(t);
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      await store.link(ctx, "contradicts", a, b);
      await store.link(ctx, "contradicts", b, a);

      for (const kind of [undefined, "contradicts"] as const) {
        const many = await store.listRelatedMany(ctx, [a, b], kind);
        expect(norm(many[0]!)).toEqual(norm(await store.listRelated(ctx, a, kind)));
        expect(norm(many[1]!)).toEqual(norm(await store.listRelated(ctx, b, kind)));
        expect(many[0]!.map((r) => r.memoryId)).toEqual([b]);
        expect(many[1]!.map((r) => r.memoryId)).toEqual([a]);
      }
    });

    it("listRelatedMany は重複した id の位置それぞれに同じ内容を返す（別々の配列で）", async (t) => {
      const store = await createManyStore(t);
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      await store.link(ctx, "contradicts", a, b);

      const many = await store.listRelatedMany(ctx, [a, b, a]);
      expect(many).toHaveLength(3);
      expect(many[0]!.map((r) => r.memoryId)).toEqual([b]);
      expect(many[1]).toEqual([]);
      expect(many[2]!.map((r) => r.memoryId)).toEqual([b]);
      expect(many[0]).not.toBe(many[2]);
    });

    it("listRelatedMany は空の起点に空配列を返す", async (t) => {
      const store = await createManyStore(t);
      const ctx: Ctx = { tenantId: "tenant-1" };
      expect(await store.listRelatedMany(ctx, [])).toEqual([]);
    });

    it("listRelatedMany は実在しない id の位置に空配列を返し、他の位置に影響しない", async (t) => {
      const store = await createManyStore(t);
      const ctx: Ctx = { tenantId: "tenant-1" };
      const a = await prepareMemoryId(ctx);
      const b = await prepareMemoryId(ctx);
      await store.link(ctx, "contradicts", a, b);
      const missing = "00000000-0000-4000-8000-000000000000" as MemoryId;

      const many = await store.listRelatedMany(ctx, [missing, a, missing]);
      expect(many).toHaveLength(3);
      expect(many[0]).toEqual([]);
      expect(many[1]!.map((r) => r.memoryId)).toEqual([b]);
      expect(many[2]).toEqual([]);
    });

    it("listRelatedMany は別テナントの ctx では、同じ id を起点にしても関係を返さない", async (t) => {
      const store = await createManyStore(t);
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const a1 = await prepareMemoryId(ctxA);
      const a2 = await prepareMemoryId(ctxA);
      const b1 = await prepareMemoryId(ctxB);
      const b2 = await prepareMemoryId(ctxB);
      await store.link(ctxA, "contradicts", a1, a2);
      await store.link(ctxB, "contradicts", b1, b2);

      // 同じ呼び出しに、自分のテナントの起点と他テナントの起点を混ぜる。
      const asA = await store.listRelatedMany(ctxA, [a1, b1]);
      expect(asA[0]!.map((r) => r.memoryId)).toEqual([a2]);
      expect(asA[1]).toEqual([]);
      const asB = await store.listRelatedMany(ctxB, [a1, b1]);
      expect(asB[0]).toEqual([]);
      expect(asB[1]!.map((r) => r.memoryId)).toEqual([b2]);
    });

    // 保存の形で区別できない識別子は、入口で断る（ADR 0423）
    for (const [label, value] of MALFORMED_IDENTIFIER_CASES) {
      it(`${label}を含む識別子は、ctx.tenantId でも ctx.subjectId でも断る`, async () => {
        const store = await createStore();
        const calls: Array<[string, () => Promise<unknown>]> = [
          [
            "listRelated の ctx.tenantId",
            () => store.listRelated({ tenantId: value }, randomUUID()),
          ],
          [
            "listRelated の ctx.subjectId",
            () => store.listRelated({ tenantId: "tenant-wf", subjectId: value }, randomUUID()),
          ],
        ];
        for (const [where, call] of calls) {
          await expectMalformedIdentifierRejection(call(), `${label} / ${where}`, value);
        }
      });
    }
  });
}
