import { describe, expect, it } from "vitest";
import type { VectorHit, VectorStore } from "@mnemora/core";
import { stage3_5DbMs, type VectorStoreSpy, wrapVectorStoreWithSpy } from "../vector-store-spy.js";

/**
 * Issue #1012: association-scale 系ベンチの VectorStore の包みの歯。
 *
 * 包みが、内側の store が持つ任意の一括の口（`searchMany?`、PR #932）を外へ出さないと、
 * runtime の段3.5 は「`searchMany` が無い adapter」とみなしてアンカーごとに `search()` を
 * 撃つ——本番（`PostgresVectorStore` は `searchMany` を持つ）と違う経路の往復・時間を測る。
 * ここでは、包みが `searchMany` を外へ出し、1回の束を1件として（時間は束の単位で、按分しない）
 * 記録し、段3.5 の DB 時間に含めることを測る。
 */

const hit = (memoryId: string): VectorHit => ({ memoryId, distance: 0.1 }) as VectorHit;

function innerStore(): VectorStore {
  return {
    upsert: async () => {},
    delete: async () => {},
    search: async () => [hit("stage1")],
    searchMany: async (_ctx, _space, queries) =>
      new Map(queries.map((q) => [q.key, [hit(`anchor-of-${q.key}`)]])),
    getVectors: async () => [],
  };
}

function newSpy(): VectorStoreSpy {
  const spy: VectorStoreSpy = {
    calls: [],
    reset() {
      spy.calls.length = 0;
    },
  };
  return spy;
}

describe("association-scale 系ベンチの VectorStore の包み（Issue #1012）", () => {
  it("内側が searchMany を持てば、包みも searchMany を外へ出す（runtime が本番と同じ経路を通る）", () => {
    const wrapped = wrapVectorStoreWithSpy(innerStore(), newSpy());
    expect(typeof wrapped.searchMany).toBe("function");
  });

  it("searchMany の1回の束を1件として記録し、結果はそのまま返す", async () => {
    const spy = newSpy();
    const wrapped = wrapVectorStoreWithSpy(innerStore(), spy);
    const space = { provider: "p", model: "m", dimensions: 2 };
    await wrapped.search({ tenantId: "t" }, space, [1, 0], { limit: 1, filter: {} } as never);
    const result = await wrapped.searchMany!(
      { tenantId: "t" },
      space,
      [
        { key: "a", vector: [1, 0] },
        { key: "b", vector: [0, 1] },
      ],
      { limit: 1, filter: {} } as never,
    );

    expect([...result.keys()]).toEqual(["a", "b"]);
    expect(spy.calls.map((c) => c.kind)).toEqual(["search", "searchMany"]);
    const batch = spy.calls[1]!;
    expect(batch.queryCount).toBe(2);
    // 段3.5 の DB 時間は、1回目の search（段1）より後の呼び出しの合計——束はそのまま1件で入る。
    expect(stage3_5DbMs(spy)).toBe(batch.ms);
  });
});
