import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { LexicalFilter } from "../interfaces/lexical-store.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.labels`/`RecallQuery.taxonomyGroups`（Issue #201 PR-B、
 * [ADR 0320](../../../docs/decisions/0320-taxonomy-recall-filter.md)）の歯。
 *
 * `recall-attributes-filter.test.ts`（ADR 0312）と同型の構え:
 * 1. 配線の歯——段1（ANN・語彙）と段3.5（連想枠）の filter に `labels` が渡ること。
 * 2. 本命の歯——OR の集合絞り込み、`taxonomy_mode` の参加資格。
 * 3. `filteredTaxonomy`/`omitted.condition: 'taxonomy'`。
 * 4. adapter が `labels` を無視しても安全（後置フィルタ）。
 * 5. 連想枠にも同じ絞りが掛かる。
 * 6. `taxonomyGroups` — 呼び手が明示したときだけ `axis: 'taxonomy'` の群が載る。
 * 7. `listLabels?` を実装しない adapter では静かに無効化される。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(vectorStoreOverride?: (fvs: VectorStore) => VectorStore) {
  const stores = createFakeRuntimeStores();
  const vectorStore = vectorStoreOverride
    ? vectorStoreOverride(stores.vectorStore)
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

function captureVectorFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, space, query, opts);
  };
  return captured;
}

function captureLexicalFilters(
  stores: ReturnType<typeof createFakeRuntimeStores>,
): LexicalFilter[] {
  const captured: LexicalFilter[] = [];
  const originalSearch = stores.lexicalStore.search.bind(stores.lexicalStore);
  stores.lexicalStore.search = async (c, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, query, opts);
  };
  return captured;
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

// ---------------------------------------------------------------------------
// 1. 配線の歯。
// ---------------------------------------------------------------------------

describe("recall() — 段1の filter に labels が載ること（配線の歯、Issue #201 PR-B）", () => {
  it("RecallQuery.labels が VectorStore.search / LexicalStore.search の opts.filter.labels に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { tags: ["project/mnemora"] });
    const vectorFilters = captureVectorFilters(stores);
    const lexicalFilters = captureLexicalFilters(stores);

    await runtime.recall(ctx, {
      vector: [1, 0],
      text: "本文",
      channels: ["ann", "lexical"],
      labels: ["project/mnemora"],
    });

    expect(vectorFilters[0]?.labels).toEqual(["project/mnemora"]);
    expect(lexicalFilters[0]?.labels).toEqual(["project/mnemora"]);
  });

  it("labels を渡さないときは opts.filter.labels も undefined のまま渡る（既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0] });

    expect(vectorFilters[0]?.labels).toBeUndefined();
  });

  it("空配列は「絞り込み無し」——渡さなかったときと1バイトも変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], labels: [] });

    expect(vectorFilters[0]?.labels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 本命の歯: OR の集合絞り込みと taxonomy_mode の参加資格。
// ---------------------------------------------------------------------------

describe("recall() — labels が実際に候補を落とす（OR、Issue #201 PR-B）", () => {
  it("渡した名前のいずれかを tags に持つ Memory だけが返る", async () => {
    const { runtime, stores } = buildRuntime();
    const matching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      tags: ["alpha"],
    });
    const other = await createEmbeddedMemory(stores, [1, 0], {
      digest: "other",
      tags: ["beta"],
    });
    const untagged = await createEmbeddedMemory(stores, [1, 0], { digest: "untagged" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      labels: ["alpha"],
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(untagged.id);
  });

  it("複数名は OR——いずれか1つでも一致すれば残る", async () => {
    const { runtime, stores } = buildRuntime();
    const alpha = await createEmbeddedMemory(stores, [1, 0], { digest: "alpha", tags: ["alpha"] });
    const beta = await createEmbeddedMemory(stores, [1, 0], { digest: "beta", tags: ["beta"] });
    const gamma = await createEmbeddedMemory(stores, [1, 0], { digest: "gamma", tags: ["gamma"] });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      labels: ["alpha", "beta"],
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alpha.id);
    expect(ids).toContain(beta.id);
    expect(ids).not.toContain(gamma.id);
  });

  it("open（既定）では proposed のラベルも絞り込みに参加する", async () => {
    const { runtime, stores } = buildRuntime();
    // `createEmbeddedMemory` が自動で `alpha` を proposed ラベルとして作る（何も registerLabel しない）。
    const matching = await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });
    const labels = await stores.memoryStore.listLabels(ctx);
    expect(labels).toEqual([
      { name: "alpha", status: "proposed", proposedCount: 1, registeredAt: null },
    ]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    expect(result.memories.map((m) => m.memoryId)).toContain(matching.id);
  });

  it("strict では registered だけが参加する——proposed だけを渡すと絞り込みが丸ごと無効化される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setTaxonomyMode(ctx, "strict");
    const proposedOnly = await createEmbeddedMemory(stores, [1, 0], {
      digest: "proposed-only",
      tags: ["alpha"], // 誰も registerLabel していない=proposed のまま。
    });
    const other = await createEmbeddedMemory(stores, [1, 0], {
      digest: "other",
      tags: ["beta"],
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    // ADR 0320「決定2」: 参加資格の無い名前しか渡していないので、絞り込みそのものが
    // 無効化される——「その名前を条件にしていない」のと同じ扱いになり、両方返る。
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(proposedOnly.id);
    expect(ids).toContain(other.id);
  });

  it("strict で registered に昇格したラベルは参加する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.registerLabel(ctx, "alpha");
    await stores.tenantSettingsStore.setTaxonomyMode(ctx, "strict");
    const matching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      tags: ["alpha"],
    });
    const other = await createEmbeddedMemory(stores, [1, 0], {
      digest: "other",
      tags: ["beta"],
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("既存の tagMatch 加点は taxonomy_mode に関わらず変わらない（ADR 0318 決定5）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setTaxonomyMode(ctx, "strict");
    const memory = await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });

    // labels を渡さず、既存の RecallQuery.tags（段2のスコアリング加点）だけを使う——
    // strict でも proposed のタグはそのまま tagMatch に参加し続ける。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      tags: ["alpha"],
    });

    const returned = result.memories.find((m) => m.memoryId === memory.id);
    expect(returned?.score.tagMatch).toBeGreaterThan(0);
  });
});

