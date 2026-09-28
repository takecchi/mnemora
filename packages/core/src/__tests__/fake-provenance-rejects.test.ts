import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * core の Fake（`FakeMemoryStore`）が `provenance` をどう扱うかの歯（8回目の TSDoc の棚卸し。`MemoryStore.createMemory` の TSDoc）。
 * testkit の fixture と `@mnemora/postgres` が拒む3つの形のうち、2つに揃えた:
 * - `provenance.kind` が列挙に無い → 投げる
 * - `provenance` が `null` → 投げる（`TypeError`）
 *
 * ⚠ **3つ目（`stated`・`inferred` なのに列の `sourceObservationId` が `null`）は、意図して揃えていない——Fake は受け付ける。**
 * fixture と Postgres は拒むが、core の既存のテストのうち25件（`recall-pipeline`・`recall-basis-lost`・`recall-association`・
 * `recall-exclude-provenance-filter`・`runtime` の5ファイル）が、`sourceObservationId: null` の `inferred`・`stated` の Memory を
 * この Fake に書いて前提にしている。拒むとそれらのデータを書き換えることになり、各テストが縛っているものが変わりうる。
 * 下の歯はこの違いを今の振る舞いとして縛る（揃えるときは、この歯と25件をいっしょに見直すこと）。
 *
 * それ以外の中身の欠け（欄が無い・値域の外）は、Postgres・fixture と同じく検査しない（受け付ける）。
 * Postgres と fixture の側の歯は `packages/postgres/src/__tests__/store-input-current-behaviour.postgres.test.ts`。
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
  "FakeMemoryStore.%s の provenance の扱い（fixture・Postgres と2つを揃え、1つは意図して違える）",
  (_name, write) => {
    it("provenance.kind が列挙に無ければ投げる", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({ provenance: { kind: "bogus" } as never }))).rejects.toThrow(
        /provenance_kind must be one of stated, inferred, consolidated, reflected, imported/,
      );
    });

    it.each(["stated", "inferred"] as const)(
      "provenance.kind が %s なのに列の sourceObservationId が null でも、受け付ける（fixture・Postgres と意図して違える）",
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
        // ⚠ fixture・Postgres はここで投げる。Fake は意図して受け付ける（上の doc）。
        const memory = await write(
          store,
          input({ sourceObservationId: null, provenance: provenance as never }),
        );
        expect(memory.sourceObservationId).toBeNull();
        expect(memory.provenance.kind).toBe(kind);
      },
    );

    it("provenance が null なら投げる", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({ provenance: null as never }))).rejects.toThrow(TypeError);
    });

    it("それ以外の中身の欠け（stated で at が無い）は、今までどおり受け付ける", async () => {
      const { store, observationId, input } = await setup();
      const memory = await write(
        store,
        input({ provenance: { kind: "stated", sourceObservationId: observationId } as never }),
      );
      expect(memory.id).toBeDefined();
    });

    it("正しい provenance は、今までどおり受け付ける", async () => {
      const { store, input } = await setup();
      await expect(write(store, input({}))).resolves.toMatchObject({ content: "本文" });
    });
  },
);
