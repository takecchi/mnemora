// Postgres の `real`（float4）の列は、値を float4 で持ち、**最短の10進表記**で読み戻す。fixture も同じ値を返す。
//
// 対象の列（`packages/postgres/migrations/*.sql` の `real`）: `memories.strength`・`memories.half_life_hours`・
// `memories.half_life_recalls`・`tenant_settings.default_half_life_hours`・`tenant_settings.default_half_life_recalls`。
//
// ⚠ 読み戻す値は `Math.fround(x)` そのものではない（`Math.fround(720.1)` は `720.0999755859375` だが、Postgres は
// `720.1` を返す）。下の表は `packages/postgres/src/__tests__/float4-readback.postgres.test.ts` が本物の Postgres で
// 確かめた値と**同じ表**——変えるときは両方を揃えること。
//
// `*-conformance.ts` には足さない: float4 で持つのは Postgres の列の性質で、adapter 一般の契約ではない。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

const FLOAT4_READBACK_CASES: ReadonlyArray<readonly [input: number, readBack: number]> = [
  [0.1 + 0.2, 0.3],
  [720.1, 720.1],
  [100 / 3, 33.333332],
  [1 / 7, 0.14285715],
  [16777217, 16777216],
  [123456.789, 123456.79],
];

describe("InMemoryMemoryStore: float4 の列は Postgres が読み戻す値で返す", () => {
  it.each(FLOAT4_READBACK_CASES)(
    "halfLifeHours=%s は createMemory の返り値も get も %s になる",
    async (input, readBack) => {
      const store = new InMemoryMemoryStore();
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
      const store = new InMemoryMemoryStore();
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "f4s", strength: input }),
      );
      expect(created.strength).toBe(readBack);
      const reinforced = await store.reinforce(ctx, created.id, new Date(Date.now() + 1000));
      expect(reinforced.strength).toBe(readBack);
    },
  );

  it("createMemoryWithOutbox の返り値も同じ値になる", async () => {
    const store = new InMemoryMemoryStore();
    const { memory } = await store.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "f4w",
        halfLifeHours: 0.1 + 0.2,
        strength: 0.1 + 0.2,
        halfLifeRecalls: 0.1 + 0.2,
      }),
      [],
    );
    expect([memory.halfLifeHours, memory.strength, memory.halfLifeRecalls]).toEqual([
      0.3, 0.3, 0.3,
    ]);
  });
});

describe("InMemoryTenantSettingsStore: float4 の既定 half-life は Postgres が読み戻す値で返す", () => {
  it.each(FLOAT4_READBACK_CASES)(
    "既定 half-life（%s）は、時間側・想起側とも %s になる",
    async (input, readBack) => {
      const store = new InMemoryTenantSettingsStore();
      await store.setDefaultHalfLifeRecalls(ctx, input);
      expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(readBack);
      store.setDefaultHalfLifeHours(ctx.tenantId, input);
      expect(await store.getDefaultHalfLifeHours(ctx)).toBe(readBack);
    },
  );
});
