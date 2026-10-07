import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: `decayed-label-mismatch-${randomUUID()}` };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date(NOW.getTime() - 1_000);
const FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365);

describe("PostgresMemoryStore.aggregateScope: labels で落ちた記憶は decayed に数えない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("ラベルに合う減衰しきった記憶だけが decayed、合わない減衰しきった記憶は taxonomy に数える", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const add = (hash: string, tags: string[], decayFloorAt: Date) =>
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `${hash}-${randomUUID()}`,
          tags,
          decayFloorAt,
        }),
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