describe("recall() — labels で落ちた分は filteredTaxonomy として報告される（Issue #201 PR-B）", () => {
  it("落ちた Memory の件数が omitted.condition: 'taxonomy' として exact に積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "matching", tags: ["alpha"] });
    await createEmbeddedMemory(stores, [1, 0], { digest: "other-1", tags: ["beta"] });
    await createEmbeddedMemory(stores, [1, 0], { digest: "other-2", tags: ["gamma"] });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "taxonomy",
      scopeRelation: "outside_scope",
      count: 2,
      countKind: "exact",
    });
    // `attributes`（ADR 0312 決定6）とは違い、taxonomy は totalInScope から除かれる
    // （period/validity と同じ側）。
    expect(result.index.totalInScope).toBe(1);
  });

  it("labels を渡さなければ condition: 'taxonomy' は一度も積まれない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.omitted.some((o) => o.kind === "filtered" && o.condition === "taxonomy")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. adapter がこの欄を無視しても安全である（取りこぼしはあるが、混入は無い）。
// ---------------------------------------------------------------------------

class LabelsFilterStrippingVectorStore implements VectorStore {
  constructor(private readonly inner: VectorStore) {}

  upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["upsert"]>[2],
    vector: number[],
  ): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(ctx, space, memoryId, vector);
  }

  delete(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["delete"]>[2],
  ): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(ctx, space, memoryId);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const { labels: _labels, ...stripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 後置フィルタ（survivesLabelsFilter）が段1の絞りを剥がしても正しく絞る", () => {
  it("adapter が labels を無視しても、後置フィルタが混入を防ぐ", async () => {
    const { runtime, stores } = buildRuntime((fvs) => new LabelsFilterStrippingVectorStore(fvs));
    const matching = await createEmbeddedMemory(stores, [1, 0], {
      digest: "matching",
      tags: ["alpha"],
    });
    const other = await createEmbeddedMemory(stores, [1, 0], { digest: "other", tags: ["beta"] });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, labels: ["alpha"] });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });
});

// ---------------------------------------------------------------------------
// 4. 連想枠（段3.5）にも同じ絞りが掛かる。
// ---------------------------------------------------------------------------

const ANCHOR_VECTOR = [0.70710678, 0.70710678];
const ASSOCIATED_VECTOR = [0, 1];
const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

