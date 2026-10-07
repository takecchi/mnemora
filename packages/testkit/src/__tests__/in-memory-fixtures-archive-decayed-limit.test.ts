import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

async function seedDecayedMemory(store: InMemoryMemoryStore, contentHash: string) {
  return store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }));
}

describe("InMemoryMemoryStore.archiveDecayed: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も archived にしない", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    it(`limit=${limit} は例外を投げ、対象の Memory を archived にしない`, async () => {
      const store = new InMemoryMemoryStore();
      const memory = await seedDecayedMemory(store, `h-${limit}`);

      await expect(store.archiveDecayed(ctx, { now: NOW, limit })).rejects.toThrow(
        /limit must (be an integer|not be negative)/,
      );

      const after = await store.get(ctx, memory.id);
      expect(after?.status).toBe("active");
    });
  }

  it("limit=2（正整数）は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await seedDecayedMemory(store, "h-ok");
    const result = await store.archiveDecayed(ctx, { now: NOW, limit: 2 });
    expect(result.archived.map((a) => a.memoryId)).toEqual([memory.id]);
    const after = await store.get(ctx, memory.id);
    expect(after?.status).toBe("archived");
  });
});
