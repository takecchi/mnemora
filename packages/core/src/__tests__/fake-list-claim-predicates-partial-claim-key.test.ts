import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 片側だけの claim key は、正しい claim key で書いた後に Fake の内部の `backing` の行を書き換えて作る（`withClaimKey`）: 書き込みの口は片側だけ・空文字の claim key を拒むため。 */

const ctx: Ctx = { tenantId: "tenant-1" };
let n = 0;

function memory(over: Partial<NewMemory> = {}): NewMemory {
  n += 1;
  return {
    tenantId: "tenant-1",
    subjectId: "user-1",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `partial-claim-key-${n}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...over,
  };
}

type Store = ReturnType<typeof createFakeRuntimeStores>["memoryStore"];

const list = (store: Store) =>
  store.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 });

async function withClaimKey(store: Store, claimKey: unknown): Promise<void> {
  const written = await store.createMemory(
    ctx,
    memory({ claimKey: { subject: "tmp", predicate: "tmp" } }),
  );
  (
    store as unknown as { backing: { memories: Map<string, { claimKey: unknown }> } }
  ).backing.memories.get(written.id)!.claimKey = claimKey;
}

describe("FakeMemoryStore.listActiveClaimPredicates: 片側だけの claim key（ADR 0563）", () => {
  it("subject だけの claim key は数えず、TypeError にもならない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await withClaimKey(memoryStore, { subject: "user" });
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "favorite_color" } }),
    );
    await expect(list(memoryStore)).resolves.toEqual(["favorite_color"]);
  });

  it("predicate だけの claim key は数えない（predicate を別のキーとして混ぜない）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await withClaimKey(memoryStore, { predicate: "home_city" });
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "favorite_color" } }),
    );
    await expect(list(memoryStore)).resolves.toEqual(["favorite_color"]);
  });

  it("片側だけの claim key しか無いときは空配列", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await withClaimKey(memoryStore, { subject: "user" });
    await withClaimKey(memoryStore, { predicate: "home_city" });
    await expect(list(memoryStore)).resolves.toEqual([]);
  });

  it("片側が null の claim key も数えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await withClaimKey(memoryStore, { subject: "user", predicate: null });
    await withClaimKey(memoryStore, { subject: null, predicate: "home_city" });
    await expect(list(memoryStore)).resolves.toEqual([]);
  });

  it("対照: 両方そろった claim key は数える。空文字の claim key は、書き込みの口が拒む（ADR 0630。以前は書けて、数えた）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "older" } }),
    );
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "newer" } }),
    );
    await expect(
      memoryStore.createMemory(ctx, memory({ claimKey: { subject: "", predicate: "" } })),
    ).rejects.toThrow(/claimKey/);
    const result = await list(memoryStore);
    expect(result.sort()).toEqual(["newer", "older"]);
  });

  it("対照: claim key が無い Memory・別 subject・active でない Memory は、これまでどおり数えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, memory());
    await memoryStore.createMemory(
      ctx,
      memory({ subjectId: "user-2", claimKey: { subject: "user", predicate: "other_subject" } }),
    );
    await memoryStore.createMemory(
      ctx,
      memory({ status: "archived", claimKey: { subject: "user", predicate: "archived" } }),
    );
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "kept" } }),
    );
    await expect(list(memoryStore)).resolves.toEqual(["kept"]);
  });
});
