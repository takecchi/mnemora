import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryStore,
  NewMemory,
  ObservationId,
  VectorStore,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryVectorStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 文字列を区切り文字で繋いだキーが、区切り文字を含む値で別の対象と衝突しないこと。
 * `tenantId`・`extractorVersion`・`contentHash`・埋め込み空間の `model` は呼び手の値で、`:` を含んでよい。
 * InMemory の冪等キーや `InMemoryVectorStore` の空間の前方一致は、区切り文字を含む値で別の対象と衝突しうる。Postgres はどれも分かれている（冪等は4列の UNIQUE、空間はテーブルが別）。
 */

const KITS: Array<[string, () => Promise<{ memoryStore: MemoryStore; vectorStore: VectorStore }>]> =
  [
    [
      "testkit の InMemory",
      async () => {
        const memoryStore = new InMemoryMemoryStore();
        return { memoryStore, vectorStore: new InMemoryVectorStore(memoryStore) };
      },
    ],
    [
      "Postgres",
      async () => {
        await resetTestDatabase();
        const { db } = await getTestClient();
        return {
          memoryStore: new PostgresMemoryStore(db),
          vectorStore: new PostgresVectorStore(db),
        };
      },
    ],
  ];

async function observe(store: MemoryStore, ctx: Ctx): Promise<ObservationId> {
  const observation = await store.createObservation(
    ctx,
    buildNewObservationFixture({ tenantId: ctx.tenantId }),
  );
  return observation.id;
}

function extracted(
  ctx: Ctx,
  sourceObservationId: ObservationId,
  extractorVersion: string,
  contentHash: string,
): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    sourceObservationId,
    extractorVersion,
    contentHash,
    content: `本文 ${ctx.tenantId} ${extractorVersion} ${contentHash}`,
  });
}

/** 前方一致で `{p, m, 3}` が `{p, m:3, 3}` を拾う組。Postgres ではテーブル名も別になる。 */
const SPACE_SHORT: EmbeddingSpaceId = { provider: "joined-keys", model: "m", dimensions: 3 };
const SPACE_LONG: EmbeddingSpaceId = { provider: "joined-keys", model: "m:3", dimensions: 3 };

afterAll(async () => {
  await closeTestClient();
});

describe("区切り文字で繋いだキーが、区切り文字を含む値で衝突しない", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("抽出の冪等キー: 同じ Observation で版と hash の境目がずれた2件は、別の Memory になる", async () => {
        const { memoryStore } = await makeKit();
        const ctx: Ctx = { tenantId: "joined-keys" };
        const obs = await observe(memoryStore, ctx);

        const first = await memoryStore.createMemory(ctx, extracted(ctx, obs, "v:x", "h"));
        const second = await memoryStore.createMemory(ctx, extracted(ctx, obs, "v", "x:h"));

        expect(second.id).not.toBe(first.id);
        expect(second.content).toBe(`本文 joined-keys v x:h`);
      });

      it("抽出の冪等キー: `:` を含むテナントが、別テナントの Memory を受け取らない", async () => {
        const { memoryStore } = await makeKit();
        const t: Ctx = { tenantId: "joined-keys" };
        const o1 = await observe(memoryStore, t);
        const tO1: Ctx = { tenantId: `joined-keys:${o1}` };
        const o2 = await observe(memoryStore, tO1);

        const own = await memoryStore.createMemory(t, extracted(t, o1, `${o2}:v`, "h"));
        const other = await memoryStore.createMemory(tO1, extracted(tO1, o2, "v", "h"));

        expect(other.id).not.toBe(own.id);
        expect(other.tenantId).toBe(tO1.tenantId);
        expect(other.sourceObservationId).toBe(o2);
      });

      it("ベクトル: 空間 {p, m, 3} の検索が、空間 {p, m:3, 3} のベクトルを返さない", async () => {
        const { memoryStore, vectorStore } = await makeKit();
        if (kitName === "Postgres") {
          const { pool } = await getTestClient();
          await registerEmbeddingSpace(pool, SPACE_SHORT);
          await registerEmbeddingSpace(pool, SPACE_LONG);
        }
        const ctx: Ctx = { tenantId: "joined-keys" };
        const memory = await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "vec", content: "vec" }),
        );
        await vectorStore.upsert(ctx, SPACE_LONG, memory.id, [1, 0, 0]);

        const hits = await vectorStore.search(ctx, SPACE_SHORT, [1, 0, 0], {
          limit: 10,
          filter: { tenantId: ctx.tenantId },
        });
        expect(hits).toEqual([]);
        const own = await vectorStore.search(ctx, SPACE_LONG, [1, 0, 0], {
          limit: 10,
          filter: { tenantId: ctx.tenantId },
        });
        expect(own.map((hit) => hit.memoryId)).toEqual([memory.id]);
      });
    });
  }
});
