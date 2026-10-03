import type { Ctx } from "@mnemora/core";
import {
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryVectorStore,
} from "../fixtures.js";
import {
  describeLoneSurrogateFffd,
  LEXICAL_PROBE,
  type LoneSurrogateKit,
} from "./lone-surrogate-fffd-teeth.js";

const SPACE = { provider: "test", model: "fixture-model", dimensions: 3 };

/** ADR 0543: `InMemoryMemoryStore` に当てる。本文は lone-surrogate-fffd-teeth.ts（PG・Fake と同じ）。 */
async function makeKit(): Promise<LoneSurrogateKit> {
  const store = new InMemoryMemoryStore();
  return {
    store,
    jsonbRejectsLoneSurrogate: false,
    listEvents: async (ctx: Ctx) => store.events.filter((e) => e.tenantId === ctx.tenantId),
    claimBatch: (ctx, opts) => new InMemoryOutboxStore(store.outboxJobs).claimBatch(ctx, opts),
    searchByLabels: async (ctx, memoryId, labels) => {
      const vec = new InMemoryVectorStore(store);
      await vec.upsert(ctx, SPACE, memoryId, [1, 0, 0]);
      const filter = { tenantId: ctx.tenantId, labels };
      const v = await vec.search(ctx, SPACE, [1, 0, 0], { limit: 10, filter });
      const l = await new InMemoryLexicalStore(store).search(ctx, LEXICAL_PROBE.query, {
        limit: 10,
        filter,
      });
      return { vector: v.map((h) => h.memoryId), lexical: l.map((h) => h.memoryId) };
    },
  };
}

describeLoneSurrogateFffd("InMemoryMemoryStore", makeKit);
