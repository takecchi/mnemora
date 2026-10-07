import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

describe("InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  it("🔴 大文字小文字・空白・記号が混在する名前でも、コードポイント順で返る", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        tags: [" Foo ", "Foo", "foo", "_a", "B"],
      }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual([" Foo ", "B", "Foo", "_a", "foo"]);
  });

  it("🔴 サロゲートペア（U+10000 以上）を含む名前でも、コードポイント順で返る", async () => {
    // JS の `<`（UTF-16 コード単位の比較）だと、BMP 外の "😀"（先頭が上位サロゲート 0xD83D）が BMP 内の "！"（0xFF01）より先に来て、コードポイント順と逆になる。
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        tags: ["😀", "！"],
      }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["！", "😀"]);
  });

  it("別の名前の接頭辞になっている名前は、短い方が先に返る", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", tags: ["abc", "ab", "a"] }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["a", "ab", "abc"]);
  });

  it("同じサロゲートペアで始まる名前は、その後ろの文字の順で返る", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", tags: ["😁a", "😀b", "😀a"] }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["😀a", "😀b", "😁a"]);
  });

  it("U+FFFF（BMP の最後の1文字）で始まる名前は、1コード単位として読まれ、後ろの文字の順で返る", async () => {
    // U+FFFF は BMP 内（コード単位1つ）。サロゲートペアと取り違えて2コード単位進めると、後ろの文字を読み飛ばす。
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "tenant-1" };

    await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", tags: ["￿b", "￿a", "￿"] }),
    );

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => l.name)).toEqual(["￿", "￿a", "￿b"]);
  });
});
