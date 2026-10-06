import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// `InMemoryLexicalStore.search` の並びは `coverage` 降順 → `rank` 降順 → `recordedAt` 降順 → `memoryId` 昇順。
// - 同点（`recordedAt` まで同じ）の最後の段は `memoryId` の文字列順で、挿入順ではない。
// - `recordedAt` は `coverage`・`rank` が同じときだけ効く（新しいからといって、`coverage`・`rank` が低い行が先に出てはならない）。
// 新しい方が先に来ること（`recordedAt` の段そのもの）と、2件だけの `memoryId` 昇順は
// `in-memory-lexical-store-tiebreak.test.ts` にある。
//
// ⚠ 1つ目の歯は、このファイルで最初に Memory を作る歯でなければならない。`mem-N` の連番は
// ファイルごとに 1 から始まるので、12件作ると `mem-10` を跨ぎ、「作った順」と「文字列順」が分かれる
// （2件だけでは、挿入順と文字列順が同じになって、`memoryId` の段を外しても気づけない）。

const TENANT = "lexical-tiebreak-order-tenant";
const ctx: Ctx = { tenantId: TENANT };

function setup(): { memoryStore: InMemoryMemoryStore; lexicalStore: InMemoryLexicalStore } {
  const memoryStore = new InMemoryMemoryStore();
  return { memoryStore, lexicalStore: new InMemoryLexicalStore(memoryStore) };
}

describe("InMemoryLexicalStore.search の並び: coverage・rank・recordedAt が同点なら memoryId の文字列順", () => {
  it("作った順ではなく、memoryId の昇順（文字列順）で返す", async () => {
    const { memoryStore, lexicalStore } = setup();
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const created: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          content: "widget alpha",
          contentHash: `same-time-${i}`,
          recordedAt: sameRecordedAt,
        }),
      );
      created.push(memory.id);
    }
    const expected = [...created].sort();
    // 歯が効く前提: 作った順と文字列順が違う（`mem-10` 以降があるので違うはず）。
    expect(created).not.toEqual(expected);

    const hits = await lexicalStore.search(ctx, "widget", {
      limit: 100,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual(expected);
    expect(new Set(hits.map((hit) => hit.coverage)).size).toBe(1);
    expect(new Set(hits.map((hit) => hit.rank)).size).toBe(1);
  });
});

describe("InMemoryLexicalStore.search の並び: recordedAt は coverage・rank が同じときだけ効く", () => {
  it("新しくても rank が低い行は、古くて rank が高い行より後", async () => {
    const { memoryStore, lexicalStore } = setup();
    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "widget widget widget",
        contentHash: "rank-older",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "widget",
        contentHash: "rank-newer",
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );

    const hits = await lexicalStore.search(ctx, "widget", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual([older.id, newer.id]);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
  });

  it("新しくても coverage が低い行は、古くて coverage が高い行より後", async () => {
    const { memoryStore, lexicalStore } = setup();
    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "widget alpha",
        contentHash: "coverage-older",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "widget",
        contentHash: "coverage-newer",
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );

    const hits = await lexicalStore.search(ctx, "widget alpha", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual([older.id, newer.id]);
    expect(hits[0]!.coverage).toBeGreaterThan(hits[1]!.coverage);
  });
});
