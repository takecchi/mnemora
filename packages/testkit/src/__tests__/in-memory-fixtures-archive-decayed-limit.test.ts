// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #880: `InMemoryMemoryStore.archiveDecayed`（packages/testkit/src/__fixtures__/in-memory-memory-store.ts）
// は `opts.limit` を検査せず `.slice(0, Math.max(0, opts.limit))` へ渡していた。
// `PostgresMemoryStore.archiveDecayed` は同じ `limit` を生 SQL の `LIMIT`（bigint
// パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数はすべて例外になる
// （実測: 本物の Postgres 17 + pgvector を手元に立てて確認した——
// `LIMIT must not be negative` / `invalid input syntax for type bigint: "NaN"` 等）。
//
// 修正前の Fake は例外を投げず、`Math.max(0, ...)` の丸めに従って実際に書き込みまで
// 行ってしまっていた——`limit: Infinity` は対象を無条件に全件 `archived` にし、
// `limit: 1.5` は `Math.trunc` 相当で1件だけ `archived` にする。このメソッドは
// 書き込みの副作用（`status` を `archived` にし、イベントを積む）を持つため、
// 他の口（PR #811/#875 の limit ガード）より実害が大きい。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812/#875 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

async function seedDecayedMemory(store: InMemoryMemoryStore, contentHash: string) {
  // `buildNewMemoryFixture` の既定値（recordedAt 2026-01-01, halfLifeHours 720,
  // strength 1）は `decayFloorAt` が 2026-05-10 頃になる（fixture の doc コメント参照）
  // ——`NOW`（2026-06-01）はその後なので、`archiveDecayed` の対象（`decay_floor_at <=
  // now`）に入る。
  return store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }));
}

describe("InMemoryMemoryStore.archiveDecayed: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も archived にしない", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    it(`limit=${limit} は例外を投げ、対象の Memory を archived にしない`, async () => {
      const store = new InMemoryMemoryStore();
      const memory = await seedDecayedMemory(store, `h-${limit}`);

      await expect(store.archiveDecayed(ctx, { now: NOW, limit })).rejects.toThrow(
        /limit must (be an integer|not be negative)/,
      );

      const after = await store.get(ctx, memory.id);
      expect(after?.status).toBe("active");
    });
  }

  it("limit=2（正整数）は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await seedDecayedMemory(store, "h-ok");
    const result = await store.archiveDecayed(ctx, { now: NOW, limit: 2 });
    expect(result.archived.map((a) => a.memoryId)).toEqual([memory.id]);
    const after = await store.get(ctx, memory.id);
    expect(after?.status).toBe("archived");
  });
});
