import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore, InMemoryOutboxStore } from "../fixtures.js";
import { describeLoneSurrogateFffd, type LoneSurrogateKit } from "./lone-surrogate-fffd-teeth.js";

/** ADR 0543: `InMemoryMemoryStore` に当てる。本文は lone-surrogate-fffd-teeth.ts（PG・Fake と同じ）。 */
async function makeKit(): Promise<LoneSurrogateKit> {
  const store = new InMemoryMemoryStore();
  return {
    store,
    listEvents: async (ctx: Ctx) => store.events.filter((e) => e.tenantId === ctx.tenantId),
    claimBatch: (ctx, opts) => new InMemoryOutboxStore(store.outboxJobs).claimBatch(ctx, opts),
  };
}

describeLoneSurrogateFffd("InMemoryMemoryStore", makeKit);
