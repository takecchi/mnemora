import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore` の抽出の冪等キーと `FakeVectorStore` のベクトルのキーが、区切り文字（`:`）を
 * 含む値で別の対象と衝突しない。`packages/testkit` の InMemory と同じ直し（キーを
 * `JSON.stringify` の配列にする）を、別系統のこちらにも当てた。2実装に当てる歯は
 * `packages/postgres/src/__tests__/joined-string-keys.postgres.test.ts`。
 */

let counter = 0;
function newMemory(tenantId: string, overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `hash-${counter}`,
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

async function observe(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  ctx: Ctx,
): Promise<string> {
  const observation = await stores.memoryStore.createObservation(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "発話" },
    occurredAt: null,
  });
  return observation.id;
}

describe("Fake のキーは区切り文字を含む値で衝突しない", () => {
  it("抽出の冪等キー: 版と hash の境目がずれた2件は、別の Memory になる", async () => {
    const stores = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: "t" };
    const obs = await observe(stores, ctx);
    const first = await stores.memoryStore.createMemory(
      ctx,
      newMemory("t", { sourceObservationId: obs, extractorVersion: "v:x", contentHash: "h" }),
    );
    const second = await stores.memoryStore.createMemory(
      ctx,
      newMemory("t", { sourceObservationId: obs, extractorVersion: "v", contentHash: "x:h" }),
    );
    expect(second.id).not.toBe(first.id);
  });

  it("抽出の冪等キー: `:` を含むテナントが、別テナントの Memory を受け取らない", async () => {
    const stores = createFakeRuntimeStores();
    const t: Ctx = { tenantId: "t" };
    const o1 = await observe(stores, t);
    const tO1: Ctx = { tenantId: `t:${o1}` };
    const o2 = await observe(stores, tO1);
    const own = await stores.memoryStore.createMemory(
      t,
      newMemory("t", { sourceObservationId: o1, extractorVersion: `${o2}:v`, contentHash: "h" }),
    );
    const other = await stores.memoryStore.createMemory(
      tO1,
      newMemory(tO1.tenantId, { sourceObservationId: o2, extractorVersion: "v", contentHash: "h" }),
    );
    expect(other.id).not.toBe(own.id);
    expect(other.tenantId).toBe(tO1.tenantId);
  });

  it("ベクトル: 空間 {p, m, 3} の検索が、空間 {p, m:3, 3} のベクトルを返さない", async () => {
    const stores = createFakeRuntimeStores();
    const ctx: Ctx = { tenantId: "t" };
    const short: EmbeddingSpaceId = { provider: "p", model: "m", dimensions: 3 };
    const long: EmbeddingSpaceId = { provider: "p", model: "m:3", dimensions: 3 };
    const memory = await stores.memoryStore.createMemory(ctx, newMemory("t"));
    await stores.vectorStore.upsert(ctx, long, memory.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, short, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "t" },
    });
    expect(hits).toEqual([]);
  });
});
