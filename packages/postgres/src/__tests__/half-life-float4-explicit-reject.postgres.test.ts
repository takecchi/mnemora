import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const FLOAT4_MESSAGE = /does not fit in a Postgres "real" \(float4\) column/;
const ctx: Ctx = { tenantId: "half-life-float4-explicit-reject" };

afterAll(async () => {
  await closeTestClient();
});

/** float4 の範囲の両端で、すぐ外に出る値（`Math.fround` が `Infinity` か 0 になる）。 */
const FLOAT4_EDGES_OUTSIDE: Array<[string, number]> = [
  ["Infinity に丸まる最小の値（2^128 - 2^103）", 2 ** 128 - 2 ** 103],
  ["0 に丸まる最大の値（2^-150）", 2 ** -150],
];

const CASES: Array<[string, Record<string, unknown>]> = [
  ["halfLifeHours が大きすぎる", { halfLifeHours: 1e39 }],
  ["halfLifeHours が 0 に丸まる", { halfLifeHours: 1e-50 }],
  ["halfLifeRecalls が大きすぎる", { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: 1e39 }],
  ["halfLifeRecalls が 0 に丸まる", { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: 1e-50 }],
  ...FLOAT4_EDGES_OUTSIDE.map(([label, value]): [string, Record<string, unknown>] => [
    `halfLifeHours が ${label}`,
    { halfLifeHours: value },
  ]),
  ...FLOAT4_EDGES_OUTSIDE.map(([label, value]): [string, Record<string, unknown>] => [
    `halfLifeRecalls が ${label}`,
    { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: value },
  ]),
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

describe("setDefaultHalfLifeRecalls も float4 に収まらない値を明示の例外で断る", () => {
  it.each(FLOAT4_EDGES_OUTSIDE)("%s", async (_label, recalls) => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const settings = new PostgresTenantSettingsStore(db);
    await expect(settings.setDefaultHalfLifeRecalls(ctx, recalls)).rejects.toThrow(FLOAT4_MESSAGE);
  });
});
