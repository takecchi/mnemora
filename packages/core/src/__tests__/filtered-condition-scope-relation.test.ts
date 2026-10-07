import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import type { FilteredOmission } from "../recall.js";
import { FILTERED_CONDITION_SCOPE_RELATION } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 網羅性は型（このファイル自身が持つ `Record<FilteredOmission["condition"], true>`）と実行時の両方で見る（型だけでは zod 側・実装側の緩みに気づけない）。
 * `recall()` の `omitted` は本番の生成経路（`recall-runtime.ts`）を駆動して確かめる: 値を手で組み立てて schema に通すだけでは、`recall-runtime.ts` 側が定数を読み忘れて別の値を push する事故を捕まえられない。
 * 各 `condition` について1状況ずつしか駆動しない（`tenant`/`taxonomy` は本番コードが生成しない値）。境界値・複数条件の組み合わせは `recall-decay-gate.test.ts` / `recall-validity.test.ts` / `recall-pipeline.test.ts` が持つ。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

describe("FILTERED_CONDITION_SCOPE_RELATION の網羅性", () => {
  // `recall.test.ts` の `ALL_FILTERED_CONDITIONS` と同じ形だが独立に持つ: `FILTERED_CONDITION_SCOPE_RELATION` 自身の宣言を検査対象にするテストが、同じ宣言を「正解」として借りると自明になってしまうため。
  const ALL_FILTERED_CONDITIONS: Record<FilteredOmission["condition"], true> = {
    tenant: true,
    superseded: true,
    forgotten: true,
    archived: true,
    taxonomy: true,
    period: true,
    decayed: true,
    expired: true,
    not_yet_valid: true,
  };

  it("キー集合が FilteredOmission['condition'] の全値と実行時に一致する（型を緩める変異はここで赤くなる）", () => {
    const expectedKeys = Object.keys(ALL_FILTERED_CONDITIONS).sort();
    const actualKeys = Object.keys(FILTERED_CONDITION_SCOPE_RELATION).sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it.each(Object.keys(ALL_FILTERED_CONDITIONS) as FilteredOmission["condition"][])(
    "condition: %s は 'outside_scope' か 'within_scope' のどちらかを持つ",
    (condition) => {
      expect(["outside_scope", "within_scope"]).toContain(
        FILTERED_CONDITION_SCOPE_RELATION[condition],
      );
    },
  );

  it("decayed だけが within_scope である（他の6つは outside_scope）— Issue #352 の非対称そのもの", () => {
    const entries = Object.entries(FILTERED_CONDITION_SCOPE_RELATION) as [
      FilteredOmission["condition"],
      string,
    ][];
    const withinScope = entries.filter(([, rel]) => rel === "within_scope").map(([c]) => c);
    expect(withinScope).toEqual(["decayed"]);
  });
});

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
      completeStructured: async () => {
        throw new Error("not used");
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
    occurredAt: new Date("2026-03-01T00:00:00.000Z"),
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({ recordedAt, lastReinforcedAt: null, strength, halfLifeHours }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("recall() が返す omitted.filtered の scopeRelation（本番の生成経路を駆動する）", () => {
  it("archived/superseded/forgotten/period/expired/not_yet_valid/decayed の7条件すべてで、omitted.filtered の scopeRelation が FILTERED_CONDITION_SCOPE_RELATION と一致する", async () => {
    const { runtime, stores } = buildRuntime();

    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "superseded" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date("2020-01-01T00:00:00.000Z") }), // period の外
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validUntil: new Date(NOW.getTime() - 1_000) }), // expired
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: new Date(NOW.getTime() + 1_000) }), // not_yet_valid
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(NOW.getTime() - 1_000) }), // decayed
    );
    // スコープ内に残る「生きている」記憶も1件混ぜる——全部落ちて index が空、という
    // 縮退したケースにしない。
    await stores.memoryStore.createMemory(ctx, newMemory({}));

    const result = await runtime.recall(ctx, {
      occurredAfter: new Date("2026-01-01T00:00:00.000Z"),
    });

    const filteredOmissions = result.omitted.filter(
      (o): o is FilteredOmission => o.kind === "filtered",
    );
    const seenConditions = filteredOmissions.map((o) => o.condition).sort();
    expect(seenConditions).toEqual(
      [
        "archived",
        "decayed",
        "expired",
        "forgotten",
        "not_yet_valid",
        "period",
        "superseded",
      ].sort(),
    );

    for (const omission of filteredOmissions) {
      expect(omission.scopeRelation).toBe(FILTERED_CONDITION_SCOPE_RELATION[omission.condition]);
    }

    const decayedOmission = filteredOmissions.find((o) => o.condition === "decayed");
    expect(decayedOmission?.scopeRelation).toBe("within_scope");
    const outsideScopeOmissions = filteredOmissions.filter((o) => o.condition !== "decayed");
    for (const omission of outsideScopeOmissions) {
      expect(omission.scopeRelation).toBe("outside_scope");
    }
  });
});
