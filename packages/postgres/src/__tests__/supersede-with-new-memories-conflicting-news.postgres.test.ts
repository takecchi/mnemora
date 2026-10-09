import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `news` が既存行と衝突して `created: false` になった要素は、ジョブもラベルの提案回数も積まない。
 * 衝突は、同じ observation・extractorVersion・contentHash の既存行で起こす。
 */

const TENANT = "supersede-conflicting-news-tenant";
const ctx: Ctx = { tenantId: TENANT };

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore.supersedeWithNewMemories: 既存行と衝突した news は副作用を積まない（本物の Postgres）", () => {
  let store: PostgresMemoryStore;
  let countOutbox: () => Promise<number>;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    store = new PostgresMemoryStore(db);
    countOutbox = async () => {
      const r = await pool.query(`SELECT count(*)::int AS c FROM outbox WHERE tenant_id = $1`, [
        TENANT,
      ]);
      return r.rows[0].c as number;
    };
  });

  it("created: false の要素の jobKinds は、outbox に行を積まない", async () => {
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: TENANT }),
    );
    const input = buildNewMemoryFixture({
      tenantId: TENANT,
      contentHash: "conflict-job-hash",
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      digest: "既存",
    });
    const existing = await store.createMemory(ctx, input);
    expect(await countOutbox()).toBe(0);

    const result = await store.supersedeWithNewMemories(
      ctx,
      [{ input, jobKinds: ["embed", "consolidate"] }],
      [],
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.created).toBe(false);
    expect(result.created[0]!.memory.id).toBe(existing.id);
    expect(result.created[0]!.jobs).toEqual([]);
    expect(await countOutbox()).toBe(0);
  });

  it("created: false の要素の tags は、ラベルの proposedCount を増やさない", async () => {
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: TENANT }),
    );
    const input = buildNewMemoryFixture({
      tenantId: TENANT,
      contentHash: "conflict-label-hash",
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      digest: "既存",
      tags: ["conflict-label-a", "conflict-label-b"],
    });
    await store.createMemory(ctx, input);
    const before = await store.listLabels(ctx);
    expect(before.map((l) => l.name).sort()).toEqual(["conflict-label-a", "conflict-label-b"]);

    const result = await store.supersedeWithNewMemories(ctx, [{ input, jobKinds: [] }], []);

    expect(result.created[0]!.created).toBe(false);
    const after = await store.listLabels(ctx);
    expect(after.map((l) => [l.name, l.proposedCount])).toEqual(
      before.map((l) => [l.name, l.proposedCount]),
    );
  });
});
