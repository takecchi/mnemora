import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { Clock } from "../interfaces/clock.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "validity-intersection" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = new Date("2025-06-01T00:00:00.000Z");
  const halfLifeHours = 24 * 365 * 10;
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
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/** `clock.now()` を外から進められるテスト専用の `Clock`。LLM 呼び出しの最中に時計を進めて、選定時刻と記録時刻を実際にずらすために使う。 */
function createMutableClock(initial: Date): Clock & { advance: (to: Date) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (to: Date) => {
      current = to;
    },
  };
}

/** 統合結果を固定で返す偽物の LLM。`onCall` は応答を返す直前に呼ぶ（時計を進めるため）。 */
function recordingConsolidateLlm(onCall?: () => void): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      onCall?.();
      return req.schema.parse({ content: "統合後の本文" }) as T;
    },
  };
}

/** 内省結果を固定で返す偽物の LLM。`onCall` は応答を返す直前に呼ぶ（時計を進めるため）。 */
function recordingReflectLlm(onCall?: () => void): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      onCall?.();
      return req.schema.parse({ outcome: "reflected", content: "内省した本文" }) as T;
    },
  };
}

describe("runtime.consolidate({ memoryIds }) — 統合先は材料の有効期間の積を持つ（Issue #1188 残り、ADR 0368）", () => {
  it("両端とも材料ごとに違う: 統合先の validFrom は最大値、validUntil は最小値", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: recordingConsolidateLlm(),
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const e = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "E",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2027-01-01T00:00:00.000Z"),
      }),
    );
    const f = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "F",
        validFrom: new Date("2026-03-01T00:00:00.000Z"),
        validUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [e.id, f.id] } });
    expect(result.outcome).toBe("consolidated");

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.validFrom).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(created?.validUntil).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });
});

describe("runtime.reflect({ memoryIds }) — 内省の記憶は材料の有効期間の積を持つ（Issue #1188 残り、ADR 0368）", () => {
  it("両端とも材料ごとに違う: 内省の記憶の validFrom は最大値、validUntil は最小値", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: recordingReflectLlm(),
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const e = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "E",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2027-01-01T00:00:00.000Z"),
      }),
    );
    const f = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "F",
        validFrom: new Date("2026-03-01T00:00:00.000Z"),
        validUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );

    const result = await runtime.reflect(ctx, { target: { memoryIds: [e.id, f.id] } });
    expect(result.outcome).toBe("reflected");

    const reflected = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(reflected?.validFrom).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(reflected?.validUntil).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });
});

/** 陽性対照: 材料を選ぶ時刻と記録する時刻の間に LLM 呼び出しが挟まるので、時計を実際に進めて窓を意図的に起こし、アサーションがそれを捕まえることを示す。時計を固定する他の歯では再現しない。 */
describe("窓（ADR 0368 決定2）: validAt と recordedAt の間に min(validUntil) を過ぎると、新しい記憶は作った時点で既に期限切れになる", () => {
  it("consolidate: 統合先は作られる（validUntil <= recordedAt）が、recall には出ない", async () => {
    const stores = createFakeRuntimeStores();
    const clock = createMutableClock(NOW);
    const justAfterNow = new Date(NOW.getTime() + 1);
    const afterJustAfterNow = new Date(NOW.getTime() + 10_000);
    const runtime = createRuntime({
      ...stores,
      llmProvider: recordingConsolidateLlm(() => clock.advance(afterJustAfterNow)),
      hashContent: (content: string) => `sha256(${content})`,
      clock,
    });
    const e = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "統合対象トークンXYZ E", validUntil: justAfterNow }),
    );
    const f = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "統合対象トークンXYZ F" }),
    );

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [e.id, f.id] } });
    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.kind)).toEqual(["superseded", "superseded"]);

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created).not.toBeNull();
    expect(created?.status).toBe("active");
    expect(created?.validUntil).toEqual(justAfterNow);
    expect(created!.recordedAt.getTime()).toBeGreaterThanOrEqual(created!.validUntil!.getTime());

    // 語彙チャンネルは embeddingStatus に依存しないので、出ない理由が validity ゲートであることを切り分けられる。
    const recalled = await runtime.recall(ctx, {
      text: "統合対象トークンXYZ",
      channels: ["lexical"],
    });
    expect(recalled.memories.map((m) => m.memoryId)).not.toContain(result.consolidatedMemoryId);
  });

  it("reflect: 内省の記憶は作られる（validUntil <= recordedAt）が、recall には出ない", async () => {
    const stores = createFakeRuntimeStores();
    const clock = createMutableClock(NOW);
    const justAfterNow = new Date(NOW.getTime() + 1);
    const afterJustAfterNow = new Date(NOW.getTime() + 10_000);
    const runtime = createRuntime({
      ...stores,
      llmProvider: recordingReflectLlm(() => clock.advance(afterJustAfterNow)),
      hashContent: (content: string) => `sha256(${content})`,
      clock,
    });
    const e = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "内省対象トークンXYZ E", validUntil: justAfterNow }),
    );
    const f = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "内省対象トークンXYZ F" }),
    );

    const result = await runtime.reflect(ctx, { target: { memoryIds: [e.id, f.id] } });
    expect(result.outcome).toBe("reflected");
    expect(result.basis.map((b) => b.kind)).toEqual(["used", "used"]);

    const reflected = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(reflected).not.toBeNull();
    expect(reflected?.status).toBe("active");
    expect(reflected?.validUntil).toEqual(justAfterNow);
    expect(reflected!.recordedAt.getTime()).toBeGreaterThanOrEqual(
      reflected!.validUntil!.getTime(),
    );

    const recalled = await runtime.recall(ctx, {
      text: "内省対象トークンXYZ",
      channels: ["lexical"],
    });
    expect(recalled.memories.map((m) => m.memoryId)).not.toContain(result.reflectedMemoryId);
  });
});
