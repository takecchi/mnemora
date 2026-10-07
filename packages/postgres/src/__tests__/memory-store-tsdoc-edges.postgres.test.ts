import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: `memory-store-tsdoc-edges-${randomUUID()}` };
const memory = (overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) =>
  buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `tsdoc-edges-${randomUUID()}`,
    ...overrides,
  });

async function kit() {
  const { db } = await getTestClient();
  return { db, store: new PostgresMemoryStore(db), outbox: new PostgresOutboxStore(db) };
}

interface OutboxRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  last_error: string | null;
}

describe("PostgresMemoryStore: MemoryStore の TSDoc の端", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("listBySourceObservation: null を渡すと、その Observation の extractorVersion が null の行だけを返す", async () => {
    const { store } = await kit();
    const obs = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const other = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const nullA = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const nullB = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: null }),
    );
    const v1 = await store.createMemory(
      ctx,
      memory({ sourceObservationId: obs.id, extractorVersion: "v1" }),
    );
    await store.createMemory(
      ctx,
      memory({ sourceObservationId: other.id, extractorVersion: null }),
    );

    const ids = async (version: string | null) =>
      (await store.listBySourceObservation(ctx, obs.id, version)).map((m) => m.id).sort();

    expect({ null: await ids(null), v1: await ids("v1") }).toEqual({
      null: [nullA.id, nullB.id].sort(),
      v1: [v1.id],
    });
  });

  it("requeueEmbedJobs: updatedAt の古い順・同着は id の昇順で選び、繰り返すと一巡する", async () => {
    const { db, store } = await kit();
    const late = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    const tieX = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    const tieY = await store.createMemory(ctx, memory({ embeddingStatus: "pending" }));
    await db.execute(sql`
      UPDATE memories SET updated_at = CASE id
        WHEN ${late.id}::uuid THEN '2026-01-01T00:00:02.000Z'::timestamptz
        ELSE '2026-01-01T00:00:01.000Z'::timestamptz END
      WHERE tenant_id = ${ctx.tenantId}
    `);
    const ties = [tieX.id, tieY.id].sort();

    const picks: string[][] = [];
    for (let i = 0; i < 3; i += 1) {
      picks.push(
        (await store.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 1 })).memoryIds,
      );
    }

    expect(picks).toEqual([[ties[0]], [ties[1]], [late.id]]);
  });

  it("requeueEmbedJobs: 失敗済みの古い embed 行には触らず、新しい行を attempts 0 で積む", async () => {
    const { db, store, outbox } = await kit();
    const { memory: m, jobs } = await store.createMemoryWithOutbox(ctx, memory(), ["embed"]);
    const [claimed] = await outbox.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(Date.now() + 1_000),
      claimedBy: "worker-1",
      leaseMs: 60_000,
    });
    await outbox.fail(ctx, claimed!.id, "boom", claimed!.attempts);
    await store.setEmbeddingStatus(ctx, m.id, "failed");
    const rows = async () =>
      (
        await db.execute<OutboxRow & Record<string, unknown>>(sql`
          SELECT id::text AS id, kind, payload, attempts, claimed_at::text AS claimed_at,
                 completed_at::text AS completed_at, failed_at::text AS failed_at, last_error
          FROM outbox WHERE tenant_id = ${ctx.tenantId}
        `)
      ).rows as unknown as OutboxRow[];
    const oldBefore = (await rows()).find((r) => r.id === jobs[0]!.id)!;
    expect({ attempts: oldBefore.attempts, lastError: oldBefore.last_error }).toEqual({
      attempts: 1,
      lastError: "boom",
    });
    expect(oldBefore.failed_at).not.toBeNull();

    await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

    const after = await rows();
    expect({
      old: after.find((r) => r.id === jobs[0]!.id),
      newJobs: after
        .filter((r) => r.id !== jobs[0]!.id)
        .map((r) => ({
          kind: r.kind,
          payload: r.payload,
          attempts: r.attempts,
          claimedAt: r.claimed_at,
          completedAt: r.completed_at,
          failedAt: r.failed_at,
        })),
    }).toEqual({
      old: oldBefore,
      newJobs: [
        {
          kind: "embed",
          payload: { memoryId: m.id },
          attempts: 0,
          claimedAt: null,
          completedAt: null,
          failedAt: null,
        },
      ],
    });
  });

  it("supersedeWithNewMemories: 呼び出し側が渡した meta.supersededById は、解決したアンカーの id で上書きし、meta の他の欄は変えない", async () => {
    const { db, store } = await kit();
    const old = await store.createMemory(ctx, memory());
    const decoy = await store.createMemory(ctx, memory());
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: old.digest,
      sizeBeforeBytes: null,
      meta: { reason: "caller-reason", supersededById: decoy.id, note: "keep" },
    };

    const result = await store.supersedeWithNewMemories(
      ctx,
      [{ input: memory({ content: "anchor" }), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event }],
    );

    const anchorId = result.created[0]!.memory.id;
    const stored = (
      await db.execute<{ meta: unknown } & Record<string, unknown>>(sql`
        SELECT meta FROM memory_events
        WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${old.id}::uuid AND kind = 'superseded'
      `)
    ).rows.map((r) => r.meta);
    const expected = { reason: "caller-reason", supersededById: anchorId, note: "keep" };
    expect(anchorId).not.toBe(decoy.id);
    expect({ returned: result.superseded.map((e) => e.meta), stored }).toEqual({
      returned: [expected],
      stored: [expected],
    });
  });
});
