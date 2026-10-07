import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider, MemoryId, RelationStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** 往復数は `Client.prototype.query` を数える。数えるのは `memory_relations` を `from_memory_id` で引く SELECT だけで、他の文の数は実装の細部で動くので固定しない。 */

const TENANT = "list-related-many-tenant";
const ctx: Ctx = { tenantId: TENANT };

async function countRelationSelects(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    const text = typeof first === "string" ? first : (first?.text ?? "");
    if (/select[\s\S]*from memory_relations[\s\S]*from_memory_id/i.test(text)) count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

const embeddingProvider: EmbeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
};

/** `listRelatedMany` を隠した `RelationStore`（実装していない adapter の代わり）。 */
function withoutMany(inner: RelationStore): RelationStore {
  return {
    link: (c, kind, from, to) => inner.link(c, kind, from, to),
    unlink: (c, kind, from, to) => inner.unlink(c, kind, from, to),
    listRelated: (c, id, kind) => inner.listRelated(c, id, kind),
  };
}

async function createClique(n: number) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const relationStore = new PostgresRelationStore(db);
  const buildRuntime = (relations: RelationStore) =>
    createRuntime({
      memoryStore,
      outboxStore: {
        claimBatch: async () => [],
        complete: async () => {},
        fail: async () => {},
      },
      vectorStore,
      eventStore: {
        append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
        get: async () => null,
        list: async () => [],
      },
      tenantSettingsStore: {
        getDefaultHalfLifeHours: async () => 720,
        getEventRetention: async () => {
          throw new Error("not used");
        },
        setEventRetention: async () => {
          throw new Error("not used");
        },
      },
      llmProvider: throwingLlm,
      embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      relationStore: relations,
    });
  const ids: MemoryId[] = [];
  for (let i = 0; i < n; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: i === 0 ? "ready" : "pending",
        contentHash: `clique-${i}`,
      }),
    );
    ids.push(memory.id);
  }
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, ids[0]!, [1, 0, 0]);
  await buildRuntime(relationStore).markContestedGroup!(ctx, ids);
  return { ids, relationStore, buildRuntime };
}

describe("PostgresRelationStore.listRelatedMany（本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("返す createdAt は、同じ関係の listRelated の createdAt と等しい（固定値ではない。#1499）", async () => {
    const { ids, relationStore } = await createClique(4);

    const many = await relationStore.listRelatedMany(ctx, ids);

    expect(many).toHaveLength(ids.length);
    for (const [i, id] of ids.entries()) {
      const expected = new Map(
        (await relationStore.listRelated(ctx, id)).map((r) => [r.memoryId, r.createdAt.getTime()]),
      );
      expect(expected.size).toBeGreaterThan(0);
      expect(many[i]!).toHaveLength(expected.size);
      for (const r of many[i]!) {
        expect(r.createdAt.getTime()).toBe(expected.get(r.memoryId));
      }
    }
  });

  it("起点の数に依らず1文で、起点ごとに listRelated と同じ集合を同じ位置に返す（大文字の綴り・重複・存在しない id・uuid の形でない id を含む）", async () => {
    const { ids, relationStore } = await createClique(12);
    const missing = "00000000-0000-4000-8000-000000000000" as MemoryId;
    const query: MemoryId[] = [
      ...ids,
      ids[3]!.toUpperCase() as MemoryId,
      missing,
      "does-not-exist" as MemoryId,
      ids[0]!,
    ];

    let many: Awaited<ReturnType<NonNullable<RelationStore["listRelatedMany"]>>> = [];
    const statements = await countRelationSelects(async () => {
      many = await relationStore.listRelatedMany(ctx, query);
    });
    const single = await countRelationSelects(async () => {
      await relationStore.listRelatedMany(ctx, [ids[0]!]);
    });

    expect(many).toHaveLength(query.length);
    expect(statements).toBe(1);
    expect(single).toBe(1);
    const norm = (rs: Array<{ memoryId: string }>) => rs.map((r) => r.memoryId).sort();
    for (const [i, id] of ids.entries()) {
      expect(norm(many[i]!)).toEqual(norm(await relationStore.listRelated(ctx, id)));
      expect(many[i]).toHaveLength(ids.length - 1);
    }
    expect(norm(many[ids.length]!)).toEqual(norm(many[3]!));
    expect(many[ids.length + 1]).toEqual([]);
    expect(many[ids.length + 2]).toEqual([]);
    expect(norm(many[ids.length + 3]!)).toEqual(norm(many[0]!));
    expect(many[0]).not.toBe(many[ids.length + 3]);
  });

  it("kind を渡した版も同じ結果を返し、別テナントの ctx では何も返さない", async () => {
    const { ids, relationStore } = await createClique(4);

    const withKind = await relationStore.listRelatedMany(ctx, ids, "contradicts");
    const without = await relationStore.listRelatedMany(ctx, ids);
    const norm = (rs: Array<{ memoryId: string }>) => rs.map((r) => r.memoryId).sort();
    expect(withKind.map(norm)).toEqual(without.map(norm));
    expect(withKind.every((rs) => rs.length === 3)).toBe(true);

    const other = await relationStore.listRelatedMany({ tenantId: "someone-else" }, ids);
    expect(other).toEqual(ids.map(() => []));
  });

  it("recall 段3: listRelatedMany があれば関係の SELECT は段数（2文）、無ければ起点ごと（クリーク 8 件で 8 文）。結果は同じ", async () => {
    const { relationStore, buildRuntime } = await createClique(8);
    const withMany = buildRuntime(relationStore);
    const serial = buildRuntime(withoutMany(relationStore));

    let a: Awaited<ReturnType<typeof withMany.recall>> | undefined;
    const manyStatements = await countRelationSelects(async () => {
      a = await withMany.recall(ctx, { vector: [1, 0, 0] });
    });
    let b: Awaited<ReturnType<typeof serial.recall>> | undefined;
    const serialStatements = await countRelationSelects(async () => {
      b = await serial.recall(ctx, { vector: [1, 0, 0] });
    });

    expect(a!.memories).toHaveLength(8);
    expect(manyStatements).toBe(2);
    expect(serialStatements).toBe(8);
    const shape = (r: NonNullable<typeof a>) =>
      r.memories.map((m) => [m.memoryId, m.retrievedVia, m.companionOf ?? null]);
    expect(shape(a!)).toEqual(shape(b!));
    expect(a!.omitted).toEqual(b!.omitted);
  });
});
