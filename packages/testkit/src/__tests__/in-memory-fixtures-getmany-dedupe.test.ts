import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.getMany: ids に重複があっても一意な id の集合しか返さない", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）", async () => {
    const store = new InMemoryMemoryStore();
    const x = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-x" }),
    );
    const y = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-y" }),
    );

    const results = await store.getMany(ctx, [x.id, x.id, y.id]);

    // Postgres 側に ORDER BY が無く順序は契約に無いため、集合として比較する。
    expect(results).toHaveLength(2);
    expect(new Set(results.map((m) => m.id))).toEqual(new Set([x.id, y.id]));
  });
});

describe("InMemoryMemoryStore.reinforce: 他テナントの Memory を対象にしない", () => {
  it("他テナントの id を渡すと memory not found を投げ、対象の行は無傷のまま", async () => {
    const store = new InMemoryMemoryStore();
    const ctxA: Ctx = { tenantId: "tenant-a" };
    const ctxB: Ctx = { tenantId: "tenant-b" };
    const memoryA = await store.createMemory(
      ctxA,
      buildNewMemoryFixture({ tenantId: "tenant-a", contentHash: "reinforce-tenant-a" }),
    );

    await expect(
      store.reinforce(ctxB, memoryA.id, new Date(memoryA.recordedAt.getTime() + 1000)),
    ).rejects.toThrow(/memory not found for tenant/);

    const afterA = await store.get(ctxA, memoryA.id);
    expect(afterA?.lastReinforcedAt ?? null).toBe(memoryA.lastReinforcedAt ?? null);
    expect(afterA?.updatedAt.getTime()).toBe(memoryA.updatedAt.getTime());
  });
});
