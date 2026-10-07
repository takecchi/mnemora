import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

// owner とクエリを [1, 0] にして、cos(x, owner) と cos(x, query) を同じ値（第1成分 c）にする。各候補のクエリでの順位とアンカーへの近さを1つの数で同時に制御できる。
function vec(c: number): [number, number] {
  return [c, Math.sqrt(1 - c * c)];
}

/** 共通フィクスチャ。limit=5 で owner+フィラー4件が withinLimit を満たし、C1・T が over_limit(rescore) に回る。`withD` は連想の近傍に現れない over_limit 候補 D を足す。 */
async function createFixture(stores: ReturnType<typeof createFakeRuntimeStores>, withD: boolean) {
  const owner = await createEmbeddedMemory(stores, vec(1.0), { digest: "owner" });
  const f1 = await createEmbeddedMemory(stores, vec(0.95), { digest: "F1" });
  const f2 = await createEmbeddedMemory(stores, vec(0.9), { digest: "F2" });
  const f3 = await createEmbeddedMemory(stores, vec(0.85), { digest: "F3" });
  const f4 = await createEmbeddedMemory(stores, vec(0.8), { digest: "F4" });
  const c1 = await createEmbeddedMemory(stores, vec(0.65), { digest: "C1" });
  const t = await createEmbeddedMemory(stores, vec(0.6), { digest: "T" });
  const d = withD ? await createEmbeddedMemory(stores, vec(0.3), { digest: "D" }) : undefined;
  return { owner, f1, f2, f3, f4, c1, t, d };
}

describe("recall() — over_limit(stage:'rescore') の候補が段3.5（連想）の候補プールに入ったが席に着けなかったときの排他性（Issue #949）", () => {
  it("(a) 過取得の窓には入ったが maxCount の席を競り負けたときは、over_limit(stage:'rescore') からも差し引かれる", async () => {
    const { runtime, stores } = buildRuntime();
    const { owner, c1, t } = await createFixture(stores, false);

    // overFetchFactor=2.0 で C1・T の両方が窓に入り、maxCount=1 の席を競わせる（T は競り負け）。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();

    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeUndefined();

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });

  it("(b) 過取得の窓の外に居たときも、over_limit(stage:'rescore') からも差し引かれる", async () => {
    const { runtime, stores } = buildRuntime();
    const { owner, c1, t } = await createFixture(stores, false);

    // overFetchFactor=1.4 で窓は1件: T は席の競り合いにも参加しない。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 1.4,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();

    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeUndefined();

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });

  it("(c) 連想の近傍に現れていない over_limit(stage:'rescore') のバイスタンダーは残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();
    // D は連想の候補プールに一度も入らず、無関係であり続けなければならない。
    const { owner, c1, t, d } = await createFixture(stores, true);
    if (!d) throw new Error("fixture must include D");

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();
    const returnedD = result.memories.find((m) => m.memoryId === d.id);
    expect(returnedD).toBeUndefined();

    // D まで巻き込まれて 0 になったら、差し引く判定が over_limit 全件のように広すぎる過剰実装になっている。
    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeDefined();
    if (overLimitRescore?.kind === "over_limit") {
      expect(overLimitRescore.count).toBe(1);
    }

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });
});
