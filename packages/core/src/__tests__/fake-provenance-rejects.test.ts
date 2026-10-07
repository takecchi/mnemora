import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 中身の欠けの全形は `fake-new-memory-rejects.test.ts` が縛るので、ここには1つだけ置く。
 */

const ctx: Ctx = { tenantId: "fake-provenance" };

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
  const stores = createFakeRuntimeStores();
  const observation = await stores.memoryStore.createObservation(ctx, {
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
      contentHash: `h-${Math.random()}`,
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
  return { store: stores.memoryStore, observationId: observation.id, input };
}

describe.each(WRITES)(
  "FakeMemoryStore.%s の provenance の扱い（fixture・Postgres と揃える）",
  (_name, write) => {
    it("provenance.kind が列挙に無ければ投げる", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({ provenance: { kind: "bogus" } as never }))).rejects.toThrow(
        /provenance_kind must be one of stated, inferred, consolidated, reflected, imported/,
      );
    });

    it.each(["stated", "inferred"] as const)(
      "provenance.kind が %s なのに列の sourceObservationId が null なら投げる",
      async (kind) => {
        const { store, observationId, input } = await setup();
        const provenance =
          kind === "stated"
            ? { kind, sourceObservationId: observationId, at: "2026-01-01T00:00:00Z" }
            : {
                kind,
                model: "m",
                promptVersion: "p",
                basis: { memoryIds: [], observationIds: [] },
                confidence: 0.5,
              };
        await expect(
          write(store, input({ sourceObservationId: null, provenance: provenance as never })),
        ).rejects.toThrow(new RegExp(`provenance\\.kind "${kind}" requires sourceObservationId`));
      },
    );

    it("provenance が null なら投げる", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({ provenance: null as never }))).rejects.toThrow(TypeError);
    });

    it("それ以外の中身の欠け（stated で at が無い）は、ADR 0630 から拒む（以前は受け付けた）", async () => {
      const { store, observationId, input } = await setup();
      await expect(
        write(
          store,
          input({ provenance: { kind: "stated", sourceObservationId: observationId } as never }),
        ),
      ).rejects.toThrow(/provenance\.at/);
    });

    it("正しい provenance は、今までどおり受け付ける", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({}))).resolves.toMatchObject({ content: "本文" });
    });
  },
);
