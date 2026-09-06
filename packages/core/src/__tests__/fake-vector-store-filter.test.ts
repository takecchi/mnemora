import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeVectorStore`（`packages/core` 自身の runtime テスト用フェイク、`runtime-fakes.ts`）が
 * `VectorFilter` の契約（ADR 0034、`packages/core/src/interfaces/vector-store.ts` の doc）を
 * 実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の `vector-store-conformance.ts` の対象ではない。** `FakeVectorStore` は
 * adapter 適合テストの対象である `VectorStore` 実装（`InMemoryVectorStore`/
 * `PostgresVectorStore`）ではなく、`packages/core` 自身の runtime テスト専用の別系統
 * （`runtime-fakes.ts` 冒頭のコメント: core は testkit に依存しない）。ADR 0034 はこの
 * `FakeVectorStore` を「範囲外・別系統」として明示的に残しており（採らなかった案の節）、
 * 本テストはその残された穴を `packages/core` 側で埋める。
 *
 * 置く歯はすべて非対称——「除外される側」と「残る側」を同じ検査の中で押さえる。
 * 片方だけだと、全部返す実装／全部返さない実装のどちらかを緑にしてしまう。
 *
 * 期待値の導出について: `decayFloorAtAfter` の境界は `defaultDecayStrategy.floorAt` などの
 * 実装側関数からではなく、このファイル内のリテラルな `Date` から作る——検査対象
 * （`FakeVectorStore.search`）と期待値が同じ関数を共有すると、両方が一緒に壊れて
 * 変異が素通りする。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const space = { provider: "test", model: "fixture-model", dimensions: 3 };

let contentHashCounter = 0;

/** `recall-pipeline.test.ts` の `newMemory` と似た形だが、意図的に独立したコピー
 * （ファイル冒頭のコメント: `FakeVectorStore` はこの系統の別テストと結合させない）。 */
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    // decayFloorAt はテストごとにリテラルな Date で指定する。既定値は「遠い過去」——
    // decayFloorAtAfter を指定しない歯では常に生き残らせるため。
    decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  };
}

describe("FakeVectorStore — VectorFilter の契約（ADR 0034）", () => {
  it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
    const stores = createFakeRuntimeStores();
    const active = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const archived = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    await stores.vectorStore.upsert(ctx, space, active.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, archived.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", status: ["active"] },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  it("filter.subjectId: 一致しない subject の Memory は返らず、一致する subject の Memory は返る", async () => {
    const stores = createFakeRuntimeStores();
    const matching = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ subjectId: "subject-a" }),
    );
    const other = await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "subject-b" }));
    await stores.vectorStore.upsert(ctx, space, matching.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, other.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", subjectId: "subject-a" },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("filter.decayFloorAtAfter: 境界と*ちょうど同じ* decayFloorAt は除外され、境界より後は返る（狭義の `>`）", async () => {
    const stores = createFakeRuntimeStores();
    const boundary = new Date("2026-03-15T00:00:00.000Z");
    const onBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(boundary.getTime()) }),
    );
    const afterBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(boundary.getTime() + 1000) }),
    );
    await stores.vectorStore.upsert(ctx, space, onBoundary.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, afterBoundary.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", decayFloorAtAfter: boundary },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).not.toContain(onBoundary.id);
    expect(ids).toContain(afterBoundary.id);
  });

  it("filter は複数同時に渡すと AND になる（どれか1つが不一致なら返らない）", async () => {
    const stores = createFakeRuntimeStores();
    const bothMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", subjectId: "subject-a" }),
    );
    const statusOnlyMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", subjectId: "subject-b" }),
    );
    const subjectOnlyMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived", subjectId: "subject-a" }),
    );
    await stores.vectorStore.upsert(ctx, space, bothMatch.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, statusOnlyMatch.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, subjectOnlyMatch.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", status: ["active"], subjectId: "subject-a" },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(bothMatch.id);
    expect(ids).not.toContain(statusOnlyMatch.id);
    expect(ids).not.toContain(subjectOnlyMatch.id);
  });
});
