import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, DigestSource } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `purgeMemory` は `status`・`contentHash`・`digestSource` を変えない（interface の doc）。
 * `contentHash` は既存の試験が縛っているが、`digestSource` を見る試験は無く、purge が `digestSource` を書き換える形が緑のまま通っていた。
 */

const ctx: Ctx = { tenantId: "purge-memory-keeps-digest-source" };

describe("purgeMemory は digestSource を書き換えない", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  for (const digestSource of ["llm", "fallback"] as const satisfies readonly DigestSource[]) {
    it(`digestSource が ${digestSource} の記憶は、purge の後も ${digestSource} のまま`, async () => {
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `h-${digestSource}`,
          digestSource,
        }),
      );
      await store.updateStatus(ctx, created.id, "forgotten");
      const { memory } = await store.purgeMemory(
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
      // 前提: purge は実際に効いている。
      expect(memory.purgedAt).not.toBeNull();
      expect(memory.digestSource).toBe(digestSource);
      expect((await store.get(ctx, created.id))!.digestSource).toBe(digestSource);
    });
  }
});
