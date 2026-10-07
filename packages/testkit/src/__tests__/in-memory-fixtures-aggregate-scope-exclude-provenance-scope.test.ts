import { describe, expect, it } from "vitest";
import type { Ctx, Provenance } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };
const IN_PERIOD = new Date("2026-06-10T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-01-01T00:00:00.000Z");

const scope = {
  subjectId: "s1",
  labels: ["alpha"],
  occurredAfter: new Date("2026-06-01T00:00:00.000Z"),
};

describe("InMemoryMemoryStore.aggregateScope: excludedProvenanceIndexedCount は totalInScope と同じ絞りの内側だけを数える（Issue #1734 / PR #1458 のすり抜け）", () => {
  async function seed() {
    const store = new InMemoryMemoryStore();
    let n = 0;
    const make = (extra: Record<string, unknown> = {}) => {
      n += 1;
      return store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `exclude-prov-scope-${n}`,
          subjectId: "s1",
          tags: ["alpha"],
          recordedAt: IN_PERIOD,
          decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
          embeddingStatus: "ready",
          ...extra,
        }),
      );
    };
    await make({ provenance: consolidated });
    await make({ provenance: consolidated });
    await make({ provenance: consolidated, status: "archived" });
    await make({ provenance: consolidated, subjectId: "s2" });
    await make({ provenance: consolidated, recordedAt: BEFORE_PERIOD });
    await make({ provenance: consolidated, tags: ["beta"] });
    await make();
    return store;
  }

  it("archived・別 subject・期間の外・labels に合わない行は、除外 kind でも数えない", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(ctx, scope, {
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    expect(aggregate.totalInScope).toBe(3);
    expect(aggregate.filteredArchived.count).toBe(1);
  });
});
