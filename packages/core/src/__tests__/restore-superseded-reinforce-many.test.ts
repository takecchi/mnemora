import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.restoreSuperseded` の強化の束ね方（`MemoryStore.reinforceMany?`）。
 *
 * - 束ねた強化の口が在れば、群全体で1回だけ呼ぶ（群の大きさに比例して往復を増やさない。
 *   Postgres の往復数の歯は `packages/postgres/src/__tests__/restore-superseded-roundtrip-count.postgres.test.ts`）。
 * - 束ねた強化が失敗したら、1件ずつの強化へ戻る——強化の失敗は、失敗した要素の
 *   `reinforceError` にだけ入り、outcome は `restored` のまま（以前からの1件ごとの約束。
 *   `restore-superseded.test.ts` の「reinforce が例外を投げても…」と同じ約束を、束ねた経路でも見る）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => req.schema.parse({ content: "統合した本文" }),
};

let counter = 0;
function newMemory(): NewMemory {
  counter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${counter}`,
    contentHash: `restore-superseded-reinforce-many-${counter}`,
    digest: `要旨${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2027-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

async function setUpGroup(size: number) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const ids: MemoryId[] = [];
  for (let i = 0; i < size; i += 1) {
    ids.push((await stores.memoryStore.createMemory(ctx, newMemory())).id);
  }
  const consolidated = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
  return { stores, runtime, ids, supersededById: consolidated.consolidatedMemoryId! };
}

describe("restoreSuperseded は群の強化を reinforceMany に束ねる", () => {
  it("reinforceMany が在れば群全体で1回だけ呼び、全件が restored（reinforceError なし）", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(4);
    const originalMany = stores.memoryStore.reinforceMany.bind(stores.memoryStore);
    let manyCalls = 0;
    stores.memoryStore.reinforceMany = async (c, memoryIds, at, opts) => {
      manyCalls += 1;
      return originalMany(c, memoryIds, at, opts);
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(manyCalls).toBe(1);
    expect(result.outcomes.map((o) => o.memoryId).sort()).toEqual([...ids].sort());
    for (const outcome of result.outcomes) {
      expect(outcome.kind).toBe("restored");
      expect(outcome).not.toHaveProperty("reinforceError");
    }
  });

  it("reinforceMany が投げたら1件ずつへ戻り、失敗は失敗した要素の reinforceError にだけ入る", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(3);
    const failingId = ids[1]!;
    stores.memoryStore.reinforceMany = async () => {
      throw new Error("simulated reinforceMany failure");
    };
    const originalReinforce = stores.memoryStore.reinforce.bind(stores.memoryStore);
    stores.memoryStore.reinforce = async (c, id, at, opts) => {
      if (id === failingId) {
        throw new Error("simulated reinforce failure");
      }
      return originalReinforce(c, id, at, opts);
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(result.outcomes).toHaveLength(3);
    for (const outcome of result.outcomes) {
      expect(outcome.kind).toBe("restored");
      if (outcome.memoryId === failingId) {
        expect(outcome).toMatchObject({ reinforceError: "simulated reinforce failure" });
      } else {
        expect(outcome).not.toHaveProperty("reinforceError");
      }
    }
    // 復帰そのもの（status）は強化の失敗に関係なく成立している。
    for (const id of ids) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("active");
    }
  });
});

describe("restoreSuperseded が reinforceMany へ渡すもの・返ってきたものの扱い", () => {
  /** reinforceMany の呼び出しを記録し、1件ずつの reinforce が呼ばれた回数も数える。 */
  function spyOnReinforce(stores: Awaited<ReturnType<typeof setUpGroup>>["stores"]) {
    const originalReinforce = stores.memoryStore.reinforce.bind(stores.memoryStore);
    const manyCalls: { ids: MemoryId[]; at: Date; opts: unknown }[] = [];
    let singleCalls = 0;
    // 先に束ね口を差し替える（元の reinforceMany は内部で this.reinforce を呼ぶので、
    // 1件ずつの reinforce の数は、runtime が直接呼んだぶんだけが数えられるようにする）。
    stores.memoryStore.reinforceMany = async (c, memoryIds, at, opts) => {
      manyCalls.push({ ids: [...memoryIds], at, opts });
      const out = [];
      for (const id of memoryIds) {
        out.push(await originalReinforce(c, id, at, opts));
      }
      return out;
    };
    stores.memoryStore.reinforce = async (c, id, at, opts) => {
      singleCalls += 1;
      return originalReinforce(c, id, at, opts);
    };
    return { manyCalls, singleCalls: () => singleCalls };
  }

  it("束ねた強化が成功したら、1件ずつの reinforce は1回も呼ばない", async () => {
    const { stores, runtime, supersededById } = await setUpGroup(3);
    const spy = spyOnReinforce(stores);

    await runtime.restoreSuperseded(ctx, { supersededById });

    expect(spy.manyCalls).toHaveLength(1);
    expect(spy.singleCalls()).toBe(0);
  });

  it("束ねる対象は戻した記憶だけ（onlyMemoryIds で外した記憶・archived に進んだ記憶は含めない）", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(4);
    const [restoredId, leftOutId, archivedId] = [ids[0]!, ids[1]!, ids[2]!];
    await stores.memoryStore.updateStatus(ctx, archivedId, "archived");
    const spy = spyOnReinforce(stores);

    const result = await runtime.restoreSuperseded(ctx, {
      supersededById,
      onlyMemoryIds: [restoredId, archivedId],
    });

    expect(result.outcomes.map((o) => o.memoryId)).toEqual([restoredId]);
    expect(spy.manyCalls).toHaveLength(1);
    expect(spy.manyCalls[0]!.ids).toEqual([restoredId]);
    expect(spy.manyCalls[0]!.ids).not.toContain(leftOutId);
    expect(spy.manyCalls[0]!.ids).not.toContain(archivedId);
  });

  it("束ねる対象は戻した記憶の全件で、強化の時刻は clock.now() そのもの", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(3);
    const spy = spyOnReinforce(stores);

    await runtime.restoreSuperseded(ctx, { supersededById });

    expect(spy.manyCalls).toHaveLength(1);
    expect([...spy.manyCalls[0]!.ids].sort()).toEqual([...ids].sort());
    expect(spy.manyCalls[0]!.at).toEqual(NOW);
  });

  it("活動時計のテナントでは、reinforce に渡す強化の設定（nowSeq）を束ねた強化にも渡す", async () => {
    const { stores, runtime, supersededById } = await setUpGroup(2);
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const spy = spyOnReinforce(stores);

    await runtime.restoreSuperseded(ctx, { supersededById });

    expect(spy.manyCalls).toHaveLength(1);
    expect(spy.manyCalls[0]!.opts).toHaveProperty("nowSeq");
  });

  it("戻した記憶が0件なら、束ねた強化も1件ずつの強化も呼ばない", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(2);
    for (const id of ids) {
      await stores.memoryStore.updateStatus(ctx, id, "archived");
    }
    const spy = spyOnReinforce(stores);

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(result).toEqual({ supported: true, supersedingMemoryId: supersededById, outcomes: [] });
    expect(spy.manyCalls).toHaveLength(0);
    expect(spy.singleCalls()).toBe(0);
  });

  it("outcome の decayFloorAt は、束ねた強化が返した記憶の値（戻す前の値ではない）", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(2);
    const reinforcedFloor = new Date("2031-05-05T00:00:00.000Z");
    const originalMany = stores.memoryStore.reinforceMany.bind(stores.memoryStore);
    stores.memoryStore.reinforceMany = async (c, memoryIds, at, opts) =>
      (await originalMany(c, memoryIds, at, opts)).map((m) => ({
        ...m,
        decayFloorAt: reinforcedFloor,
      }));

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(result.outcomes).toHaveLength(ids.length);
    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject({ kind: "restored", decayFloorAt: reinforcedFloor });
    }
  });
});
