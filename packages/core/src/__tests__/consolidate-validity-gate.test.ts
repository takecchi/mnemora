import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "consolidate-validity-gate" };
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

/** 統合結果を固定で返し、LLM に渡された本文（プロンプト）を記録する。 */
function recordingLlm(prompts: string[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      prompts.push(JSON.stringify(req));
      return req.schema.parse({ content: "統合後の本文" }) as T;
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

describe("consolidate は、いまの時点で有効期間の外にある記憶を統合元にしない（Issue #1188）", () => {
  it("期限切れの記憶は expired で名指しし、動かさず、LLM にも渡さない。残りの2件は統合する", async () => {
    const prompts: string[] = [];
    const { runtime, stores } = buildRuntime(prompts);
    const expired = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "去年の住所は京都", validUntil: PAST }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "猫を飼っている" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "犬も飼っている" }));

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [expired.id, a.id, b.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("去年の住所は京都");
    expect(prompts[0]).toContain("猫を飼っている");

    const stillExpired = await stores.memoryStore.get(ctx, expired.id);
    expect(stillExpired?.status).toBe("active");
    expect(stillExpired?.supersededById ?? null).toBeNull();
    expect(stores.eventStore.events.filter((e) => e.memoryId === expired.id)).toEqual([]);

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.provenance).toMatchObject({ kind: "consolidated", sources: [a.id, b.id] });
    expect(created?.validFrom ?? null).toBeNull();
    expect(created?.validUntil ?? null).toBeNull();
  });

  it("期限切れを除くと1件しか残らないなら、LLM を呼ばずに single_eligible_source", async () => {
    const prompts: string[] = [];
    const { runtime, stores } = buildRuntime(prompts);
    const expired = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: PAST }));
    const current = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [expired.id, current.id] },
    });

    expect(result).toMatchObject({
      outcome: "nothing_to_consolidate",
      nothingReason: "single_eligible_source",
      consolidatedMemoryId: null,
      llmCalls: 0,
      atomicity: "not_attempted",
    });
    expect(result.sources).toEqual([
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: current.id, kind: "not_attempted" },
    ]);
    expect(prompts).toEqual([]);
    expect((await stores.memoryStore.get(ctx, current.id))?.status).toBe("active");
  });

  it("未到来の記憶は not_yet_valid で名指しする。全部が期間の外なら no_eligible_sources", async () => {
    const { runtime, stores } = buildRuntime();
    const future = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: FUTURE }));
    const expired = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: PAST }));

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [future.id, expired.id, future.id] },
    });

    expect(result).toMatchObject({
      outcome: "nothing_to_consolidate",
      nothingReason: "no_eligible_sources",
      llmCalls: 0,
    });
    expect(result.sources).toEqual([
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

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, expired.id, b.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: expired.id, kind: "expired", validUntil: PAST },
      { memoryId: b.id, kind: "eligible" },
    ]);
  });

  it("境界は recall の期間のゲートと同じ: validUntil === now は期限切れ、validFrom === now は有効", async () => {
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

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [endsNow.id, startsNow.id, endsJustAfter.id, startsJustAfter.id] },
      dryRun: true,
    });

    expect(result.sources).toEqual([
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

  it("やりすぎの歯: いまの時点で期間の内側にある記憶（両端あり・片端だけ・両端 null）は今どおり統合する", async () => {
    const { runtime, stores } = buildRuntime();
    const bounded = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: PAST, validUntil: FUTURE }),
    );
    const fromOnly = await stores.memoryStore.createMemory(ctx, newMemory({ validFrom: PAST }));
    const untilOnly = await stores.memoryStore.createMemory(ctx, newMemory({ validUntil: FUTURE }));
    const unbounded = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [bounded.id, fromOnly.id, untilOnly.id, unbounded.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.kind)).toEqual([
      "superseded",
      "superseded",
      "superseded",
      "superseded",
    ]);
  });

  it("status の判定が先: forgotten で期限切れの記憶は今どおり status_not_active。逆転した区間は expired", async () => {
    const { runtime, stores } = buildRuntime();
    const forgottenExpired = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validUntil: PAST }),
    );
    await runtime.forget(ctx, { memoryId: forgottenExpired.id });
    const inverted = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: FUTURE, validUntil: PAST }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [forgottenExpired.id, inverted.id] },
      dryRun: true,
    });

    expect(result.sources).toEqual([
      { memoryId: forgottenExpired.id, kind: "status_not_active", status: "forgotten" },
      { memoryId: inverted.id, kind: "expired", validUntil: PAST },
    ]);
  });
});
