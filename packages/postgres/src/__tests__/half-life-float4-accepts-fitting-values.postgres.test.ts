import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 断るのは「float4 に収まらない値（`Math.fround` が `Infinity` か 0 になる値）」だけで、収まる値は、float4 で正確に表せない値（`0.1` など）でも通す。 */
const ctx: Ctx = { tenantId: "half-life-float4-accepts-fitting-values" };

afterAll(async () => {
  await closeTestClient();
});

const build = (override: Record<string, unknown>) =>
  buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `fit-${JSON.stringify(override)}`,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    ...override,
  });

/** float4 の範囲の両端で、まだ収まる値（`Math.fround` が有限かつ 0 でない）。 */
const FLOAT4_EDGES: Array<[string, number]> = [
  ["float4 の最大ちょうど（3.4028234663852886e38）", 3.4028234663852886e38],
  ["float4 の最大に丸まる最大の値（3.4028235677973362e38）", 3.4028235677973362e38],
  ["float4 の正規数の最小（1.1754943508222875e-38）", 1.1754943508222875e-38],
  ["float4 の非正規数の最小ちょうど（2^-149）", 2 ** -149],
  [
    "0 でなく float4 の非正規数の最小に丸まる最小の値（7.006492321624087e-46）",
    7.006492321624087e-46,
  ],
];

describe("float4 に収まる値は断らない", () => {
  it.each([
    ["float4 で正確に表せない小数（0.1）", { halfLifeHours: 0.1 }],
    ["float4 の最大に近い大きい値（1e38）", { halfLifeHours: 1e38 }],
    ["小さいが 0 に丸まらない値（1e-30）", { halfLifeHours: 1e-30 }],
    [
      "halfLifeRecalls が float4 で正確に表せない小数（0.3）",
      { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: 0.3 },
    ],
    ["halfLifeRecalls が null", { halfLifeRecalls: null }],
    ...FLOAT4_EDGES.map(([label, value]): [string, Record<string, unknown>] => [
      `halfLifeHours が ${label}`,
      { halfLifeHours: value },
    ]),
    ...FLOAT4_EDGES.map(([label, value]): [string, Record<string, unknown>] => [
      `halfLifeRecalls が ${label}`,
      { decayBaseSeq: 0, decayFloorSeq: 5, halfLifeRecalls: value },
    ]),
  ])("createMemoryWithOutbox・supersedeWithNewMemories: %s", async (_label, override) => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    const first = await store.createMemoryWithOutbox(ctx, build(override), ["embed"]);
    expect(first.created).toBe(true);

    const second = await store.supersedeWithNewMemories(
      ctx,
      [{ input: build({ ...override, contentHash: "second" }), jobKinds: [] }],
      [],
    );
    expect(second.created[0]?.created).toBe(true);
  });

  it("setDefaultHalfLifeRecalls: 0.1 と 1e38 は通る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const settings = new PostgresTenantSettingsStore(db);
    await settings.setDefaultHalfLifeRecalls(ctx, 0.1);
    await settings.setDefaultHalfLifeRecalls(ctx, 1e38);
  });

  it.each(FLOAT4_EDGES)("setDefaultHalfLifeRecalls: %s は通る", async (_label, recalls) => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const settings = new PostgresTenantSettingsStore(db);
    await settings.setDefaultHalfLifeRecalls(ctx, recalls);
  });
});
