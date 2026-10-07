import type { Ctx } from "@mnemora/core";
import {
  inMemoryMemoryStoreConformanceOptions,
  inMemoryOutboxStoreConformanceOptions,
} from "./in-memory-conformance-options.js";
import { describeEventStoreConformance } from "../event-store-conformance.js";
import { describeLexicalStoreConformance } from "../lexical-store-conformance.js";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import { describeRelationStoreConformance } from "../relation-store-conformance.js";
import { describeOutboxStoreConformance } from "../outbox-store-conformance.js";
import { describeTenantSettingsStoreConformance } from "../tenant-settings-store-conformance.js";
import { describeVectorStoreConformance } from "../vector-store-conformance.js";
import { buildNewMemoryFixture, buildProvenanceFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryRelationStore } from "../__fixtures__/in-memory-relation-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

describeMemoryStoreConformance(inMemoryMemoryStoreConformanceOptions());

let latestMemoryStoreForRelations: InMemoryMemoryStore | undefined;

describeRelationStoreConformance({
  implementsListRelatedMany: true,
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForRelations = memoryStore;
    return new InMemoryRelationStore(memoryStore, memoryStore.relations);
  },
  prepareMemoryId: async (ctx) => {
    const memory = await latestMemoryStoreForRelations!.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId }),
    );
    return memory.id;
  },
});

// `InMemoryVectorStore` は Memory の `status`/`subjectId`/`decayFloorAt` を見るために `InMemoryMemoryStore` を参照するので、`prepareMemoryId` は `createStore()` が組んだ同じインスタンスに実在の Memory を作る。
let latestMemoryStoreForVectorFixtures: InMemoryMemoryStore | undefined;
let vectorFixtureContentHashCounter = 0;

describeVectorStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForVectorFixtures = memoryStore;
    return new InMemoryVectorStore(memoryStore);
  },
  prepareMemoryId: async (ctx, attrs) => {
    if (!latestMemoryStoreForVectorFixtures) {
      throw new Error("prepareMemoryId より先に createStore() を呼ぶ必要がある");
    }
    vectorFixtureContentHashCounter += 1;
    const memory = await latestMemoryStoreForVectorFixtures.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `fixture-hash-vector-${vectorFixtureContentHashCounter}`,
        ...(attrs?.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs?.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs?.decayFloorAt !== undefined ? { decayFloorAt: attrs.decayFloorAt } : {}),
        ...(attrs?.decayFloorSeq !== undefined ? { decayFloorSeq: attrs.decayFloorSeq } : {}),
        ...(attrs?.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs?.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs?.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs?.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs?.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs?.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs?.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
  // no-op で足りる。`InMemoryVectorStore` はテーブルを持たず、未知の space を渡しても事前登録は要らない。
  prepareEmbeddingSpace: () => {},
  supportsGetVectors: true,
  supportsEraseTenant: true,
  supportsSearchMany: true,
});

let latestMemoryStoreForLexicalFixtures: InMemoryMemoryStore | undefined;
let lexicalFixtureContentHashCounter = 0;

describeLexicalStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForLexicalFixtures = memoryStore;
    return new InMemoryLexicalStore(memoryStore);
  },
  prepareMemory: async (ctx, attrs) => {
    if (!latestMemoryStoreForLexicalFixtures) {
      throw new Error("prepareMemory より先に createStore() を呼ぶ必要がある");
    }
    lexicalFixtureContentHashCounter += 1;
    const memory = await latestMemoryStoreForLexicalFixtures.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: attrs.content,
        contentHash: `fixture-hash-lexical-${lexicalFixtureContentHashCounter}`,
        ...(attrs.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
});

let latestMemoryStoreForEventFixtures: InMemoryMemoryStore | undefined;
let eventFixtureContentHashCounter = 0;

describeEventStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForEventFixtures = memoryStore;
    return new InMemoryEventStore(memoryStore);
  },
  prepareMemoryId: async (ctx) => {
    if (!latestMemoryStoreForEventFixtures) {
      throw new Error("prepareMemoryId より先に createStore() を呼ぶ必要がある");
    }
    eventFixtureContentHashCounter += 1;
    const memory = await latestMemoryStoreForEventFixtures.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `fixture-hash-event-${eventFixtureContentHashCounter}`,
      }),
    );
    return memory.id;
  },
});

// `supportsRealConcurrency` は渡さない。in-memory の `claimBatch` は `await` を含まず、`Promise.all` で並べても逐次化されるので、渡すと何も測っていないのに緑になる。「in-memory でも通るように」と `true` を足さないこと。
describeOutboxStoreConformance(inMemoryOutboxStoreConformanceOptions());

let latestTenantSettingsStore: InMemoryTenantSettingsStore | undefined;
let latestMemoryStoreForTenantSettingsFixtures: InMemoryMemoryStore | undefined;

describeTenantSettingsStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForTenantSettingsFixtures = memoryStore;
    const store = new InMemoryTenantSettingsStore(
      memoryStore.activitySeq,
      memoryStore.subjectActivitySeq,
    );
    latestTenantSettingsStore = store;
    return store;
  },
  setDefaultHalfLifeHours: (ctx: Ctx, hours: number) => {
    if (!latestTenantSettingsStore) {
      throw new Error("setDefaultHalfLifeHours より先に createStore() を呼ぶ必要がある");
    }
    latestTenantSettingsStore.setDefaultHalfLifeHours(ctx.tenantId, hours);
  },
  supportsDecayClock: true,
  setDefaultHalfLifeRecalls: (ctx: Ctx, recalls: number) => {
    if (!latestTenantSettingsStore) {
      throw new Error("setDefaultHalfLifeRecalls より先に createStore() を呼ぶ必要がある");
    }
    return latestTenantSettingsStore.setDefaultHalfLifeRecalls(ctx, recalls);
  },
  advanceActivitySeq: async (ctx: Ctx) => {
    if (!latestMemoryStoreForTenantSettingsFixtures) {
      throw new Error("advanceActivitySeq より先に createStore() を呼ぶ必要がある");
    }
    await latestMemoryStoreForTenantSettingsFixtures.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
      advanceActivityClock: true,
    });
  },
  advanceSubjectActivitySeq: async (ctx: Ctx, subjectId: string) => {
    if (!latestMemoryStoreForTenantSettingsFixtures) {
      throw new Error("advanceSubjectActivitySeq より先に createStore() を呼ぶ必要がある");
    }
    await latestMemoryStoreForTenantSettingsFixtures.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
      advanceActivityClock: { scope: "subject", subjectId },
    });
  },
  supportsTaxonomyMode: true,
  supportsEraseTenant: true,
});
