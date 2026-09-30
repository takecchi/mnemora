// 適合テストに当てる in-memory 実装の設定（ADR 0418 の追記）。
// `in-memory-fixtures.conformance.test.ts`（そのまま）と `foreign-realm-conformance.test.ts`
// （store が投げる core の例外を別 realm のものに差し替える包み）が同じ設定を共有する。
import type { MemoryStore, OutboxStore } from "@mnemora/core";
import type { MemoryStoreConformanceOptions } from "../memory-store-conformance.js";
import type { OutboxStoreConformanceOptions } from "../outbox-store-conformance.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

export function inMemoryMemoryStoreConformanceOptions(
  decorate: (store: MemoryStore) => MemoryStore = (store) => store,
): MemoryStoreConformanceOptions {
  // `listEventsForMemory`（ADR 0031）も `seedJob`/`setDefaultHalfLifeHours` と同じ理由で
  // 直近のインスタンスを持ち回る——`updateStatusWithEvent` が積んだイベントを読むには、
  // `createStore()` が作った、まさにその `InMemoryMemoryStore` インスタンスの `events` 配列を
  // 見る必要がある。
  let latestMemoryStoreForEvents: InMemoryMemoryStore | undefined;
  return {
    name: "in-memory placeholder",
    createStore: () => {
      const store = new InMemoryMemoryStore();
      latestMemoryStoreForEvents = store;
      return decorate(store);
    },
    listEventsForMemory: (ctx, memoryId) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("listEventsForMemory より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForEvents.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.memoryId === memoryId,
      );
    },
    // ADR 0047: `recall_usages.recall_id → recalls(id)` の外部キーを `InMemoryMemoryStore`
    // にも適用したことで、`recordUsage` の適合テストには実在の recallId が要る
    // （既定の固定文字列 `"recall-1"` はもう通らない）。`MemoryStore.createRecall` は
    // 本体がまさに用意している「recall を記録する」書き込み口そのものなので、それを使う
    // （`memory-store-conformance.ts` の「createRecall は recallId を発行する」の歯と
    // 同じ最小フィクスチャ）。
    prepareRecallId: async (ctx) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("prepareRecallId より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForEvents.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        query: { text: "fixture" },
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
        returnedMemories: [],
      });
    },
    // ADR 0079: 積み直した `embed` ジョブを、運搬役が実際に claim できるところまで見る。
    // `InMemoryOutboxStore` は `InMemoryMemoryStore.outboxJobs` の配列を共有参照で受け取る
    // ——`createStore()` が作った、まさにその instance のジョブを claim する必要がある
    // （`listEventsForMemory` と同じ理由・同じ形）。
    // `leaseMs` はこの検査の中だけの値であり、実運用のリース長とは無関係（ADR 0032）。
    claimEmbedJobs: (ctx, now) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("claimEmbedJobs より先に createStore() を呼ぶ必要がある");
      }
      return new InMemoryOutboxStore(latestMemoryStoreForEvents.outboxJobs).claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now,
        claimedBy: "conformance-requeue",
        leaseMs: 60_000,
      });
    },
    // Issue #134 / ADR 0100: InMemoryMemoryStore は supersedeWithNewMemories を実装している。
    supportsSupersedeWithNewMemories: true,
    // Issue #1226 / ADR 0375 決定7: InMemoryMemoryStore は opts.abortIfForgotten を実装
    // しない（渡しても無視される。`SourceMemoryForgottenError` の doc コメント参照）。
    supportsAbortIfForgotten: false,
    // Issue #210 / ADR 0115: InMemoryMemoryStore は purgeExpiredEvents を実装している。
    supportsPurgeExpiredEvents: true,
    // ADR 0404: InMemoryMemoryStore は purgeExpiredRecalls を実装している。
    supportsPurgeExpiredRecalls: true,
    listPurgedEvents: (ctx) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("listPurgedEvents より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForEvents.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.kind === "events_purged",
      );
    },
    // ADR 0114: InMemoryMemoryStore は archiveDecayed を実装している。
    supportsArchiveDecayed: true,
    // Issue #198 / ADR 0124: InMemoryMemoryStore は purgeMemory を実装している。
    supportsPurgeMemory: true,
    // Issue #197 / ADR 0134: InMemoryMemoryStore は markContestedPair を実装している。
    supportsMarkContestedPair: true,
    // Issue #197 / ADR 0150: InMemoryMemoryStore は resolveContestedPair を実装している。
    supportsResolveContestedPair: true,
    // 本 PR: InMemoryMemoryStore は restoreSupersededBy を実装している。
    supportsRestoreSupersededBy: true,
    // Issue #515: InMemoryMemoryStore は previewRestoreSupersededBy を実装している。
    supportsPreviewRestoreSupersededBy: true,
    // Issue #515 方向①、ADR 0258: InMemoryMemoryStore は onlyMemoryIds フィルタを
    // 実装している。
    supportsOnlyMemoryIdsFilter: true,
    // Issue #201 / ADR 0318: InMemoryMemoryStore は listLabels/registerLabel を
    // 実装している。
    supportsLabels: true,
    // Issue #372: InMemoryMemoryStore は findActiveByClaimKey を実装している。
    supportsFindActiveByClaimKey: true,
    // Issue #933 案2 / ADR 0378: InMemoryMemoryStore は findContestedByClaimKey を実装している。
    supportsFindContestedByClaimKey: true,
    // Issue #691続き / ADR 0329: InMemoryMemoryStore は listActiveClaimPredicates を
    // 実装している。
    supportsListActiveClaimPredicates: true,
    // Issue #1412 コメント1 / ADR 0373: InMemoryMemoryStore は resolveOrphanedContested を
    // 実装している。
    supportsResolveOrphanedContested: true,
    // Issue #1207 / ADR 0383: InMemoryMemoryStore は eraseTenant を実装している。
    supportsEraseTenant: true,
    // Issue #207/#933 PR2 / ADR 0381: InMemoryMemoryStore は markContestedGroup /
    // resolveContestedGroup を実装している。
    supportsMarkContestedGroup: true,
    supportsResolveContestedGroup: true,
    // ADR 0410（穴 D-3）: InMemoryMemoryStore は createMemoriesWithOutboxAndEvents を実装している。
    supportsCreateMemoriesWithOutboxAndEvents: true,
    // ADR 0416: supersedeWithNewMemories の opts.buildCreatedEvent（created を events 配列へ、supersede の前に積む）。
    supportsSupersedeCreatedEvents: true,
    listRelationsForMemory: (ctx, memoryId) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("listRelationsForMemory より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForEvents.relations
        .filter((r) => r.tenantId === ctx.tenantId && r.fromMemoryId === memoryId)
        .map((r) => ({ memoryId: r.toMemoryId }));
    },
  };
}

