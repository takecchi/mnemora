// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryOutboxStore.claimBatch`（packages/testkit/src/__fixtures__/in-memory-outbox-store.ts）は
// `opts.now` と `opts.leaseMs` を検査せず、`now - leaseMs` を数のまま比べていた。
// `PostgresOutboxStore.claimBatch` は `now` と `new Date(now - leaseMs)` を `timestamptz` の
// パラメータとして送るため、どちらかが Invalid Date になる入力では例外になる（実測: 本物の
// Postgres 17 + pgvector。`leaseMs` が `NaN` / `Infinity` / `-Infinity` / `1e20`、`now` が
// Invalid Date のとき、`invalid input syntax for type timestamp with time zone`）。
//
// 修正前の Fake は、`leaseMs` が `NaN` / `±Infinity` / `1e20` でも例外を投げず、まだ claim
// されていないジョブを実際に claim していた（`claimedAt`・`attempts` の書き込み）。
//
// ⚠ `new Date(now - leaseMs)` が `Date` としては有効でも、Postgres の `timestamptz` の範囲
// （紀元前4713年より前）を外れると Postgres だけが例外になる（実測: `leaseMs: 8e15` で
// `timestamp out of range`）。表現できる範囲の違いは Issue #1041 の論点なので、ここでは
// 揃えない。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には触れていない（Issue #809）。

import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-01-01T00:00:00.000Z");

function unclaimedJob(): OutboxJobRecord {
  return {
    id: "job-1",
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: {},
    availableAt: new Date("2025-12-31T00:00:00.000Z"),
    claimedAt: null,
    claimedBy: null,
    attempts: 0,
    completedAt: null,
    failedAt: null,
    createdAt: new Date("2025-12-31T00:00:00.000Z"),
  };
}

describe("InMemoryOutboxStore.claimBatch: リースの境界時刻が Date にならない入力は、Postgres と同じく例外を投げ、1件も claim しない", () => {
  const cases: [label: string, now: Date, leaseMs: number][] = [
    ["leaseMs=NaN", NOW, Number.NaN],
    ["leaseMs=Infinity", NOW, Number.POSITIVE_INFINITY],
    ["leaseMs=-Infinity", NOW, Number.NEGATIVE_INFINITY],
    ["leaseMs=1e20", NOW, 1e20],
    ["now=Invalid Date", new Date(Number.NaN), 60_000],
  ];
  for (const [label, now, leaseMs] of cases) {
    it(`${label} は例外を投げ、claimedAt も attempts も変えない`, async () => {
      const job = unclaimedJob();
      const store = new InMemoryOutboxStore([job]);
      await expect(
        store.claimBatch(ctx, { limit: 5, now, claimedBy: "test-worker", leaseMs }),
      ).rejects.toThrow(/claimBatch: now - leaseMs must be a valid Date/);
      expect(job.claimedAt).toBeNull();
      expect(job.attempts).toBe(0);
    });
  }

  // 回帰確認: 有限の leaseMs（0・負数・小数を含む）は、これまでどおり claim する
  // （実測: Postgres も例外にならない）。
  for (const leaseMs of [0, -1_000, 0.5, 60_000]) {
    it(`leaseMs=${leaseMs} は例外を投げず、未 claim のジョブを claim する（回帰確認）`, async () => {
      const job = unclaimedJob();
      const store = new InMemoryOutboxStore([job]);
      const claimed = await store.claimBatch(ctx, {
        limit: 5,
        now: NOW,
        claimedBy: "test-worker",
        leaseMs,
      });
      expect(claimed.map((j) => j.id)).toEqual(["job-1"]);
      expect(job.attempts).toBe(1);
    });
  }
});
