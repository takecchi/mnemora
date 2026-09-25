import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.createMemory`/`createMemoryWithOutbox`（`packages/core` 自身の
 * runtime テスト用フェイク、`runtime-fakes.ts`）が、`InMemoryMemoryStore`/
 * `PostgresMemoryStore` と同じ値域の検査（ADR 0078: `strength` は `(0, 1]`）を
 * 実際に持っていることを検査する歯。
 *
 * **`packages/testkit` の `memory-store-conformance.ts` の対象ではない。**
 * `FakeMemoryStore` は adapter 適合テストの対象である `MemoryStore` 実装
 * （`InMemoryMemoryStore`/`PostgresMemoryStore`）ではなく、`packages/core` 自身の
 * runtime テスト専用の別系統（`runtime-fakes.ts` 冒頭のコメント: core は testkit に
 * 依存しない）。`fake-reinforce-monotonicity.test.ts` と同じ理由・同じ形。
 *
 * Issue #768: 調査時、この Fake を `describeMemoryStoreConformance` へ一時的に通して
 * 見つけた食い違い（値域チェックが丸ごと無く、`strength: 2` や `strength: NaN` が
 * 無条件で通っていた）を、`runtime-fakes.ts` の `createMemoryIdempotent` に足した
 * `isStrengthInRange` 検査で塞いだ。その塞ぎが実際に効いていることを、ここで
 * 固定する（通し方自体は PR に含めていない——`runtime-fakes.ts` の
 * `createMemoryIdempotent` の doc コメント参照）。
 */

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
    // ⚠ `strength` が NaN/Infinity のとき `defaultDecayStrategy.floorAt` が
    // `Invalid Date` を返す（`memory-store-conformance.ts` の同種の歯と同じ実測）。
    // ここでは検査したいのは `strength` だけなので、`decayFloorAt` は妥当な値を
    // 明示的に固定する。
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const outOfRange: Array<[string, number]> = [
  ["上限をわずかに超える", 1.0001],
  ["1 より大きい", 2],
  ["桁が違う", 1e6],
  ["ちょうど 0", 0],
  ["負", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
];

describe("FakeMemoryStore の strength 値域検査（ADR 0078、Issue #768）", () => {
  it.each(outOfRange)("createMemory は %s（strength=%s）を拒む", async (label, strength) => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, newMemory({ strength }))).rejects.toThrow(
      /strength out of range/,
    );
  });

  it.each(outOfRange)(
    "createMemoryWithOutbox は %s（strength=%s）を拒む",
    async (label, strength) => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.createMemoryWithOutbox(ctx, newMemory({ strength }), []),
      ).rejects.toThrow(/strength out of range/);
    },
  );

  it("値域の内側（境界の 1 を含む）なら createMemory は通す", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    for (const strength of [1, 0.42, 1e-6]) {
      const memory = await memoryStore.createMemory(ctx, newMemory({ strength }));
      expect(memory.strength).toBeCloseTo(strength, 6);
    }
  });
});
