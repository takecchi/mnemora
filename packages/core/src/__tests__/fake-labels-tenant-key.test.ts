import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore`（`packages/core` 自身のテスト用フェイク）のラベルも、`::` を含むテナントで
 * 分かれる。`packages/testkit` の `InMemoryMemoryStore` と同じ直し（キーを
 * `JSON.stringify([tenantId, name])` にする）を、別系統のこちらにも当てた。2実装に当てる歯は
 * `packages/postgres/src/__tests__/labels-tenant-key.postgres.test.ts`。
 */

const A: Ctx = { tenantId: "a" };
const AB: Ctx = { tenantId: "a::b" };
let contentHashCounter = 0;

function newMemory(tenantId: string, tags: string[]): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags,
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

describe("FakeMemoryStore のラベルは `::` を含むテナントでも分かれる", () => {
  it("tags から作られた提案ラベルが、別テナントに混ざらず潰れない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(AB, newMemory(AB.tenantId, ["x"]));
    await memoryStore.createMemory(A, newMemory(A.tenantId, ["b::x"]));

    const brief = async (ctx: Ctx) =>
      (await memoryStore.listLabels(ctx)).map((l) => [l.name, l.proposedCount]);
    expect(await brief(A)).toEqual([["b::x", 1]]);
    expect(await brief(AB)).toEqual([["x", 1]]);
  });
});
