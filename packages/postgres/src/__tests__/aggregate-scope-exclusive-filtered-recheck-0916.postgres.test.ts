import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: `exclusive-filtered-${randomUUID()}` };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const OUT_OF_PERIOD = new Date("2020-01-01T00:00:00.000Z");
const IN_PERIOD = new Date("2026-05-01T00:00:00.000Z");
const PAST = new Date(NOW.getTime() - 1_000);

describe("PostgresMemoryStore.aggregateScope: 落ちた理由は1件につき1つだけに数える", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function seed(overrides: {
    occurredAt?: Date;
    validUntil?: Date;
    tags?: string[];
    archived?: boolean;
  }) {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `h-${randomUUID()}`,
        occurredAt: overrides.occurredAt ?? IN_PERIOD,
        validUntil: overrides.validUntil,
        tags: overrides.tags ?? ["alpha"],
      }),
    );
    if (overrides.archived === true) {
      await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "archived",
        {},
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "archived",
          actor: { type: "system" },
          digestSnapshot: memory.digest,
          meta: {},
        },
      );
    }
    return store;
  }

  const scope = {
    occurredAfter: new Date("2026-01-01T00:00:00.000Z"),
    validAt: NOW,
    labels: ["alpha"],
  };

  it("archived で期間外の記憶は archived にだけ数え、period には数えない", async () => {
    const store = await seed({ occurredAt: OUT_OF_PERIOD, archived: true });
    const a = await store.aggregateScope(ctx, scope);
    expect({ archived: a.filteredArchived.count, period: a.filteredPeriod.count }).toEqual({
      archived: 1,
      period: 0,
    });
  });

  it("期間外で期限切れの記憶は period にだけ数え、expired には数えない", async () => {
    const store = await seed({ occurredAt: OUT_OF_PERIOD, validUntil: PAST });
    const a = await store.aggregateScope(ctx, scope);
    expect({ period: a.filteredPeriod.count, expired: a.filteredExpired.count }).toEqual({
      period: 1,
      expired: 0,
    });
  });

  it("期限切れでラベルも合わない記憶は expired にだけ数え、taxonomy には数えない", async () => {
    const store = await seed({ validUntil: PAST, tags: ["beta"] });
    const a = await store.aggregateScope(ctx, scope);
    expect({ expired: a.filteredExpired.count, taxonomy: a.filteredTaxonomy?.count }).toEqual({
      expired: 1,
      taxonomy: 0,
    });
  });
});
