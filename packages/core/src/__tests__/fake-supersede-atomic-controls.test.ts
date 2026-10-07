import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { TaxonomyMode } from "../interfaces/tenant-settings-store.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const ctxA: Ctx = { tenantId: "tenant-ctl-a" };
let counter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `atomic-ctl-hash-${counter}`,
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

function supersedeEvent(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
  };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

function backingOf(stores: Stores) {
  return (
    stores.memoryStore as unknown as {
      backing: {
        memories: Map<string, unknown>;
        extractionIndex: Map<string, unknown>;
        labels: Map<string, unknown>;
        memoryLabels: Map<string, Set<string>>;
        events: unknown[];
        outboxJobs: unknown[];
      };
    }
  ).backing;
}

function snapshotOf(stores: Stores) {
  const backing = backingOf(stores);
  return structuredClone({
    memories: [...backing.memories.entries()],
    extractionIndex: [...backing.extractionIndex.entries()],
    labels: [...backing.labels.entries()],
    memoryLabels: [...backing.memoryLabels.entries()].map(([k, v]) => [k, [...v]]),
    events: backing.events,
    outboxJobs: backing.outboxJobs,
  });
}

async function newObservation(stores: Stores) {
  return stores.memoryStore.createObservation(ctx, {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "fixture" },
    occurredAt: null,
  });
}

describe("ADR 0564 の歯の穴: supersedeWithNewMemories の巻き戻しの範囲（O1・O3）", () => {
  it("O1: 失敗しても、先の呼び出しが残したイベントは消えない（巻き戻しすぎない）", async () => {
    const stores = createFakeRuntimeStores();
    const old = await stores.memoryStore.createMemory(ctx, newMemory());
    // 先に別の記憶を superseded にして、イベントを1件残す。
    const first = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: [] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(old.id),
        },
      ],
    );
    expect(first.superseded).toHaveLength(1);
    expect(backingOf(stores).events).toHaveLength(1);
    const before = snapshotOf(stores);

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory(), jobKinds: ["embed"] },
          { input: newMemory({ sourceObservationId: randomUUID() }), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toThrow(/observation not found/);

    expect(backingOf(stores).events).toHaveLength(1);
    expect(snapshotOf(stores)).toEqual(before);
  });

  it("O3: 成功した supersedeWithNewMemories の冪等キーの索引は残り、同じ入力の createMemoryWithOutbox は created: false", async () => {
    const stores = createFakeRuntimeStores();
    const observation = await newObservation(stores);
    const input = newMemory({ sourceObservationId: observation.id, extractorVersion: "ctl-v1" });

    const result = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input, jobKinds: ["embed"] }],
      [],
    );
    expect(result.created[0]?.created).toBe(true);
    expect(backingOf(stores).extractionIndex.size).toBe(1);

    const retry = await stores.memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    expect(retry.created).toBe(false);
    expect(retry.memory.id).toBe(result.created[0]!.memory.id);
    expect(retry.jobs).toEqual([]);
  });

  it("A4: 失敗した supersedeWithNewMemories の後でも、先に作った記憶の冪等キーの索引は残る（巻き戻しが索引を空にしない）", async () => {
    const stores = createFakeRuntimeStores();
    const observation = await newObservation(stores);
    const input = newMemory({ sourceObservationId: observation.id, extractorVersion: "ctl-v2" });
    const first = await stores.memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    expect(first.created).toBe(true);
    expect(backingOf(stores).extractionIndex.size).toBe(1);

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory(), jobKinds: ["embed"] },
          { input: newMemory({ sourceObservationId: randomUUID() }), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toThrow(/observation not found/);
    expect(backingOf(stores).extractionIndex.size).toBe(1);

    const retry = await stores.memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    expect(retry.created).toBe(false);
    expect(retry.memory.id).toBe(first.memory.id);
    expect(retry.jobs).toEqual([]);
  });
});

describe("ADR 0564 の歯の穴: 行を作る条件（O5・O6）", () => {
  it("O5: 不正な mode の setTaxonomyMode は投げ、行を作らない（getEventRetention は unset のまま）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(
      tenantSettingsStore.setTaxonomyMode!(ctxA, "bogus" as unknown as TaxonomyMode),
    ).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
    expect(await tenantSettingsStore.getTaxonomyMode!(ctxA)).toBe("open");
  });

  it("O5: float4 に収まらない値の setDefaultHalfLifeRecalls は投げ、行を作らない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 1e39)).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("B4: float4 で 0 に丸まる値（アンダーフロー 1e-50）の setDefaultHalfLifeRecalls も投げ、行を作らない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctxA, 1e-50)).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("B8: 不正な decay clock の setDecayClock は投げ、読み戻す値は元のまま（検査の前に書かない）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    const before = await tenantSettingsStore.getDecayClock!(ctxA);
    await expect(
      tenantSettingsStore.setDecayClock!(ctxA, "bogus" as unknown as "wall"),
    ).rejects.toThrow();
    expect(await tenantSettingsStore.getDecayClock!(ctxA)).toBe(before);
  });

  it("C6: 読む側（get*）は、新しいテナントの行を作らない", async () => {
    const { tenantSettingsStore: settings } = createFakeRuntimeStores();
    await settings.getDefaultHalfLifeHours(ctxA);
    await settings.getDecayClock!(ctxA);
    await settings.getDefaultHalfLifeRecalls!(ctxA);
    await settings.getActivitySeq!(ctxA);
    await settings.getSubjectActivitySeqs!(ctxA, []);
    await settings.hasSubjectActivityCounters!(ctxA);
    await settings.getTaxonomyMode!(ctxA);
    // 行の有無の観測は最後（getEventRetention 自身も読む側）。
    expect(await settings.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("O5: 不正な decay clock の setDecayClock も、行を作らない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(
      tenantSettingsStore.setDecayClock!(ctxA, "bogus" as unknown as "wall"),
    ).rejects.toThrow();
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("O6: テスト専用の setDefaultHalfLifeRecallsForTest は値を返すが、行は作らない（ADR 0564 の決定3）", async () => {
    const stores = createFakeRuntimeStores();
    const settings = stores.tenantSettingsStore as unknown as {
      setDefaultHalfLifeRecallsForTest(tenantId: string, value: number): void;
    };
    settings.setDefaultHalfLifeRecallsForTest(ctxA.tenantId, 123);
    expect(await stores.tenantSettingsStore.getDefaultHalfLifeRecalls!(ctxA)).toBe(123);
    expect(await stores.tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unset" });
  });

  it("対照: 検査を通った setTaxonomyMode は行を作る（unlimited）", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setTaxonomyMode!(ctxA, "strict");
    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "unlimited" });
  });
});
