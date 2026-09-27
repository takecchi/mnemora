// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #817（PR #923）は、`memories.half_life_hours`（Postgres の `real`＝float4）に
// float4 の範囲を**上に**超える値（`1e300` など）を Fake が受け入れる食い違いを塞いだ。
// **下側（アンダーフロー）は塞がれていなかった。**Postgres の `real` は、0 でない値が
// float4 で 0 に丸まると `"…" is out of range for type real` で拒む。`strength` も同じ
// `real` 列であり、値域 `(0, 1]` の中の値（例: `1e-46`）でもこの形で拒まれる。
//
// 【実測】手元の PostgreSQL 17 + pgvector（`initdb`）で `createMemory` に渡した結果:
// - `halfLifeHours: 1e-300` → 例外（`"1e-300" is out of range for type real`）
// - `strength: 1e-300` / `1e-46` → 例外（同上）
// - `strength: 1e-45`（float4 の最小の非正規数 約 1.4e-45 に丸まる）→ 受け付ける
// ⟹ 境界は「`Math.fround(x)` が 0 になるか」とビット単位で一致する（上側の #817 の検査が
// 「`Math.fround(x)` が `Infinity` になるか」で Postgres と一致するのと同じ形）。
//
// `*-conformance.ts` には触れていない（Issue #809 と同じ理由。PR #923 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const REAL = /does not fit in a Postgres "real"/;

describe("InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む", () => {
  it("halfLifeHours: 1e-300 は例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u1", halfLifeHours: 1e-300 }),
      ),
    ).rejects.toThrow(REAL);
    expect(await store.listBySourceObservation(ctx, "none", null)).toEqual([]);
  });

  it("strength: 1e-300 と 1e-46 は例外を投げる（値域 (0, 1] の中でも float4 では 0 になる）", async () => {
    const store = new InMemoryMemoryStore();
    for (const [i, strength] of [1e-300, 1e-46].entries()) {
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `u2-${i}`, strength }),
        ),
      ).rejects.toThrow(REAL);
    }
  });

  it("createMemoryWithOutbox も同じ入口で拒む", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u3", strength: 1e-46 }),
        [],
      ),
    ).rejects.toThrow(REAL);
  });

  it("float4 の非正規数に収まる値（1e-45）と通常の値は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u4", strength: 1e-45 }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u5", halfLifeHours: 1e-40 }),
    );
    const c = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "u6" }),
    );
    expect([a.strength, b.halfLifeHours, c.halfLifeHours]).toEqual([1e-45, 1e-40, 720]);
  });
});
