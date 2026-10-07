import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function setupMarkContestedPair(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  runtime: ReturnType<typeof createRuntime>,
) {
  const a = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "A" }),
  );
  const b = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "B" }),
  );
  const markResult = await runtime.markContested(ctx, a.id, b.id);
  expect(markResult).toEqual({
    supported: true,
    outcome: { kind: "contested", first: expect.anything(), second: expect.anything() },
  });
  return { a, b };
}

describe("recall() — 段3の必須同伴取得は、companion 自身が壊れていれば拾わない", () => {
  it("forget した対向は companion として出てこない。生存側も単独では出ず unit_assembly_dropped に計上される", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    // a だけをベクタ検索で拾えるようにする。b は埋め込みを持たない
    // （= 段1の候補生成には出てこない。段3の必須同伴取得だけが b への経路になる)。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it.each(["superseded", "archived"] as const)(
    "対向の status が %s（contested でない）でも companion として出てこない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const { a, b } = await setupMarkContestedPair(stores, runtime);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

      // ADR 0557（ADR 0503 決定8 と同じ扱い）: superseded には置き換えた側が要る（archived には付けない）。
      await stores.memoryStore.updateStatus(ctx, b.id, status, {
        expectedStatus: "contested",
        ...(status === "superseded" ? { supersededById: a.id } : {}),
      });

      const result = await runtime.recall(ctx, { vector: [1, 0] });
      const ids = result.memories.map((m) => m.memoryId);

      expect(ids).not.toContain(b.id);
      expect(ids).not.toContain(a.id);
      expect(result.omitted).toContainEqual({
        kind: "unit_assembly_dropped",
        count: 1,
        countKind: "lower_bound",
      });
    },
  );
});

describe("recall() — 段3の必須同伴取得は decayFloorAt を検査しない（fetchMandatoryCompanions の doc・docs/recall.md §8。Issue #1775 の #824）", () => {
  it("decayFloorAt が now より前の contested の対向も companion として返り、生存側は単独で消えない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", digest: "A" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "active",
        digest: "B",
        // 忘却の床を過ぎている（通常の候補なら忘却ゲートで落ちる）。
        decayFloorAt: new Date(NOW.getTime() - 1_000),
      }),
    );
    await runtime.markContested(ctx, a.id, b.id);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(result.memories.find((m) => m.memoryId === b.id)?.retrievedVia).toBe(
      "mandatory_companion",
    );
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});
