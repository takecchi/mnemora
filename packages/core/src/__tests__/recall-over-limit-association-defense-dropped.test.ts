import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段3.5（連想）の候補が、過取得の窓には入ったが、組み立ての多層防御（`survives*` のゲート）で
 * 落ちるとき、その候補は `over_limit(stage:"association")` に数えられない。したがって、
 * 段2で数えた `over_limit(stage:"rescore")` からも差し引かない（差し引くと、どの札にも
 * 数えられない記憶が1件できる）。
 *
 * ゲートは段1と同じ述語なので、vectorStore が契約どおりなら連想では何も落ちない。ここでは、
 * 連想の候補を読み出す `getMany` だけが、段2のときと違う行（状態が `superseded`）を返す
 * 形にして、ゲートに落とさせる。
 */

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

// `recall-over-limit-association-seat-promotion.test.ts` と同じ配置。owner（c=1.0）を
// アンカーに、フィラー4件で limit=5 を満たし、C1（0.65）・T（0.60）が over_limit(rescore) になる。
function vec(c: number): [number, number] {
  return [c, Math.sqrt(1 - c * c)];
}

describe("recall() — 連想の組み立てで多層防御に落ちた候補は、over_limit(rescore) から差し引かない", () => {
  it("T が連想の読み出しで状態の違う行になりゲートに落ちても、over_limit(rescore) に1件残り、over_limit(association) は出ない", async () => {
    const { runtime, stores } = buildRuntime();
    const owner = await createEmbeddedMemory(stores, vec(1.0), { digest: "owner" });
    for (const [digest, c] of [
      ["F1", 0.95],
      ["F2", 0.9],
      ["F3", 0.85],
      ["F4", 0.8],
    ] as const) {
      await createEmbeddedMemory(stores, vec(c), { digest });
    }
    const c1 = await createEmbeddedMemory(stores, vec(0.65), { digest: "C1" });
    const t = await createEmbeddedMemory(stores, vec(0.6), { digest: "T" });

    // 連想の候補の読み出し（アンカー owner を含まない `getMany`）だけ、T を状態 `superseded` で返す。
    // 段1の読み出しは owner を含むので、そのまま通す。
    const getMany = stores.memoryStore.getMany.bind(stores.memoryStore);
    stores.memoryStore.getMany = async (...args: Parameters<typeof getMany>) => {
      const memories = await getMany(...args);
      const [, ids] = args;
      if (ids.includes(owner.id)) return memories;
      return memories.map((m) => (m.id === t.id ? { ...m, status: "superseded" as const } : m));
    };

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    // C1 は連想の席に着き、T はゲートに落ちて返らない。
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1?.retrievedVia).toBe("association");
    expect(result.memories.find((m) => m.memoryId === t.id)).toBeUndefined();

    // T は over_limit(association) には数えられていない（窓の中で、席の競りにも載らなかった）。
    expect(
      result.omitted.find((o) => o.kind === "over_limit" && o.stage === "association"),
    ).toBeUndefined();

    // したがって、段2で数えた over_limit(rescore) の T の分は残る（C1 の分だけが差し引かれる）。
    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeDefined();
    if (overLimitRescore?.kind === "over_limit") {
      expect(overLimitRescore.count).toBe(1);
    }
  });
});
