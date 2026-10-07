import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 決定性を確かめるだけで1回引いて同じ順序を見る歯は弱い（たまたま `id` の大小関係が都合よく揃っていただけ、という可能性を排除できない）。
 * そこで、同じ筋書きを別々のテナントで N=20 回繰り返す。`memories.id` は行ごとの `gen_random_uuid()` なので、`id` の大小関係は毎回独立に引き直され、
 * 「DB を作り直す」ことを1つのテスト内で標本抽出できる。同じ `content` を持つ行は `coverage`/`rank` が完全に一致する。
 *
 * 実装が `recorded_at` を見ずに `id` の運に任せているなら、20回連続で「`recorded_at` が新しい方が先」になる確率は 2⁻²⁰ しかない。
 * さらに、`newer.id` が `older.id` より小さい回・大きい回の両方が少なくとも1回ずつ現れたことも検査し、結果が `id` の偏りの産物でないことを示す。
 * ⚠ この追加の検査は確率的に失敗しうる（概算 2 × 2⁻²⁰）が、無視できるほど小さいので残す。
 */
const TENANT_PREFIX = "lexical-search-tiebreak-tenant";
const QUERY = "widget";
// 同じ content を使えば coverage も rank も完全一致する（どちらも content だけの関数）。
const TIED_CONTENT = "widget alpha bravo tie-break test content";

describe("PostgresLexicalStore.search — coverage/rank が完全一致したときの tie-break（Issue #345 / ADR 0175）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("recorded_at が新しい方を先に返す — N=20回、毎回別テナントで id の大小関係を引き直しても崩れない（実装が id 順に落ちていれば通る確率は2⁻²⁰）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);

    const N = 20;
    const newerIdSmaller: boolean[] = [];

    for (let i = 0; i < N; i++) {
      const tenantId = `${TENANT_PREFIX}-${i}`;
      const ctx: Ctx = { tenantId };

      const older = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId,
          content: TIED_CONTENT,
          recordedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );
      const newer = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId,
          content: TIED_CONTENT,
          recordedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      );

      const hits = await lexicalStore.search(ctx, QUERY, {
        limit: 10,
        filter: { tenantId, status: ["active", "contested"] },
      });

      expect(hits).toHaveLength(2);
      expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
      expect(hits[0]!.rank).toBe(hits[1]!.rank);

      expect(hits.map((h) => h.memoryId)).toEqual([newer.id, older.id]);

      newerIdSmaller.push(newer.id < older.id);
    }

    expect(newerIdSmaller).toContain(true);
    expect(newerIdSmaller).toContain(false);
  }, 60_000);

  it("recorded_at まで完全一致したときは id にフォールバックし、例外にも欠落にもならない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const tenantId = `${TENANT_PREFIX}-collision`;
    const ctx: Ctx = { tenantId };

    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, content: TIED_CONTENT, recordedAt: sameRecordedAt }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, content: TIED_CONTENT, recordedAt: sameRecordedAt }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId, status: ["active", "contested"] },
    });

    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);

    // `recorded_at` が完全一致したときの並びは `id` の辞書順に落ちる（ANN 側と同じ残余）。
    const expectedOrder = [a.id, b.id].sort();
    expect(hits.map((h) => h.memoryId)).toEqual(expectedOrder);
  }, 60_000);
});
