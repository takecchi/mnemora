import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewMemoryEvent } from "../event.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function supersedeEvent(memoryId: string, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
    ...overrides,
  };
}

describe("FakeMemoryStore.supersedeWithNewMemories（Issue #134 / ADR 0100）", () => {
  it("news を作り（3件）、created を news と同じ順序で返し、supersededByIndex が指す行へ寄せる", async () => {
    const stores = createFakeRuntimeStores();
    const oldA = await stores.memoryStore.createMemory(ctx, newMemory());
    const oldB = await stores.memoryStore.createMemory(ctx, newMemory());

    // news は3件にして、異なる索引（0 と 2）へ寄せる: `created[i]` が `news[i]` に対応することは型が保証せず、
    // 2件だと並びがずれて別の記憶の id が `supersededById` に書かれても検査が緑で通る。
    const news1 = newMemory({ content: "news-1 の本文" });
    const news2 = newMemory({ content: "news-2 の本文" });
    const news3 = newMemory({ content: "news-3 の本文" });

    const result = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [
        { input: news1, jobKinds: ["embed"] },
        { input: news2, jobKinds: [] },
        { input: news3, jobKinds: [] },
      ],
      [
        {
          id: oldA.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(oldA.id),
        },
        {
          id: oldB.id,
          supersededByIndex: 2,
          expectedStatus: "active",
          event: supersedeEvent(oldB.id),
        },
      ],
    );

    expect(result.created).toHaveLength(3);
    expect(result.created.map((c) => c.memory.contentHash)).toEqual([
      news1.contentHash,
      news2.contentHash,
      news3.contentHash,
    ]);
    expect(result.created.map((c) => c.memory.content)).toEqual([
      "news-1 の本文",
      "news-2 の本文",
      "news-3 の本文",
    ]);
    expect(result.created.every((c) => c.created)).toBe(true);
    expect(result.created[0]?.jobs).toHaveLength(1);
    expect(result.created[1]?.jobs).toHaveLength(0);
    expect(result.created[2]?.jobs).toHaveLength(0);

    const anchor0 = result.created[0]!.memory.id;
    const anchor2 = result.created[2]!.memory.id;
    expect(anchor0).not.toBe(anchor2);

    expect(result.conflicted).toEqual([]);
    expect(result.superseded).toHaveLength(2);

    const updatedA = await stores.memoryStore.get(ctx, oldA.id);
    const updatedB = await stores.memoryStore.get(ctx, oldB.id);
    expect(updatedA?.status).toBe("superseded");
    expect(updatedA?.supersededById).toBe(anchor0);
    expect(updatedB?.status).toBe("superseded");
    expect(updatedB?.supersededById).toBe(anchor2);
  });

  it("CAS に弾かれた対象を conflicted に積み、他の news/supersede は commit される", async () => {
    const stores = createFakeRuntimeStores();
    const oldOk = await stores.memoryStore.createMemory(ctx, newMemory());
    const oldConflicted = await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.memoryStore.updateStatus(ctx, oldConflicted.id, "archived");
    // ⚠ Fake も Map の行の参照をそのまま返す——プリミティブへ写し取ってから比べる。
    const observedBeforeStatus: string = "archived";

    const result = await stores.memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: [] }],
      [
        {
          id: oldOk.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(oldOk.id),
        },
        {
          id: oldConflicted.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(oldConflicted.id),
        },
      ],
    );

    expect(result.conflicted).toEqual([{ id: oldConflicted.id, observedStatus: "archived" }]);
    expect(result.created).toHaveLength(1);
    expect(result.superseded).toHaveLength(1);

    const updatedOk = await stores.memoryStore.get(ctx, oldOk.id);
    expect(updatedOk?.status).toBe("superseded");
    expect(updatedOk?.supersededById).toBe(result.created[0]!.memory.id);

    const stillConflicted = await stores.memoryStore.get(ctx, oldConflicted.id);
    expect(stillConflicted?.status).toBe(observedBeforeStatus);
  });

  it("supersede 対象がそもそも存在しなければ throw し、news の作成も含めてロールバックする", async () => {
    const stores = createFakeRuntimeStores();
    const missingId = randomUUID();
    const observation = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    // 冪等キー（sourceObservationId, extractorVersion, contentHash）を意図的に持たせる——
    // ロールバックされていなければ、同じキーでの再作成が `created: false`（衝突）になる。
    const newsInput = newMemory({
      sourceObservationId: observation.id,
      extractorVersion: "fake-supersede-with-new-memories-v1",
    });

    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [{ input: newsInput, jobKinds: [] }],
        [
          {
            id: missingId,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: supersedeEvent(missingId),
          },
        ],
      ),
    ).rejects.toThrow(/memory not found for tenant/);

    const { created } = await stores.memoryStore.createMemoryWithOutbox(ctx, newsInput, []);
    expect(created).toBe(true);
  });

  it("範囲外の supersededByIndex を RangeError で落とし、news の作成もロールバックする", async () => {
    const stores = createFakeRuntimeStores();
    const oldA = await stores.memoryStore.createMemory(ctx, newMemory());
    const observation = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    const newsInput = newMemory({
      sourceObservationId: observation.id,
      extractorVersion: "fake-supersede-with-new-memories-v1",
    });

    // `RangeError` であることとメッセージまで固定する: CAS で弾かれた場合・対象の行が無い場合とは別の失敗なので、潰さない。
    await expect(
      stores.memoryStore.supersedeWithNewMemories(
        ctx,
        [{ input: newsInput, jobKinds: [] }],
        [
          {
            id: oldA.id,
            supersededByIndex: 1,
            expectedStatus: "active",
            event: supersedeEvent(oldA.id),
          },
        ],
      ),
    ).rejects.toThrow(/supersededByIndex out of range/);

    const unchanged = await stores.memoryStore.get(ctx, oldA.id);
    expect(unchanged?.status).toBe("active");

    const { created } = await stores.memoryStore.createMemoryWithOutbox(ctx, newsInput, []);
    expect(created).toBe(true);
  });
});
