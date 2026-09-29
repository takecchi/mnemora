// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #1196（ADR 0357）: `claimBatch` は取り直し（更新前の `claimedAt` が在る行）のときだけ
// `availableAt` を `opts.now` に書き直す。`OutboxJobRecord.claimedAt` は `?: Date | null` であり、
// `InMemoryOutboxStore` は呼び手が渡した配列をそのまま使うので、`claimedAt` を省いた（`undefined`）
// 記録も入りうる。同じファイルの候補の絞り込みはそれを `?? null` で「未 claim」と読んでいる。
// 取り直しの判定だけが `!== null` で読むと、未 claim の job の初回の claim で `availableAt` が動き、
// `PostgresOutboxStore`（`claimed_at IS NULL` を見る）と食い違う。

import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-01-01T00:00:00.000Z");
const AVAILABLE_AT = new Date("2025-12-31T00:00:00.000Z");

describe("InMemoryOutboxStore.claimBatch: claimedAt を省いた記録の初回の claim", () => {
  it("claimedAt が undefined の job は未 claim として扱い、availableAt を変えない", async () => {
    const job: OutboxJobRecord = {
      id: "job-1",
      tenantId: ctx.tenantId,
      kind: "extract",
      payload: {},
      availableAt: new Date(AVAILABLE_AT),
      claimedBy: null,
      attempts: 0,
      completedAt: null,
      failedAt: null,
      createdAt: new Date(AVAILABLE_AT),
    };
    const store = new InMemoryOutboxStore([job]);
    const claimed = await store.claimBatch(ctx, {
      limit: 1,
      now: NOW,
      claimedBy: "w",
      leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.availableAt.getTime()).toBe(AVAILABLE_AT.getTime());
  });
});
