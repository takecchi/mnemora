// `InMemoryMemoryStore.aggregateScope` の `options.excludeProvenanceKinds`（ADR 0390）が返す任意の欄
// `excludedProvenanceIndexedCount`（「除外される kind で、索引済み（embeddingStatus='ready'）の行の
// 数」）の歯。**`memory-store-conformance.ts` には足さない**（Issue #809 の方針。外部 adapter へ
// 要求を増やさない）。core 側の Fake は
// `packages/core/src/__tests__/fake-aggregate-scope-exclude-provenance.test.ts`。

import { describe, expect, it } from "vitest";
import type { Ctx, Provenance } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };

async function seed() {
  const store = new InMemoryMemoryStore();
  const make = (contentHash: string, extra: Record<string, unknown>) =>
    store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash,
        embeddingStatus: "ready",
        ...extra,
      }),
    );
  await make("exclude-prov-imported", {});
  await make("exclude-prov-consolidated-1", { provenance: consolidated });
  await make("exclude-prov-consolidated-2", { provenance: consolidated });
  await make("exclude-prov-consolidated-pending", {
    provenance: consolidated,
    embeddingStatus: "pending",
  });
  return store;
}

describe("InMemoryMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390）", () => {
  it("除外 kind で索引済みの行の数を excludedProvenanceIndexedCount に返す（未索引は数えない）", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      {},
      {
        excludeProvenanceKinds: ["consolidated"],
      },
    );
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    expect(aggregate.totalInScope).toBe(4);
  });

  it("空配列は no-op: 欄は返らず、返り値全体が指定なしと同じ", async () => {
    const store = await seed();
    const withEmpty = await store.aggregateScope(ctx, {}, { excludeProvenanceKinds: [] });
    const without = await store.aggregateScope(ctx, {});
    expect(withEmpty).toEqual(without);
    expect(withEmpty.excludedProvenanceIndexedCount).toBeUndefined();
    expect(withEmpty.totalInScope).toBe(without.totalInScope);
    expect(withEmpty.groups).toEqual(without.groups);
  });

  it("scopeAggregate: 'skip' は excludeProvenanceKinds を渡しても欄を足さない（対照: 'exact' では欄が在る）", async () => {
    const store = await seed();
    const exact = await store.aggregateScope(
      ctx,
      {},
      { scopeAggregate: "exact", excludeProvenanceKinds: ["consolidated"] },
    );
    expect(exact.excludedProvenanceIndexedCount).toBe(2);

    const skipped = await store.aggregateScope(
      ctx,
      {},
      { scopeAggregate: "skip", excludeProvenanceKinds: ["consolidated"] },
    );
    expect("excludedProvenanceIndexedCount" in skipped).toBe(false);
    expect(skipped.countKind).toBe("unknown");
  });
});
