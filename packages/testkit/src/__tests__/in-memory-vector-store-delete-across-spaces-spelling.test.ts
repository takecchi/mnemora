import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * `InMemoryVectorStore.deleteAcrossSpaces` は、大文字で綴った memoryId でも同じ行を消す。
 * `@mnemora/postgres` は `memory_id` を uuid 型の列で比べるので、綴りの違いは区別しない
 * （ADR 0521 が `delete`・`getVectors` などを揃えた。`deleteAcrossSpaces` も同じ）。
 * 全 space から消すこと・渡していない id の行を残すことも、同じ it で見る。
 */

const ctx: Ctx = { tenantId: "in-memory-delete-across-spelling" };
const SPACE_A: EmbeddingSpaceId = { provider: "test", model: "across-a", dimensions: 3 };
const SPACE_B: EmbeddingSpaceId = { provider: "test", model: "across-b", dimensions: 3 };

describe("InMemoryVectorStore.deleteAcrossSpaces の id の綴り", () => {
  it("大文字の memoryId でも、全 space の同じ行が消え、渡していない記憶の行は残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "across-target" }),
    );
    const kept = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "across-kept" }),
    );
    for (const space of [SPACE_A, SPACE_B]) {
      await vectorStore.upsert(ctx, space, target.id, [1, 0, 0]);
      await vectorStore.upsert(ctx, space, kept.id, [0, 1, 0]);
    }

    await vectorStore.deleteAcrossSpaces(ctx, [target.id.toUpperCase() as MemoryId]);

    for (const space of [SPACE_A, SPACE_B]) {
      const remaining = await vectorStore.getVectors!(ctx, space, [target.id, kept.id]);
      expect(remaining.map((v) => v.memoryId)).toEqual([kept.id]);
    }
  });
});
