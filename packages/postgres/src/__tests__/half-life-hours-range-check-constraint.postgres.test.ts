import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "half-life-check" };

// アプリ層の検査（`assertNewMemoryHalfLivesFitFloat4`）を通らない生の SQL の書き込みを、DB の CHECK 制約だけが守る。
const OUT_OF_RANGE: Array<[string, string]> = [
  ["ちょうど 0", "0"],
  ["負", "-1"],
  ["Infinity", "Infinity"],
  ["NaN", "NaN"],
];
const IN_RANGE: Array<[string, string]> = [
  ["既定の 720", "720"],
  ["1 を下回る小さい正の値", "0.5"],
  ["大きい有限の値", "1000000"],
];

describe("half_life_hours の値域は DB の CHECK 制約が守る（生の SQL で書いても (0, ∞) の外は入らない）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function setMemoryHalfLife(value: string) {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `h-${randomUUID()}` }),
    );
    await db.execute(
      sql`UPDATE memories SET half_life_hours = ${value}::real WHERE tenant_id = ${ctx.tenantId} AND id = ${memory.id}`,
    );
  }

  async function insertDefaultHalfLife(value: string) {
    const { db } = await getTestClient();
    await db.execute(
      sql`INSERT INTO tenant_settings (tenant_id, default_half_life_hours) VALUES (${`t-${randomUUID()}`}, ${value}::real)`,
    );
  }

  describe("memories.half_life_hours", () => {
    it.each(OUT_OF_RANGE)("%s は拒まれる", async (_label, value) => {
      await expect(setMemoryHalfLife(value)).rejects.toThrow();
    });
    it.each(IN_RANGE)("%s は通る", async (_label, value) => {
      await expect(setMemoryHalfLife(value)).resolves.toBeUndefined();
    });
  });

  describe("tenant_settings.default_half_life_hours", () => {
    it.each(OUT_OF_RANGE)("%s は拒まれる", async (_label, value) => {
      await expect(insertDefaultHalfLife(value)).rejects.toThrow();
    });
    it.each(IN_RANGE)("%s は通る", async (_label, value) => {
      await expect(insertDefaultHalfLife(value)).resolves.toBeUndefined();
    });
  });
});

describe("値域の外の halfLifeHours は、DB の生の例外ではなく範囲を名指しする例外で、どの書き込み口でも拒まれる", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  const BAD_VALUES: Array<[string, number]> = [
    ["ちょうど 0", 0],
    ["負", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  const validFloorAt = new Date("2026-06-01T00:00:00.000Z");

  function badInput(halfLifeHours: number) {
    return buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `h-${randomUUID()}`,
      halfLifeHours,
      decayFloorAt: validFloorAt,
    });
  }

  it("値域の内なら、1e6 を超える大きい値も書ける（上限は無い）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    const memory = await store.createMemory(ctx, badInput(1e9));

    expect(memory.halfLifeHours).toBe(1e9);
  });

  it.each(BAD_VALUES)("createMemory: %s", async (_label, value) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    await expect(store.createMemory(ctx, badInput(value))).rejects.toThrow(
      /halfLifeHours out of range/,
    );
  });

  it.each(BAD_VALUES)("createMemoryWithOutbox: %s", async (_label, value) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    await expect(store.createMemoryWithOutbox(ctx, badInput(value), [])).rejects.toThrow(
      /halfLifeHours out of range/,
    );
  });

  it.each(BAD_VALUES)("supersedeWithNewMemories の news: %s", async (_label, value) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    await expect(
      store.supersedeWithNewMemories(ctx, [{ input: badInput(value), jobKinds: [] }], []),
    ).rejects.toThrow(/halfLifeHours out of range/);
  });
});
