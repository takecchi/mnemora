import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const INVALID_DATE = new Date(Number.NaN);

describe("InMemoryMemoryStore.reinforce: Invalid Date を渡すと Postgres と同じく例外を投げ、状態を書き換えない", () => {
  it("Invalid Date は例外を投げ、lastReinforcedAt/decayFloorAt を変えない", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h1" }),
    );
    await expect(store.reinforce(ctx, memory.id, INVALID_DATE)).rejects.toThrow(
      /at must be a valid Date/,
    );
    const after = await store.get(ctx, memory.id);
    expect(after?.lastReinforcedAt).toBeNull();
    expect(after?.decayFloorAt).toEqual(memory.decayFloorAt);
  });

  it("妥当な Date は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h2" }),
    );
    const at = new Date("2026-02-01T00:00:00.000Z");
    const after = await store.reinforce(ctx, memory.id, at);
    expect(after.lastReinforcedAt).toEqual(at);
  });
});

describe("InMemoryMemoryStore.createMemory: Date フィールドに Invalid Date を渡すと例外を投げ、Memory を作らない", () => {
  for (const field of ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const) {
    it(`${field}=Invalid Date は例外を投げる`, async () => {
      const store = new InMemoryMemoryStore();
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `h-${field}`,
            [field]: INVALID_DATE,
          } as never),
        ),
      ).rejects.toThrow(/must be a valid Date/);
    });
  }
});

describe("InMemoryEventStore.append: at に Invalid Date を渡すと例外を投げ、イベントを積まない", () => {
  it("Invalid Date は例外を投げ、events に積まれない", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h3" }),
    );
    const eventStore = new InMemoryEventStore(memoryStore);
    await expect(
      eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        at: INVALID_DATE,
        actor: { type: "system" },
        meta: {},
      }),
    ).rejects.toThrow(/at must be a valid Date/);
    const list = await eventStore.list(ctx, {});
    expect(list).toHaveLength(0);
  });
});
