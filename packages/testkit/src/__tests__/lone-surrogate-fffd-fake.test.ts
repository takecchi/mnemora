import type { Ctx } from "@mnemora/core";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { describeLoneSurrogateFffd, type LoneSurrogateKit } from "./lone-surrogate-fffd-teeth.js";

/**
 * ADR 0543: core のテスト用 `FakeMemoryStore` に当てる。本文は lone-surrogate-fffd-teeth.ts（PG・IM と同じ）。
 * `packages/core` は `@mnemora/testkit` を import できない（`dependency-boundary.test.ts`）ので、この歯は testkit 側に置き、
 * core の Fake を相対パスで読む（`packages/postgres` の `consolidate-reflect-sources-lowercase.postgres.test.ts` と同じ向き）。
 */
async function makeKit(): Promise<LoneSurrogateKit> {
  const stores = createFakeRuntimeStores();
  return {
    store: stores.memoryStore,
    listEvents: async (ctx: Ctx) =>
      stores.eventStore.events.filter((e: { tenantId: string }) => e.tenantId === ctx.tenantId),
    claimBatch: (ctx, opts) => stores.outboxStore.claimBatch(ctx, opts),
  };
}

describeLoneSurrogateFffd("FakeMemoryStore", makeKit);
