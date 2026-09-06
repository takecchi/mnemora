import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EmbeddingStatus } from "@mnemora/core";
import type {
  Ctx,
  MemoryEvent,
  MemoryId,
  MemoryStore,
  NewMemoryEvent,
  RecallId,
} from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "./test-data.js";

/**
 * 「対象が無い」系の検査専用の、well-formed だが実在しない id。
 *
 * この適合テストは複数の `MemoryStore` 実装（postgres / in-memory）に同じ入力を
 * 投げて、*同じ種類の*失敗になることを測る（このファイル冒頭の doc コメント参照）。
 * `packages/postgres` の `memories.id` は `uuid` 型（migrations/0001_init.sql）で、
 * `setEmbeddingStatus`/`reinforce`/`updateStatus` は `getObservation` と違い
 * `isUuidLike` による事前チェックを持たない（packages/postgres/src/memory-store.ts）ため、
 * UUID の形をしていない文字列（例: 旧 `"does-not-exist"`）を渡すと Postgres 側だけ
 * SQL 実行時点でドライバの `invalid input syntax for type uuid` が飛ぶ——in-memory側は
 * 意図した「memory not found」を投げる。**id を well-formed な UUID に揃えないと、
 * 両実装がここで初めて違う種類の失敗を返すようになり、後段でメッセージを
 * `/memory not found for tenant/` に固定したときに、測りたい対象（「対象が無い」を
 * 両実装が同じに扱っているか）ではなく、この入力形式の食い違いだけで赤くなってしまう**。
 * `randomUUID()` で実行のたびに新しい値を生成すれば、fixture が作る実在の id
 * （store が発行する UUID）と衝突しないことは構造的に保証される。
 */
const NONEXISTENT_MEMORY_ID = randomUUID();

/**
 * 「対象が無い」異常系が投げる例外を検査するための、両実装に共通する部分文字列。
 *
 * `packages/postgres/src/memory-store.ts` は
 * `PostgresMemoryStore: memory not found for tenant: ${id}`、
 * `InMemoryMemoryStore`（packages/testkit/src/__fixtures__/in-memory-memory-store.ts）は
 * `InMemoryMemoryStore: memory not found for tenant: ${id}` を投げる——共通する安定した
 * 部分が `memory not found for tenant`。引数なしの `.rejects.toThrow()` は「何かが
 * 投げられた」しか測らないため、`if (!memory) throw ...` を消しても、null に対する
 * プロパティアクセスが投げる `TypeError`（例: `Cannot set properties of null`）で
 * 同じく満たされてしまい、意図した「対象が無い」分岐を検査したことにならない。
 * メッセージをこのパターンに固定することで、`TypeError` のような別種の失敗と
 * 区別する。
 */
const NOT_FOUND_ERROR_MESSAGE = /memory not found for tenant/;

export interface MemoryStoreConformanceOptions {
  /** テスト出力に出す adapter 名（例: "postgres", "in-memory"）。 */
  name: string;
  /** テストケースごとに独立した状態を持つ新しい MemoryStore を返す。 */
  createStore: () => MemoryStore | Promise<MemoryStore>;
  /**
   * `recordUsage` を呼ぶ前に、有効な `recallId` を用意する必要がある adapter のためのフック。
   *
   * docs/memory-model.md §10 の DDL は `recall_usages.recall_id` を `recalls(id)` への
   * 外部キーにしている。`MemoryStore` interface 自体には「recall を記録する」操作が無い
   * （それは recall() の実装、roadmap.md 段階4の責務）ため、この適合テストは
   * `recordUsage` を単体で検査する際に使う `recallId` をどう用意するかを adapter に委ねる。
   * 省略時は固定文字列を使う（外部キーを持たない in-memory 実装向け）。
   */
  prepareRecallId?: (ctx: Ctx) => Promise<RecallId> | RecallId;
  /**
   * ADR 0031: `updateStatusWithEvent` が実際に `memory_events`（相当）へ書いたイベントを
   * 読み出すためのフック。**必須。**「CAS に弾かれたときイベントが1件も積まれていないこと」
   * を検査するには、適合テストがイベントを直接読める必要がある——`MemoryStore` interface
   * 自体には「あるメモリに紐づくイベントを読む」操作が無い（それは `EventStore` の責務）ため、
   * `prepareRecallId` / `outbox-store-conformance.ts` の `seedJob` と同じ理由で、
   * adapter ごとの用意の仕方を呼び出し側に委ねる。**省略可のオプションにしないこと**——
   * 省略できると「検査した」adapter と「検査していない」adapter が同じ緑色の出力になり、
   * このリポジトリが ADR 0011/0025/0027/0028 で繰り返した「名乗れる以上の精度を主張する」
   * 族の失敗を、フックの省略という形で再現することになる。
   */
  listEventsForMemory: (ctx: Ctx, memoryId: MemoryId) => Promise<MemoryEvent[]> | MemoryEvent[];
}

