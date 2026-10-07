import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "purge-target-only" };
const otherCtx: Ctx = { tenantId: "purge-target-only-other-tenant" };
const TOMBSTONE = { content: "[purged]", digest: "[purged]" };

async function purge(store: InMemoryMemoryStore, id: MemoryId, tenant: Ctx = ctx) {
  return store.purgeMemory(tenant, id, TOMBSTONE, {
    tenantId: tenant.tenantId,
    memoryId: id,
    kind: "purged",
    actor: { type: "system" },
    meta: {},
  });
}

describe("InMemoryMemoryStore.purgeMemory は対象の1件だけを書き換える", () => {
  it("同じテナントの forgotten な別の記憶は、本文・要旨・purgedAt のどれも変わらない", async () => {
    const store = new InMemoryMemoryStore();
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "t", status: "forgotten" }),
    );
    const bystander = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "b",
        status: "forgotten",
        content: "別の記憶の本文",
        digest: "別の記憶の要旨",
      }),
    );

    await purge(store, target.id);

    const after = await store.get(ctx, bystander.id);
    expect(after?.content).toBe("別の記憶の本文");
    expect(after?.digest).toBe("別の記憶の要旨");
    expect(after?.purgedAt ?? null).toBeNull();
    expect(store.events.filter((e) => e.kind === "purged").map((e) => e.memoryId)).toEqual([
      target.id,
    ]);
  });

  it("別のテナントの forgotten な記憶には、同じ id 空間でも触れない", async () => {
    const store = new InMemoryMemoryStore();
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "t", status: "forgotten" }),
    );
    const otherTenant = await store.createMemory(
      otherCtx,
      buildNewMemoryFixture({
        tenantId: otherCtx.tenantId,
        contentHash: "o",
        status: "forgotten",
        content: "他のテナントの本文",
      }),
    );

    await purge(store, target.id);
    await expect(purge(store, target.id, otherCtx)).rejects.toThrow();

    const after = await store.get(otherCtx, otherTenant.id);
    expect(after?.content).toBe("他のテナントの本文");
    expect(after?.purgedAt ?? null).toBeNull();
  });
});
