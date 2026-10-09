import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 目次帯の digest は切り詰めず、生のまま返す。長い digest（コードポイントで数えて200超）で、通常と skip の両方を見る。 */

const TENANT = "digest-band-full-digest-tenant";
const ctx: Ctx = { tenantId: TENANT };
const longDigest = `${"あ".repeat(250)}-末尾`;
const shortDigest = "短い要旨";

describe("PostgresMemoryStore.aggregateScope: 目次帯の digest は切り詰めない（本物の Postgres）", () => {
  let store: PostgresMemoryStore;
  let longId: MemoryId;
  let shortId: MemoryId;

  beforeAll(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
    const long = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "full-digest-long",
        digest: longDigest,
        recordedAt: new Date("2026-03-02T00:00:00.000Z"),
      }),
    );
    const short = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "full-digest-short",
        digest: shortDigest,
        recordedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    );
    longId = long.id;
    shortId = short.id;
  }, 60_000);

  afterAll(async () => {
    await closeTestClient();
  });

  it.each(["exact", "skip"] as const)(
    "scopeAggregate: %s のとき、長い digest が元のまま返る",
    async (scopeAggregate) => {
      const result = await store.aggregateScope(
        ctx,
        {},
        { scopeAggregate, digestBand: { limit: 10, excludeMemoryIds: [] } },
      );
      const byId = new Map(result.digests.map((d) => [d.memoryId, d.digest]));
      expect(byId.get(longId)).toBe(longDigest);
      expect(byId.get(shortId)).toBe(shortDigest);
    },
  );
});
