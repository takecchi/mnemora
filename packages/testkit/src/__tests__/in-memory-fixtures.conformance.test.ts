// このファイルが roadmap.md 段階1の完了条件そのものにあたる:
// 「testkit の適合テストの雛形（2テナント分のデータを入れて走らせる枠組み）が、
//   プレースホルダ実装に対して動く」

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

// Issue #207/#933 PR2（ADR 0381）: `RelationStore` の in-memory 実装。
// `link` は両端の記憶が `ctx` のテナントに在ることを、渡された `InMemoryMemoryStore` で確かめる
// ——`prepareMemoryId` は `createStore()` が組んだ、まさにその `InMemoryMemoryStore` に
// 記憶を作る（`latestMemoryStoreForEvents` と同じ持ち回りの形）。
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

// `InMemoryVectorStore` は `status`/`subjectId`/`decayFloorAt`（Memory の属性であり
// ベクトルの属性ではない）を見るために `InMemoryMemoryStore` を必須で参照する
// （in-memory-vector-store.ts のクラス doc、ADR 0034）。`prepareMemoryId` はこの
// 「まさに同じ `InMemoryMemoryStore` インスタンス」に実在の Memory を作ることで、
// `describeOutboxStoreConformance` の `seedJob`/`latestMemoryStoreForOutboxSeed` と
// 同じ理由・同じ形で辻褄を合わせる。
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
    // `sourceObservationId` を持たせないため `createMemory` の冪等キー（extractionIndex）は
    // 使われず、`contentHash` の一意性は本来不要——それでも「別の Memory のつもりが
    // 同じ内容のまま」に読めてしまわないよう、呼ぶたびに変える。
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
  // ADR 0065: `InMemoryVectorStore` はテーブルを持たず、`search` が呼ばれた時点の
  // key prefix（provider:model:dimensions）一致で絞るだけ——`upsert`/`search` に
  // 未知の space を渡しても事前登録は要らない（`registerEmbeddingSpace` に相当する
  // ものが無い）。そのため no-op で足りる。
  prepareEmbeddingSpace: () => {},
  // Issue #200 / ADR 0151: InMemoryVectorStore は getVectors を実装している。
  supportsGetVectors: true,
  // Issue #1207 / ADR 0383: InMemoryVectorStore は eraseTenant を実装している。
  supportsEraseTenant: true,
  // Issue #1412 の続き: InMemoryVectorStore が searchMany を実装しているか（歯は宣言した adapter にだけかかる）。
  supportsSearchMany: true,
});

// ADR 0084 / Issue #106: `InMemoryLexicalStore` は自前の Map を持たず、`memoryStore` の
// `listByTenant` を通じて Memory を直接読む（`in-memory-lexical-store.ts` のクラス doc）。
// `prepareMemory` はこの「まさに同じ `InMemoryMemoryStore` インスタンス」に実在の Memory を
// 作ることで辻褄を合わせる——`prepareMemoryId`（`describeVectorStoreConformance` 向け）と
// 同じ理由・同じ形。
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

// ADR 0047: `memory_events.memory_id → memories(id)` の外部キーを `InMemoryEventStore`
// にも適用したことで、コンストラクタに `InMemoryMemoryStore` が必須になった
// （#33 が `InMemoryVectorStore` に対して通したのと同じ形）。`prepareMemoryId` はこの
// 「まさに同じ `InMemoryMemoryStore` インスタンス」に実在の Memory を作ることで辻褄を
// 合わせる（`latestMemoryStoreForVectorFixtures`/`prepareMemoryId` と同じパターン）。
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

// ⛔ `supportsRealConcurrency` は**渡さない**（ADR 0206）——in-memory 実装の
// `claimBatch` は本体に `await` を1つも含まないため、async 関数は最初の `await` まで
// 同期実行される ⟹ `Promise.all` で並べても**完全に逐次化される。**渡すと
// 「何も測っていないのに緑」になる。渡さないことで並行の歯は `it.skip` になり、
// **測っていないことがログ上で skip として見える。**
// 🔴 「in-memory でも通るように」とここへ `true` を足さないこと。
describeOutboxStoreConformance(inMemoryOutboxStoreConformanceOptions());

let latestTenantSettingsStore: InMemoryTenantSettingsStore | undefined;
// [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと2・5・13
// （Issue #305）: `advanceActivitySeq` が `MemoryStore.createRecall({ advanceActivityClock:
// true })` を呼ぶための、まさに同じ `InMemoryMemoryStore` インスタンス
// （`InMemoryTenantSettingsStore` のコンストラクタへ `activitySeq` Map を共有渡ししたのと
// 同じインスタンス）。`latestMemoryStoreForVectorFixtures` 等と同じパターン。
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
  // ADR 0165 決めたこと13: `InMemoryTenantSettingsStore` は4メソッドとも実装している。
  supportsDecayClock: true,
  // ADR 0197: `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` は
  // `TenantSettingsStore` interface の本番の書き込み口そのもの（`ctx`/`Promise` の形）に
  // なったため、`setDefaultHalfLifeHours`（本番の口が無いため生の tenantId フックを呼ぶ）
  // とは違い、ここは store のメソッドをそのまま呼ぶだけでよい。
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
  // [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
  // （Issue #338）: `advanceActivitySeq`（上）と同じ形——`tenant_subject_activity` は
  // `MemoryStore.createRecall({ advanceActivityClock: { scope: "subject", subjectId } })`
  // 経由でだけ進む。
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
  // Issue #201 / ADR 0318: InMemoryTenantSettingsStore は getTaxonomyMode/setTaxonomyMode
  // を実装している。
  supportsTaxonomyMode: true,
  // Issue #1207 / ADR 0383: InMemoryTenantSettingsStore は eraseTenant を実装している。
  supportsEraseTenant: true,
});
