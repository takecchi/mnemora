import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { MemorySchema } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import {
  MALFORMED_NEW_MEMORY_CASES,
  WELL_FORMED_NEW_MEMORY_CASES,
} from "./malformed-new-memory-cases.js";

const ctx: Ctx = { tenantId: "fake-new-memory" };

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
  const store = stores.memoryStore;
  const observation = await store.createObservation(ctx, {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "t" },
    recordedAt: new Date("2026-01-01T00:00:00Z"),
  } as never);
  const obs = observation.id;
  const input = (over: Partial<NewMemory> = {}): NewMemory =>
    ({
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: obs,
      extractorVersion: "v1",
      content: "本文",
      contentHash: "h",
      digest: "本文",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "b" },
      tags: ["tag-a"],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2027-01-01T00:00:00Z"),
      embeddingStatus: "pending",
      ...over,
    }) as NewMemory;
  const backing = (store as unknown as { backing: { outboxJobs: unknown[] } }).backing;
  /** 書かれたものの写し（Memory・ラベル・outbox・イベント）。 */
  const state = async () =>
    JSON.stringify({
      memories: (await store.listBySourceObservationAllVersions(ctx, obs)).map((m) => m.id),
      labels: await store.listLabels(ctx),
      outbox: backing.outboxJobs.length,
    });
  return { store, obs, input, state };
}

describe.each(WRITES)(
  "FakeMemoryStore.%s は、読み戻すと MemorySchema を通らない値を入口で拒む（ADR 0630）",
  (_name, write) => {
    it.each(MALFORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
      "%s は拒み、何も書かない",
      async (_label, c) => {
        const { store, obs, input, state } = await setup();
        const before = await state();
        await expect(write(store, input(c.over(obs)))).rejects.toThrow(c.field);
        expect(await state()).toBe(before);
      },
    );

    it.each(MALFORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
      "%s は、冪等の既存の行が在っても拒む",
      async (_label, c) => {
        const { store, obs, input, state } = await setup();
        const existing = await write(store, input());
        const before = await state();
        // 既存の行と同じ冪等キー（観測・抽出器の版・contentHash）で、壊れた値を渡す。
        const bad = { ...input(c.over(obs)) };
        await expect(write(store, bad)).rejects.toThrow(c.field);
        expect(await state()).toBe(before);
        expect(existing.id).toBeDefined();
      },
    );

    it.each(WELL_FORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
      "%s は通り、読み戻した Memory は MemorySchema を通る",
      async (_label, c) => {
        const { store, obs, input } = await setup();
        const memory = await write(store, input(c.over(obs)));
        expect(MemorySchema.safeParse(memory).success).toBe(true);
      },
    );
  },
);

describe("FakeMemoryStore.supersedeWithNewMemories: news の2件目が壊れていたら、1件目も書かない", () => {
  it("1件目の Memory・ラベル・outbox が残らない", async () => {
    const { store, input, state } = await setup();
    const before = await state();
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [
          { input: input({ contentHash: "first", tags: ["only-first"] }), jobKinds: ["embed"] },
          { input: input({ contentHash: "second", digest: "" }), jobKinds: ["embed"] },
        ],
        [],
      ),
    ).rejects.toThrow(/digest/);
    expect(await state()).toBe(before);
  });

  it("3件の真ん中が壊れていても拒み、前後の Memory・ラベル・outbox も残らない", async () => {
    const { store, input, state } = await setup();
    const before = await state();
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [
          { input: input({ contentHash: "first", tags: ["only-first"] }), jobKinds: ["embed"] },
          { input: input({ contentHash: "middle", digest: "" }), jobKinds: ["embed"] },
          { input: input({ contentHash: "last", tags: ["only-last"] }), jobKinds: ["embed"] },
        ],
        [],
      ),
    ).rejects.toThrow(/digest/);
    expect(await state()).toBe(before);
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: 例外の順（ADR 0630）", () => {
  it("壊れた news と存在しない対象が同時なら、壊れた値の例外（is malformed）が先に出る", async () => {
    const { store, input, state } = await setup();
    const before = await state();
    const missing = "00000000-0000-4000-8000-000000000001";
    const outcome = await store.supersedeWithNewMemories!(
      ctx,
      [{ input: input({ digest: "" }), jobKinds: ["embed"] }],
      [
        {
          id: missing as never,
          supersededByIndex: 0,
          event: {
            tenantId: ctx.tenantId,
            memoryId: missing as never,
            kind: "superseded",
            actor: { type: "system" },
            digestSnapshot: "d",
            sizeBeforeBytes: null,
            meta: { reason: "test" },
          },
        },
      ],
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(outcome)).toMatch(/digest is malformed/);
    expect(String(outcome)).not.toMatch(/memory not found/);
    expect(await state()).toBe(before);
  });
});

describe("FakeMemoryStore: 範囲外の口は拒まない（ADR 0630）", () => {
  it("createObservation・createObservationWithOutbox は、attributes の値が文字列でなくても、この検査では拒まない", async () => {
    const { store } = await setup();
    const base = {
      tenantId: ctx.tenantId,
      kind: "utterance",
      payload: { text: "t" },
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      attributes: { a: 1 },
    };
    await expect(
      store.createObservation(ctx, { ...base, externalId: "scope-1" } as never),
    ).resolves.toBeDefined();
    await expect(
      store.createObservationWithOutbox(ctx, { ...base, externalId: "scope-2" } as never, []),
    ).resolves.toBeDefined();
  });
});
