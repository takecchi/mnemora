import type { MemoryStore, OutboxStore } from "@mnemora/core";
import type { MemoryStoreConformanceOptions } from "../memory-store-conformance.js";
import type { OutboxStoreConformanceOptions } from "../outbox-store-conformance.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

export function inMemoryMemoryStoreConformanceOptions(
  decorate: (store: MemoryStore) => MemoryStore = (store) => store,
): MemoryStoreConformanceOptions {
  // `createStore()` が作った instance の `events` 配列を読む必要があるので、直近のインスタンスを持ち回る。
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
    // `recordUsage` には実在の recallId が要る（既定の固定文字列は通らない）ので、`createRecall` で用意する。
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
    // `InMemoryOutboxStore` は `outboxJobs` を共有参照で受け取るので、`createStore()` が作った instance のジョブを claim する。
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
    supportsSupersedeWithNewMemories: true,
    // InMemoryMemoryStore は opts.abortIfForgotten を実装しない（渡しても無視される）。
    supportsAbortIfForgotten: false,
    supportsAbortIfSuperseded: true,
    supportsAbortIfAllConflicted: true,
    supportsPurgeExpiredEvents: true,
    supportsPurgeExpiredRecalls: true,
    supportsPurgeExpiredEventsByRetention: true,
    setEventRetention: async (ctx, retention) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("setEventRetention より先に createStore() を呼ぶ必要がある");
      }
      await new InMemoryTenantSettingsStore(
        latestMemoryStoreForEvents.activitySeq,
        latestMemoryStoreForEvents.subjectActivitySeq,
        latestMemoryStoreForEvents.eventRetentionDays,
      ).setEventRetention(ctx, retention);
    },
    listPurgedEvents: (ctx) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("listPurgedEvents より先に createStore() を呼ぶ必要がある");
      }
      return latestMemoryStoreForEvents.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.kind === "events_purged",
      );
    },
    supportsArchiveDecayed: true,
    supportsPurgeMemory: true,
    // v1.0.x の purge が残した状態（purgedAt だけ立ち、tags・attributes・claim key・label の紐付けが残る）は、内部の Map を書き換えて作る。
    supportsScrubPurged: true,
    seedLegacyPurgedRow: async (ctx, memoryId) => {
      if (!latestMemoryStoreForEvents) {
        throw new Error("seedLegacyPurgedRow より先に createStore() を呼ぶ必要がある");
      }
      const memories = (
        latestMemoryStoreForEvents as unknown as {
          memories: Map<
            string,
            { tenantId: string; content: string; digest: string; purgedAt?: Date | null }
          >;
        }
      ).memories;
      const memory = memories.get(memoryId);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(`seedLegacyPurgedRow: memory not found: ${memoryId}`);
      }
      memory.content = "[purged]";
      memory.digest = "[purged]";
      memory.purgedAt = new Date();
    },
    supportsMarkContestedPair: true,
    supportsResolveContestedPair: true,
    supportsRestoreSupersededBy: true,
    supportsPreviewRestoreSupersededBy: true,
    supportsOnlyMemoryIdsFilter: true,
    supportsLabels: true,
    supportsFindActiveByClaimKey: true,
    supportsFindContestedByClaimKey: true,
    supportsListActiveClaimPredicates: true,
    supportsResolveOrphanedContested: true,
    supportsEraseTenant: true,
    supportsMarkContestedGroup: true,
    supportsResolveContestedGroup: true,
    supportsCreateMemoriesWithOutboxAndEvents: true,
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
      // 返るジョブは複製なので、store の中の行（共有している `outboxJobs`）を書き換える。
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
    supportsEraseTenant: true,
    supportsPurgeCompletedJobs: true,
  };
}
