import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
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

describe("FakeMemoryStore.createMemory — validFrom/validUntil（Issue #202、ADR 0145）", () => {
  it("validFrom/validUntil を書き込み、get で読み戻す", async () => {
    const stores = createFakeRuntimeStores();
    const validFrom = new Date("2025-01-01T00:00:00.000Z");
    const validUntil = new Date("2025-12-31T23:59:59.000Z");

    const created = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom, validUntil }),
    );
    expect(created.validFrom?.getTime()).toBe(validFrom.getTime());
    expect(created.validUntil?.getTime()).toBe(validUntil.getTime());

    const reread = await stores.memoryStore.get(ctx, created.id);
    expect(reread?.validFrom?.getTime()).toBe(validFrom.getTime());
    expect(reread?.validUntil?.getTime()).toBe(validUntil.getTime());
  });

  it("省略すると null のまま保存・返却する（非破壊の既定値）", async () => {
    const stores = createFakeRuntimeStores();

    const created = await stores.memoryStore.createMemory(ctx, newMemory());
    expect(created.validFrom ?? null).toBeNull();
    expect(created.validUntil ?? null).toBeNull();
  });

  it("occurredAt と validFrom/validUntil を混同しない — 3つに別々の値を渡すと、別々に返る（Issue #202 受け入れ条件2）", async () => {
    const stores = createFakeRuntimeStores();
    const occurredAt = new Date("2024-06-01T00:00:00.000Z");
    const validFrom = new Date("2025-01-01T00:00:00.000Z");
    const validUntil = new Date("2025-12-31T23:59:59.000Z");

    const created = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt, validFrom, validUntil }),
    );

    expect(created.occurredAt?.getTime()).toBe(occurredAt.getTime());
    expect(created.validFrom?.getTime()).toBe(validFrom.getTime());
    expect(created.validUntil?.getTime()).toBe(validUntil.getTime());
    expect(created.occurredAt?.getTime()).not.toBe(created.validFrom?.getTime());
    expect(created.validFrom?.getTime()).not.toBe(created.validUntil?.getTime());
  });
});
