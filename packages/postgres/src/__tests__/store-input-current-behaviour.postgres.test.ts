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
import {
  MALFORMED_NEW_MEMORY_CASES,
  WELL_FORMED_NEW_MEMORY_CASES,
} from "../../../core/src/__tests__/malformed-new-memory-cases.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * store の入口が入力の中身をどう扱うかの、今の振る舞い。
 *
 * - `getRecall`: adapter の期待する形式でない id は `null`（3実装）。マイグレーション 0013 より前の形の行は
 *   `breakdownCaptured: false` で読み戻る（Postgres）。
 * - `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`: `provenance` の中身の欠け・値域外
 *   （`MemorySchema` を通らなくなる形）も拒む（`REJECTED`）。ほかの欄の全形と、拒むときに何も書かないことは、
 *   下の `MALFORMED_NEW_MEMORY_CASES` の節。Postgres と testkit の fixture で縛る。
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

const NOW_REJECTED: Array<[string, (obs: string) => Partial<NewMemory>]> = [
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

describe.each(KITS)("provenance の入口の検査: %s", (_name, build) => {
  describe.each(WRITES)("%s", (_method, write) => {
    it.each(NOW_REJECTED)(
      "%s は拒む（ADR 0630。以前は受け付け、返った Memory は MemorySchema を通らなかった）",
      async (_label, over) => {
        const store = await build();
        await expect(write(store, await freshInput(store, over, 1))).rejects.toThrow(/provenance/);
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

describe("Postgres: 拒むとき、Memory・ラベル・outbox・イベントのどれにも書かない（ADR 0630）", () => {
  async function counts(): Promise<Record<string, number>> {
    const { pool } = await getTestClient();
    const out: Record<string, number> = {};
    for (const table of ["memories", "labels", "outbox", "memory_events"]) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      out[table] = (r.rows[0] as { n: number }).n;
    }
    return out;
  }

  describe.each(WRITES)("%s", (_method, write) => {
    it.each(MALFORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
      "%s は、欄を名指しした例外で拒み、何も書かない（既存の行が無くても、冪等の既存の行が在っても）",
      async (_label, c) => {
        const store = await postgresStore();
        const observation = await store.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: ctx.tenantId } as never),
        );
        const base = (over: Partial<NewMemory>) =>
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            sourceObservationId: observation.id,
            extractorVersion: "v1",
            contentHash: "pg-shape-h",
            tags: ["shape-tag"],
            ...over,
          });
        // 既存の行が無いとき: 拒み、何も書かない（書いてから検査する実装を赤にする）。
        const empty = await counts();
        await expect(write(store, base(c.over(observation.id)))).rejects.toThrow(c.field);
        expect(await counts()).toEqual(empty);
        // 既存の行（同じ冪等キー）を先に書く。壊れた入力は、その行が在っても拒まれる。
        await write(store, base({}));
        const before = await counts();
        await expect(write(store, base(c.over(observation.id)))).rejects.toThrow(c.field);
        expect(await counts()).toEqual(before);
      },
    );
  });

  it("supersedeWithNewMemories: news の2件目が壊れていたら、1件目・supersede の対象・イベントも書かない", async () => {
    const store = await postgresStore();
    const old = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    const before = await counts();
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [
          {
            input: buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: "n1",
              tags: ["only-n1"],
            }),
            jobKinds: ["embed"],
          },
          {
            input: buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: "n2",
              attributes: { a: 1 } as never,
            }),
            jobKinds: ["embed"],
          },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: {
              tenantId: ctx.tenantId,
              memoryId: old.id,
              kind: "superseded",
              actor: { type: "system" },
              meta: {},
            } as never,
          },
        ],
      ),
    ).rejects.toThrow(/attributes/);
    expect(await counts()).toEqual(before);
    expect((await store.get(ctx, old.id))?.status).toBe("active");
  });

  it("createMemoriesWithOutboxAndEvents（3口の外。同じ入口を共有する）: 壊れた候補は dropped に積み、ほかは書く", async () => {
    const store = await postgresStore();
    const result = await store.createMemoriesWithOutboxAndEvents!(
      ctx,
      [
        {
          input: buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "ok-1" }),
          jobKinds: ["embed"],
        },
        {
          input: buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: "bad",
            extractorVersion: "",
          }),
          jobKinds: ["embed"],
        },
      ],
      (memory) =>
        ({
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "created",
          actor: { type: "system" },
          meta: {},
        }) as never,
    );
    expect(result.written.map((w) => w.index)).toEqual([0]);
    expect(result.dropped.map((d) => d.index)).toEqual([1]);
    expect(String(result.dropped[0]!.error)).toMatch(/extractorVersion is malformed/);
  });
});

describe.each(KITS)(
  "正しい値（境界のすぐ内側）は通り、読み戻すと MemorySchema を通る: %s",
  (_name, build) => {
    describe.each(WRITES)("%s", (_method, write) => {
      it.each(WELL_FORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
        "%s",
        async (_label, c) => {
          const store = await build();
          const memory = await write(store, await freshInput(store, c.over, 7));
          expect(MemorySchema.safeParse(memory).success).toBe(true);
          expect(MemorySchema.safeParse(await store.get(ctx, memory.id)).success).toBe(true);
        },
      );
    });
  },
);

describe.each(KITS)("範囲外は、この検査では拒まない（ADR 0630）: %s", (_name, build) => {
  it("createObservation: attributes の値が文字列でなくても、この検査では拒まない（Observation は範囲外）", async () => {
    const store = await build();
    await expect(
      store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, attributes: { a: 1 } as never }),
      ),
    ).resolves.toBeDefined();
  });

  it("createObservationWithOutbox: attributes の値が文字列でなくても、この検査では拒まない（Observation は範囲外）", async () => {
    const store = await build();
    await expect(
      store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, attributes: { a: 1 } as never }),
        [],
      ),
    ).resolves.toBeDefined();
  });

  it("Memory の subjectId の空文字は、この検査の message では拒まれない（別の担当の件）", async () => {
    const store = await build();
    const outcome = await store
      .createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, subjectId: "", contentHash: "scope-s" }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String(outcome)).not.toMatch(/is malformed/);
  });
});
