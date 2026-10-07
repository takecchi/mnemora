import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

async function seed() {
  const store = new InMemoryMemoryStore();
  const make = (contentHash: string, tags: string[], subjectId: string) =>
    store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash, tags, subjectId }),
    );
  const a1 = await make("skip-taxonomy-a1", ["alpha"], "user-1");
  await make("skip-taxonomy-a2", ["alpha", "beta"], "user-1");
  await make("skip-taxonomy-none", [], "user-2");
  return { store, a1 };
}

describe("InMemoryMemoryStore.aggregateScope: scopeAggregate 'skip' と taxonomyGroupCandidates", () => {
  it("対照: 'exact' なら taxonomy の群（alpha・beta・残差）が出る", async () => {
    const { store } = await seed();
    const aggregate = await store.aggregateScope(ctx, {
      taxonomyGroupCandidates: ["alpha", "beta"],
    });
    const taxonomy = aggregate.groups.filter((g) => g.axis === "taxonomy");
    expect(taxonomy).toHaveLength(3);
    expect(taxonomy.map((g) => [g.key, g.count])).toEqual(
      expect.arrayContaining([
        ["alpha", 2],
        ["beta", 1],
        [null, 1],
      ]),
    );
  });

  it("'skip' なら、taxonomyGroupCandidates を渡しても groups は空で、件数は unknown / 0 のまま", async () => {
    const { store, a1 } = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      { taxonomyGroupCandidates: ["alpha", "beta"] },
      { scopeAggregate: "skip", digestBand: { limit: 10, excludeMemoryIds: [] } },
    );
    expect(aggregate.groups).toEqual([]);
    expect(aggregate.totalInScope).toBe(0);
    expect(aggregate.countKind).toBe("unknown");
    expect(aggregate.filteredTaxonomy).toEqual({ count: 0, countKind: "unknown" });
    expect(aggregate.digests.map((d) => d.memoryId)).toContain(a1.id);
  });
});
