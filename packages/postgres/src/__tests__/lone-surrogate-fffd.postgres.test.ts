import { afterAll } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  describeLoneSurrogateFffd,
  type LoneSurrogateKit,
} from "../../../testkit/src/__tests__/lone-surrogate-fffd-teeth.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** ADR 0543: `PostgresMemoryStore` に当てる（置き換えの出所そのもの）。本文は testkit の lone-surrogate-fffd-teeth.ts。 */
afterAll(async () => {
  await closeTestClient();
});

async function makeKit(): Promise<LoneSurrogateKit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const events = new PostgresEventStore(db);
  return {
    store: new PostgresMemoryStore(db),
    listEvents: (ctx: Ctx) => events.list(ctx, {}),
    claimBatch: (ctx, opts) => new PostgresOutboxStore(db).claimBatch(ctx, opts),
  };
}

describeLoneSurrogateFffd("PostgresMemoryStore", makeKit);
