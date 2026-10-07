import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  createOptionalTrigramIndex,
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresTrigramLexicalStore`（opt-in の語彙 store）の4点の歯。
 *
 * - E1: 同点（`coverage`・`rank` が同じ）の並びは `recorded_at DESC`、同時刻では `id` 昇順。
 * - G1: `create({ threshold })` は `[0, 1]` の有限数だけを受ける（上限・下限・非有限数を拒む）。
 * - I: `create()` は索引を作らない（`createOptionalTrigramIndex` で初めて作る）。
 * - S: `rank` に `word_similarity` が入る。`coverage` が同じ2行で、
 *   `word_similarity` の高いほうが、`recorded_at` が古くても先に来る。
 *
 * SQL_ASCII のクラスタでは `create()` が拒むので、その場合は何も確かめずに戻る。
 */

const ctx: Ctx = { tenantId: "trigram-teeth" };
const filter = { tenantId: ctx.tenantId };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

async function setup() {
  const { db } = await getTestClient();
  if (!(await probeTrigramLexicalSupport(db)).ok) return null;
  const memoryStore = new PostgresMemoryStore(db);
  const make = async (label: string, content: string, recordedAt: Date) =>
    (
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `trigram-teeth-${label}`,
          content,
          recordedAt,
        }),
      )
    ).id;
  return { db, make };
}

describe("PostgresTrigramLexicalStore.search の同点の並び（E1。ADR 0175）", () => {
  it.each([
    ["日本語の一致", "東京タワーに行きました", "東京タワー"],
    ["ASCII の一致", "obsidian shards glimmer in the cave", "obsidian shards"],
  ])("%s: recorded_at の新しい順、同時刻では id 昇順", async (_label, content, query) => {
    const env = await setup();
    if (env === null) return;
    const store = await PostgresTrigramLexicalStore.create(env.db);
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-01-02T00:00:00.000Z");
    const t3 = new Date("2026-01-03T00:00:00.000Z");
    const oldest = await env.make("oldest", content, t1);
    const newest = await env.make("newest", content, t3);
    const middleA = await env.make("middle-a", content, t2);
    const middleB = await env.make("middle-b", content, t2);

    const hits = await store.search(ctx, query, { limit: 10, filter });

    const [smaller, larger] = [middleA, middleB].sort();
    expect(hits.map((h) => h.memoryId)).toEqual([newest, smaller, larger, oldest]);
  });
});

describe("PostgresTrigramLexicalStore.create の threshold の範囲（G1。ADR 0319 §5）", () => {
  it.each([
    1.0000001,
    1.5,
    2,
    -0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("threshold: %j は RangeError で拒まれる", async (threshold) => {
    const env = await setup();
    if (env === null) return;
    await expect(PostgresTrigramLexicalStore.create(env.db, { threshold })).rejects.toThrow(
      RangeError,
    );
  });

  it.each([0, 1])("境界の threshold: %j は通る", async (threshold) => {
    const env = await setup();
    if (env === null) return;
    await expect(PostgresTrigramLexicalStore.create(env.db, { threshold })).resolves.toBeDefined();
  });
});

describe("PostgresTrigramLexicalStore.create は索引を作らない（I。ADR 0319 決定5）", () => {
  it("create() の後に idx_memories_trigram は無く、createOptionalTrigramIndex を呼んで初めて作られる", async () => {
    const env = await setup();
    if (env === null) return;
    const exists = async () =>
      (
        (
          await env.db.execute(
            sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_memories_trigram'`,
          )
        ).rows[0] as { n: number }
      ).n;
    await env.db.execute(sql`DROP INDEX IF EXISTS idx_memories_trigram`);

    await PostgresTrigramLexicalStore.create(env.db);
    expect(await exists()).toBe(0);

    // 陽性対照: 明示の口では作られる（この歯の「無い」が、検査の外れでないことの確認）。
    await createOptionalTrigramIndex(env.db);
    expect(await exists()).toBe(1);
    await env.db.execute(sql`DROP INDEX IF EXISTS idx_memories_trigram`);
  });
});

describe("PostgresTrigramLexicalStore.search の rank に word_similarity が入る（S。ADR 0553）", () => {
  it("coverage が同じ2行では、word_similarity の高い行が、recorded_at が古くても先に来る", async () => {
    const env = await setup();
    if (env === null) return;
    const store = await PostgresTrigramLexicalStore.create(env.db, { threshold: 0.3 });
    // 完全一致（word_similarity が高い）を古く、部分的な一致（低い）を新しくする。
    // rank に word_similarity が無ければ、同点の次の段（recorded_at DESC）で新しい行が先になる。
    const exactButOld = await env.make("exact", "東京タワー", new Date("2026-01-01T00:00:00.000Z"));
    const partialButNew = await env.make(
      "partial",
      "東京の古いタワーが好きです",
      new Date("2026-01-02T00:00:00.000Z"),
    );

    const hits = await store.search(ctx, "東京タワー", { limit: 10, filter });

    expect(hits.map((h) => h.memoryId)).toEqual([exactButOld, partialButNew]);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
  });
});
