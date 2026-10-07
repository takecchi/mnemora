import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-provenance-kind-rejection" };
const BAD_KIND = { kind: "bogus" } as never;

type Write = (store: MemoryStore, input: NewMemory) => Promise<Memory>;
const WRITES: Array<[string, Write]> = [
  ["createMemory", (store, input) => store.createMemory(ctx, input)],
  [
    "createMemoryWithOutbox",
    async (store, input) => (await store.createMemoryWithOutbox(ctx, input, ["embed"])).memory,
  ],
  [
    "supersedeWithNewMemories",
    async (store, input) =>
      (await store.supersedeWithNewMemories!(ctx, [{ input, jobKinds: ["embed"] }], [])).created[0]!
        .memory,
  ],
];

async function setup() {
  const { memoryStore: store } = createFakeRuntimeStores();
  const observation = await store.createObservation(ctx, {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "t" },
    recordedAt: new Date("2026-01-01T00:00:00Z"),
  } as never);
  const input = (over: Partial<NewMemory>): NewMemory =>
    ({
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: observation.id,
      extractorVersion: null,
      content: "本文",
      contentHash: "same-hash",
      digest: "本文",
      digestSource: "llm",
      provenance: {
        kind: "stated",
        sourceObservationId: observation.id,
        at: "2026-01-01T00:00:00Z",
      },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2027-01-01T00:00:00Z"),
      embeddingStatus: "pending",
      ...over,
    }) as NewMemory;
  return { store, observationId: observation.id, input };
}

describe.each(WRITES)("FakeMemoryStore.%s は provenance.kind の拒否を", (_name, write) => {
  it("同じ sourceObservationId・contentHash の既存の行が在っても、再送で行う", async () => {
    const { store, input } = await setup();
    await write(store, input({}));

    await expect(write(store, input({ provenance: BAD_KIND }))).rejects.toThrow(
      /provenance_kind must be one of/,
    );
  });

  // Fake の内部の Map を直接読むと、行の置き場所の変更で壊れる。公開の読み口だけで「残っていない」を見る。
  it("記憶もラベルも書かずに行う", async () => {
    const { store, observationId, input } = await setup();

    await expect(
      write(store, input({ provenance: BAD_KIND, tags: ["rejected-tag"] })),
    ).rejects.toThrow(/provenance_kind must be one of/);

    expect(await store.listBySourceObservation(ctx, observationId, null)).toEqual([]);
    expect(await store.listLabels!(ctx)).toEqual([]);
  });
});
