import type { Ctx } from "@mnemora/core";
import {
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
} from "../fixtures.js";
import { describeRound31Teeth, type Round31Kit } from "./memory-store-round31-teeth.js";

/** 31巡目（ADR 0458）: `InMemoryMemoryStore` に当てる。本文は memory-store-round31-teeth.ts（PG と同じ）。 */
async function makeKit(): Promise<Round31Kit> {
  const store = new InMemoryMemoryStore();
  const settings = new InMemoryTenantSettingsStore(
    store.activitySeq,
    store.subjectActivitySeq,
    store.eventRetentionDays,
  );
  const relations = new InMemoryRelationStore(store, store.relations);
  return {
    store,
    listEvents: async (ctx: Ctx, memoryId) =>
      store.events.filter(
        (e) => e.tenantId === ctx.tenantId && (memoryId === undefined || e.memoryId === memoryId),
      ),
    relatedIds: async (ctx, id) => (await relations.listRelated(ctx, id)).map((r) => r.memoryId),
    linkContradicts: (ctx, fromId, toId) => relations.link(ctx, "contradicts", fromId, toId),
    setRetention: async (ctx, days) =>
      settings.setEventRetention(
        ctx,
        days === "unlimited" ? { kind: "unlimited" } : { kind: "days", days },
      ),
    activitySeq: async (ctx) => settings.getActivitySeq(ctx),
    claimEmbedJobs: (ctx, now) =>
      new InMemoryOutboxStore(store.outboxJobs).claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now,
        claimedBy: "r31",
        leaseMs: 60_000,
      }),
    seedLegacyPurged: async (ctx, memoryId) => {
      const row = (
        store as unknown as {
          memories: Map<
            string,
            { tenantId: string; content: string; digest: string; purgedAt?: Date | null }
          >;
        }
      ).memories.get(memoryId);
      if (!row || row.tenantId !== ctx.tenantId) throw new Error("seedLegacyPurged: not found");
      row.content = "[purged]";
      row.digest = "[purged]";
      row.purgedAt = new Date();
    },
  };
}

describeRound31Teeth("InMemoryMemoryStore", makeKit, {
  implementsAbortIfForgotten: false,
  jsonbRejectsLoneSurrogate: false,
  claimKeyIndexLimit: false,
});
