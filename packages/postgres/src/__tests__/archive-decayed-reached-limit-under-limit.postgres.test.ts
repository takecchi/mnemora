import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "archive-decayed-reached-limit-under-limit" };
const now = new Date("2026-06-01T00:00:00.000Z");

const KITS: Array<[string, () => Promise<InMemoryMemoryStore | PostgresMemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)(
  "archiveDecayed の reachedLimit：limit に届かなければ false（%s）",
  (_name, make) => {
    it.each([
      [5, false],
      [3, false],
      [2, true],
    ])("対象が2件で limit=%i なら、2件掃いて reachedLimit は %s", async (limit, expected) => {
      const store = await make();
      for (const tag of ["a", "b"]) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `h-${tag}` }),
        );
      }

      const result = await store.archiveDecayed(ctx, { now, limit });

      expect(result.archived).toHaveLength(2);
      expect(result.reachedLimit).toBe(expected);
    });
  },
);
