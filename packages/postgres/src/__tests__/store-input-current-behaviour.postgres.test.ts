import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MemorySchema,
  type Ctx,
  type Memory,
  type MemoryStore,
  type NewMemory,
  type NewRecallRecord,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * store の入口が入力の中身をどう扱うかの、今の振る舞い（8回目の TSDoc の棚卸し）。
 *
 * - `getRecall`: adapter の期待する形式でない id は `null`（`MemoryStore.getRecall` の TSDoc）。3実装で縛る。
 * - `getRecall`: マイグレーション 0013 より前の形の行は `breakdownCaptured: false` で読み戻る（同じ TSDoc）。Postgres で縛る。
 * - `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`: `provenance` の中身は検査しない。拒むのは
 *   列挙に無い `kind`・列の `sourceObservationId` が無い `stated`/`inferred`・`null` の3つだけ（`createMemory` の TSDoc）。
 *   Postgres と testkit の fixture で縛る（core の Fake は `packages/core/src/__tests__/fake-provenance-rejects.test.ts`）。
 *
 * ⚠ 望ましい姿の主張ではない（検査を足すかは決まっていない）。変えるときは、この歯ごと書き換えること。
 */

const ctx: Ctx = { tenantId: "store-input-current-behaviour" };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

async function postgresStore(): Promise<MemoryStore> {
  const { db } = await getTestClient();
  return new PostgresMemoryStore(db);
}

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["Postgres", postgresStore],
  ["testkit の fixture", async () => new InMemoryMemoryStore()],
];

describe("getRecall: adapter の期待する形式でない id は null（例外にしない）", () => {
  it.each([
    ...KITS,
    ["core の Fake", async () => createFakeRuntimeStores().memoryStore] as [
      string,
      () => Promise<MemoryStore>,
    ],
  ])("%s", async (_name, build) => {
    const store = await build();
    for (const id of ["not-a-uuid", "", "00000000-0000-4000-8000-00000000000Z"]) {
      await expect(store.getRecall(ctx, id)).resolves.toBeNull();
    }
  });
});

describe("getRecall: マイグレーション 0013 より前の形の行は breakdownCaptured: false で読み戻る（Postgres）", () => {
  it("returned_memories が { breakdownCaptured: false, memories: [{ memoryId }] } の行を、そのまま返す", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const record: NewRecallRecord = {
      tenantId: ctx.tenantId,
      query: {},
      omitted: [],
      usage: {} as NewRecallRecord["usage"],
      indexBand: {} as NewRecallRecord["indexBand"],
      explain: { stages: [] },
      returnedMemories: [],
    };
    const recallId = await store.createRecall(ctx, record);
    // マイグレーション 0013 が、それより前の行を書き換える形（`memories` は移行元の memoryId だけを持つ）。
    await pool.query(`UPDATE recalls SET returned_memories = $2::jsonb WHERE id = $1`, [
      recallId,
      JSON.stringify({
        breakdownCaptured: false,
        memories: [{ memoryId: "11111111-1111-4111-8111-111111111111" }],
      }),
    ]);
    const read = await store.getRecall(ctx, recallId);
    expect(read?.returnedMemories).toEqual({
      breakdownCaptured: false,
      memories: [{ memoryId: "11111111-1111-4111-8111-111111111111" }],
    });
  });
});

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

/** 受け付ける（そのまま書いて返し、返った Memory は MemorySchema を通らない）形。 */
const ACCEPTED: Array<[string, (obs: string) => Partial<NewMemory>]> = [
  [
    "stated で sourceObservationId・at が無い",
    (obs) => ({ sourceObservationId: obs, provenance: { kind: "stated" } as never }),
  ],
  ["consolidated で sources が空", () => ({ provenance: { kind: "consolidated", sources: [] } })],
  ["imported で batchId が無い", () => ({ provenance: { kind: "imported" } as never })],
  [
    "inferred で confidence が 2",
    (obs) => ({
      sourceObservationId: obs,
      provenance: {
        kind: "inferred",
        model: "m",
        promptVersion: "p",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 2,
      },
    }),
  ],
  [
    "inferred で model が無い",
    (obs) => ({
      sourceObservationId: obs,
      provenance: {
        kind: "inferred",
        promptVersion: "p",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.5,
      } as never,
    }),
  ],
  [
    "stated で at が空文字",
    (obs) => ({
      sourceObservationId: obs,
      provenance: { kind: "stated", sourceObservationId: obs, at: "" },
    }),
  ],
];

/** 拒む（例外になる）形。 */
const REJECTED: Array<[string, (obs: string) => Partial<NewMemory>]> = [
  ["kind が列挙に無い", () => ({ provenance: { kind: "bogus" } as never })],
  [
    "stated なのに列の sourceObservationId が null",
    (obs) => ({
      sourceObservationId: null,
      provenance: { kind: "stated", sourceObservationId: obs, at: "2026-01-01T00:00:00Z" },
    }),
  ],
  [
    "inferred なのに列の sourceObservationId が null",
    () => ({
      sourceObservationId: null,
      provenance: {
        kind: "inferred",
        model: "m",
        promptVersion: "p",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.5,
      },
    }),
  ],
  ["provenance が null", () => ({ provenance: null as never })],
];

async function freshInput(
  store: MemoryStore,
  over: (obs: string) => Partial<NewMemory>,
  n: number,
) {
  const observation = await store.createObservation(
    ctx,
    buildNewObservationFixture({ tenantId: ctx.tenantId } as never),
  );
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `store-input-${n}`,
    ...over(observation.id),
  });
}

describe.each(KITS)("provenance の中身は検査しない（今の振る舞い）: %s", (_name, build) => {
  describe.each(WRITES)("%s", (_method, write) => {
    it.each(ACCEPTED)(
      "%s は受け付け、返った Memory は MemorySchema を通らない",
      async (_label, over) => {
        const store = await build();
        const memory = await write(store, await freshInput(store, over, 1));
        expect(memory.id).toBeDefined();
        expect(MemorySchema.safeParse(memory).success).toBe(false);
      },
    );

    it.each(REJECTED)("%s は拒む", async (_label, over) => {
      const store = await build();
      await expect(write(store, await freshInput(store, over, 2))).rejects.toThrow();
    });

    it("provenance.sourceObservationId が列と食い違っても受け付ける（MemorySchema は通る）", async () => {
      const store = await build();
      const memory = await write(
        store,
        await freshInput(
          store,
          (obs) => ({
            sourceObservationId: obs,
            provenance: {
              kind: "stated",
              sourceObservationId: "00000000-0000-4000-8000-000000000000",
              at: "2026-01-01T00:00:00Z",
            },
          }),
          3,
        ),
      );
      expect(memory.provenance).toMatchObject({
        sourceObservationId: "00000000-0000-4000-8000-000000000000",
      });
      expect(MemorySchema.safeParse(memory).success).toBe(true);
    });
  });
});
