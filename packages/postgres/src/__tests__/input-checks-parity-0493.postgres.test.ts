import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/** 断る入力は、InMemory・Fake の歯が同じ入力で断ることを確かめているもの。断る側の例外の文面は Postgres のものであり、揃えていない。ここでは「断る」ことだけを見る。 */

const ctx: Ctx = { tenantId: "input-checks-0493" };
const bad = new Date("invalid");

afterAll(async () => {
  await closeTestClient();
});

async function stores() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return {
    memory: new PostgresMemoryStore(db),
    events: new PostgresEventStore(db),
    outbox: new PostgresOutboxStore(db),
    vector: new PostgresVectorStore(db),
  };
}

describe("Postgres が断る入力（InMemory・Fake が揃えた側の根拠）", () => {
  it("D1: createMemory の decayFloorAt・lastReinforcedAt が Invalid Date", async () => {
    const { memory } = await stores();
    await expect(
      memory.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, decayFloorAt: bad }),
      ),
    ).rejects.toThrow();
    await expect(
      memory.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "x2", lastReinforcedAt: bad }),
      ),
    ).rejects.toThrow();
  });

  it("D2: createObservationWithOutbox の claimedBy に NUL（行を書かないときは通る）", async () => {
    const { memory } = await stores();
    await expect(
      memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "e1" }),
        ["extract"],
        { claimedBy: "a\u0000b" },
      ),
    ).rejects.toThrow();
    await expect(
      memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "e2" }),
        [],
        { claimedBy: "a\u0000b" },
      ),
    ).resolves.toMatchObject({ created: true, jobs: [] });
  });

  for (const limit of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 63]) {
    it(`D3: eraseTenant の limit が ${limit}（MemoryStore・VectorStore・OutboxStore）`, async () => {
      const { memory, vector, outbox } = await stores();
      await expect(memory.eraseTenant(ctx, { limit })).rejects.toThrow();
      await expect(vector.eraseTenant(ctx, { limit })).rejects.toThrow();
      await expect(outbox.eraseTenant(ctx, { limit })).rejects.toThrow();
    });
  }

  it("E1: ctx.tenantId の NUL・孤立サロゲートは MalformedIdentifierError", async () => {
    const { memory, events } = await stores();
    for (const tenantId of ["a\u0000b", "a\ud800b"]) {
      await expect(memory.get({ tenantId }, "x")).rejects.toMatchObject({
        name: "MalformedIdentifierError",
      });
      await expect(events.list({ tenantId }, {})).rejects.toMatchObject({
        name: "MalformedIdentifierError",
      });
    }
  });

  it("E2・E3: aggregateScope の scope・VectorStore.search の絞りの Invalid Date・非整数の通し番号", async () => {
    const { memory, vector } = await stores();
    for (const scope of [
      { occurredAfter: bad },
      { validAt: bad },
      { decayFloorAtAfter: bad },
      { decayFloorSeqAfter: 1.5 },
      { decayFloorSeqAfter: Number.NaN },
    ]) {
      await expect(memory.aggregateScope(ctx, scope)).rejects.toThrow();
    }
    for (const filter of [{ decayFloorAtAfter: bad }, { decayFloorSeqAfter: 1.5 }]) {
      await expect(
        vector.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
          limit: 5,
          filter: { tenantId: ctx.tenantId, ...filter },
        }),
      ).rejects.toThrow();
    }
  });

  it("E4: イベントの actor・meta・digestSnapshot の NUL、BigInt、sizeBeforeBytes の int4 外", async () => {
    const { events } = await stores();
    const base = {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "created" as const,
      actor: { type: "system" as const },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: {},
    };
    for (const over of [
      { actor: { type: "user", id: "a\u0000" } as never },
      { meta: { a: "x\u0000" } },
      { meta: { a: 1n } },
      { digestSnapshot: "a\u0000" },
      { sizeBeforeBytes: 1.5 },
      { sizeBeforeBytes: 2 ** 31 },
      { sizeBeforeBytes: Number.NaN },
    ]) {
      await expect(events.append(ctx, { ...base, ...over })).rejects.toThrow();
    }
  });

  it("E5・E6: reinforce の nowSeq、createMemory の活動時計3欄・列挙・extractorVersion の NUL", async () => {
    const { memory } = await stores();
    const m = await memory.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        halfLifeRecalls: 10,
        decayBaseSeq: 0,
        decayFloorSeq: 10,
      }),
    );
    for (const nowSeq of [Number.NaN, 1.5, -1]) {
      await expect(
        memory.reinforce(ctx, m.id, new Date("2030-01-01"), { nowSeq }),
      ).rejects.toThrow();
    }
    let n = 0;
    for (const over of [
      { decayBaseSeq: -1 },
      { decayFloorSeq: 1.5 },
      { halfLifeRecalls: 0 },
      { halfLifeRecalls: Number.NaN },
      { extractorVersion: "a\u0000" },
      { status: "bogus" as never },
      { digestSource: "bogus" as never },
      { embeddingStatus: "bogus" as never },
    ]) {
      n += 1;
      await expect(
        memory.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `p-${n}`, ...over }),
        ),
      ).rejects.toThrow();
    }
  });

  it("E8・E11: archiveDecayed の now・nowSeq、limit 0 は reachedLimit: false", async () => {
    const { memory } = await stores();
    await memory.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    await expect(memory.archiveDecayed(ctx, { now: bad, limit: 5 })).rejects.toThrow();
    await expect(
      memory.archiveDecayed(ctx, {
        now: new Date("2030-01-01"),
        limit: 5,
        nowSeq: 1.5,
        clock: "activity",
      }),
    ).rejects.toThrow();
    expect(await memory.archiveDecayed(ctx, { now: new Date("2030-01-01"), limit: 0 })).toEqual({
      archived: [],
      reachedLimit: false,
    });
  });

  it("E12: float4 に丸まる成分（1e-50）の距離は NaN", async () => {
    const { memory, vector } = await stores();
    const m = await memory.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    await vector.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1e-50, 0, 0]);
    const hits = await vector.search(ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
      limit: 5,
      filter: { tenantId: ctx.tenantId },
    });
    expect(Number.isNaN(hits[0]!.distance)).toBe(true);
  });
});
