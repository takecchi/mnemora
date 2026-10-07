import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorFilter, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const tenantCtx: Ctx = { tenantId: "tenant-1" };
const aliceCtx: Ctx = { tenantId: "tenant-1", subjectId: "alice" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);
const deg = (d: number): number => (d * Math.PI) / 180;
const unit = (d: number): number[] => [Math.cos(deg(d)), Math.sin(deg(d))];

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = NOW;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours,
      }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function buildRuntime(
  overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: overrideVectorStore ? overrideVectorStore(stores) : stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

async function createEmbeddedMemory(
  stores: Stores,
  vector: number[],
  overrides: Partial<NewMemory> = {},
  ctx: Ctx = tenantCtx,
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

/** `search()` が受け取った filter を、呼ばれた順に集める。 */
function captureFilters(stores: Stores): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, space, query, opts);
  };
  return captured;
}

/**
 * ゲートの欄を無視する adapter を模す。段1・連想枠とも、押し下げが効かず、後置の再検査だけが落とす形になる。
 */
function ignoreGateFilterFields(stores: Stores): void {
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) =>
    originalSearch(c, space, query, {
      ...opts,
      filter: {
        ...opts.filter,
        decayFloorAtAfter: undefined,
        decayFloorSeqAfter: undefined,
        decayFloorAnyAxis: undefined,
        validAt: undefined,
      },
    });
}

const decayedOmissions = (omitted: readonly { kind: string }[]) =>
  omitted.filter(
    (o): o is { kind: "filtered"; condition: string; count: number; countKind: string } =>
      o.kind === "filtered" && (o as { condition?: string }).condition === "decayed",
  );

describe("recall() — 連想枠のアンカー順（複数アンカーが同じ候補を連想するとき）", () => {
  it("associationOf は、アンカーの id の並びではなくスコア順で先のアンカーになる（作る順を入れ替えても変わらない）", async () => {
    // Q=0°。A(40°)はB(55°)よりQに近いのでA=rank1。C(90°)は連想でしか拾えず、アンカー B のほうが A より近い。
    for (const order of [
      ["A", "B"],
      ["B", "A"],
    ] as const) {
      const { runtime, stores } = buildRuntime();
      const created = new Map<string, Memory>();
      for (const name of order) {
        created.set(
          name,
          await createEmbeddedMemory(stores, unit(name === "A" ? 40 : 55), { digest: name }),
        );
      }
      const c = await createEmbeddedMemory(stores, unit(90), { digest: "C" });

      const result = await runtime.recall(tenantCtx, {
        vector: unit(0),
        association: { maxCount: 5, anchorCount: 2 },
      });

      const entry = result.memories.find((m) => m.memoryId === c.id);
      expect(entry?.retrievedVia).toBe("association");
      expect(entry?.associationOf).toBe(created.get("A")?.id);
    }
  });
});

