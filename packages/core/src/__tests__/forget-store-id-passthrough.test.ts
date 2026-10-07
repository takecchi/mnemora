import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `memoryLookupKeyFor` は store が返した id と渡された id の突き合わせでだけ両側を小文字にし、store へ渡す id は変えない（在るかどうかは store が決める）。結果だけを見る `fake-uppercase-target-id.test.ts` では渡す側を小文字にしても赤くならないので、ここでは `getMany` を記録して渡された引数そのものを見る。 */

const ctx: Ctx = { tenantId: "forget-store-id-passthrough" };
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
  const newMemory: NewMemory = {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "h-1",
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "forget-store-id-passthrough" },
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
  };
  const created = await stores.memoryStore.createMemory(ctx, newMemory);
  const getMany = vi.spyOn(stores.memoryStore, "getMany");
  return { rt, id: created.id, getMany };
}

describe("forget: store の getMany へ渡す id は、渡されたまま（小文字にしない）", () => {
  it("大文字にした id と、綴りが混ざった存在しない id が、そのまま getMany に渡る", async () => {
    const { rt, id, getMany } = await setup();
    const upper = id.toUpperCase() as MemoryId;
    const mixed = "Not-Found-ID-ABC" as MemoryId;
    expect(upper).not.toBe(id);

    const result = await rt.forget(ctx, { memoryIds: [upper, mixed] });

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls[0]![1]).toEqual([upper, mixed]);
    expect(result.outcomes).toMatchObject([
      { memoryId: upper, kind: "forgotten" },
      { memoryId: mixed, kind: "not_found" },
    ]);
  });

  it("1件の指定（memoryId）でも、大文字のまま getMany に渡る", async () => {
    const { rt, id, getMany } = await setup();
    const upper = id.toUpperCase() as MemoryId;

    const result = await rt.forget(ctx, { memoryId: upper });

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls[0]![1]).toEqual([upper]);
    expect(result.outcomes[0]).toMatchObject({ memoryId: upper, kind: "forgotten" });
  });
});
