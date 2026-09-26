import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #948: `FakeVectorStore.search` / `FakeLexicalStore.search`
 * （`packages/core/src/__tests__/runtime-fakes.ts`）は、`VectorFilter`/`LexicalFilter` の
 * `labels`（OR の絞り込み、ADR 0323）と `includeSubjectless`（`subjectId` 一致に加えて
 * 主体なしの行も含める、ADR 0286）を一度も見ていなかった——同じ filter の `attributes`・
 * `excludeProvenanceKinds`・`period`・`validAt`・`decayFloor*` は適用しているのに、
 * この2つだけ抜けていた。`packages/postgres` と `packages/testkit`（`InMemoryVectorStore`/
 * `InMemoryLexicalStore`）はどちらも適用しており、Fake だけが取り残されていた。
 *
 * over-fetch の窓（`limit × overFetchFactor`）が広い既存の歯（`recall-taxonomy-filter.test.ts`
 * 等）では `recall-runtime.ts` の後置フィルタが取りこぼしを隠すため表に出ないが、窓を
 * 絞ると Fake 版 runtime と Postgres 版 runtime が同じ入力に対して違う結果を返す
 * （このファイルの最後の2つの it が、その崩れを直接再現する）。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
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
  return { runtime, stores };
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

describe("Issue #948: FakeVectorStore.search — filter.labels / includeSubjectless", () => {
  it("labels: OR の絞り込み——一致しないタグの Memory は候補から落ちる", async () => {
    const { stores } = buildRuntime();
    const matching = await createEmbeddedMemory(stores, [1, 0], { tags: ["alpha"] });
    const other = await createEmbeddedMemory(stores, [1, 0], { tags: ["beta"] });

    const hits = await stores.vectorStore.search(ctx, stores.embeddingProvider.space, [1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, labels: ["alpha"] },
    });

    const ids = hits.map((h) => h.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("includeSubjectless: true のときだけ subjectId 無しの行も含む", async () => {
    const { stores } = buildRuntime();
    const inSubject = await createEmbeddedMemory(stores, [1, 0], { subjectId: "s1" });
    const subjectless = await createEmbeddedMemory(stores, [1, 0], { subjectId: null });
    const otherSubject = await createEmbeddedMemory(stores, [1, 0], { subjectId: "s2" });

    const withInclude = await stores.vectorStore.search(
      ctx,
      stores.embeddingProvider.space,
      [1, 0],
      { limit: 10, filter: { tenantId: ctx.tenantId, subjectId: "s1", includeSubjectless: true } },
    );
    const withIncludeIds = withInclude.map((h) => h.memoryId);
    expect(withIncludeIds).toContain(inSubject.id);
    expect(withIncludeIds).toContain(subjectless.id);
    expect(withIncludeIds).not.toContain(otherSubject.id);

    const withoutInclude = await stores.vectorStore.search(
      ctx,
      stores.embeddingProvider.space,
      [1, 0],
      { limit: 10, filter: { tenantId: ctx.tenantId, subjectId: "s1" } },
    );
    const withoutIncludeIds = withoutInclude.map((h) => h.memoryId);
    expect(withoutIncludeIds).toContain(inSubject.id);
    expect(withoutIncludeIds).not.toContain(subjectless.id);
  });
});

describe("Issue #948: FakeLexicalStore.search — filter.labels / includeSubjectless", () => {
  it("labels: OR の絞り込み——一致しないタグの Memory は候補から落ちる", async () => {
    const { stores } = buildRuntime();
    const matching = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "keyword一致", tags: ["alpha"] }),
    );
    const other = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "keyword一致", tags: ["beta"] }),
    );

    const hits = await stores.lexicalStore.search(ctx, "keyword", {
      limit: 10,
      filter: { tenantId: ctx.tenantId, labels: ["alpha"] },
    });
    const ids = hits.map((h) => h.memoryId);
    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("includeSubjectless: true のときだけ subjectId 無しの行も含む", async () => {
    const { stores } = buildRuntime();
    const inSubject = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "keyword一致", subjectId: "s1" }),
    );
    const subjectless = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "keyword一致", subjectId: null }),
    );

    const withInclude = await stores.lexicalStore.search(ctx, "keyword", {
      limit: 10,
      filter: { tenantId: ctx.tenantId, subjectId: "s1", includeSubjectless: true },
    });
    const withIncludeIds = withInclude.map((h) => h.memoryId);
    expect(withIncludeIds).toContain(inSubject.id);
    expect(withIncludeIds).toContain(subjectless.id);

    const withoutInclude = await stores.lexicalStore.search(ctx, "keyword", {
      limit: 10,
      filter: { tenantId: ctx.tenantId, subjectId: "s1" },
    });
    const withoutIncludeIds = withoutInclude.map((h) => h.memoryId);
    expect(withoutIncludeIds).not.toContain(subjectless.id);
  });
});

describe("Issue #948: recall() — labels + 小さい over-fetch 窓でのクラウディング", () => {
  it("ベクトル channel: 一致しない候補が窓を占有しても、labels 一致の候補が正しく返る", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: `decoy-${i}`, tags: ["beta"] });
    }
    const target = await createEmbeddedMemory(stores, [0.99, 0.14], {
      digest: "target",
      tags: ["alpha"],
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      labels: ["alpha"],
      scoreThreshold: 0,
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([target.id]);
  });

  it("語彙 channel: 一致しない候補が窓を占有しても、labels 一致の候補が正しく返る", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i += 1) {
      await stores.memoryStore.createMemory(
        ctx,
        newMemory({ digest: `decoy-${i}`, content: "keyword一致", tags: ["beta"] }),
      );
    }
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "target", content: "keyword一致", tags: ["alpha"] }),
    );

    const result = await runtime.recall(ctx, {
      text: "keyword",
      channels: ["lexical"],
      limit: 1,
      overFetchFactor: 1,
      labels: ["alpha"],
      scoreThreshold: 0,
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([target.id]);
  });
});