/**
 * `MemoryStore` の適合テスト（docs/architecture.md §5.1・§3.7）。
 *
 * ここでの契約は「型」ではなく「振る舞い」である。以下を実際に検査する:
 * - 2テナント分のデータを投入し、クロステナントの取得（get/getMany/aggregateScope/
 *   updateStatus/reinforce）がクロステナントとして扱われること（§3.7 必須契約）
 * - `createObservation` の冪等性（externalId の有無・一致/不一致の各分岐）
 * - `createMemory` の冪等性（§3.5、抽出キーの一致・不一致・sourceObservationId 無しの各分岐）
 * - `recordUsage` が実際に挿入が起きたときだけ `insertedMemoryIds` に載ること
 *   （D9・§3.5、全件新規/全件再送/部分再送/空配列の各分岐）
 * - `reinforce` / `updateStatus` の正常系と「対象が無い」異常系
 * - `updateStatusWithEvent`（ADR 0031）が status 更新とイベント追記を1つの操作として
 *   扱うこと——成功時は両方起きる、CAS に弾かれたら両方とも起きない、対象が無ければ
 *   両方とも起きない、の3分岐を「Memory の状態」と「積まれたイベント数」を並べて検査する
 * - `aggregateScope` の集計が実データを反映すること（群カウント・totalInScope・
 *   status ゲート・period フィルタ・not_indexed の各分岐、roadmap.md 段階4/5・
 *   docs/recall.md §5「スコープの外延」）
 * - `createRecall` が recallId を発行すること（段6、ADR 0008）
 */
