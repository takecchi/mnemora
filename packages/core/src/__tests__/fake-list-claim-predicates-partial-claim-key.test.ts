import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0563: `FakeMemoryStore.listActiveClaimPredicates` は、`subject` か `predicate` の片方しか無い claim key を持つ
 * Memory を数えない（`InMemoryMemoryStore` は `subject == null || predicate == null` を飛ばし、Postgres は
 * `claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL` で絞る）。
 *
 * 直す前は `claimKey` が在りさえすれば数え、`predicate` が無い行で並べ替えの `Buffer.from(undefined)` が `TypeError` を
 * 投げ、`subject` が無い行は `predicate` を数えに混ぜた。
 *
 * 対応する適合テスト: 「subject か predicate の片方しか無い claim key を持つ Memory は数えない（null を混ぜない）」
 * （`memory-store-conformance.ts`）。**適合テストの対象ではない**（Issue #768 コメント2）。
 */

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

const list = (store: ReturnType<typeof createFakeRuntimeStores>["memoryStore"]) =>
  store.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 });

describe("FakeMemoryStore.listActiveClaimPredicates: 片側だけの claim key（ADR 0563）", () => {
  it("subject だけの claim key は数えず、TypeError にもならない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, memory({ claimKey: { subject: "user" } as never }));
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "favorite_color" } }),
    );
    await expect(list(memoryStore)).resolves.toEqual(["favorite_color"]);
  });

  it("predicate だけの claim key は数えない（predicate を別のキーとして混ぜない）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, memory({ claimKey: { predicate: "home_city" } as never }));
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "favorite_color" } }),
    );
    await expect(list(memoryStore)).resolves.toEqual(["favorite_color"]);
  });

  it("片側だけの claim key しか無いときは空配列", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, memory({ claimKey: { subject: "user" } as never }));
    await memoryStore.createMemory(ctx, memory({ claimKey: { predicate: "home_city" } as never }));
    await expect(list(memoryStore)).resolves.toEqual([]);
  });

  it("片側が null の claim key も数えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: null } as never }),
    );
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: null, predicate: "home_city" } as never }),
    );
    await expect(list(memoryStore)).resolves.toEqual([]);
  });

  it("対照: 両方そろった claim key は数える（空文字も NULL ではないので数える）。新しい順、同着は predicate の順", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(
      ctx,
      memory({ claimKey: { subject: "user", predicate: "older" } }),
    );
    await memoryStore.createMemory(ctx, memory({ claimKey: { subject: "", predicate: "" } }));
    const result = await list(memoryStore);
    expect(result.sort()).toEqual(["", "older"]);
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
