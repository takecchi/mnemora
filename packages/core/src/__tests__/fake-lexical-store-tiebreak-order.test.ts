import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 1つ目の歯は、このファイルで最初に Memory を作る歯でなければならない: `mem-N` の連番はファイルごとに 1 から始まり、
 * 12件作ると `mem-10` を跨いで「作った順」と「文字列順」が分かれる。
 */

const TENANT = "fake-lexical-tiebreak-order-tenant";
const ctx: Ctx = { tenantId: TENANT };

function fixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  const recordedAt = overrides.recordedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "widget alpha",
    contentHash: `tiebreak-order-hash-${recordedAt.getTime()}-${Math.random()}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeLexicalStore.search の並び: coverage・rank・recordedAt が同点なら memoryId の文字列順", () => {
  it("作った順ではなく、memoryId の昇順（文字列順）で返す", async () => {
    const { memoryStore, lexicalStore } = createFakeRuntimeStores();
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const created: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        fixture({ recordedAt: sameRecordedAt, contentHash: `same-time-${i}` }),
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

describe("FakeLexicalStore.search の並び: recordedAt は coverage・rank が同じときだけ効く", () => {
  it("新しくても rank が低い行は、古くて rank が高い行より後", async () => {
    const { memoryStore, lexicalStore } = createFakeRuntimeStores();
    const older = await memoryStore.createMemory(
      ctx,
      fixture({
        content: "widget widget widget",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      fixture({ content: "widget", recordedAt: new Date("2026-01-02T00:00:00.000Z") }),
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
    const { memoryStore, lexicalStore } = createFakeRuntimeStores();
    const older = await memoryStore.createMemory(
      ctx,
      fixture({ content: "widget alpha", recordedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      fixture({ content: "widget", recordedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );

    const hits = await lexicalStore.search(ctx, "widget alpha", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((hit) => hit.memoryId)).toEqual([older.id, newer.id]);
    expect(hits[0]!.coverage).toBeGreaterThan(hits[1]!.coverage);
  });
});
