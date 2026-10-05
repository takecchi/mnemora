import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * ADR 0630: `InMemoryMemoryStore` の Memory の書き込みの口が、読み戻すと `MemorySchema` を通らない値を入口で拒む。
 * 全形を3口で縛るのは適合テスト（`memory-store-conformance.ts`。この fixture と Postgres に当たる）。ここは fixture 固有の
 * 内部状態（outbox・イベント）が進まないことと、範囲の境界（範囲外の欄・口を拒まない）を縛る。
 */

const ctx: Ctx = { tenantId: "in-memory-new-memory" };

async function setup() {
  const store = new InMemoryMemoryStore();
  const obs = (
    await store.createObservation(ctx, buildNewObservationFixture({ tenantId: ctx.tenantId }))
  ).id;
  const input = (over: Partial<NewMemory> = {}) =>
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      sourceObservationId: obs,
      extractorVersion: "v1",
      contentHash: "h",
      tags: ["t"],
      ...over,
    });
  const state = async () =>
    JSON.stringify({
      memories: store.listByTenant(ctx).map((m) => m.id),
      outbox: store.outboxJobs.length,
      events: store.events.length,
      labels: await store.listLabels(ctx),
    });
  return { store, obs, input, state };
}

describe("InMemoryMemoryStore: 拒むとき、Memory・outbox・イベント・ラベルのどれも進めない（ADR 0630）", () => {
  it("createMemoryWithOutbox: 冪等の既存の行が在っても拒み、outbox を積まない", async () => {
    const { store, input, state } = await setup();
    await store.createMemoryWithOutbox(ctx, input(), ["embed"]);
    const before = await state();
    await expect(
      store.createMemoryWithOutbox(ctx, input({ digest: "" }), ["embed"]),
    ).rejects.toThrow(/digest/);
    expect(await state()).toBe(before);
  });

  it("supersedeWithNewMemories: 壊れた news があれば、supersede の対象も動かさず、イベントも積まない", async () => {
    const { store, input, state } = await setup();
    const old = await store.createMemory(ctx, input({ contentHash: "old", tags: [] }));
    const before = await state();
    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [
          { input: input({ contentHash: "n1", tags: ["only-n1"] }), jobKinds: ["embed"] },
          {
            input: input({ contentHash: "n2", claimKey: { subject: "s" } as never }),
            jobKinds: [],
          },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: {
              tenantId: ctx.tenantId,
              memoryId: old.id,
              kind: "superseded",
              actor: { type: "system" },
              meta: {},
            } as never,
          },
        ],
      ),
    ).rejects.toThrow(/claimKey/);
    expect(await state()).toBe(before);
    expect((await store.get(ctx, old.id))?.status).toBe("active");
  });

  it("createMemoriesWithOutboxAndEvents（3口の外。同じ入口を共有する）: 壊れた候補は dropped に積み、ほかは書く", async () => {
    const { store, input } = await setup();
    const result = await store.createMemoriesWithOutboxAndEvents(
      ctx,
      [
        { input: input({ contentHash: "ok-1" }), jobKinds: ["embed"] },
        { input: input({ contentHash: "bad", extractorVersion: "" }), jobKinds: ["embed"] },
      ],
      (memory) =>
        ({
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "created",
          actor: { type: "system" },
          meta: {},
        }) as never,
    );
    expect(result.written.map((w) => w.index)).toEqual([0]);
    expect(result.dropped.map((d) => d.index)).toEqual([1]);
    expect(String(result.dropped[0]!.error)).toMatch(/extractorVersion is malformed/);
  });
});

describe("InMemoryMemoryStore: 範囲外は拒まない（ADR 0630）", () => {
  it("createObservation は、attributes の値が文字列でなくても、この検査では拒まない（Observation は範囲外）", async () => {
    const { store } = await setup();
    // 範囲外: Observation の書き込みにこの検査は掛からない（Memory と同じ形の attributes を渡しても、今までどおり書ける）。
    await expect(
      store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, attributes: { a: 1 } as never }),
      ),
    ).resolves.toBeDefined();
  });

  it("tags の値・validFrom > validUntil は、この検査の対象ではない", async () => {
    const { store, input } = await setup();
    const bad = await store
      .createMemory(
        ctx,
        input({
          contentHash: "scope-inverted",
          validFrom: new Date("2026-02-01"),
          validUntil: new Date("2026-01-01"),
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String(bad)).not.toMatch(/is malformed/);
  });
});
