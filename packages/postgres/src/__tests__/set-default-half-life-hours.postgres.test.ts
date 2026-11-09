import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { HALF_LIFE_HOURS_INVALID_MESSAGE } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

// ADR 0706: テナントの既定の半減期を本番の口で設定できる。効くのは呼び出し後に作られる記憶だけ。

const ctx: Ctx = { tenantId: "set-default-half-life-hours" };

describe("PostgresTenantSettingsStore.setDefaultHalfLifeHours（本物の Postgres）", () => {
  let settings: PostgresTenantSettingsStore;
  let memories: PostgresMemoryStore;

  beforeEach(async () => {
    const { db } = await getTestClient();
    await resetTestDatabase();
    settings = new PostgresTenantSettingsStore(db);
    memories = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("設定した値を getDefaultHalfLifeHours が返し、上書きもできる", async () => {
    await settings.setDefaultHalfLifeHours(ctx, 24 * 90);
    expect(await settings.getDefaultHalfLifeHours(ctx)).toBe(24 * 90);
    await settings.setDefaultHalfLifeHours(ctx, 24 * 365);
    expect(await settings.getDefaultHalfLifeHours(ctx)).toBe(24 * 365);
  });

  it("既存の記憶の halfLifeHours・decayFloorAt は書き換えない", async () => {
    const before = await memories.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-before",
        halfLifeHours: 720,
      }),
    );

    await settings.setDefaultHalfLifeHours(ctx, 24 * 365);

    const after = await memories.get(ctx, before.id);
    expect(after?.halfLifeHours).toBe(720);
    expect(after?.decayFloorAt.toISOString()).toBe(before.decayFloorAt.toISOString());
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "値域 (0, ∞) の外（%s）は、行を書かずに HALF_LIFE_HOURS_INVALID_MESSAGE で拒む",
    async (hours) => {
      await expect(settings.setDefaultHalfLifeHours(ctx, hours)).rejects.toThrow(
        HALF_LIFE_HOURS_INVALID_MESSAGE,
      );
      expect(await settings.getEventRetention(ctx)).toEqual({ kind: "unset" });
    },
  );

  it("float4 に収まらない値は、DB の生の例外ではなく明示の例外で拒む", async () => {
    await expect(settings.setDefaultHalfLifeHours(ctx, 1e39)).rejects.toThrow(
      'does not fit in a Postgres "real" (float4) column',
    );
  });
});
