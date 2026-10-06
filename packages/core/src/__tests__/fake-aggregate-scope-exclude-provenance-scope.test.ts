import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { Provenance } from "../provenance.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）で、PR #1458（ADR 0390）の変異試験が**すり抜けた**
 * 「Fake が archived の行も数える」を塞ぐ歯。担当はクローン（miku）の判断で進めている作業であり、
 * オーナーの判断ではない。`fake-aggregate-scope-exclude-provenance.test.ts` の seed は全部 active・絞りなしで、
 * 絞りで落ちる行が無かった。
 *
 * `excludedProvenanceIndexedCount` は「除外する kind で、ready で、`totalInScope` と同じ絞りの内側の行」
 * を数える（ADR 0390 決定1・2）。archived・別 subject・期間の外・labels に合わない行は数えない。
 * 同じ形の歯が InMemory（testkit）と Postgres にも在る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };
const IN_PERIOD = new Date("2026-06-10T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-01-01T00:00:00.000Z");
let counter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: "s1",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `agg-exclude-prov-scope-${counter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: ["alpha"],
    occurredAt: null,
    recordedAt: IN_PERIOD,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  } as NewMemory;
}

const scope = {
  subjectId: "s1",
  labels: ["alpha"],
  occurredAfter: new Date("2026-06-01T00:00:00.000Z"),
};

describe("FakeMemoryStore.aggregateScope: excludedProvenanceIndexedCount は totalInScope と同じ絞りの内側だけを数える（Issue #1734 / PR #1458 のすり抜け）", () => {
  async function seed() {
    const { memoryStore } = createFakeRuntimeStores();
    // 数える: スコープ内・active・ready・除外 kind
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated }));
    // 数えない（絞りで落ちる行。どれも除外 kind・ready）
    await memoryStore.createMemory(
      ctx,
      newMemory({ provenance: consolidated, status: "archived" }),
    );
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated, subjectId: "s2" }));
    await memoryStore.createMemory(
      ctx,
      newMemory({ provenance: consolidated, recordedAt: BEFORE_PERIOD }),
    );
    await memoryStore.createMemory(ctx, newMemory({ provenance: consolidated, tags: ["beta"] }));
    // 除外 kind ではない行（スコープ内）
    await memoryStore.createMemory(ctx, newMemory());
    return memoryStore;
  }

  it("archived・別 subject・期間の外・labels に合わない行は、除外 kind でも数えない", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(ctx, scope, {
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    // 対照: スコープ内の行は除外 kind の2件と、除外 kind でない1件（totalInScope の意味は変えない）
    expect(aggregate.totalInScope).toBe(3);
    expect(aggregate.filteredArchived.count).toBe(1);
  });
});
