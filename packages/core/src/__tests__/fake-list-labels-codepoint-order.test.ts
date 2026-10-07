import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  it("🔴 大文字小文字・空白・記号が混在する名前でも、コードポイント順で返る", async () => {
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ tags: [" Foo ", "Foo", "foo", "_a", "B"] }),
    );

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual([" Foo ", "B", "Foo", "_a", "foo"]);
  });

  it("🔴 サロゲートペア（U+10000 以上）を含む名前でも、コードポイント順で返る", async () => {
    // JS の `<`（UTF-16 コード単位）だと 😀（上位サロゲート 0xD83D）が ！（0xFF01）より先に来て、コードポイント順とは逆になる組を選ぶ。
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["😀", "！"] }));

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["！", "😀"]);
  });

  it("別の名前の接頭辞になっている名前は、短い方が先に返る", async () => {
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["abc", "ab", "a"] }));

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["a", "ab", "abc"]);
  });

  it("同じサロゲートペアで始まる名前は、その後ろの文字の順で返る", async () => {
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["😁a", "😀b", "😀a"] }));

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["😀a", "😀b", "😁a"]);
  });

  it("U+FFFF（BMP の最後の1文字）で始まる名前は、1コード単位として読まれ、後ろの文字の順で返る", async () => {
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["￿b", "￿a", "￿"] }));

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["￿", "￿a", "￿b"]);
  });
});