describe("recall() — 連想用 search() の filter が活動時計の欄も段1と同じにする", () => {
  it("'activity' のテナントで、段1と連想枠の decayFloorSeqAfter が同じ数値になる", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
    await createEmbeddedMemory(stores, unit(40), { decayFloorAt: FAR_FUTURE });
    const filters = captureFilters(stores);

    await runtime.recall(tenantCtx, {
      vector: unit(0),
      association: { maxCount: 5, anchorCount: 1 },
    });

    expect(filters).toHaveLength(2);
    const [stage1, association] = filters;
    expect(typeof stage1?.decayFloorSeqAfter).toBe("number");
    expect(association?.decayFloorSeqAfter).toBe(stage1?.decayFloorSeqAfter);
    expect(association?.decayFloorAtAfter).toBeUndefined();
  });

  it("'either' のテナントで、連想枠の filter は2軸とも OR で渡る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "either");
    await createEmbeddedMemory(stores, unit(40), { decayFloorAt: FAR_FUTURE });
    const filters = captureFilters(stores);

    await runtime.recall(tenantCtx, {
      vector: unit(0),
      association: { maxCount: 5, anchorCount: 1 },
    });

    const association = filters[1];
    expect(association?.decayFloorAtAfter).toEqual(NOW);
    expect(typeof association?.decayFloorSeqAfter).toBe("number");
    expect(association?.decayFloorAnyAxis).toBe(true);
  });

  it("subject 単位のカウンタを使っているテナントでは、連想枠の filter も decayFloorSeqUsesSubjectCounters を渡す", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
    await createEmbeddedMemory(
      stores,
      unit(40),
      {
        subjectId: "alice",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 1_000,
        halfLifeRecalls: 2,
      },
      aliceCtx,
    );
    await runtime.recall(aliceCtx, { vector: unit(0), activityCounting: "subject" });
    expect(await stores.tenantSettingsStore.hasSubjectActivityCounters(tenantCtx)).toBe(true);
    const filters = captureFilters(stores);

    await runtime.recall(aliceCtx, {
      vector: unit(0),
      association: { maxCount: 5, anchorCount: 1 },
    });

    expect(filters).toHaveLength(2);
    expect(filters[0]?.decayFloorSeqUsesSubjectCounters).toBe(true);
    expect(filters[1]?.decayFloorSeqUsesSubjectCounters).toBe(true);
  });
});

describe("recall() — 後置の再検査で落ちた忘却ゲートの件数は、集約の1箇所だけが名乗る", () => {
  it("連想枠: ゲートを無視する adapter でも、落とした記憶は返らず、filtered(decayed) は1件・exact で1回だけ出る", async () => {
    const { runtime, stores } = buildRuntime();
    ignoreGateFilterFields(stores);
    await createEmbeddedMemory(stores, unit(40), { decayFloorAt: FAR_FUTURE });
    const decayed = await createEmbeddedMemory(stores, unit(90), {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(tenantCtx, {
      vector: unit(0),
      association: { maxCount: 5, anchorCount: 1 },
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(decayed.id);
    expect(decayedOmissions(result.omitted)).toEqual([
      {
        kind: "filtered",
        condition: "decayed",
        scopeRelation: "within_scope",
        count: 1,
        countKind: "exact",
      },
    ]);
  });

  it("段1: ゲートを無視する adapter でも、落とした記憶は返らず、filtered(decayed) は1件・exact で1回だけ出る", async () => {
    const { runtime, stores } = buildRuntime();
    ignoreGateFilterFields(stores);
    const decayed = await createEmbeddedMemory(stores, unit(0), {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });
    await createEmbeddedMemory(stores, unit(10), { decayFloorAt: FAR_FUTURE });

    const result = await runtime.recall(tenantCtx, { vector: unit(0), association: null });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(decayed.id);
    expect(decayedOmissions(result.omitted)).toEqual([
      {
        kind: "filtered",
        condition: "decayed",
        scopeRelation: "within_scope",
        count: 1,
        countKind: "exact",
      },
    ]);
  });
});

describe("recall() — ann_unreached は1回だけ名乗る", () => {
  it("索引が scope の候補を取りこぼしたとき、ann_unreached は1件だけ出る", async () => {
    const { runtime, stores } = buildRuntime((s) => {
      const originalSearch = s.vectorStore.search.bind(s.vectorStore);
      return {
        upsert: s.vectorStore.upsert.bind(s.vectorStore),
        delete: s.vectorStore.delete.bind(s.vectorStore),
        deleteAcrossSpaces: s.vectorStore.deleteAcrossSpaces.bind(s.vectorStore),
        search: async (c, space, query, opts) =>
          (await originalSearch(c, space, query, opts)).slice(0, 1),
      };
    });
    for (const d of [0, 10, 20]) {
      await createEmbeddedMemory(stores, unit(d), { decayFloorAt: FAR_FUTURE });
    }

    const result = await runtime.recall(tenantCtx, { vector: unit(0), association: null });

    expect(result.omitted.filter((o) => o.kind === "ann_unreached")).toHaveLength(1);
  });
});
