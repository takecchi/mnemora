import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * [ADR 0438](../../../docs/decisions/0438-tenant-boundary-teeth-and-purge-uuid-case.md):
 * `purgeMemory` に大文字の uuid を渡しても、`memories` の行だけでなく、`recalls.index_band` の目次帯
 * （`digestBand`）の digest も書き換わる。以前は `memories` の UPDATE（uuid 型で比べる）だけが効き、
 * 目次帯の UPDATE（文字列で比べる）は小文字の id にしか当たらず、書き換える前の digest が recall の記録に残った。
 */

const ctx: Ctx = { tenantId: "purge-upper-tenant" };
const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

describe("purgeMemory: uuid の形でない id は、渡された綴りのまま message に出る", () => {
  it.each(["NOT-A-UUID-ABC", "Mixed-Case-ID", "ABCDEF"])(
    "%s: 大文字を小文字にそろえず、message はその綴りのまま",
    async (badId) => {
      const { db } = await getTestClient();
      const mem = new PostgresMemoryStore(db);
      await expect(
        mem.purgeMemory(ctx, badId as never, { content: "[purged]", digest: "[purged]" }, {
          memoryId: badId,
          kind: "purged",
          actor: { type: "system" },
          meta: {},
        } as never),
      ).rejects.toThrow(new Error(`PostgresMemoryStore: memory not found for tenant: ${badId}`));
    },
  );
});

describe("purgeMemory: 大文字の id でも recall の目次帯の digest を書き換える", () => {
  it("大文字の id で purge すると、digestBand の該当の digest が tombstone になり、ほかの記憶の digest は残る", async () => {
    const { db } = await getTestClient();
    const mem = new PostgresMemoryStore(db);
    const target = await mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-target",
        digest: "SECRET-DIGEST",
      }),
    );
    const other = await mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-other",
        digest: "KEEP-DIGEST",
      }),
    );
    await mem.updateStatus(ctx, target.id, "forgotten");
    const recallId = await mem.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage,
      indexBand: {
        groups: [],
        totalInScope: 2,
        countKind: "exact",
        digestBand: [
          { memoryId: target.id, digest: "SECRET-DIGEST" },
          { memoryId: other.id, digest: "KEEP-DIGEST" },
        ],
      },
      explain: { stages: [] },
      returnedMemories: [],
    } as never);

    await mem.purgeMemory(
      ctx,
      target.id.toUpperCase(),
      { content: "[purged]", digest: "[purged]" },
      { memoryId: target.id, kind: "purged", actor: { type: "system" }, meta: {} } as never,
    );

    const band = (await mem.getRecall(ctx, recallId))!.indexBand.digestBand!;
    expect(band.find((e) => e.memoryId === target.id)!.digest).toBe("[purged]");
    expect(band.find((e) => e.memoryId === other.id)!.digest).toBe("KEEP-DIGEST");
  });
});
