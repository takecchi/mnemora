import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "store-id-passthrough-other-mouths" };
const T0 = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

async function setup() {
  const stores = createFakeRuntimeStores();
  const rt = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    relationStore: stores.relationStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (c: string) => `sha256(${c})`,
    clock: { now: () => T0 },
  });
  const halfLifeHours = 24 * 365;
  let seq = 0;
  const make = async (status: NewMemory["status"] = "active") => {
    seq += 1;
    const newMemory: NewMemory = {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文${seq}`,
      contentHash: `h-${seq}`,
      digest: `要旨${seq}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "store-id-passthrough-other-mouths" },
      tags: [],
      occurredAt: null,
      recordedAt: T0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: T0,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
      status,
    };
    return (await stores.memoryStore.createMemory(ctx, newMemory)).id;
  };
  return { rt, stores, make };
}

// Fake は大文字の id も同じ記憶と答えるので、渡す側を小文字にしても結果は変わらない。引数そのものを見る。
const upperOf = (id: MemoryId) => id.toUpperCase() as MemoryId;
const NOT_FOUND = "Not-Found-ID-ABC" as MemoryId;

describe("store へ渡す id は、渡されたまま（小文字にしない）", () => {
  it("restoreArchived: getMany へ、大文字の id と綴りの混ざった存在しない id がそのまま渡る", async () => {
    const { rt, stores, make } = await setup();
    const id = await make("archived");
    const upper = upperOf(id);
    expect(upper).not.toBe(id);
    const getMany = vi.spyOn(stores.memoryStore, "getMany");

    const result = await rt.restoreArchived(ctx, { memoryIds: [upper, NOT_FOUND] });

    expect(getMany.mock.calls[0]![1]).toEqual([upper, NOT_FOUND]);
    expect(result.outcomes).toMatchObject([
      { memoryId: upper, kind: "restored" },
      { memoryId: NOT_FOUND, kind: "not_found" },
    ]);
  });

  it("purge: getMany へ、大文字の id と綴りの混ざった存在しない id がそのまま渡る", async () => {
    const { rt, stores, make } = await setup();
    const id = await make();
    await rt.forget(ctx, { memoryId: id });
    const upper = upperOf(id);
    const getMany = vi.spyOn(stores.memoryStore, "getMany");

    const result = await rt.purge(ctx, { memoryIds: [upper, NOT_FOUND] });

    expect(getMany.mock.calls[0]![1]).toEqual([upper, NOT_FOUND]);
    expect(result.outcomes).toMatchObject([
      { memoryId: upper, kind: "purged" },
      { memoryId: NOT_FOUND, kind: "not_found" },
    ]);
  });

  it("markContested: getMany へ、大文字の id 2つがそのまま渡る", async () => {
    const { rt, stores, make } = await setup();
    const a = await make();
    const b = await make();
    const getMany = vi.spyOn(stores.memoryStore, "getMany");

    const result = await rt.markContested(ctx, upperOf(a), upperOf(b));

    expect(getMany.mock.calls[0]![1]).toEqual([upperOf(a), upperOf(b)]);
    expect(result.outcome.kind).toBe("contested");
  });

  it("resolveContested（supersede）: store へ渡す supersededById は、渡された winnerId の綴りのまま", async () => {
    const { rt, stores, make } = await setup();
    const a = await make();
    const b = await make();
    await rt.markContested(ctx, a, b);
    const resolveContestedPair = vi.spyOn(stores.memoryStore, "resolveContestedPair");

    const winnerUpper = upperOf(b);
    const result = await rt.resolveContested(ctx, a, b, {
      kind: "supersede",
      winnerId: winnerUpper,
    });

    expect(result.outcome.kind).toBe("resolved");
    const sides = resolveContestedPair.mock.calls[0]!.slice(1) as Array<{
      id: MemoryId;
      status: string;
      supersededById?: MemoryId;
    }>;
    const loser = sides.find((s) => s.status === "superseded")!;
    expect(loser.id).toBe(a);
    expect(loser.supersededById).toBe(winnerUpper);
  });
});

describe("resolveContested: どちらの側とも大文字小文字を無視しても違う winnerId は、store を読まずに RangeError", () => {
  it("get を1回も呼ばず、何も書かない", async () => {
    const { rt, stores, make } = await setup();
    const a = await make();
    const b = await make();
    await rt.markContested(ctx, a, b);
    const get = vi.spyOn(stores.memoryStore, "get");
    const resolveContestedPair = vi.spyOn(stores.memoryStore, "resolveContestedPair");

    await expect(
      rt.resolveContested(ctx, a, b, {
        kind: "supersede",
        winnerId: "Not-Either-Side" as MemoryId,
      }),
    ).rejects.toThrow(RangeError);

    expect(get).not.toHaveBeenCalled();
    expect(resolveContestedPair).not.toHaveBeenCalled();
  });
});

