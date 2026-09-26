import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/**
 * 変異試験で既存の歯がすり抜けた `recall-runtime.ts` の分岐を、それぞれの約束に当てて
 * 押さえる歯（境界の向き・件数の上限・除外集合）。1本ごとに、どの変異を捕まえるためのものか
 * と約束の出所を書く。
 *
 * 段1の後置フィルタ（多層防御）の境界は、adapter がゲートを押し下げている限り外から
 * 見えない——`FakeVectorStore` がゲートの欄を正しく適用するため、後置フィルタの境界を
 * 変えても結果が変わらない。そこで R02/R05 は、`search()` がゲートの欄を剥がす形にして
 * 後置フィルタだけを通す（`recall-decay-gate.test.ts` の `*StrippingVectorStore` と同じ手）。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(opts: { vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore } = {}) {
  const stores = createFakeRuntimeStores();
  const vectorStore = opts.vectorStoreOverride
    ? opts.vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    lexicalStore: stores.lexicalStore,
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

/** `search()` に渡る filter から、ゲートの欄（忘却・validAt）を剥がす。 */
function stripGates(fvs: FakeVectorStore): VectorStore {
  const originalSearch = fvs.search.bind(fvs);
  fvs.search = async (c, space, query, opts) =>
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
  return fvs;
}

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
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({ recordedAt, lastReinforcedAt: null, strength, halfLifeHours }),
    embeddingStatus: "pending",
    ...overrides,
  };
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

describe("recall() — 段1の後置フィルタの境界（ゲートを押し下げない adapter でも約束どおり）", () => {
  // 変異 R02（`decayFloorAt > now` → `>=`）を捕まえる。約束: `VectorFilter.decayFloorAtAfter`
  // の doc「非包含」——`decayFloorAt` が「いま」ちょうどの記憶は、もう減衰しきっている。
  it("decayFloorAt がちょうど「いま」の記憶は返らず、1ミリ秒後なら返る", async () => {
    const { runtime, stores } = buildRuntime({ vectorStoreOverride: stripGates });
    const atNow = await createEmbeddedMemory(stores, [1, 0], { decayFloorAt: NOW });
    const justAfter = await createEmbeddedMemory(stores, [1, 0], {
      decayFloorAt: new Date(NOW.getTime() + 1),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: null });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(atNow.id);
    expect(ids).toContain(justAfter.id);
  });

  // 変異 R05（`validUntil <= validAt` → `<`）を捕まえる。約束: `VectorFilter.validAt` の doc
  // 「`valid_until` は開区間の右端（狭義の `>`）」。
  it("validUntil がちょうど validAt の記憶は返らず、1ミリ秒後なら返る", async () => {
    const { runtime, stores } = buildRuntime({ vectorStoreOverride: stripGates });
    const endsAt = await createEmbeddedMemory(stores, [1, 0], { validUntil: NOW });
    const endsJustAfter = await createEmbeddedMemory(stores, [1, 0], {
      validUntil: new Date(NOW.getTime() + 1),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      validAt: NOW,
      association: null,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(endsAt.id);
    expect(ids).toContain(endsJustAfter.id);
  });
});

describe("recall() — below_threshold の nearMisses は上位5件", () => {
  // 変異 R10（`.slice(0, 5)` → `.slice(0, 4)`）を捕まえる。約束: `BelowThresholdOmission.nearMisses`
  // の doc（ADR 0203「決めたこと」5 の「上位5件サンプル」）——`count` が5を超えても
  // `nearMisses.length` は5を超えず、5件以上あれば5件載る。
  it("閾値未満が7件あれば count は7、nearMisses はちょうど5件", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 7; i += 1) {
      await createEmbeddedMemory(stores, [0, 1]);
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      scoreThreshold: 0.5,
      association: null,
    });

    const below = result.omitted.find((o) => o.kind === "below_threshold");
    expect(below).toMatchObject({ kind: "below_threshold", count: 7 });
    expect(below && "nearMisses" in below ? below.nearMisses : undefined).toHaveLength(5);
  });
});

describe("recall() — 連想枠（段3.5）の境界と除外集合", () => {
  // 変異 R16（`similarity >= minSimilarity` → `>`）を捕まえる。約束: docs/recall.md §9.2
  // 手順5「`minSimilarity` 未満を除く」——ちょうど `minSimilarity` の候補は残る。
  it("アンカーとの類似度がちょうど minSimilarity の候補は連想枠に入る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [1, 0], { digest: "anchor" });
    const neighbor = await createEmbeddedMemory(stores, [1, 0], { digest: "neighbor" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      association: { maxCount: 5, anchorCount: 1, minSimilarity: 1 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    const [anchorReturned] = returnedIds;
    const other = anchorReturned === anchor.id ? neighbor : anchor;
    expect(result.memories).toContainEqual(
      expect.objectContaining({ memoryId: other.id, retrievedVia: "association" }),
    );
  });

  // 変異 R32（除外集合から `companions` を外す）を捕まえる。約束: docs/recall.md §9.2 手順5
  // 「既に返る集合・アンカー自身……を除く」——段3の必須同伴取得で返る記憶を、連想枠が
  // もう一度拾わない（同じ記憶が `memories` に2回載らず、`omitted` にも数えられない）。
  it("段3で同伴として返る記憶は、連想枠がもう一度拾わない（memories の id は重複しない）", async () => {
    const { runtime, stores } = buildRuntime();
    const companion = await createEmbeddedMemory(stores, [0.8, 0.6], {
      digest: "companion",
      status: "contested",
    });
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      digest: "owner",
      status: "contested",
      contestedWithId: companion.id,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      association: { maxCount: 5, anchorCount: 1, minSimilarity: 0 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(owner.id);
    expect(ids.filter((id) => id === companion.id)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    // 連想枠が同伴を拾い直すと、連想側の単位の組み立てがそれを落として
    // `unit_assembly_dropped` に数える——返した記憶を「落ちた」と数えることになる
    // （ADR 0203 の排他性）。除外集合が効いていれば、この Omission は積まれない。
    expect(result.omitted.filter((o) => o.kind === "unit_assembly_dropped")).toEqual([]);
  });
});

describe("recall() — usage.budgetExceeded の境界", () => {
  // 変異 R30（`digestChars > maxMemoryChars` → `>=`）を捕まえる。約束: `RecallUsage` の doc
  // 「この値は 1 を超えうる。超えたときは `budgetExceeded` が `true` になる」——予算ちょうど
  // （比が 1）は超えていない。
  it("返した digest の文字数がちょうど maxMemoryChars なら budgetExceeded は立たない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "abc" });
    await createEmbeddedMemory(stores, [1, 0], { digest: "de" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 5 },
      association: null,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.usage.budgetExceeded ?? false).toBe(false);
  });
});
