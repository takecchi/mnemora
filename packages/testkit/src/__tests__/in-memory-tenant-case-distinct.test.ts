import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const UPPER: Ctx = { tenantId: "Tenant-A" };
const LOWER: Ctx = { tenantId: "tenant-a" };

async function setup() {
  const store = new InMemoryMemoryStore();
  const upperMemory = await store.createMemory(
    UPPER,
    buildNewMemoryFixture({ tenantId: UPPER.tenantId, content: "upper", contentHash: "h-upper" }),
  );
  const lowerMemory = await store.createMemory(
    LOWER,
    buildNewMemoryFixture({ tenantId: LOWER.tenantId, content: "lower", contentHash: "h-lower" }),
  );
  return { store, upperMemory, lowerMemory };
}

describe("綴りだけが違う tenant は別の tenant（InMemoryMemoryStore）", () => {
  it("get・getMany: 相手の綴りの tenant からは null・空配列。自分の tenant からは見える", async () => {
    const { store, upperMemory, lowerMemory } = await setup();
    expect(upperMemory.tenantId).toBe("Tenant-A");
    expect(lowerMemory.tenantId).toBe("tenant-a");

    expect(await store.get(LOWER, upperMemory.id)).toBeNull();
    expect(await store.get(UPPER, lowerMemory.id)).toBeNull();
    expect((await store.get(UPPER, upperMemory.id))?.id).toBe(upperMemory.id);
    expect((await store.get(LOWER, lowerMemory.id))?.id).toBe(lowerMemory.id);

    expect(await store.getMany(LOWER, [upperMemory.id])).toEqual([]);
    expect(await store.getMany(UPPER, [lowerMemory.id])).toEqual([]);
    expect((await store.getMany(UPPER, [upperMemory.id, lowerMemory.id])).map((m) => m.id)).toEqual(
      [upperMemory.id],
    );
  });

  it("getObservation: 相手の綴りの tenant からは null。自分の tenant からは見える", async () => {
    const store = new InMemoryMemoryStore();
    const upperObservation = await store.createObservation(
      UPPER,
      buildNewObservationFixture({ tenantId: UPPER.tenantId, externalId: "ext-upper" }),
    );
    expect(await store.getObservation(LOWER, upperObservation.id)).toBeNull();
    expect((await store.getObservation(UPPER, upperObservation.id))?.id).toBe(upperObservation.id);
  });

  it("aggregateScope: 綴りの違う tenant の件数を数えない（それぞれ1件）", async () => {
    const { store } = await setup();
    expect((await store.aggregateScope(UPPER, {})).totalInScope).toBe(1);
    expect((await store.aggregateScope(LOWER, {})).totalInScope).toBe(1);
  });

  it("listLabels: 登録したラベルは、登録した tenant の綴りでだけ見える", async () => {
    const store = new InMemoryMemoryStore();
    await store.registerLabel(UPPER, "label-only-upper");
    expect((await store.listLabels(UPPER)).map((l) => l.name)).toEqual(["label-only-upper"]);
    expect(await store.listLabels(LOWER)).toEqual([]);
  });

  it("eraseTenant: 片方の綴りを消しても、もう片方の行は残る", async () => {
    const { store, upperMemory, lowerMemory } = await setup();
    const erased = await store.eraseTenant(UPPER, { limit: 1000 });
    expect(erased).toMatchObject({ kind: "executed", deleted: expect.any(Number) });
    expect(erased.kind === "executed" ? erased.deleted : 0).toBeGreaterThan(0);
    expect(await store.get(UPPER, upperMemory.id)).toBeNull();
    expect((await store.get(LOWER, lowerMemory.id))?.id).toBe(lowerMemory.id);
  });
});