describe("recall() — 連想枠（段3.5）にも labels が掛かる（Issue #201 PR-B）", () => {
  it("連想用 search() の filter にも段1と同じ labels が渡る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー", tags: ["alpha"] });
    await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
      digest: "連想候補",
      tags: ["alpha"],
    });
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      labels: ["alpha"],
      association: ASSOCIATION,
    });

    // vectorFilters[0] は段1（ANN）、以降が連想用の search()。
    expect(vectorFilters.slice(1).every((f) => f.labels?.includes("alpha"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. GroupCount.axis: 'taxonomy' — 呼び手が明示したときだけ。
// ---------------------------------------------------------------------------

describe("recall() — RecallQuery.taxonomyGroups（Issue #201 PR-B、ADR 0320「決定5」）", () => {
  it("既定（省略）では axis: 'taxonomy' の群は1件も載らない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.index.groups.some((g) => g.axis === "taxonomy")).toBe(false);
  });

  it("true を渡すと、ラベルごとの群と残差（key: null）が載る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "a1", tags: ["alpha"] });
    await createEmbeddedMemory(stores, [1, 0], { digest: "a2", tags: ["alpha", "beta"] });
    await createEmbeddedMemory(stores, [1, 0], { digest: "none", tags: [] });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      taxonomyGroups: true,
    });

    const taxonomyGroups = result.index.groups.filter((g) => g.axis === "taxonomy");
    expect(taxonomyGroups).toContainEqual({
      axis: "taxonomy",
      key: "alpha",
      count: 2,
      countKind: "exact",
    });
    expect(taxonomyGroups).toContainEqual({
      axis: "taxonomy",
      key: "beta",
      count: 1,
      countKind: "exact",
    });
    expect(taxonomyGroups).toContainEqual({
      axis: "taxonomy",
      key: null,
      count: 1,
      countKind: "exact",
    });
    // `axis: 'subject'` の被覆不変条件（合計 = totalInScope）は taxonomy を足しても崩れない。
    const subjectSum = result.index.groups
      .filter((g) => g.axis === "subject")
      .reduce((sum, g) => sum + g.count, 0);
    expect(subjectSum).toBe(result.index.totalInScope);
  });

  it("strict では registered のみが群になり、proposed しか持たない Memory は残差に数えられる", async () => {
    const { runtime, stores } = buildRuntime();
    // `registerLabel` は「まだ誰も tags に使っていない名前」も直接 registered として作れる
    // （ADR 0318「決定3」）——ここでは種になる proposed の Memory を作らずに済む。
    await stores.memoryStore.registerLabel(ctx, "alpha");
    await stores.tenantSettingsStore.setTaxonomyMode(ctx, "strict");
    await createEmbeddedMemory(stores, [1, 0], { digest: "registered", tags: ["alpha"] });
    await createEmbeddedMemory(stores, [1, 0], { digest: "proposed-only", tags: ["beta"] });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      taxonomyGroups: true,
    });

    const taxonomyGroups = result.index.groups.filter((g) => g.axis === "taxonomy");
    expect(taxonomyGroups).toContainEqual({
      axis: "taxonomy",
      key: "alpha",
      count: 1,
      countKind: "exact",
    });
    // "beta" は proposed のまま——strict では群にならず、残差に数えられる。
    expect(taxonomyGroups.some((g) => g.key === "beta")).toBe(false);
    expect(taxonomyGroups).toContainEqual({
      axis: "taxonomy",
      key: null,
      count: 1,
      countKind: "exact",
    });
  });
});

// ---------------------------------------------------------------------------
// 6. `listLabels?` を実装しない adapter では静かに無効化される（ADR 0318 の規律）。
// ---------------------------------------------------------------------------

describe("recall() — MemoryStore.listLabels? を実装しない adapter（Issue #201 PR-B）", () => {
  it("labels/taxonomyGroups の両方が静かに無効化される（エラーにしない）", async () => {
    const { stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });
    // `listLabels` を持たない MemoryStore を装う——透過的な Proxy で1つのプロパティだけ
    // `undefined` に見せる（class インスタンスをそのまま spread すると prototype 上の
    // メソッドが1つも複製されない）。
    const memoryStoreWithoutListLabels = new Proxy(stores.memoryStore, {
      get(target, prop, receiver) {
        if (prop === "listLabels") return undefined;
        return Reflect.get(target, prop, receiver);
      },
    });
    const runtimeWithoutListLabels = createRuntime({
      memoryStore: memoryStoreWithoutListLabels,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
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

    const result = await runtimeWithoutListLabels.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      labels: ["alpha"],
      taxonomyGroups: true,
    });

    expect(result.memories.length).toBe(1); // 絞り込みは無効化されている。
    expect(result.index.groups.some((g) => g.axis === "taxonomy")).toBe(false);
  });
});