describe("大文字小文字だけが違う id を同じ呼び出しに混ぜたときは、渡された文字列どおりに突き合わせる", () => {
  it("restoreArchived: store の id と同じ綴りの側だけが見つかり、大文字の側は not_found（並びの位置によらない）", async () => {
    for (const order of ["lower-first", "upper-first"] as const) {
      const { rt, make } = await setup();
      const id = await make("archived");
      const upper = upperOf(id);
      const ids = order === "lower-first" ? [id, upper] : [upper, id];

      const result = await rt.restoreArchived(ctx, { memoryIds: ids });

      const kinds = Object.fromEntries(result.outcomes.map((o) => [o.memoryId, o.kind]));
      expect(kinds, order).toEqual({ [id]: "restored", [upper]: "not_found" });
    }
  });

  it("purge: store の id と同じ綴りの側だけが見つかり、大文字の側は not_found（並びの位置によらない）", async () => {
    for (const order of ["lower-first", "upper-first"] as const) {
      const { rt, make } = await setup();
      const id = await make();
      await rt.forget(ctx, { memoryId: id });
      const upper = upperOf(id);
      const ids = order === "lower-first" ? [id, upper] : [upper, id];

      const result = await rt.purge(ctx, { memoryIds: ids });

      const kinds = Object.fromEntries(result.outcomes.map((o) => [o.memoryId, o.kind]));
      expect(kinds, order).toEqual({ [id]: "purged", [upper]: "not_found" });
    }
  });
});

describe("reflect・consolidate: 混ぜた id は渡された文字列どおりに突き合わせる（2026-09-28 マージ分 #1327）", () => {
  it("reflect { memoryIds }: store の id と同じ綴りの側だけが eligible、大文字の側は not_found", async () => {
    const { rt, make } = await setup();
    const a = await make();
    const b = await make();

    const result = await rt.reflect(ctx, {
      target: { memoryIds: [a, upperOf(a), b] },
      dryRun: true,
    });

    expect(result.basis).toEqual([
      { memoryId: a, kind: "eligible" },
      { memoryId: upperOf(a), kind: "not_found" },
      { memoryId: b, kind: "eligible" },
    ]);
  });

  it("reflect { memoryIds }: 大文字だけで渡せば、store が在ると言う記憶は eligible（対照）", async () => {
    const { rt, make } = await setup();
    const a = await make();
    const b = await make();

    const result = await rt.reflect(ctx, {
      target: { memoryIds: [upperOf(a), upperOf(b)] },
      dryRun: true,
    });

    expect(result.basis).toEqual([
      { memoryId: upperOf(a), kind: "eligible" },
      { memoryId: upperOf(b), kind: "eligible" },
    ]);
  });

  it("consolidate { memoryIds }: store の id と同じ綴りの側だけが eligible、大文字の側は not_found", async () => {
    const { rt, make } = await setup();
    const a = await make();
    const b = await make();

    const result = await rt.consolidate(ctx, {
      target: { memoryIds: [a, upperOf(a), b] },
      dryRun: true,
    });

    expect(result.sources).toEqual([
      { memoryId: a, kind: "eligible" },
      { memoryId: upperOf(a), kind: "not_found" },
      { memoryId: b, kind: "eligible" },
    ]);
  });
});

describe("同じ綴りで2回渡した大文字の id は、混在ではないので not_found にならない", () => {
  it("restoreArchived({ memoryIds: [大文字, 大文字] })", async () => {
    const { rt, make } = await setup();
    const id = await make("archived");
    const upper = upperOf(id);

    const result = await rt.restoreArchived(ctx, { memoryIds: [upper, upper] });

    expect(result.outcomes.map((o) => o.kind)).not.toContain("not_found");
    expect(result.outcomes[0]).toMatchObject({ memoryId: upper, kind: "restored" });
  });

  it("purge({ memoryIds: [大文字, 大文字] })", async () => {
    const { rt, make } = await setup();
    const id = await make();
    await rt.forget(ctx, { memoryId: id });
    const upper = upperOf(id);

    const result = await rt.purge(ctx, { memoryIds: [upper, upper] });

    expect(result.outcomes.map((o) => o.kind)).not.toContain("not_found");
    expect(result.outcomes[0]).toMatchObject({ memoryId: upper, kind: "purged" });
  });

  it("forget({ memoryIds: [大文字, 大文字] })", async () => {
    const { rt, make } = await setup();
    const id = await make();
    const upper = upperOf(id);

    const result = await rt.forget(ctx, { memoryIds: [upper, upper] });

    expect(result.outcomes.map((o) => o.kind)).not.toContain("not_found");
    expect(result.outcomes[0]).toMatchObject({ memoryId: upper, kind: "forgotten" });
  });
});
