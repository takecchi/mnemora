import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date(NOW.getTime() - 1_000);
const FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365);

describe("InMemoryMemoryStore.aggregateScope: labels で落ちた記憶は decayed に数えない", () => {
  it("ラベルに合う減衰しきった記憶だけが decayed、合わない減衰しきった記憶は taxonomy に数える", async () => {
    const store = new InMemoryMemoryStore();
    const add = (hash: string, tags: string[], decayFloorAt: Date) =>
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: hash, tags, decayFloorAt }),
      );
    await add("matching-decayed", ["alpha"], PAST);
    await add("mismatching-decayed", ["beta"], PAST);
    await add("matching-alive", ["alpha"], FUTURE);

    const aggregate = await store.aggregateScope(ctx, {
      labels: ["alpha"],
      decayFloorAtAfter: NOW,
    });

    expect({
      decayed: aggregate.filteredDecayed.count,
      taxonomy: aggregate.filteredTaxonomy?.count,
      totalInScope: aggregate.totalInScope,
    }).toEqual({ decayed: 1, taxonomy: 1, totalInScope: 2 });
  });
});
