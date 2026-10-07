import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

// Postgres は `23502` で例外の顔が違うので、揃えない。型の検査を外しても直後の `getTime()` が素の `TypeError` になるので、種類と欄の名指しまで見る。
const ctx: Ctx = { tenantId: "in-memory-decay-floor-at" };

const VARIANTS: Array<[string, (m: NewMemory) => NewMemory]> = [
  ["null", (m) => ({ ...m, decayFloorAt: null }) as unknown as NewMemory],
  ["undefined", (m) => ({ ...m, decayFloorAt: undefined }) as unknown as NewMemory],
  [
    "キーなし",
    (m) => {
      const { decayFloorAt: _omit, ...rest } = m;
      return rest as NewMemory;
    },
  ],
];

async function setup() {
  const store = new InMemoryMemoryStore();
  const obs = (
    await store.createObservation(ctx, buildNewObservationFixture({ tenantId: ctx.tenantId }))
  ).id;
  const input = (over: Partial<NewMemory> = {}) =>
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      sourceObservationId: obs,
      extractorVersion: "v1",
      contentHash: "h",
      ...over,
    });
  const state = () =>
    JSON.stringify({
      memories: store.listByTenant(ctx).map((m) => [m.id, m.status]),
      outbox: store.outboxJobs.length,
      events: store.events.length,
    });
  return { store, input, state };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("拒まれなかった");
}

function expectDecayFloorAtTypeError(e: unknown): void {
  expect(e).toBeInstanceOf(TypeError);
  expect((e as TypeError).message).toMatch(/decayFloorAt must be a Date/);
}

describe("InMemoryMemoryStore: decayFloorAt が Date でない新しい Memory は、TypeError で、書く前に断る（PR #1772）", () => {
  it.each(VARIANTS)(
    "createMemory・createMemoryWithOutbox・supersedeWithNewMemories: %s",
    async (_n, broken) => {
      const { store, input, state } = await setup();
      const target = await store.createMemory(ctx, input({ contentHash: "target" }));
      const before = state();
      expectDecayFloorAtTypeError(
        await rejection(() => store.createMemory(ctx, broken(input({ contentHash: "a" })))),
      );
      expectDecayFloorAtTypeError(
        await rejection(() =>
          store.createMemoryWithOutbox(ctx, broken(input({ contentHash: "b" })), ["embed"]),
        ),
      );
      expectDecayFloorAtTypeError(
        await rejection(() =>
          store.supersedeWithNewMemories(
            ctx,
            [{ input: broken(input({ contentHash: "c" })), jobKinds: ["embed"] }],
            [
              {
                id: target.id,
                supersededByIndex: 0,
                event: {
                  tenantId: ctx.tenantId,
                  memoryId: target.id,
                  kind: "superseded",
                  actor: { type: "system" },
                  digestSnapshot: null,
                  sizeBeforeBytes: null,
                  meta: {},
                },
              },
            ],
          ),
        ),
      );
      expect(state()).toBe(before);
    },
  );

  it.each(VARIANTS)(
    "冪等の既存の行が在っても断る（createMemory・createMemoryWithOutbox）: %s",
    async (_n, broken) => {
      const { store, input, state } = await setup();
      await store.createMemoryWithOutbox(ctx, input(), ["embed"]);
      const before = state();
      expectDecayFloorAtTypeError(await rejection(() => store.createMemory(ctx, broken(input()))));
      expectDecayFloorAtTypeError(
        await rejection(() => store.createMemoryWithOutbox(ctx, broken(input()), ["embed"])),
      );
      expect(state()).toBe(before);
    },
  );

  it("陽性対照: Date なら、同じ入力が既存の行に解決される（冪等）", async () => {
    const { store, input } = await setup();
    const first = await store.createMemory(ctx, input());
    const second = await store.createMemoryWithOutbox(ctx, input(), ["embed"]);
    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.id);
  });
});
