import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, TenantSettingsStore } from "@mnemora/core";
import { InMemoryMemoryStore, InMemoryTenantSettingsStore } from "@mnemora/testkit/fixtures";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "clock-settings-a" };
const B: Ctx = { tenantId: "clock-settings-b" };

interface Impl {
  name: string;
  create: () => Promise<{ settings: Required<TenantSettingsStore> }>;
}

const impls: Impl[] = [
  {
    name: "InMemory",
    create: async () => {
      const memory = new InMemoryMemoryStore();
      const settings = new InMemoryTenantSettingsStore(memory.activitySeq) as unknown;
      return { settings: settings as Required<TenantSettingsStore> };
    },
  },
  {
    name: "Postgres",
    create: async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        settings: new PostgresTenantSettingsStore(db) as unknown as Required<TenantSettingsStore>,
      };
    },
  },
];

describe.each(impls)(
  "テナントの減衰設定の書き込みは、そのテナントのその欄だけを変える（$name）",
  (impl) => {
    afterAll(async () => {
      if (impl.name === "Postgres") await closeTestClient();
    });

    it("setDecayClock は、別のテナントの時計と、同じテナントの既定の半減期（回数）を動かさない", async () => {
      const { settings } = await impl.create();
      await settings.setDefaultHalfLifeRecalls(A, 5000);
      await settings.setDecayClock(B, "either");

      await settings.setDecayClock(A, "activity");

      expect(await settings.getDecayClock(A)).toBe("activity");
      expect(await settings.getDefaultHalfLifeRecalls(A)).toBe(5000);
      expect(await settings.getDecayClock(B)).toBe("either");
    });

    it("setDefaultHalfLifeRecalls は、別のテナントの既定の半減期（回数）と、同じテナントの時計を動かさない", async () => {
      const { settings } = await impl.create();
      await settings.setDecayClock(A, "either");
      await settings.setDefaultHalfLifeRecalls(B, 3000);

      await settings.setDefaultHalfLifeRecalls(A, 5000);

      expect(await settings.getDefaultHalfLifeRecalls(A)).toBe(5000);
      expect(await settings.getDecayClock(A)).toBe("either");
      expect(await settings.getDefaultHalfLifeRecalls(B)).toBe(3000);
      expect(await settings.getDecayClock(B)).toBe("wall");
    });
  },
);
