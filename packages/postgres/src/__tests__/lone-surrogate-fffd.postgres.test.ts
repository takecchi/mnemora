import { afterAll } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  describeLoneSurrogateFffd,
  LEXICAL_PROBE,
  type LoneSurrogateKit,
} from "../../../testkit/src/__tests__/lone-surrogate-fffd-teeth.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

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
    searchByLabels: async (ctx, memoryId, labels) => {
      const vec = new PostgresVectorStore(db);
      await vec.upsert(ctx, TEST_EMBEDDING_SPACE, memoryId, [1, 0, 0]);
      const filter = { tenantId: ctx.tenantId, labels };
      const v = await vec.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], { limit: 10, filter });
      const l = await new PostgresLexicalStore(db).search(ctx, LEXICAL_PROBE.query, {
        limit: 10,
        filter,
      });
      return { vector: v.map((h) => h.memoryId), lexical: l.map((h) => h.memoryId) };
    },
  };
}

describeLoneSurrogateFffd("PostgresMemoryStore", makeKit);
