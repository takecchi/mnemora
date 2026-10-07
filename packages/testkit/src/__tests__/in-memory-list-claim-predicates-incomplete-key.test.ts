import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/** 片方だけの claim key は、ADR 0630 より前に書かれた行（読み側に残りうる）の再現。正しい鍵で書いた後に、fixture 内部の `memories` の行を書き換えて作る。 */

const ctx: Ctx = { tenantId: "tenant-1" };

async function seedLegacyClaimKey(
  store: InMemoryMemoryStore,
  contentHash: string,
  claimKey: unknown,
): Promise<void> {
  const written = await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash,
      claimKey: { subject: "tmp", predicate: "tmp" },
    }),
  );
  (store as unknown as { memories: Map<string, { claimKey: unknown }> }).memories.get(
    written.id,
  )!.claimKey = claimKey;
}

describe("InMemoryMemoryStore.listActiveClaimPredicates — 片方が欠けた claim key を数えない", () => {
  it("主語だけ・述語だけの claim key を持つ Memory は数えず、両方そろったものだけを返す（null を混ぜない）", async () => {
    const store = new InMemoryMemoryStore();
    await seedLegacyClaimKey(store, "subject-only", { subject: "user" });
    await seedLegacyClaimKey(store, "predicate-only", { predicate: "home_city" });
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "complete",
        claimKey: { subject: "user", predicate: "favorite_color" },
      }),
    );

    const predicates = await store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 10 });

    expect(predicates).toEqual(["favorite_color"]);
  });
});
