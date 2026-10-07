import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ⚠ 読み戻す値は `Math.fround(x)` そのものではない。Postgres は float4 を「float4 として一意に決まる最短の10進表記」で文字列にして返し、
 * ドライバがそれを float64 として読む。だから `0.30000000000000004` は `0.3` に、`720.1` は `720.1` のまま返る（`Math.fround(720.1)` は `720.0999755859375`）。
 * testkit の `in-memory-fixtures-float4-readback.test.ts` は、下の表と同じ値を fixture に期待する。表を変えるときは両方を揃えること。
 */
const FLOAT4_READBACK_CASES: ReadonlyArray<readonly [input: number, readBack: number]> = [
  [0.1 + 0.2, 0.3],
  [720.1, 720.1],
  [100 / 3, 33.333332],
  [1 / 7, 0.14285715],
  [16777217, 16777216],
  [123456.789, 123456.79],
];

describe("float4（real）の列は、Postgres が最短表記で読み戻した値を返す", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it.each(FLOAT4_READBACK_CASES)(
    "halfLifeHours=%s は createMemory の返り値も get も %s になる",
    async (input, readBack) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const ctx: Ctx = { tenantId: "float4-readback" };
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "f4",
          halfLifeHours: input,
          halfLifeRecalls: input,
        }),
      );
      expect(created.halfLifeHours).toBe(readBack);
      expect(created.halfLifeRecalls).toBe(readBack);
      const got = await store.get(ctx, created.id);
      expect(got?.halfLifeHours).toBe(readBack);
      expect(got?.halfLifeRecalls).toBe(readBack);
    },
  );

  it.each(FLOAT4_READBACK_CASES.filter(([input]) => input <= 1))(
    "strength=%s は createMemory の返り値も、reinforce の返り値も %s になる",
    async (input, readBack) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const ctx: Ctx = { tenantId: "float4-readback" };
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "f4s", strength: input }),
      );
      expect(created.strength).toBe(readBack);
      const reinforced = await store.reinforce(ctx, created.id, new Date(Date.now() + 1000));
      expect(reinforced.strength).toBe(readBack);
    },
  );

  it.each(FLOAT4_READBACK_CASES)(
    "tenant_settings の既定 half-life（%s）は、時間側・想起側とも %s になる",
    async (input, readBack) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresTenantSettingsStore(db);
      const ctx: Ctx = { tenantId: "float4-readback" };
      await store.setDefaultHalfLifeRecalls(ctx, input);
      expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(readBack);
      await db.execute(sql`
        UPDATE tenant_settings SET default_half_life_hours = ${input} WHERE tenant_id = ${ctx.tenantId}
      `);
      expect(await store.getDefaultHalfLifeHours(ctx)).toBe(readBack);
    },
  );
});
