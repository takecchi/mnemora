import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const claimKey = { subject: "user", predicate: "likes" };

function pairEvent(memoryId: MemoryId): NewMemoryEvent {
  return buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId, kind: "updated" });
}

describe("InMemoryMemoryStore.findContestedByClaimKey: excludeMemoryId は、その id の行だけを除く", () => {
  it("excludeMemoryId と contested の対になっている相手の行は、除かずに返す", async () => {
    const store = new InMemoryMemoryStore();
    const first = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-first", claimKey }),
    );
    const second = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "hash-second", claimKey }),
    );
    await store.markContestedPair(
      ctx,
      { id: first.id, event: pairEvent(first.id) },
      { id: second.id, event: pairEvent(second.id) },
    );

    const matches = await store.findContestedByClaimKey(ctx, {
      subjectId: null,
      claimKey,
      excludeMemoryId: first.id,
      contentHash: "hash-third",
      validFrom: null,
      validUntil: null,
    });

    // 返す順序は規定しないが、一致は1件だけなので配列で比べてよい。
    expect(matches.map((m) => m.id)).toEqual([second.id]);
    expect(matches[0]?.contestedWithId).toBe(first.id);
  });
});

describe("InMemoryMemoryStore.listActiveClaimPredicates: status と claim key の有無のほかでは絞らない", () => {
  it("validUntil が過ぎた active の行の predicate も、一覧に入れる", async () => {
    const store = new InMemoryMemoryStore();
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "hash-expired",
        claimKey: { subject: "user", predicate: "lived_in" },
        validFrom: new Date("2020-01-01T00:00:00.000Z"),
        validUntil: new Date("2021-01-01T00:00:00.000Z"),
      }),
    );

    const predicates = await store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 10 });

    expect(predicates).toEqual(["lived_in"]);
  });

  it("validFrom が未来の active の行の predicate も、一覧に入れる", async () => {
    const store = new InMemoryMemoryStore();
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "hash-future",
        claimKey: { subject: "user", predicate: "will_live_in" },
        validFrom: new Date("2999-01-01T00:00:00.000Z"),
      }),
    );

    const predicates = await store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 10 });

    expect(predicates).toEqual(["will_live_in"]);
  });
});

describe("InMemoryMemoryStore.listLabels: proposedCount が 0 になった proposed のラベルも出し続ける", () => {
  it("唯一の Memory を purge して proposedCount が 0 になっても、その行を返す", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "hash-labelled",
        tags: ["hobby"],
        status: "forgotten",
      }),
    );
    await store.purgeMemory(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id, kind: "purged" }),
    );

    const labels = await store.listLabels(ctx);

    expect(labels).toEqual([
      { name: "hobby", status: "proposed", proposedCount: 0, registeredAt: null },
    ]);
  });
});
