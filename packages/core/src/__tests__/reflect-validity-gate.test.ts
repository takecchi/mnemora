import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 2実装（Postgres・testkit の fixture）と `{ seedMemoryId }`・`{ query }` の形は
// `packages/postgres/src/__tests__/reflect-target-selection.postgres.test.ts` が見る。

const ctx: Ctx = { tenantId: "reflect-validity-gate" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

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

/** 内省の結果を固定で返し、LLM に渡された本文（プロンプト）を記録する。 */
function recordingLlm(prompts: string[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      prompts.push(JSON.stringify(req));
      return req.schema.parse({ outcome: "reflected", content: "内省した本文" }) as T;
    },
  };
}

function buildRuntime(prompts: string[] = []) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider: recordingLlm(prompts),
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("reflect は、いまの時点で有効期間の外にある記憶を材料にしない（Issue #1188）", () => {
  it("期限切れの記憶は expired で名指しし、材料にせず、LLM にも渡さない。残りは used になる", async () => {
    const prompts: string[] = [];
    const { runtime, stores } = buildRuntime(prompts);
    const expired = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "去年の住所は京都", validUntil: PAST }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "猫を飼っている" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "犬も飼っている" }));

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [expired.id, a.id, b.id] },
    });

    expect(result.outcome).toBe("reflected");
    expect(result.basis).toEqual([
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: a.id, kind: "used" },
      { memoryId: b.id, kind: "used" },
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("去年の住所は京都");
    expect(prompts[0]).toContain("猫を飼っている");

    const stillExpired = await stores.memoryStore.get(ctx, expired.id);
    expect(stillExpired?.status).toBe("active");
    expect(stores.eventStore.events.filter((e) => e.memoryId === expired.id)).toEqual([]);

    const reflected = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(reflected?.provenance).toMatchObject({ kind: "reflected", sources: [a.id, b.id] });
    expect(reflected?.validFrom ?? null).toBeNull();
    expect(reflected?.validUntil ?? null).toBeNull();
  });

  it("全部が期間の外なら no_eligible_basis。LLM を呼ばない", async () => {
    const prompts: string[] = [];
    const { runtime, stores } = buildRuntime(prompts);
    const expired = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: PAST }));
    const future = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: FUTURE }));

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [expired.id, future.id] },
    });

    expect(result).toMatchObject({
      outcome: "nothing_to_reflect",
      nothingReason: "no_eligible_basis",
      reflectedMemoryId: null,
      llmCalls: 0,
    });
    expect(result.basis).toEqual([
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: future.id, kind: "not_yet_valid", validFrom: FUTURE },
    ]);
    expect(prompts).toEqual([]);
  });

  it("未到来の記憶は not_yet_valid で名指しする。重複した id も同じ値で出る", async () => {
    const { runtime, stores } = buildRuntime();
    const future = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: FUTURE }));
    const expired = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: PAST }));

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [future.id, expired.id, future.id] },
    });

    expect(result).toMatchObject({
      outcome: "nothing_to_reflect",
      nothingReason: "no_eligible_basis",
      llmCalls: 0,
    });
    expect(result.basis).toEqual([
      { memoryId: future.id, kind: "not_yet_valid", validFrom: FUTURE },
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: future.id, kind: "not_yet_valid", validFrom: FUTURE },
    ]);
  });

  it("dryRun でも同じ値で名指しし、期間の内側のものだけが eligible", async () => {
    const { runtime, stores } = buildRuntime();
    const expired = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: PAST }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory());
    const b = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [a.id, expired.id, b.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: b.id, kind: "eligible" },
    ]);
  });

  it("境界は recall・consolidate の期間のゲートと同じ: validUntil === now は期限切れ、validFrom === now は有効", async () => {
    const { runtime, stores } = buildRuntime();
    const endsNow = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: NOW }));
    const startsNow = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: NOW }));
    const endsJustAfter = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validUntil: new Date(NOW.getTime() + 1) }),
    );
    const startsJustAfter = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: new Date(NOW.getTime() + 1) }),
    );

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [endsNow.id, startsNow.id, endsJustAfter.id, startsJustAfter.id] },
      dryRun: true,
    });

    expect(result.basis).toEqual([
      { memoryId: endsNow.id, kind: "expired", validUntil: NOW },
      { memoryId: startsNow.id, kind: "eligible" },
      { memoryId: endsJustAfter.id, kind: "eligible" },
      {
        memoryId: startsJustAfter.id,
        kind: "not_yet_valid",
        validFrom: new Date(NOW.getTime() + 1),
      },
    ]);
  });

  it("やりすぎの歯: いまの時点で期間の内側にある記憶（両端あり・片端だけ・両端 null）は今どおり材料になる", async () => {
    const { runtime, stores } = buildRuntime();
    const bounded = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: PAST, validUntil: FUTURE }),
    );
    const fromOnly = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: PAST }));
    const untilOnly = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: FUTURE }));
    const unbounded = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [bounded.id, fromOnly.id, untilOnly.id, unbounded.id] },
    });

    expect(result.outcome).toBe("reflected");
    expect(result.basis.map((b) => b.kind)).toEqual(["used", "used", "used", "used"]);
  });

  it("判定の優先順: status を先に見る（forgotten で期限切れは status_not_active）。逆転した区間は expired", async () => {
    const { runtime, stores } = buildRuntime();
    const forgottenExpired = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validUntil: PAST }),
    );
    await runtime.forget(ctx, { memoryId: forgottenExpired.id });
    // 逆転した区間: validFrom が validUntil より後。どの時点でも期間の外にある。
    const inverted = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: FUTURE, validUntil: PAST }),
    );

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [forgottenExpired.id, inverted.id] },
      dryRun: true,
    });

    expect(result.basis).toEqual([
      { memoryId: forgottenExpired.id, kind: "status_not_active", status: "forgotten" },
      { memoryId: inverted.id, kind: "expired", validUntil: PAST },
    ]);
  });

  it("判定の優先順: 有効期間を basis_is_reflected より先に見る（期限切れの reflected 産物は expired）", async () => {
    const { runtime, stores } = buildRuntime();
    const expiredReflected = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        validUntil: PAST,
        provenance: { kind: "reflected", sources: ["seed-1"] },
      }),
    );
    const currentReflected = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ provenance: { kind: "reflected", sources: ["seed-2"] } }),
    );

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [expiredReflected.id, currentReflected.id] },
      dryRun: true,
    });

    expect(result.basis).toEqual([
      { memoryId: expiredReflected.id, kind: "expired", validUntil: PAST },
      { memoryId: currentReflected.id, kind: "basis_is_reflected" },
    ]);
  });
});
