import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const REAL = /does not fit in a Postgres "real"/;

describe("InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む", () => {
  it("halfLifeHours: 1e-300 は例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u1", halfLifeHours: 1e-300 }),
      ),
    ).rejects.toThrow(REAL);
    expect(await store.listBySourceObservation(ctx, "none", null)).toEqual([]);
  });

  it("strength: 1e-300 と 1e-46 は例外を投げる（値域 (0, 1] の中でも float4 では 0 になる）", async () => {
    const store = new InMemoryMemoryStore();
    for (const [i, strength] of [1e-300, 1e-46].entries()) {
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `u2-${i}`, strength }),
        ),
      ).rejects.toThrow(REAL);
    }
  });

  it("createMemoryWithOutbox も同じ入口で拒む", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u3", strength: 1e-46 }),
        [],
      ),
    ).rejects.toThrow(REAL);
  });

  it("float4 の非正規数に収まる値（1e-45）と通常の値は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u4", strength: 1e-45 }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u5", halfLifeHours: 1e-40 }),
    );
    const c = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u6" }),
    );
    expect([a.strength, b.halfLifeHours, c.halfLifeHours]).toEqual([1e-45, 1e-40, 720]);
  });

  it("境界の両側: 7.0e-46（0 に丸まる）は拒み、7.1e-46（最小の非正規数に丸まる）は通す", async () => {
    expect(Math.fround(7.0e-46)).toBe(0);
    expect(Math.fround(7.1e-46)).toBe(1.4012984643248171e-45);
    for (const field of ["halfLifeHours", "strength"] as const) {
      const store = new InMemoryMemoryStore();
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `edge-low-${field}`,
            [field]: 7.0e-46,
          }),
        ),
      ).rejects.toThrow(REAL);
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `edge-high-${field}`,
            [field]: 7.1e-46,
          }),
        ),
      ).resolves.toBeDefined();
    }
  });
});
