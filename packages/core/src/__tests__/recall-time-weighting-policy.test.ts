import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.timeWeighting` の配線の歯（Issue #690、ADR 0295）。
 *
 * `scoring-time-weighting-policy.test.ts` が `defaultScoringStrategy` を直接呼んで
 * 計算式そのものを守るのに対し、このファイルは **`recall()` から先の配線** を守る:
 * - `RecallQuery.timeWeighting` を渡さない呼び出しは、既定（"legacy"）から1バイトも
 *   変わらない（ケース表・ADR 0295 §2 の陽性対照をここでも取る）。
 * - `RecallQuery.timeWeighting` を渡すと、`recall()` が返す `memories`/`omitted` の
 *   件数（量）が変わりうる——ただし忘却ゲート・`validAt` ゲートは一切変わらない。
 * - ⭐ **期限切れの予定（ケース D）は、`timeWeighting` の値に関係なく常に除外される**
 *   （validity ゲートを弱めないことの本命の歯。ADR 0295 §8 の変異(c)が狙う対象）。
 *
 * `recall-decay-gate.test.ts`/`recall-validity.test.ts` と同型: `packages/core` 自身の
 * テストなので `@mnemora/testkit` には依存しない。DB を要さないため手元で実行できる。
 */

const HOUR_MS = 1000 * 60 * 60;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        return req.schema.parse({
          memories: [{ content: "抽出結果", provenanceKind: "stated" }],
        }) as T;
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 720; // 30日、docs既定
  return {
    tenantId: "tenant-1",
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
    validFrom: null,
    validUntil: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: overrides.lastReinforcedAt ?? null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — RecallQuery.timeWeighting 省略時は legacy と1バイトも変わらない（既定不変の歯）", () => {
  it("恒常的な好み（occurredAt無し・古いrecordedAt・最近reinforce相当）が、省略時は below_threshold に落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    const durable = await createEmbeddedMemory(stores, [1, 0], {
      digest: "durable-preference",
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      occurredAt: null,
      lastReinforcedAt: new Date(NOW.getTime() - 1 * HOUR_MS),
      decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS), // 忘却ゲートには掛からない
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(durable.id);
    expect(result.omitted).toContainEqual(expect.objectContaining({ kind: "below_threshold" }));
  });
});

describe("recall() — RecallQuery.timeWeighting: 'eventAwareFreshness' を渡すと、恒常的な好みが浮上する（配線の歯）", () => {
  it("同じ記憶が below_threshold から memories へ移る（件数＝量が動く）", async () => {
    const { runtime, stores } = buildRuntime();
    const durable = await createEmbeddedMemory(stores, [1, 0], {
      digest: "durable-preference",
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      occurredAt: null,
      lastReinforcedAt: new Date(NOW.getTime() - 1 * HOUR_MS),
      decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      timeWeighting: "eventAwareFreshness",
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(durable.id);
    const belowThreshold = result.omitted.find((o) => o.kind === "below_threshold");
    expect(belowThreshold).toBeUndefined();
  });

  it("過去の出来事（occurredAt 400日前）は、'eventAwareFreshness' でも below_threshold に留まる（事件は動かさない）", async () => {
    const { runtime, stores } = buildRuntime();
    const pastEvent = await createEmbeddedMemory(stores, [1, 0], {
      digest: "past-event",
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      occurredAt: new Date(NOW.getTime() - 400 * DAY_MS),
      lastReinforcedAt: null,
      decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS),
    });

    const legacyResult = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const newPolicyResult = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      timeWeighting: "eventAwareFreshness",
    });

    expect(legacyResult.memories.map((m) => m.memoryId)).not.toContain(pastEvent.id);
    expect(newPolicyResult.memories.map((m) => m.memoryId)).not.toContain(pastEvent.id);
  });
});

describe("recall() — ⭐ 期限切れの予定は timeWeighting に関係なく常に除外される（validity ゲートを弱めない、ADR 0295 §8 変異(c)）", () => {
  it("legacy でも 'eventAwareFreshness' でも、validUntil を過ぎた記憶は memories に出ず、omitted に 'expired' で名指しされる", async () => {
    const { runtime, stores } = buildRuntime();
    const expiredAppointment = await createEmbeddedMemory(stores, [1, 0], {
      digest: "expired-appointment",
      occurredAt: new Date(NOW.getTime() - 45 * DAY_MS),
      recordedAt: new Date(NOW.getTime() - 60 * DAY_MS),
      validFrom: new Date(NOW.getTime() - 60 * DAY_MS),
      validUntil: new Date(NOW.getTime() - 30 * DAY_MS),
      decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS), // 忘却ゲートでは落ちない設定にし、
      // 落ちるのが validity ゲートであることをはっきりさせる。
    });

    for (const timeWeighting of ["legacy", "eventAwareFreshness"] as const) {
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 10,
        timeWeighting,
      });
      expect(result.memories.map((m) => m.memoryId)).not.toContain(expiredAppointment.id);
      expect(result.omitted).toContainEqual(
        expect.objectContaining({ kind: "filtered", condition: "expired" }),
      );
    }
  });

  it("忘却ゲート（decay floor gate）も timeWeighting に関係なく効く", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    for (const timeWeighting of ["legacy", "eventAwareFreshness"] as const) {
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 10,
        timeWeighting,
      });
      expect(result.memories.map((m) => m.memoryId)).not.toContain(decayed.id);
    }
  });
});

describe("recall() — 活動時計テナント（decayClock: 'activity'）でも配線される", () => {
  it("恒常的な好みが 'eventAwareFreshness' で below_threshold から浮上する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const durable = await createEmbeddedMemory(stores, [1, 0], {
      digest: "durable-preference-activity",
      recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      occurredAt: null,
      lastReinforcedAt: null,
      decayBaseSeq: 0,
      halfLifeRecalls: 1000, // 十分大きく、活動軸では沈まないようにする
      decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS),
    });

    const legacyResult = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const newPolicyResult = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      timeWeighting: "eventAwareFreshness",
    });

    expect(legacyResult.memories.map((m) => m.memoryId)).not.toContain(durable.id);
    expect(newPolicyResult.memories.map((m) => m.memoryId)).toContain(durable.id);
  });
});
