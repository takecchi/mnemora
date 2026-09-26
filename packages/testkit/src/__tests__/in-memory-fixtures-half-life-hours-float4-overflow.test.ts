// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #817（PR #815 と同根）: `Memory.halfLifeHours`（`memories.half_life_hours` 列、
// Postgres の `real`＝IEEE 754 単精度・float4）に、float64 では有限だが float4 の範囲
// （約 `±3.4028235e38`）を超える値を `createMemory` 経由で渡すと、Postgres は例外を
// 投げるが Fake は静かに受け入れていた。`memories.half_life_hours` は
// `CHECK (half_life_hours > 0 AND half_life_hours < 'Infinity'::real)`
// （migrations/0012_half_life_hours_range.sql）を持つ列であり、値が `real` へ変換される
// 際に `Infinity` へ丸まり CHECK 制約に抵触して Postgres は例外を投げる
// （実測: 本物の Postgres 17 + pgvector を手元に立てて確認した）。
//
// ⚠ Issue #817 本文は「`strength` も同じ列型のため同種の食い違いを持つ可能性が高いが
// 実測していない」と書いていたが、実測すると `strength` にはこの穴は無い——
// `strength` の値域は `(0, MAX_STRENGTH]`（`MAX_STRENGTH = 1`、`packages/core/src/memory.ts`）
// であり、float4 の範囲（約 `±3.4028235e38`）へ遠く届かない。既存の値域検査
// （`isStrengthInRange`）の時点で `1e300` のような値は既に「範囲外」として拒まれて
// おり（修正前の Fake でも実測済み——別のエラーメッセージだが例外は投げる）、float4
// オーバーフローに到達する前に別の理由で例外になるため、この PR では `strength` に
// float4 専用の検査を足していない。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812/#815 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h1", halfLifeHours: 1e300 }),
      ),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });

  it("Number.MAX_VALUE（float64 の最大値）は例外を投げる", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h2",
          halfLifeHours: Number.MAX_VALUE,
        }),
      ),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });

  it("strength=1e300 は（別の理由=値域外で）引き続き例外を投げる（回帰確認、float4 検査は不要）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h3", strength: 1e300 }),
      ),
    ).rejects.toThrow(/strength out of range/);
  });

  it("3e38（float4 の範囲に収まる）と既定の720はどちらも引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h4", halfLifeHours: 3e38 }),
    );
    expect(a.halfLifeHours).toBe(3e38);
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h5" }),
    );
    expect(b.halfLifeHours).toBe(720);
  });
});
