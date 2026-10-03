import type { Ctx } from "@mnemora/core";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import {
  describeLoneSurrogateFffd,
  LEXICAL_PROBE,
  type LoneSurrogateKit,
} from "./lone-surrogate-fffd-teeth.js";

const SPACE = { provider: "test", model: "fixture-model", dimensions: 3 };

/**
 * ADR 0543: core のテスト用 `FakeMemoryStore` に当てる。本文は lone-surrogate-fffd-teeth.ts（PG・IM と同じ）。
 * `packages/core` は `@mnemora/testkit` を import できない（`dependency-boundary.test.ts`）ので、この歯は testkit 側に置き、
 * core の Fake を相対パスで読む（`packages/postgres` の `consolidate-reflect-sources-lowercase.postgres.test.ts` と同じ向き）。
 */
async function makeKit(): Promise<LoneSurrogateKit> {
  const stores = createFakeRuntimeStores();
  return {
    store: stores.memoryStore,
    jsonbRejectsLoneSurrogate: false,
    listEvents: async (ctx: Ctx) =>
      stores.eventStore.events.filter((e: { tenantId: string }) => e.tenantId === ctx.tenantId),
    claimBatch: (ctx, opts) => stores.outboxStore.claimBatch(ctx, opts),
    searchByLabels: async (ctx, memoryId, labels) => {
      await stores.vectorStore.upsert(ctx, SPACE, memoryId, [1, 0, 0]);
      const filter = { tenantId: ctx.tenantId, labels };
      const v = await stores.vectorStore.search(ctx, SPACE, [1, 0, 0], { limit: 10, filter });
      const l = await stores.lexicalStore.search(ctx, LEXICAL_PROBE.query, { limit: 10, filter });
      return { vector: v.map((h) => h.memoryId), lexical: l.map((h) => h.memoryId) };
    },
  };
}

describeLoneSurrogateFffd("FakeMemoryStore", makeKit);
