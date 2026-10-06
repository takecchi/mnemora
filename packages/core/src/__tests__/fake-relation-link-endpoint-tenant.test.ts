// Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1474（ADR 0398）の変異試験で、
// 「Fake の `link` が別テナントの記憶を端に取れる」変異がすり抜けた（Fake の `link` を呼ぶ歯が、
// ctx のテナントの記憶しか与えていなかった）。担当はクローン（miku）の判断で進めている作業であり、
// オーナーの判断ではない。
//
// ADR 0398 決定4: core の Fake も、両端（from・to）がどちらも `ctx.tenantId` の実在の記憶であることを
// 書く前に確かめ、無い・別テナントなら行を書かずに `memory not found for tenant` を含む Error を投げる
// （「無い」と「別テナント」は区別しない）。適合テスト（`describeRelationStoreConformance`）は Fake に
// 当たっていない（当たるのは InMemory と Postgres だけ）ので、Fake 自身の歯をここに置く。
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctxA: Ctx = { tenantId: "tenant-link-endpoint-a" };
const ctxB: Ctx = { tenantId: "tenant-link-endpoint-b" };

let counter = 0;
function newMemory(tenantId: string): NewMemory {
  counter += 1;
  return {
    tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `link-endpoint-tenant-${counter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  } as NewMemory;
}

async function setup() {
  const stores = createFakeRuntimeStores();
  const a1 = await stores.memoryStore.createMemory(ctxA, newMemory(ctxA.tenantId));
  const a2 = await stores.memoryStore.createMemory(ctxA, newMemory(ctxA.tenantId));
  const b1 = await stores.memoryStore.createMemory(ctxB, newMemory(ctxB.tenantId));
  return { stores, a1: a1.id, a2: a2.id, b1: b1.id };
}

const GHOST = "00000000-0000-4000-8000-000000000001" as MemoryId;

describe("FakeRelationStore.link: 両端は ctx のテナントの実在の記憶でなければならない（ADR 0398、Issue #1734）", () => {
  it("陽性対照: 同じテナントの2件なら書ける", async () => {
    const { stores, a1, a2 } = await setup();
    await stores.relationStore.link(ctxA, "contradicts", a1, a2);
    expect((await stores.relationStore.listRelated(ctxA, a1)).map((r) => r.memoryId)).toEqual([a2]);
  });

  it.each(["from", "to"] as const)(
    "別のテナントの記憶を %s に取ると断られ、行は書かれない",
    async (end) => {
      const { stores, a1, b1 } = await setup();
      const [fromId, toId] = end === "from" ? [b1, a1] : [a1, b1];
      await expect(stores.relationStore.link(ctxA, "contradicts", fromId, toId)).rejects.toThrow(
        /memory not found for tenant/,
      );
      expect(await stores.relationStore.listRelated(ctxA, a1)).toEqual([]);
      expect(await stores.relationStore.listRelated(ctxB, b1)).toEqual([]);
    },
  );

  it.each([
    ["from", GHOST],
    ["to", GHOST],
    ["from", "not-a-uuid" as MemoryId],
    ["to", "not-a-uuid" as MemoryId],
  ] as const)("存在しない id（%s に %s）は断られ、行は書かれない", async (end, ghost) => {
    const { stores, a1 } = await setup();
    const [fromId, toId] = end === "from" ? [ghost, a1] : [a1, ghost];
    await expect(stores.relationStore.link(ctxA, "contradicts", fromId, toId)).rejects.toThrow(
      /memory not found for tenant/,
    );
    expect(await stores.relationStore.listRelated(ctxA, a1)).toEqual([]);
    expect(await stores.relationStore.listRelated(ctxA, ghost)).toEqual([]);
  });
});
