import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * ADR 0426 の確かめ直し（Issue #1734、PR #1529）で見つかった穴の歯。
 *
 * 1. subject ごとの行をすべて消したら、テナントの入れ物（`subjectActivitySeq` の外側の Map のエントリ）も消える。
 * 2. `dryRun` は何も消さない——冪等キー（`extractionIndex`）も消さない。
 * 3. `onMemoriesDeleted` は listener を足していく。`InMemoryVectorStore` を2つ（別の space を持つなど）
 *    同じ `InMemoryMemoryStore` に載せたら、どちらの埋め込みも消える。
 */
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 2 };

describe("InMemoryMemoryStore.eraseTenant（ADR 0426）の確かめ直し", () => {
  it("subject の行をすべて消したら、テナントのエントリも残さない", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "erase-gaps-empty-map" };
    memoryStore.subjectActivitySeq.set(ctx.tenantId, new Map([["s1", 1]]));

    await memoryStore.eraseTenant(ctx, { limit: 1000 });

    expect(memoryStore.subjectActivitySeq.has(ctx.tenantId)).toBe(false);
  });

  it("dryRun は冪等キーを消さない（同じ入力の再書き込みは、dryRun の後も created: false）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "erase-gaps-dry-run-idem" };
    const observation = await memoryStore.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const input = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      sourceObservationId: observation.id,
      extractorVersion: "v1",
    });
    expect((await memoryStore.createMemoryWithOutbox(ctx, input, [])).created).toBe(true);
    expect((await memoryStore.createMemoryWithOutbox(ctx, input, [])).created).toBe(false);

    await memoryStore.eraseTenant(ctx, { limit: 1000, dryRun: true });

    expect((await memoryStore.createMemoryWithOutbox(ctx, input, [])).created).toBe(false);
  });

  it("InMemoryVectorStore を2つ載せても、どちらの埋め込みも memories と一緒に消える", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const first = new InMemoryVectorStore(memoryStore);
    const second = new InMemoryVectorStore(memoryStore);
    const ctx: Ctx = { tenantId: "erase-gaps-two-vector-stores" };
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    await first.upsert(ctx, SPACE, memory.id, [1, 0]);
    await second.upsert(ctx, SPACE, memory.id, [0, 1]);

    await memoryStore.eraseTenant(ctx, { limit: 1000 });

    expect(await first.getVectors(ctx, SPACE, [memory.id])).toEqual([]);
    expect(await second.getVectors(ctx, SPACE, [memory.id])).toEqual([]);
  });
});
