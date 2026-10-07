// `tenantId` は対象外: `ctx` を通じてほぼ全メソッドが共有する値で、`createMemory` の入口だけ検査しても他のメソッドが素通りして一貫しない。孤立サロゲートも対象外: Postgres は U+FFFD へ置換し Fake は保持する（契約は `InMemoryMemoryStore.createMemory` の doc）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる", () => {
  it("content の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h1",
          content: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/must not contain NUL/);
    const all = store.listByTenant(ctx);
    expect(all).toHaveLength(0);
  });

  it("NUL を含まない content は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h2", content: "abcdef" }),
    );
    expect(memory.content).toBe("abcdef");
  });
});

describe("InMemoryMemoryStore.createMemory: subjectId に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("subjectId の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-subject-nul",
          subjectId: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/input\.subjectId contains a NUL character/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("subjectId が null は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-subject-ok",
        subjectId: null,
      }),
    );
    expect(memory.subjectId).toBeNull();
  });
});

describe("InMemoryMemoryStore.createMemory: tags の要素に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("tags[0] の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-tags-nul",
          tags: ["ok-tag", "abc\u0000def"],
        }),
      ),
    ).rejects.toThrow(/tags must not contain NUL/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("NUL を含まない tags は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-tags-ok", tags: ["a", "b"] }),
    );
    expect(memory.tags).toEqual(["a", "b"]);
  });
});

describe("InMemoryMemoryStore.createMemory: digest に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("digest の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-digest-nul",
          digest: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/digest must not contain NUL/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("NUL を含まない digest は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-digest-ok", digest: "ok" }),
    );
    expect(memory.digest).toBe("ok");
  });
});
