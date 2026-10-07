import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, VectorHit } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * float4 に収まらない有限の成分を持つクエリベクトルは、`search()` も `searchMany()` も投げず、
 * 比較の通らないクエリとして扱う。`searchMany` だけが投げる入力が在ってはならない。
 */

const SPACE = TEST_EMBEDDING_SPACE;
const runTag = Math.random().toString(36).slice(2, 7);
const ctx: Ctx = { tenantId: `smf4-${runTag}` };
const opts = { limit: 5, filter: { tenantId: ctx.tenantId } };

const OUT_OF_RANGE: Array<[string, number[]]> = [
  ["1e39", [1e39, 0, 0]],
  ["-1e39", [-1e39, 0, 0]],
  ["Number.MAX_VALUE", [Number.MAX_VALUE, 0, 0]],
  ["2番目の成分だけ範囲外", [1, 1e39, 0]],
];

let vs: PostgresVectorStore;

beforeAll(async () => {
  const { db } = await getTestClient();
  const ms = new PostgresMemoryStore(db);
  vs = new PostgresVectorStore(db);
  const m = await ms.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "smf4-a" }),
  );
  await vs.upsert(ctx, SPACE, m.id, [1, 0, 0]);
});

afterAll(async () => {
  await closeTestClient();
});

const settle = async (run: () => Promise<unknown>) => run().then(() => "returns", () => "throws");

describe("PostgresVectorStore.searchMany は、float4 に収まらない成分のクエリでも search() と同じく投げない", () => {
  for (const [label, vector] of OUT_OF_RANGE) {
    it(`${label}: search() が投げないとき、searchMany も投げず、同じ結果を key に載せる`, async () => {
      expect(await settle(() => vs.search(ctx, SPACE, vector, opts))).toBe("returns");
      const expected: VectorHit[] = await vs.search(ctx, SPACE, vector, opts);

      const many = await vs.searchMany(ctx, SPACE, [{ key: "k", vector }], opts);

      expect([...many.keys()]).toEqual(["k"]);
      expect(many.get("k")).toEqual(expected);
    });

    it(`${label}: 同じ key の前のクエリがその値でも、投げずに最後のクエリの結果を返す`, async () => {
      const last = await vs.search(ctx, SPACE, [1, 0, 0], opts);

      const many = await vs.searchMany(
        ctx,
        SPACE,
        [
          { key: "k", vector },
          { key: "k", vector: [1, 0, 0] },
        ],
        opts,
      );

      expect([...many.keys()]).toEqual(["k"]);
      expect(many.get("k")).toEqual(last);
    });
  }
});
