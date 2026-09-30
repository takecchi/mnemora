import { afterAll, describe, expect, it } from "vitest";
import { isEmbeddingSpaceNotRegisteredError } from "@mnemora/core";
import type { Ctx, EmbeddingSpaceId, VectorFilter } from "@mnemora/core";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0433 決定3: 登録していない埋め込み空間（`registerEmbeddingSpace` を呼んでいない
 * `memory_embeddings_<space>` が無い空間）で vector store を引くと、生の
 * `relation "memory_embeddings_..." does not exist`（SQLSTATE 42P01、kind なしの `Error`）ではなく、
 * `kind: "embedding_space_not_registered"` を持つ `EmbeddingSpaceNotRegisteredError` が出る。
 * 原因の Error は `cause` に残る。
 *
 * 投げる入力そのものは変えない: 形式不正な id だけの `delete`・`getVectors` と、空の `searchMany`
 * は、これまでどおり空間が未登録でも例外にならない。
 */

const UNREGISTERED: EmbeddingSpaceId = {
  provider: "test",
  model: "never-registered",
  dimensions: 3,
};
const ctx: Ctx = { tenantId: "unregistered-space" };
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const FILTER: VectorFilter = { tenantId: ctx.tenantId, status: ["active"] };

afterAll(async () => {
  await closeTestClient();
});

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("resolved, expected a rejection");
}

describe("PostgresVectorStore: 未登録の空間（ADR 0433 決定3）", () => {
  const mouths: Array<[string, (store: PostgresVectorStore) => Promise<unknown>]> = [
    ["upsert", (s) => s.upsert(ctx, UNREGISTERED, MEMORY_ID, [1, 0, 0])],
    ["search", (s) => s.search(ctx, UNREGISTERED, [1, 0, 0], { limit: 5, filter: FILTER })],
    [
      "searchMany",
      (s) =>
        s.searchMany(ctx, UNREGISTERED, [{ key: "a", vector: [1, 0, 0] }], {
          limit: 5,
          filter: FILTER,
        }),
    ],
    ["delete", (s) => s.delete(ctx, UNREGISTERED, MEMORY_ID)],
    ["getVectors", (s) => s.getVectors(ctx, UNREGISTERED, [MEMORY_ID])],
  ];

  for (const [name, run] of mouths) {
    it(`${name}: EmbeddingSpaceNotRegisteredError になり、cause に元の 42P01 が残る`, async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const error = await rejection(() => run(new PostgresVectorStore(db)));
      expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(true);
      const typed = error as Error & { kind: string; space: EmbeddingSpaceId };
      expect(typed.kind).toBe("embedding_space_not_registered");
      expect(typed.name).toBe("EmbeddingSpaceNotRegisteredError");
      expect(typed.space).toEqual(UNREGISTERED);
      expect(typed.message).toContain("registerEmbeddingSpace");
      // 元の Error（drizzle の包み、その cause が pg の 42P01）が辿れる
      let cursor: unknown = typed.cause;
      let code: unknown;
      while (cursor !== undefined && cursor !== null) {
        code = (cursor as { code?: unknown }).code ?? code;
        cursor = (cursor as { cause?: unknown }).cause;
      }
      expect(typed.cause).toBeInstanceOf(Error);
      expect(code).toBe("42P01");
    });
  }

  it("今 throw しない入力は throw しない: 形式不正な id だけの delete・getVectors、空の searchMany、全 space 掃引", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresVectorStore(db);
    await expect(store.delete(ctx, UNREGISTERED, "not-a-uuid")).resolves.toBeUndefined();
    await expect(store.getVectors(ctx, UNREGISTERED, ["not-a-uuid"])).resolves.toEqual([]);
    await expect(
      store.searchMany(ctx, UNREGISTERED, [], { limit: 5, filter: FILTER }),
    ).resolves.toEqual(new Map());
    await expect(store.deleteAcrossSpaces(ctx, [MEMORY_ID])).resolves.toBeUndefined();
  });

  it("登録済みの空間では、これまでどおり例外にならない（陽性対照）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresVectorStore(db);
    const registered: EmbeddingSpaceId = {
      provider: "test",
      model: "fixture-model",
      dimensions: 3,
    };
    await expect(
      store.search(ctx, registered, [1, 0, 0], { limit: 5, filter: FILTER }),
    ).resolves.toEqual([]);
  });

  it("別の relation の 42P01（空間の表ではない）は包まず、生のまま出る", async () => {
    const other = Object.assign(new Error('relation "memories" does not exist'), { code: "42P01" });
    const failing = {
      execute: async () => {
        throw new Error("Failed query", { cause: other });
      },
    } as unknown as ConstructorParameters<typeof PostgresVectorStore>[0];
    const registered: EmbeddingSpaceId = {
      provider: "test",
      model: "fixture-model",
      dimensions: 3,
    };
    const error = await rejection(() =>
      new PostgresVectorStore(failing).delete(ctx, registered, MEMORY_ID),
    );
    expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(false);
    expect((error as Error).cause).toBe(other);
  });
});
