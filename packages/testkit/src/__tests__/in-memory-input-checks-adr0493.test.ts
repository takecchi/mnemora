import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

/**
 * ADR 0493（穴探し60巡目）: testkit の InMemory が、Postgres は断るのに通していた入力を断る（形 D「型の外の入力」）。
 * どれも手元の Postgres 17 に同じ入力を流して、Postgres が断ることを測ってある
 * （`packages/postgres/src/__tests__/input-checks-parity-0493.postgres.test.ts` が Postgres 側を縛る）。
 *
 * - D1: `createMemory` の `decayFloorAt`・`lastReinforcedAt` が Invalid Date（`timestamptz` 列）。
 * - D2: `createObservationWithOutbox` の `opts.claimedBy` に NUL（`outbox.claimed_by` は `text` 列）。行を書かないときは見ない。
 * - D3: `eraseTenant` の `limit` が NaN・非整数・Infinity・2^63 以上（`MemoryStore`・`VectorStore`・`OutboxStore`。`bigint` の引数）。
 *
 * 落ちる入力が増える変更なので、migration-v1 の 🔴 に載せる（CHANGELOG の [1.2.0] と同じ節）。やりすぎの対照も置く。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const bad = new Date("invalid");

describe("D1: InMemoryMemoryStore.createMemory の decayFloorAt・lastReinforcedAt の Invalid Date", () => {
  it("decayFloorAt が Invalid Date なら断り、何も書かない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, decayFloorAt: bad })),
    ).rejects.toThrow(/decayFloorAt must be a valid Date/);
    expect(await store.getMany(ctx, ["mem-1"])).toEqual([]);
  });
  it("lastReinforcedAt が Invalid Date なら断る", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, lastReinforcedAt: bad }),
      ),
    ).rejects.toThrow(/lastReinforcedAt must be a valid Date/);
  });
  it("対照: 妥当な Date と null は通る", async () => {
    const store = new InMemoryMemoryStore();
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "ok-1",
        lastReinforcedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    );
    expect(m.lastReinforcedAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    const n = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "ok-2",
        lastReinforcedAt: null,
      }),
    );
    expect(n.lastReinforcedAt).toBeNull();
  });
});

describe("D2: createObservationWithOutbox の opts.claimedBy の NUL", () => {
  it("claimedBy に NUL があれば断り、観測も outbox の行も書かない", async () => {
    const store = new InMemoryMemoryStore();
    const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "ext-1" });
    await expect(
      store.createObservationWithOutbox(ctx, input, ["extract"], { claimedBy: "a\u0000b" }),
    ).rejects.toThrow(/claimedBy must not contain NUL/);
    expect(store.outboxJobs).toHaveLength(0);
    const ok = await store.createObservationWithOutbox(ctx, input, ["extract"], {
      claimedBy: "worker",
    });
    expect(ok.created).toBe(true);
    expect(ok.jobs[0]?.claimedBy).toBe("worker");
  });
  it("対照: 行を書かないとき（jobKinds が空・冪等の既存の行）は claimedBy を見ない（Postgres は INSERT しない）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "ext-2" }),
        [],
        { claimedBy: "a\u0000" },
      ),
    ).resolves.toMatchObject({ created: true, jobs: [] });
    const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "ext-3" });
    await store.createObservationWithOutbox(ctx, input, ["extract"]);
    await expect(
      store.createObservationWithOutbox(ctx, input, ["extract"], { claimedBy: "a\u0000" }),
    ).resolves.toMatchObject({ created: false });
  });
});

describe("D3: eraseTenant の limit（InMemoryMemoryStore・InMemoryVectorStore・InMemoryOutboxStore）", () => {
  for (const limit of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 63]) {
    it(`limit が ${limit} なら断る`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
      await expect(memoryStore.eraseTenant(ctx, { limit })).rejects.toThrow(
        /eraseTenant: limit must/,
      );
      await expect(vectorStore.eraseTenant(ctx, { limit })).rejects.toThrow(
        /eraseTenant: limit must/,
      );
      await expect(outboxStore.eraseTenant(ctx, { limit })).rejects.toThrow(
        /eraseTenant: limit must/,
      );
    });
  }
  it("対照: 0 と正の整数は通り、断ったときは何も消さない", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "e-1" }),
    );
    await expect(memoryStore.eraseTenant(ctx, { limit: Number.NaN })).rejects.toThrow();
    expect(await memoryStore.get(ctx, m.id)).not.toBeNull();
    await expect(memoryStore.eraseTenant(ctx, { limit: 0 })).resolves.toBeDefined();
    await expect(memoryStore.eraseTenant(ctx, { limit: 1000 })).resolves.toMatchObject({
      kind: "executed",
    });
    expect(await memoryStore.get(ctx, m.id)).toBeNull();
  });
});
