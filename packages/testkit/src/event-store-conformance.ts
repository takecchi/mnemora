import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryId } from "@mnemora/core";
import { buildNewMemoryEventFixture } from "./test-data.js";

/** {@link describeEventStoreConformance} に渡す設定。 */
export interface EventStoreConformanceOptions {
  /** 見出し（`describe` の名前）に出す adapter の名前。 */
  name: string;
  /** 新しい store を返す関数。各 `it` の中で1回ずつ呼ぶので、テストケースごとに独立した状態を持つ store を返すこと。 */
  createStore: () => EventStore | Promise<EventStore>;
  /**
   * `memory_id` に実在の Memory を要求するためのフック。**必須。**
   *
   * `memory_events.memory_id → memories(id)` は外部キー（`kind = 'events_purged'` の
   * 場合のみ NULL）。`docs/testkit` の既定フィクスチャ（`buildNewMemoryEventFixture`）は
   * `memoryId: null` を既定にしているため、`memoryId` を伴うテスト（list の memoryId
   * フィルタ・並び順・limit・since/until 等）でのみ使う。
   *
   * **ADR 0047 より前は省略可で、省略時は `mem-fixture-N` という実体を作らない固定文字列を
   * 使っていた**——当時は「外部キーを持たない in-memory 実装向け」の既定として正当だったが、
   * ADR 0047 で `InMemoryEventStore`/`FakeEventStore` にも外部キーを適用したため、この既定は
   * 「実在しない memoryId」を意味するようになった。**省略可のオプションのままにしないこと**
   * ——`vector-store-conformance.ts` の `prepareMemoryId`（ADR 0034）と同じ理由。
   */
  prepareMemoryId: (ctx: Ctx) => Promise<MemoryId> | MemoryId;
}

/**
 * `EventStore` interface が `update`/`delete` を持たないことのコンパイル時の検査。
 *
 * これは実行時のテストでは検査できない——「型に無い」こと自体が担保だからである
 * （docs/memory-model.md §9: 「型に無ければ、実装が間違って消す経路がそもそも生えない」）。
 * `keyof EventStore` に `'update'` / `'delete'` が含まれていたら、この行自体が
 * コンパイルエラーになる。
 */
type _EventStoreHasNoUpdateOrDelete = "update" extends keyof EventStore
  ? "EventStore に update を持たせてはならない（docs/memory-model.md §9）"
  : "delete" extends keyof EventStore
    ? "EventStore に delete を持たせてはならない（docs/memory-model.md §9）"
    : true;
const _eventStoreShapeCheck: _EventStoreHasNoUpdateOrDelete = true;

/**
 * `EventStore` の適合テスト（docs/architecture.md §5.8、docs/memory-model.md §9）。
 *
 * 検査する契約:
 * - append-only（型・実行時オブジェクトの両方で update/delete が存在しない）
 * - append した event が get/list で取得できる
 * - テナント分離（get/list とも他テナントの行を返さない）
 * - list の kind フィルタ・memoryId フィルタ
 * - list の並び順（`at` 昇順）・`limit`（並べ替えた後に適用）・`since`/`until`（両端含む）
 *   （docs/decisions/0042、`packages/core/src/interfaces/event-store.ts` の doc コメント）
 * - `meta`/`actor` が、core が入れる形（文字列・id・id の配列）だけのまま読み戻る
 *   （Issue #1238 A9、#1211 の表の外の値——Date・NaN・-0・undefined・BigInt・NUL・
 *   孤立サロゲート・関数——は adapter によって往復が違うため対象外）
 */
