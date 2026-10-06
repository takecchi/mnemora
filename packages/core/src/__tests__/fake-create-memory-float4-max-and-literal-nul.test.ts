import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.createMemory` が Postgres に揃えて断る入力の、断りすぎない側。
 * - `halfLifeHours`: float4（Postgres の `real`）に収まる最大の値までは受け、`Infinity` へ丸まる境目から断る。
 * - `content`: 断るのは NUL（U+0000）そのもの。`\u0000` という6文字の文字列はただの文字なので受ける。
 *   NUL が先頭・末尾にあるときも断る。
 */

const TENANT = "fake-float4-max-tenant";
const ctx: Ctx = { tenantId: TENANT };

const FLOAT4_MAX = 3.4028234663852886e38;
// float4 の最大値と、その次の（`Infinity` になる）値の真ん中。これ以上は `Infinity` へ丸まり、これ未満は最大値へ丸まる。
const OVERFLOW_AT = 3.4028235677973366e38;
const JUST_BELOW_OVERFLOW = 3.4028235677973362e38;

function fixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: `fixture-hash-${Math.random()}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.createMemory: halfLifeHours は float4 の最大値まで受ける", () => {
  it("境目の前提（Math.fround の丸め方）", () => {
    expect(Math.fround(FLOAT4_MAX)).toBe(FLOAT4_MAX);
    expect(Math.fround(JUST_BELOW_OVERFLOW)).toBe(FLOAT4_MAX);
    expect(Math.fround(OVERFLOW_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it("float4 の最大値と、Infinity に丸まる直前の値は受ける", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const a = await memoryStore.createMemory(ctx, fixture({ halfLifeHours: FLOAT4_MAX }));
    const b = await memoryStore.createMemory(ctx, fixture({ halfLifeHours: JUST_BELOW_OVERFLOW }));
    expect(a.halfLifeHours).toBeGreaterThan(3.4e38);
    expect(b.halfLifeHours).toBeGreaterThan(3.4e38);
  });

  it("Infinity に丸まる値は断り、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ halfLifeHours: OVERFLOW_AT })),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });
});

describe("FakeMemoryStore.createMemory: content の NUL", () => {
  it("\\u0000 という文字列（NUL ではない）は受け、そのまま読み戻せる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const content = "手順は \\u0000 と書く";
    const created = await memoryStore.createMemory(ctx, fixture({ content }));
    expect((await memoryStore.get(ctx, created.id))?.content).toBe(content);
  });

  it("先頭・末尾の NUL も断る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    for (const content of ["\u0000abc", "abc\u0000", "\u0000"]) {
      await expect(memoryStore.createMemory(ctx, fixture({ content }))).rejects.toThrow(
        /content must not contain NUL/,
      );
    }
  });
});
