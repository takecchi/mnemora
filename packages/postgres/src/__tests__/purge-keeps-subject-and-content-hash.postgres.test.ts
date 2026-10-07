import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * purge が消すのは本文・digest・tags・attributes・claim key などで、`subjectId` と `contentHash` は残る。
 * `contentHash` は冪等キーの一部で、書き換えると同じ本文の再書き込みが別の行になる。
 * 2実装で同じ。
 */

const ctx: Ctx = { tenantId: "purge-keeps-subject-and-content-hash" };

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
];

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeStore] of KITS) {
  describe(name, () => {
    it("purge の後も subjectId と contentHash は元のまま、本文は消える", async () => {
      const store = await makeStore();
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          subjectId: "subject-keep",
          contentHash: "hash-keep",
          content: "消える本文",
        }),
      );
      await store.updateStatus(ctx, created.id, "forgotten");
      await store.purgeMemory!(
        ctx,
        created.id,
        { content: "[purged]", digest: "[purged]" },
        {
          tenantId: ctx.tenantId,
          memoryId: created.id,
          kind: "purged",
          at: new Date("2026-06-01T00:00:00.000Z"),
          actor: { type: "system" },
          digestSnapshot: created.digest,
          meta: {},
        },
      );
      const after = (await store.get(ctx, created.id))!;
      expect(after.content).toBe("[purged]");
      expect(after.subjectId).toBe("subject-keep");
      expect(after.contentHash).toBe("hash-keep");
    });
  });
}
