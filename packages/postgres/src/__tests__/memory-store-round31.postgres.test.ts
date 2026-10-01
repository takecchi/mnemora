import { afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import {
  describeRound31Teeth,
  type Round31Kit,
} from "../../../testkit/src/__tests__/memory-store-round31-teeth.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 31巡目（ADR 0458）: `PostgresMemoryStore` に当てる。本文は testkit の memory-store-round31-teeth.ts（IM と同じ）。 */
afterAll(async () => {
  await closeTestClient();
});

async function makeKit(): Promise<Round31Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const events = new PostgresEventStore(db);
  const settings = new PostgresTenantSettingsStore(db);
  const relations = new PostgresRelationStore(db);
  return {
    store: new PostgresMemoryStore(db),
    listEvents: (ctx: Ctx, memoryId) =>
      events.list(ctx, memoryId === undefined ? {} : { memoryId }),
    relatedIds: async (ctx, id) => (await relations.listRelated(ctx, id)).map((r) => r.memoryId),
    setRetention: (ctx, days) =>
      settings.setEventRetention(
        ctx,
        days === "unlimited" ? { kind: "unlimited" } : { kind: "days", days },
      ),
    activitySeq: (ctx) => settings.getActivitySeq(ctx),
    claimEmbedJobs: (ctx, now) =>
      new PostgresOutboxStore(db).claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now,
        claimedBy: "r31",
        leaseMs: 60_000,
      }),
    seedLegacyPurged: async (ctx, memoryId) => {
      await db.execute(sql`
        UPDATE memories SET content = '[purged]', digest = '[purged]', purged_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${memoryId}`);
    },
  };
}

describeRound31Teeth("PostgresMemoryStore", makeKit, {
  implementsAbortIfForgotten: true,
  loneSurrogateText: "replace",
  jsonbRejectsLoneSurrogate: true,
  claimKeyIndexLimit: true,
});
