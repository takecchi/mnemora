// #928 の確かめ直し（#1774）。`FakeMemoryStore.createMemory` の NUL の検査の、既存の歯が見ていなかった形。
//
// - `tags` は要素ごとに見る：NUL が先頭・中・末尾のどこにあっても断る（既存の歯は NUL を末尾の要素に置く1本だけ）。
// - 例外の文言は `FakeMemoryStore: <欄> must not contain NUL characters (U+0000)`（既存の歯は
//   `content` を `/must not contain NUL/` だけで見ていて、欄名を取り違えても通る）。
// - NUL そのものでない値（文字どおりの `\u0000` の6文字、U+2400 `␀`）は断らず、そのまま保存する。
//
// 孤立サロゲートは置き換えて保存する（ADR 0543）ので、ここでは見ない。`subjectId` の NUL は
// `assertWellFormedIdentifier`（ADR 0563、`MalformedIdentifierError`）が断る。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-nul-teeth-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 365 * 5),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.createMemory: NUL の検査の形（#928）", () => {
  for (const position of [0, 1, 2]) {
    it(`tags の ${position} 番目の要素に NUL があれば、3要素のうちどこでも断る`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const tags = ["a", "b", "c"].map((t, i) => (i === position ? `${t}\u0000x` : t));
      await expect(memoryStore.createMemory(ctx, newMemory({ tags }))).rejects.toThrow(
        "FakeMemoryStore: tags must not contain NUL characters (U+0000)",
      );
    });
  }

  it("content・digest の例外の文言は、それぞれの欄名を名乗る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, newMemory({ content: "a\u0000b" }))).rejects.toThrow(
      "FakeMemoryStore: content must not contain NUL characters (U+0000)",
    );
    await expect(memoryStore.createMemory(ctx, newMemory({ digest: "a\u0000b" }))).rejects.toThrow(
      "FakeMemoryStore: digest must not contain NUL characters (U+0000)",
    );
  });

  it("文字どおりの \\u0000（6文字）や U+2400 は NUL ではないので、content・tags・digest のどれでも断らず、そのまま保存する", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const literal = "a\\u0000b";
    const symbol = "a␀b";
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ content: literal, digest: literal + symbol, tags: [literal, symbol] }),
    );
    expect(memory.content).toBe(literal);
    expect(memory.digest).toBe(literal + symbol);
    expect(memory.tags).toEqual([literal, symbol]);
  });
});