export function describeEventStoreConformance(options: EventStoreConformanceOptions): void {
  const { name, createStore, prepareMemoryId } = options;

  describe(`EventStore conformance (${name})`, () => {
    it("append した実装オブジェクトに update/delete メソッドが生えていない（実装側の実行時の念のための確認）", async () => {
      const store = await createStore();
      expect((store as unknown as Record<string, unknown>).update).toBeUndefined();
      expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
    });

    it("append した event が get で取得できる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1" }),
      );
      const fetched = await store.get(ctx, appended.id);

      expect(fetched?.id).toBe(appended.id);
    });

    // -------------------------------------------------------------------
    // get（族A: 無い id は null — 形式不正な id も例外を投げない）
    //
    // packages/postgres/src/mapping.ts の isUuidLike の doc コメントが定める規約と
    // 同じ判定基準を EventStore にも適用する。⚠ 3つを並べて見る: 形式不正 /
    // well-formed だが実在しない / 実在する（3番目が無いと「常に null」が通ってしまう。
    // 「実在する」は上の「append した event が get で取得できる」で既に検査済み）。
    // -------------------------------------------------------------------

    it("get は形式不正な id に対して例外を投げず null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.get(ctx, "does-not-exist")).resolves.toBeNull();
    });

    it("get は well-formed だが実在しない id に対して null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.get(ctx, randomUUID())).resolves.toBeNull();
    });

    it("クロステナントの get は null になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      const appended = await store.append(
        ctxA,
        buildNewMemoryEventFixture({ tenantId: "tenant-a" }),
      );
      const crossTenantRead = await store.get(ctxB, appended.id);

      expect(crossTenantRead).toBeNull();
    });

    it("list は kind でフィルタできる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", kind: "created" }),
      );
      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", kind: "forgotten" }),
      );

      const created = await store.list(ctx, { kind: "created" });

      expect(created.every((event) => event.kind === "created")).toBe(true);
      expect(created.length).toBeGreaterThanOrEqual(1);
    });

    it("list は memoryId でフィルタできる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);
      const otherMemoryId = await prepareMemoryId(ctx);

      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, kind: "created" }),
      );
      await store.append(
        ctx,
        buildNewMemoryEventFixture({
          tenantId: "tenant-1",
          memoryId: otherMemoryId,
          kind: "created",
        }),
      );

      const filtered = await store.list(ctx, { memoryId });
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered.every((event) => event.memoryId === memoryId)).toBe(true);
    });

    it("list の memoryId フィルタは形式不正な memoryId に対して例外を投げず空配列を返す（他のフィルタに関わらず）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", kind: "created" }),
      );
      await expect(
        store.list(ctx, { memoryId: "does-not-exist", kind: "created" }),
      ).resolves.toEqual([]);
    });

    it("list の memoryId フィルタは well-formed だが実在しない memoryId に対して空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.list(ctx, { memoryId: randomUUID() })).resolves.toEqual([]);
    });

    it("クロステナントの list は他テナントのイベントを含まない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      await store.append(ctxA, buildNewMemoryEventFixture({ tenantId: "tenant-a" }));

      const listB = await store.list(ctxB, {});
      expect(listB).toEqual([]);
    });

    it("list は at 昇順で返す（挿入順ではない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      // T1 < T2 < T3 だが、挿入順は T3, T1, T2 —— 挿入順と at 順をわざと不一致にする
      // （フィクスチャの非対称性: 挿入順でソートしても at 順でソートしても同じ結果になる
      // 並びを作らない）。
      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-01-02T00:00:00.000Z");
      const t3 = new Date("2026-01-03T00:00:00.000Z");

      const e3 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t3 }),
      );
      const e1 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t1 }),
      );
      const e2 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t2 }),
      );

      const listed = await store.list(ctx, { memoryId });

      expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id, e3.id]);
    });

    it("limit は at 昇順に並べ替えた後に適用する（挿入順の先頭 n 件ではない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-01-02T00:00:00.000Z");
      const t3 = new Date("2026-01-03T00:00:00.000Z");

      // 挿入順の先頭は t3 の行。limit: 1 が挿入順の先頭 n 件を返す実装だと t3 の行が
      // 返ってしまう —— at が最も古い e1 の1件が返ることを検査する（集合そのものが
      // 変わることの歯）。
      const e3 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t3 }),
      );
      const e1 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t1 }),
      );
      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t2 }),
      );

      const limited = await store.list(ctx, { memoryId, limit: 1 });

      expect(limited.map((event) => event.id)).toEqual([e1.id]);
      expect(limited.map((event) => event.id)).not.toEqual([e3.id]);
    });

    it("since は境界を含む（at >= since）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-01-02T00:00:00.000Z");
      const t3 = new Date("2026-01-03T00:00:00.000Z");

      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t1 }),
      );
      const e2 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t2 }),
      );
      const e3 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t3 }),
      );

      const listed = await store.list(ctx, { memoryId, since: t2 });

      expect(listed.map((event) => event.id)).toEqual([e2.id, e3.id]);
    });

    it("until は境界を含む（at <= until）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-01-02T00:00:00.000Z");
      const t3 = new Date("2026-01-03T00:00:00.000Z");

      const e1 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t1 }),
      );
      const e2 = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t2 }),
      );
      await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, at: t3 }),
      );

      const listed = await store.list(ctx, { memoryId, until: t2 });

      expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id]);
    });

    // -------------------------------------------------------------------
    // 外部キー相当（ADR 0047）: `memory_events.memory_id → memories(id)`
    // （`kind = 'events_purged'` の場合のみ NULL）。**存在だけ**を見る。
    //
    // ⚠ `.rejects.toThrow()` を引数なしで使っている理由は
    // `memory-store-conformance.ts` の同種の節と同じ（メッセージの一致ではなく
    // 「実在しない参照では必ず失敗する」ことを見る）。
    // -------------------------------------------------------------------

    it("append は実在しない memoryId に対して失敗し、実在する memoryId では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.append(
          ctx,
          buildNewMemoryEventFixture({
            tenantId: "tenant-1",
            memoryId: randomUUID(),
            kind: "created",
          }),
        ),
      ).rejects.toThrow();

      const memoryId = await prepareMemoryId(ctx);
      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, kind: "created" }),
      );
      expect(appended.memoryId).toBe(memoryId);
    });

    it("append は memoryId が null なら外部キーを要求しない（events_purged 等、NULL は拒まない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({
          tenantId: "tenant-1",
          memoryId: null,
          kind: "events_purged",
        }),
      );
      expect(appended.memoryId).toBeNull();
    });

    // -------------------------------------------------------------------
    // Issue #1238 A9（#1214 の棚卸しが挙げた候補、#1211 の表）: `meta`・`actor` が
    // JSON として保存される前提の欄であることは `MemoryEvent.meta` の doc コメントに
    // 書いてあるが、event-store-conformance.ts 自体には `meta` を見る歯が1本も無かった。
    //
    // ここで課すのは「core が実際に入れる形」だけである（#1211 の表の外は adapter
    // によって往復が違うと明記されているため、課す範囲に入れない——Date・NaN・-0・
    // undefined・BigInt・NUL・孤立サロゲート・関数は対象外）。「core が入れる形」は
    // `packages/core/src/runtime.ts` の `meta:` を組み立てている箇所を `grep -n "meta:"`
    // で洗って数えた（行番号は main が動けば変わるので書かない）——`applyCorrection` 系
    // （`reason`/`sourceObservationId`/`extractorVersion`）、claim key 衝突の `updated`
    // イベント（`reason`/`note`）、reextract の `superseded`（`reason`/`supersededById`/
    // `sourceObservationId`/`extractorVersion`）、`markContestedPair`/`resolveContestedPair`
    // の `buildMeta`（相手の `MemoryId` を1個積む）・orphan reclaim（`reason`/`resolution`/
    // `note`/`contestedWithId`）、`consolidate`/`reflect` の `sources`（`MemoryId[]`）——
    // どれも文字列（`reason`/`note`/`resolution`/`extractorVersion`）、id
    // （`sourceObservationId`/`supersededById`/`contestedWithId`）、id の配列（`sources`）の
    // いずれかである。`actor` も
    // `EventActor`（`type` は列挙の文字列、`id?` は文字列）だけを渡す
    // （`opts?.actor` をそのまま使う呼び出し元も、渡ってくる値の型は同じ）。
    // -------------------------------------------------------------------

    it("append は core が入れる形（文字列・id・id の配列だけの meta・actor）を、そのままの値で読み戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);
      const sourceObservationId = randomUUID();
      const supersededById = randomUUID();
      const contestedWithId = randomUUID();
      const sources = [randomUUID(), randomUUID()];
      const actor = { type: "human" as const, id: "user-1238" };
      const meta = {
        reason: "consolidated",
        note: "手作業の統合（core が渡す自由記述の文字列）",
        sourceObservationId,
        extractorVersion: "extractor-v1",
        supersededById,
        contestedWithId,
        sources,
      };

      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, actor, meta }),
      );
      expect(appended.actor).toEqual(actor);
      expect(appended.meta).toEqual(meta);

      const fetched = await store.get(ctx, appended.id);
      expect(fetched?.actor).toEqual(actor);
      expect(fetched?.meta).toEqual(meta);
    });

    // -------------------------------------------------------------------
    // Issue #1412 A8（Issue #1238 棚卸し、ADR 0373）: 渡した入力・返した値が、
    // store の中の実体と切り離されている。
    // -------------------------------------------------------------------

    it("append の入力 meta（配列を含む）を呼び手が後から書き換えても、保存した値は変わらない（Issue #1412 A8）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);
      const sources = [randomUUID(), randomUUID()];
      const meta = { reason: "consolidated", sources };

      const expectedMeta = { reason: "consolidated", sources: [...sources] };

      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({ tenantId: "tenant-1", memoryId, meta }),
      );
      // ⚠ `sources` はここで書き換える（`meta.sources` と同じ参照）。上で `expectedMeta` を
      // 先に独立した複製として作っておかないと、期待値そのものがこの書き換えを拾ってしまう。
      meta.reason = "mutated-by-caller";
      meta.sources.push(randomUUID());

      const fetched = await store.get(ctx, appended.id);
      expect(fetched?.meta).toEqual(expectedMeta);
      expect(appended.meta).toEqual(expectedMeta);
    });

    it("get が返した meta を呼び手が書き換えても、次の get は影響を受けない（Issue #1412 A8）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);
      const sources = [randomUUID(), randomUUID()];

      const appended = await store.append(
        ctx,
        buildNewMemoryEventFixture({
          tenantId: "tenant-1",
          memoryId,
          meta: { reason: "consolidated", sources },
        }),
      );

      const first = await store.get(ctx, appended.id);
      (first!.meta as { reason: string }).reason = "mutated-by-caller";
      (first!.meta.sources as string[]).push(randomUUID());

      const second = await store.get(ctx, appended.id);
      expect(second?.meta).toEqual({ reason: "consolidated", sources });
    });
  });
}