export function describeMemoryStoreConformance(options: MemoryStoreConformanceOptions): void {
  const { name, createStore, listEventsForMemory } = options;
  const prepareRecallId: (ctx: Ctx) => Promise<RecallId> | RecallId =
    options.prepareRecallId ?? (() => "recall-1");

  describe(`MemoryStore conformance (${name})`, () => {
    // -------------------------------------------------------------------
    // テナント分離（docs/architecture.md §3.7）
    // -------------------------------------------------------------------

    it("2テナント分のデータを投入すると、クロステナントの get は null になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );
      await store.createMemory(ctxB, buildNewMemoryFixture({ tenantId: "tenant-b" }));

      const crossTenantRead = await store.get(ctxB, memoryA.id);
      expect(crossTenantRead).toBeNull();

      const sameTenantRead = await store.get(ctxA, memoryA.id);
      expect(sameTenantRead?.id).toBe(memoryA.id);
    });

    it("2テナント分のデータを投入すると、クロステナントの aggregateScope は0件になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      await store.createMemory(ctxA, buildNewMemoryFixture({ tenantId: "tenant-a" }));

      const aggregateB = await store.aggregateScope(ctxB, {});
      expect(aggregateB.totalInScope).toBe(0);
      expect(aggregateB.groups).toEqual([]);
    });

    it("2テナント分のデータを投入すると、クロステナントの getMany は空配列になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );

      const crossTenantRead = await store.getMany(ctxB, [memoryA.id]);
      expect(crossTenantRead).toEqual([]);
    });

    it("クロステナントの updateStatus/reinforce は対象が無いものとして失敗する", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );

      await expect(store.updateStatus(ctxB, memoryA.id, "archived")).rejects.toThrow();
      await expect(store.reinforce(ctxB, memoryA.id, new Date())).rejects.toThrow();
    });

    // -------------------------------------------------------------------
    // createObservation の冪等性（docs/memory-model.md §10、observe() の再送）
    // -------------------------------------------------------------------

    it("createObservation は externalId が同じなら同じ Observation を返す（冪等）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-shared" });

      const first = await store.createObservation(ctx, input);
      const second = await store.createObservation(ctx, {
        ...input,
        payload: { text: "違うペイロード（無視されるべき）" },
      });

      expect(second.id).toBe(first.id);
    });

    it("createObservation は externalId が無ければ常に新しい Observation を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({ tenantId: "tenant-1", externalId: null });

      const first = await store.createObservation(ctx, input);
      const second = await store.createObservation(ctx, input);

      expect(second.id).not.toBe(first.id);
    });

    it("createObservation は externalId が異なれば別の Observation を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const first = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-1" }),
      );
      const second = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-2" }),
      );

      expect(second.id).not.toBe(first.id);
    });

    // -------------------------------------------------------------------
    // getObservation / createObservationWithOutbox（roadmap.md 段階3・transactional outbox）
    // -------------------------------------------------------------------

    it("getObservation は作成済みの Observation を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const created = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const fetched = await store.getObservation(ctx, created.id);
      expect(fetched?.id).toBe(created.id);
    });

    it("getObservation は存在しない id に対して null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      expect(await store.getObservation(ctx, "does-not-exist")).toBeNull();
    });

    it("getObservation はクロステナントで null を返す", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const created = await store.createObservation(
        ctxA,
        buildNewObservationFixture({ tenantId: "tenant-a" }),
      );
      expect(await store.getObservation(ctxB, created.id)).toBeNull();
    });

    it("createObservationWithOutbox は新規作成時に created: true と、jobKinds ぶんの job を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { observation, created, jobs } = await store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-outbox-1" }),
        ["extract"],
      );
      expect(created).toBe(true);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("extract");
      expect(jobs[0]?.payload.observationId).toBe(observation.id);
      expect(jobs[0]?.tenantId).toBe("tenant-1");
    });

    it("createObservationWithOutbox は冪等な再送で created: false・jobs: [] を返す（重複ジョブを積まない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({
        tenantId: "tenant-1",
        externalId: "ext-outbox-2",
      });

      const first = await store.createObservationWithOutbox(ctx, input, ["extract"]);
      expect(first.created).toBe(true);

      const second = await store.createObservationWithOutbox(ctx, input, ["extract"]);
      expect(second.created).toBe(false);
      expect(second.jobs).toEqual([]);
      expect(second.observation.id).toBe(first.observation.id);
    });

    it("createObservationWithOutbox は jobKinds が空なら job を作らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { created, jobs } = await store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
        [],
      );
      expect(created).toBe(true);
      expect(jobs).toEqual([]);
    });

    // -------------------------------------------------------------------
    // createMemory の冪等性（docs/architecture.md §3.5、§5.1）
    // -------------------------------------------------------------------

    it("createMemory は同じ抽出キーに対して冪等である（重複を作らない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "same-hash",
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, {
        ...input,
        content: "違う本文（無視され、first の内容が正になるべき）",
      });

      expect(second.id).toBe(first.id);
      expect(second.content).toBe(first.content);
    });

    it("createMemory は sourceObservationId/contentHash が異なれば別の Memory を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observationA = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const observationB = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const first = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observationA.id,
          extractorVersion: "v1",
          contentHash: "hash-1",
        }),
      );
      const second = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observationB.id,
          extractorVersion: "v1",
          contentHash: "hash-2",
        }),
      );

      expect(second.id).not.toBe(first.id);
    });

    it("createMemory は extractorVersion が null でも冪等である（同じ Observation・同じ contentHash で重複を作らない）", async () => {
      // docs/memory-model.md §10 の一意制約は
      //   (tenant_id, source_observation_id, extractor_version, content_hash)
      //   WHERE source_observation_id IS NOT NULL
      // だが、Postgres は既定で NULL 同士を「異なる値」として扱うため、
      // extractor_version が NULL だと**この一意制約が発火しない**。
      // 実測（PG18.6）: extractor_version = NULL で同じ行を2回入れると2行できた。
      // roadmap.md 段階3 の完了条件「同じ Observation を二重に送っても Memory が
      // 重複して作られない」が、この経路だけ静かに崩れる。
      // インメモリ実装は JS の文字列キーで null を "" に潰すため**偶然に**冪等であり、
      // この分岐を検査しない限り両実装の食い違いは見えない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: null,
        contentHash: "hash-null-extractor",
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, input);

      expect(second.id).toBe(first.id);
    });

    it("createMemory は sourceObservationId が無い場合、同じ contentHash でも常に新しい Memory を作る（一意制約の対象外）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: null,
        extractorVersion: null,
        contentHash: "same-hash-no-source",
        provenance: { kind: "imported", batchId: "batch-1" },
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, input);

      expect(second.id).not.toBe(first.id);
    });

    // -------------------------------------------------------------------
    // listBySourceObservation（ADR 0028・runtime.reextract の前提）
    // -------------------------------------------------------------------

    it("listBySourceObservation は同じ Observation・同じ extractorVersion の Memory を列挙する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const a = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-a",
        }),
      );
      const b = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-b",
        }),
      );
      // 別の Observation・別の extractorVersion の Memory は混ざってはならない。
      const otherObservation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: otherObservation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-other-observation",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v2",
          contentHash: "hash-list-other-version",
        }),
      );

      const listed = await store.listBySourceObservation(ctx, observation.id, "v1");
      expect(listed.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("listBySourceObservation はクロステナントの Memory を返さない（テナント分離）", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const observationA = await store.createObservation(
        ctxA,
        buildNewObservationFixture({ tenantId: "tenant-a" }),
      );
      await store.createMemory(
        ctxA,
        buildNewMemoryFixture({
          tenantId: "tenant-a",
          sourceObservationId: observationA.id,
          extractorVersion: "v1",
          contentHash: "hash-tenant-a",
        }),
      );

      // tenant-b からは同じ observationId を渡しても何も見えない
      // （観測そのものがテナント分離されている前提と一貫させる）。
      const listedFromB = await store.listBySourceObservation(ctxB, observationA.id, "v1");
      expect(listedFromB).toEqual([]);

      const listedFromA = await store.listBySourceObservation(ctxA, observationA.id, "v1");
      expect(listedFromA).toHaveLength(1);
    });

    // -------------------------------------------------------------------
    // createMemoryWithOutbox（roadmap.md 段階3・transactional outbox）
    // -------------------------------------------------------------------

    it("createMemoryWithOutbox は新規作成時に created: true と、jobKinds ぶんの job を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { memory, created, jobs } = await store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "hash-outbox-1" }),
        ["embed"],
      );
      expect(created).toBe(true);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("embed");
      expect(jobs[0]?.payload.memoryId).toBe(memory.id);
    });

    it("createMemoryWithOutbox は抽出の冪等キーに衝突したら created: false・jobs: [] を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "hash-outbox-2",
      });

      const first = await store.createMemoryWithOutbox(ctx, input, ["embed"]);
      expect(first.created).toBe(true);

      const second = await store.createMemoryWithOutbox(ctx, input, ["embed"]);
      expect(second.created).toBe(false);
      expect(second.jobs).toEqual([]);
      expect(second.memory.id).toBe(first.memory.id);
    });

    // -------------------------------------------------------------------
    // setEmbeddingStatus（roadmap.md 段階3の完了条件: pending → ready | failed）
    // -------------------------------------------------------------------

    it("setEmbeddingStatus は embeddingStatus を 'ready' に遷移させる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", embeddingStatus: "pending" }),
      );
      expect(memory.embeddingStatus).toBe("pending");

      const updated = await store.setEmbeddingStatus(ctx, memory.id, "ready");
      expect(updated.embeddingStatus).toBe("ready");
    });

    it("setEmbeddingStatus は embeddingStatus を 'failed' にも遷移させる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      const updated = await store.setEmbeddingStatus(ctx, memory.id, "failed");
      expect(updated.embeddingStatus).toBe("failed");
    });

    it("setEmbeddingStatus は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.setEmbeddingStatus(ctx, NONEXISTENT_MEMORY_ID, "ready")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // recordUsage（D9・docs/architecture.md §3.5「挿入の成否で数える」）
    // -------------------------------------------------------------------

    it("recordUsage は同じ (recallId, memoryId) の再送に対して冪等である（D9）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const recallId = await prepareRecallId(ctx);

      const first = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(first.insertedMemoryIds).toEqual([memory.id]);

      const second = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(second.insertedMemoryIds).toEqual([]);
    });

    it("recordUsage は複数 memoryId のうち新規に挿入されたものだけを返す（部分的な再送）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryA = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const memoryB = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const recallId = await prepareRecallId(ctx);

      const first = await store.recordUsage(ctx, recallId, [memoryA.id]);
      expect(first.insertedMemoryIds).toEqual([memoryA.id]);

      // memoryA は既に記録済み、memoryB は初めて。新規に挿入されたのは memoryB だけ。
      const second = await store.recordUsage(ctx, recallId, [memoryA.id, memoryB.id]);
      expect(second.insertedMemoryIds).toEqual([memoryB.id]);
    });

    it("recordUsage は空配列に対して何も挿入しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const recallId = await prepareRecallId(ctx);

      const result = await store.recordUsage(ctx, recallId, []);
      expect(result.insertedMemoryIds).toEqual([]);
    });

    // -------------------------------------------------------------------
    // reinforce（docs/memory-model.md §7、ADR 0010）
    // -------------------------------------------------------------------

    it("reinforce は last_reinforced_at と decay_floor_at を更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const before = memory.decayFloorAt.getTime();

      const reinforcedAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 24 * 30);
      const reinforced = await store.reinforce(ctx, memory.id, reinforcedAt);

      expect(reinforced.lastReinforcedAt?.getTime()).toBe(reinforcedAt.getTime());
      expect(reinforced.decayFloorAt.getTime()).not.toBe(before);
    });

    it("⚠ reinforce は strength を動かさない（ADR 0041）", async () => {
      // **「強化」の意味は `last_reinforced_at`（＝減衰の起点が動く）と
      // `decay_floor_at` の再計算に確定している。`strength` は初期値として設定できる欄であり、
      // `reinforce` では動かない。**
      //
      // ⚠ 初期値を **1 ではない値**にしてある。1 のままだと「`strength` を 1 で上書きする」
      // 実装や「`strength` に `decay` を掛ける」実装（1×何かが 1 に見える場合）を
      // この検査が通してしまう。0.42 は他のどの既定値とも一致しない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const initialStrength = 0.42;
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", strength: initialStrength }),
      );
      expect(memory.strength).toBeCloseTo(initialStrength, 6);

      const reinforcedAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 24 * 30);
      const reinforced = await store.reinforce(ctx, memory.id, reinforcedAt);

      // 前提: reinforce 自体は効いている（何も起きていないなら「変わらない」は無意味な緑）。
      expect(reinforced.lastReinforcedAt?.getTime()).toBe(reinforcedAt.getTime());
      // 本題: strength は1ミリも動かない。
      expect(reinforced.strength).toBeCloseTo(initialStrength, 6);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reloaded = await store.get(ctx, memory.id);
      expect(reloaded?.strength).toBeCloseTo(initialStrength, 6);
    });

    it("reinforce は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.reinforce(ctx, NONEXISTENT_MEMORY_ID, new Date())).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // updateStatus（docs/memory-model.md §5）
    // -------------------------------------------------------------------

    it("updateStatus は status を更新し、supersededById を任意で設定できる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const oldMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const newMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );

      const updated = await store.updateStatus(ctx, oldMemory.id, "superseded", {
        supersededById: newMemory.id,
      });

      expect(updated.status).toBe("superseded");
      expect(updated.supersededById).toBe(newMemory.id);
    });

    it("updateStatus は opts を省略すると supersededById を変えない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      const updated = await store.updateStatus(ctx, memory.id, "archived");

      expect(updated.status).toBe("archived");
      expect(updated.supersededById ?? null).toBe(memory.supersededById ?? null);
    });

    it("updateStatus は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.updateStatus(ctx, NONEXISTENT_MEMORY_ID, "archived")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // updateStatus の expectedStatus（compare-and-swap、ADR 0030・安全弁3）
    // -------------------------------------------------------------------

    it("updateStatus は expectedStatus が現在の status と一致すれば更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      expect(memory.status).toBe("active");

      const updated = await store.updateStatus(ctx, memory.id, "superseded", {
        expectedStatus: "active",
      });

      expect(updated.status).toBe("superseded");
    });

    it("updateStatus は expectedStatus が現在の status と不一致なら MemoryStatusConflictError を投げ、行を一切変えない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived"); // 現在の status を archived にしておく

      await expect(
        store.updateStatus(ctx, memory.id, "superseded", { expectedStatus: "active" }),
      ).rejects.toBeInstanceOf(MemoryStatusConflictError);

      // 読み直して、行が一切変わっていないことを確認する（黙って部分的に書かれていない）。
      const unchanged = await store.get(ctx, memory.id);
      expect(unchanged?.status).toBe("archived");
    });

    it("updateStatus は expectedStatus を渡しても、投げる MemoryStatusConflictError の observedStatus に現在の status が入る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      let caught: unknown;
      await store
        .updateStatus(ctx, memory.id, "superseded", { expectedStatus: "active" })
        .catch((error: unknown) => {
          caught = error;
        });

      expect(caught).toBeInstanceOf(MemoryStatusConflictError);
      const conflict = caught as MemoryStatusConflictError;
      expect(conflict.memoryId).toBe(memory.id);
      expect(conflict.expectedStatus).toBe("active");
      expect(conflict.observedStatus).toBe("archived");
    });

    it("updateStatus は expectedStatus を省略すると、今日どおり status に関係なく更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      // expectedStatus 無し——現在の status（archived）と違う値を期待していないので通る。
      const updated = await store.updateStatus(ctx, memory.id, "forgotten");
      expect(updated.status).toBe("forgotten");
    });

    it("updateStatus は存在しない id に expectedStatus を渡しても、競合ではなく『対象が無い』の例外になる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // `.rejects.not.toBeInstanceOf(MemoryStatusConflictError)` だけでは
      // 「競合ではない」までしか測れず、ガード節が抜けて null 参照の TypeError に
      // すり替わっても（TypeError も MemoryStatusConflictError ではないので）緑のまま
      // になる。ADR 0030 の主張どおり「競合ではなく『対象が無い』」であることまで
      // 押さえるため、メッセージも NOT_FOUND_ERROR_MESSAGE に固定する。
      const rejection = store.updateStatus(ctx, NONEXISTENT_MEMORY_ID, "superseded", {
        expectedStatus: "active",
      });
      await expect(rejection).rejects.not.toBeInstanceOf(MemoryStatusConflictError);
      await expect(rejection).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);
    });

    // -------------------------------------------------------------------
    // updateStatusWithEvent（status 更新とイベント追記を同一トランザクションで、ADR 0031）
    //
    // 🔴 守る不変条件: memories.status の更新が永続化されたことと、対応するイベントが
    // 永続化されたことは、同値である。以下の各ケースで「Memory の状態」と「積まれた
    // イベントの数」を必ず並べて assert する——どちらか一方だけを見ると、この不変条件が
    // 崩れていても検査をすり抜けてしまう。
    // -------------------------------------------------------------------

    function buildSupersedeEvent(ctx: Ctx, memoryId: MemoryId, digest: string): NewMemoryEvent {
      return {
        tenantId: ctx.tenantId,
        memoryId,
        kind: "superseded",
        actor: { type: "system" },
        digestSnapshot: digest,
        sizeBeforeBytes: null,
        meta: { reason: "conformance-test" },
      };
    }

    it("updateStatusWithEvent は成功時、Memory を更新し、かつイベントを1件積む", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      expect(memory.status).toBe("active");

      const { memory: updated, event } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { expectedStatus: "active" },
        buildSupersedeEvent(ctx, memory.id, memory.digest),
      );

      expect(updated.status).toBe("superseded");
      expect(event.kind).toBe("superseded");
      expect(event.memoryId).toBe(memory.id);

      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("superseded");
    });

    it("updateStatusWithEvent は CAS に弾かれたら MemoryStatusConflictError を投げ、Memory は一切変わらず、イベントも1件も積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived"); // 現在の status を archived にしておく

      await expect(
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "superseded",
          { expectedStatus: "active" },
          buildSupersedeEvent(ctx, memory.id, memory.digest),
        ),
      ).rejects.toBeInstanceOf(MemoryStatusConflictError);

      // 行が一切変わっていない（黙って部分的に書かれていない）。
      const unchanged = await store.get(ctx, memory.id);
      expect(unchanged?.status).toBe("archived");

      // イベントも1件も積まれていない。
      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toEqual([]);
    });

    it("updateStatusWithEvent は対象が無ければ『memory not found』の例外を投げ、イベントも積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // 別 PR が直した既存の "does-not-exist" 検査とは別に、well-formed だが実在しない
      // UUID を使う（`randomUUID()`）——`.rejects.toThrow()` を引数無しで使うと TypeError
      // でも通ってしまうため、メッセージまで固定する。
      const missingId = randomUUID();

      await expect(
        store.updateStatusWithEvent(
          ctx,
          missingId,
          "superseded",
          {},
          buildSupersedeEvent(ctx, missingId, "digest"),
        ),
      ).rejects.toThrow(/memory not found for tenant/);

      const events = await listEventsForMemory(ctx, missingId);
      expect(events).toEqual([]);
    });

    it("updateStatusWithEvent は expectedStatus を省略すると、今日の updateStatus どおり無条件に更新し、イベントも積む", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      const { memory: updated } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "forgotten",
        {},
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "forgotten",
          actor: { type: "human" },
          digestSnapshot: memory.digest,
          sizeBeforeBytes: null,
          meta: {},
        },
      );

      expect(updated.status).toBe("forgotten");
      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("forgotten");
    });

    // -------------------------------------------------------------------
    // aggregateScope（docs/recall.md §5 目次帯・第3階・「スコープの外延」マネージャー決定）
    // -------------------------------------------------------------------

    it("aggregateScope は subject ごとの件数を countKind 付きで返す（groups の総和 == totalInScope）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-2" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      const byKey = new Map(aggregate.groups.map((g) => [g.key, g]));

      expect(byKey.get("user-1")?.count).toBe(2);
      expect(byKey.get("user-2")?.count).toBe(1);
      expect(aggregate.totalInScope).toBe(3);
      const sumOfGroups = aggregate.groups.reduce((sum, g) => sum + g.count, 0);
      expect(sumOfGroups).toBe(aggregate.totalInScope);
      for (const group of aggregate.groups) {
        expect(["exact", "lower_bound", "unknown"]).toContain(group.countKind);
      }
    });

    it("aggregateScope は subject_id が null の群を key: null として数える（D12）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: null }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.groups).toContainEqual(
        expect.objectContaining({ axis: "subject", key: null, count: 1 }),
      );
    });

    it("aggregateScope は scope.subjectId で絞り込める", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-2" }),
      );

      const aggregate = await store.aggregateScope(ctx, { subjectId: "user-1" });
      expect(aggregate.totalInScope).toBe(1);
    });

    it("aggregateScope は status='archived' を totalInScope に含めず filteredArchived に計上する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "active" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "archived" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredArchived.count).toBe(1);
      expect(aggregate.filteredSuperseded.count).toBe(0);
      expect(aggregate.filteredForgotten.count).toBe(0);
    });

    it("aggregateScope は status='superseded' と status='forgotten' を別々に計上する（ADR 0027、束ねない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      // 件数をわざと非対称にする（3 と 5）。これは実測の歯である
      // （オーナー指摘: `count(*) OVER ()` が `hnsw.ef_search` の設定値をそのまま返して
      // `exact` を名乗っていた事故が ADR 0008 の前例にある。「数えられるはずだ」は設計の
      // 主張であって値の主張ではないので、既知の真値と突き合わせて確かめる）。
      // 1件ずつでは、取り違え（superseded と forgotten を入れ替えて数える）も
      // 束ねたまま（両方を1つの filteredStatus のような欄に合算する）も検出できない。
      // 3 と 5 なら、束ねれば合計8になり、取り違えれば 5/3 と出る——どちらも必ず落ちる。
      const SUPERSEDED_COUNT = 3;
      const FORGOTTEN_COUNT = 5;
      for (let i = 0; i < SUPERSEDED_COUNT; i++) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", status: "superseded" }),
        );
      }
      for (let i = 0; i < FORGOTTEN_COUNT; i++) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", status: "forgotten" }),
        );
      }
      // active / archived も混ぜて、フィルタの取り違え（例えば status='active' まで
      // superseded/forgotten の列に混入する）が起きていないことも同時に検査する。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "active" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "archived" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredArchived.count).toBe(1);
      expect(aggregate.filteredSuperseded.count).toBe(SUPERSEDED_COUNT);
      expect(aggregate.filteredForgotten.count).toBe(FORGOTTEN_COUNT);
      // `countKind: 'exact'` という名乗り自体を歯にする（オーナー指摘の核）。
      expect(aggregate.filteredSuperseded.countKind).toBe("exact");
      expect(aggregate.filteredForgotten.countKind).toBe("exact");
    });

    it("aggregateScope は status='contested' を totalInScope に含める（段1と同じゲート）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "contested" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(1);
    });

    it("aggregateScope は occurredAfter の外にある Memory を filteredPeriod に計上し、totalInScope から除く", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {
        occurredAfter: new Date("2025-01-01T00:00:00.000Z"),
      });
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredPeriod.count).toBe(1);
    });

    // -----------------------------------------------------------------------
    // period の境界（ADR 0039）
    //
    // **同じ規則が4箇所で実装されている**——`recall-runtime.ts` の候補フィルタ、
    // `PostgresMemoryStore.aggregateScope`、`InMemoryMemoryStore.aggregateScope`、
    // `packages/core` のテスト用 `FakeMemoryStore.aggregateScope`。
    // 2026-09-06 時点では4つとも境界を含む（`>=` / `<=`）が、**それを測る歯が無かった。**
    // ⟹ 将来どれか1つを直したとき、他が追随しないと**返る件数と `omitted` の内訳が
    // 食い違い、`omitted` が嘘をつく。**
    //
    // ⚠ この適合テストが届くのは adapter の2つ（postgres / in-memory）だけである。
    // `recall-runtime.ts` と `packages/core` の fake には届かない（届かない理由と、
    // そちらを別に測っていることは ADR 0039 に書いた）。
    //
    // ⚠ フィクスチャは非対称にする。**「境界1件 / 内側3件 / 外側5件」**にしてあるのは、
    // 対称な件数（例: 内1・外1）だと**規則を丸ごと反転させても同じ数が出て、
    // 変異が素通りする**ためである（既存の歯がまさにその形だった——内1・外1で
    // `totalInScope=1, filteredPeriod=1`。反転しても同じ値になる）。
    // -----------------------------------------------------------------------

    /** 境界1件・内側 `inside` 件・外側 `outside` 件を作る。件数は必ず互いに違える。 */
    async function seedPeriodFixture(
      store: MemoryStore,
      ctx: Ctx,
      opts: { boundary: Date; inside: Date; outside: Date; inside_n: number; outside_n: number },
    ): Promise<void> {
      const make = async (occurredAt: Date, tag: string, n: number) => {
        for (let i = 0; i < n; i += 1) {
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              occurredAt,
              contentHash: `period-${tag}-${i}`,
            }),
          );
        }
      };
      await make(opts.boundary, "boundary", 1);
      await make(opts.inside, "inside", opts.inside_n);
      await make(opts.outside, "outside", opts.outside_n);
    }

    const PERIOD_CUTOFF = new Date("2026-06-01T00:00:00.000Z");
    const PERIOD_BEFORE_CUTOFF = new Date("2026-05-01T00:00:00.000Z");
    const PERIOD_AFTER_CUTOFF = new Date("2026-07-01T00:00:00.000Z");

    it("aggregateScope の occurredAfter は境界を含む（occurredAt === occurredAfter は残る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_AFTER_CUTOFF,
        outside: PERIOD_BEFORE_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, { occurredAfter: PERIOD_CUTOFF });
      // 境界1 + 内側3 = 4 が残り、外側5が落ちる。4 !== 5 なので、規則を反転させても
      // 境界を外しても、この2つの数の組は一致しない。
      expect(aggregate.totalInScope).toBe(4);
      expect(aggregate.filteredPeriod.count).toBe(5);
    });

    it("aggregateScope の occurredBefore は境界を含む（occurredAt === occurredBefore は残る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_BEFORE_CUTOFF,
        outside: PERIOD_AFTER_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, { occurredBefore: PERIOD_CUTOFF });
      expect(aggregate.totalInScope).toBe(4);
      expect(aggregate.filteredPeriod.count).toBe(5);
    });

    it("⚠ 鳴ってはいけない側: occurredAfter も occurredBefore も渡さなければ period は一切絞らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_AFTER_CUTOFF,
        outside: PERIOD_BEFORE_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, {});
      // 9件すべてが残り、filteredPeriod は 0。これを測らないと、
      // 「常に絞る」側へ倒しても誰も気づかない。
      expect(aggregate.totalInScope).toBe(9);
      expect(aggregate.filteredPeriod.count).toBe(0);
    });

    it("aggregateScope の period は、occurredAt が null の Memory には recordedAt を当てる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // occurredAt は渡さない（null のまま）。recordedAt だけを内側/外側に置く。
      // 件数を 2 対 7 と違えてあるので、取り違えても束ねても別の値になる。
      for (let i = 0; i < 2; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            recordedAt: PERIOD_AFTER_CUTOFF,
            contentHash: `period-null-inside-${i}`,
          }),
        );
      }
      for (let i = 0; i < 7; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            recordedAt: PERIOD_BEFORE_CUTOFF,
            contentHash: `period-null-outside-${i}`,
          }),
        );
      }

      const aggregate = await store.aggregateScope(ctx, { occurredAfter: PERIOD_CUTOFF });
      expect(aggregate.totalInScope).toBe(2);
      expect(aggregate.filteredPeriod.count).toBe(7);
    });

    it("aggregateScope は notIndexed を理由ごと（pending/failed/skipped）に分けて数え、totalInScope からは除かない", async () => {
      // 各理由の件数を**すべて異なる数**にする。同数だと、理由の取り違え
      // （例: failed を数えるべきところで skipped を数える）が起きても
      // 値が偶然一致して検出できない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const counts = { pending: 1, failed: 2, skipped: 3, ready: 4 } as const;
      for (const [embeddingStatus, n] of Object.entries(counts)) {
        for (let i = 0; i < n; i += 1) {
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              embeddingStatus: embeddingStatus as EmbeddingStatus,
            }),
          );
        }
      }

      const aggregate = await store.aggregateScope(ctx, {});
      // 索引に載っていないものも in-scope である（目次帯には現れる）。
      expect(aggregate.totalInScope).toBe(10);
      expect(aggregate.notIndexed.pending.count).toBe(1);
      expect(aggregate.notIndexed.failed.count).toBe(2);
      expect(aggregate.notIndexed.skipped.count).toBe(3);
    });

    // -------------------------------------------------------------------
    // createRecall（recall 段6「記録」。docs/recall.md §2 段6、ADR 0008）
    // -------------------------------------------------------------------

    it("createRecall は recallId を発行する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const recallId = await store.createRecall(ctx, {
        tenantId: "tenant-1",
        subjectId: null,
        query: { text: "hello" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemoryIds: [],
      });
      expect(typeof recallId).toBe("string");
      expect(recallId.length).toBeGreaterThan(0);
    });
  });
}