export function inMemoryOutboxStoreConformanceOptions(
  decorate: (store: OutboxStore) => OutboxStore = (store) => store,
): OutboxStoreConformanceOptions {
  // `seedJob` が `createStore()` の作った `MemoryStore`（同じジョブ配列を共有する側）を参照できるよう、直近のインスタンスを持ち回る。
  let latestMemoryStoreForOutboxSeed: InMemoryMemoryStore | undefined;
  return {
    name: "in-memory placeholder",
    createStore: () => {
      const memoryStore = new InMemoryMemoryStore();
      latestMemoryStoreForOutboxSeed = memoryStore;
      return decorate(new InMemoryOutboxStore(memoryStore.outboxJobs));
    },
    seedJob: async (ctx, input) => {
      if (!latestMemoryStoreForOutboxSeed) {
        throw new Error("seedJob より先に createStore() を呼ぶ必要がある");
      }
      const { jobs } = await latestMemoryStoreForOutboxSeed.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: {},
        },
        [input.kind],
      );
      // Issue #1108: 返るジョブは複製なので、store の中の行（共有している `outboxJobs`）を書き換える。
      const job = latestMemoryStoreForOutboxSeed.outboxJobs.find((j) => j.id === jobs[0]!.id)!;
      if (input.payload) {
        job.payload = input.payload;
      }
      if (input.availableAt) {
        job.availableAt = input.availableAt;
      }
      return job;
    },
    peekJob: async (_ctx, jobId) => {
      if (!latestMemoryStoreForOutboxSeed) {
        throw new Error("peekJob より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForOutboxSeed.outboxJobs.find((j) => j.id === jobId) ?? null;
    },
    // Issue #1207 / ADR 0383: InMemoryOutboxStore は eraseTenant を実装している。
    supportsEraseTenant: true,
    // ADR 0404: InMemoryOutboxStore は purgeCompletedJobs を実装している。
    supportsPurgeCompletedJobs: true,
  };
}
