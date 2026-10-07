import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-nul-teeth" };

describe("InMemoryMemoryStore.createMemory: NUL の検査の形（#928）", () => {
  for (const position of [0, 1, 2]) {
    it(`tags の ${position} 番目の要素に NUL があれば、3要素のうちどこでも断る`, async () => {
      const store = new InMemoryMemoryStore();
      const tags = ["a", "b", "c"].map((t, i) => (i === position ? `${t}\u0000x` : t));
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-tags", tags }),
        ),
      ).rejects.toThrow("InMemoryMemoryStore: tags must not contain NUL characters (U+0000)");
      expect(store.listByTenant(ctx)).toHaveLength(0);
    });
  }

  it("content・digest の例外の文言は、それぞれの欄名を名乗る", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-c", content: "a\u0000b" }),
      ),
    ).rejects.toThrow("InMemoryMemoryStore: content must not contain NUL characters (U+0000)");
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-d", digest: "a\u0000b" }),
      ),
    ).rejects.toThrow("InMemoryMemoryStore: digest must not contain NUL characters (U+0000)");
  });

  it("文字どおりの \\u0000（6文字）や U+2400 は NUL ではないので、content・tags・digest のどれでも断らず、そのまま保存する", async () => {
    const store = new InMemoryMemoryStore();
    const literal = "a\\u0000b";
    const symbol = "a␀b";
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-literal",
        content: literal,
        digest: literal + symbol,
        tags: [literal, symbol],
      }),
    );
    expect(memory.content).toBe(literal);
    expect(memory.digest).toBe(literal + symbol);
    expect(memory.tags).toEqual([literal, symbol]);
  });
});
