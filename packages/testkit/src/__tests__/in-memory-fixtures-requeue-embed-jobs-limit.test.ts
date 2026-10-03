// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryMemoryStore.requeueEmbedJobs`（packages/testkit/src/__fixtures__/in-memory-memory-store.ts）
// は `opts.limit` を検査せず `.slice(0, Math.max(0, opts.limit))` へ渡していた——Issue #880
// で `archiveDecayed` から取り除いたのと同じ形が、この口に残っていた。
// `PostgresMemoryStore.requeueEmbedJobs` は同じ `limit` を生 SQL の `LIMIT`（bigint
// パラメータ）にそのまま渡す。`NaN`・`Infinity`・非整数は、bigint への変換の時点で必ず例外になる
// （実測: 本物の Postgres 17 + pgvector。`invalid input syntax for type bigint: "NaN"` /
// `"Infinity"` / `"1.5"`）。負数の `LIMIT must not be negative` は、テナントの行が1本も無く
// `memories` の統計が古い（`reltuples = 0`）と投げずに `{ requeued: 0 }` で返る（`LIMIT` が CTE の中で
// `never executed` になる。ADR 0575 と同じ形）。この Fake は常に断る——このテストは Postgres と突き合わせない。
//
// 修正前の Fake は例外を投げず、`embeddingStatus` を `pending` に戻して embed ジョブを
// 積む書き込みまで行っていた——`limit: Infinity` は対象を全件、`limit: 1.5` は1件。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には触れていない（Issue #809）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

async function seedFailedMemories(store: InMemoryMemoryStore, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `h-${i}`,
        embeddingStatus: "failed",
      }),
    );
    ids.push(memory.id);
  }
  return ids;
}

describe("InMemoryMemoryStore.requeueEmbedJobs: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も積み直さない", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 63, 1e21]) {
    it(`limit=${limit} は例外を投げ、embeddingStatus も outbox も変えない`, async () => {
      const store = new InMemoryMemoryStore();
      const ids = await seedFailedMemories(store, 3);
      const jobsBefore = store.outboxJobs.length;

      await expect(store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit })).rejects.toThrow(
        /limit must (be an integer|not be negative|fit in a Postgres bigint)/,
      );

      for (const id of ids) {
        expect((await store.get(ctx, id))?.embeddingStatus).toBe("failed");
      }
      expect(store.outboxJobs.length).toBe(jobsBefore);
    });
  }

  // 境界の回帰確認: 0・1・ちょうど対象数・対象数+1・bigint に収まる大きな値は Postgres と
  // 同じ件数を返す（実測: Postgres も 0 / 1 / 3 / 3 / 3）。
  for (const [limit, expected] of [
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 3],
    [2 ** 62, 3],
  ] as const) {
    it(`limit=${limit} は ${expected} 件を積み直す（回帰確認）`, async () => {
      const store = new InMemoryMemoryStore();
      await seedFailedMemories(store, 3);
      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit });
      expect(result.requeued).toBe(expected);
      expect(result.memoryIds).toHaveLength(expected);
    });
  }
});
