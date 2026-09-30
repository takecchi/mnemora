import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `halfLifeHours`・`halfLifeRecalls` が float4（Postgres の `real` 列）に収まらないとき、
 * `NewMemory` を受けるどの入口も DB の生の例外ではなく、`float4` を名指しする明示の例外で断る。
 * `createMemory` は共有の conformance が見る。ここでは他の入口（createMemoryWithOutbox・
 * supersedeWithNewMemories）を見る。
 */
/** 明示の例外の目印（DB の生の例外は「Failed query: …」で始まり、この文言を含まない）。 */
const FLOAT4_MESSAGE = /does not fit in a Postgres "real" \(float4\) column/;
const ctx: Ctx = { tenantId: "half-life-float4-explicit-reject" };

afterAll(async () => {
  await closeTestClient();
});

const CASES: Array<[string, Record<string, unknown>]> = [
  ["halfLifeHours が大きすぎる", { halfLifeHours: 1e39 }],
  ["halfLifeHours が 0 に丸まる", { halfLifeHours: 1e-50 }],
  ["halfLifeRecalls が大きすぎる", { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: 1e39 }],
  ["halfLifeRecalls が 0 に丸まる", { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: 1e-50 }],
];

describe.each(CASES)("float4 に収まらない値を明示の例外で断る（%s）", (_label, override) => {
  const build = () =>
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      ...override,
    });

  it("createMemoryWithOutbox", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(store.createMemoryWithOutbox(ctx, build(), ["embed"])).rejects.toThrow(
      FLOAT4_MESSAGE,
    );
  });

  it("supersedeWithNewMemories", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(
      store.supersedeWithNewMemories(ctx, [{ input: build(), jobKinds: [] }], []),
    ).rejects.toThrow(FLOAT4_MESSAGE);
  });
});
