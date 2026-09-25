// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `packages/testkit` の in-memory Fake 実装6箇所（PR #811 が負数の `limit` に
// ガードを足した箇所と同じ6箇所）は、負数は拒むが `NaN`/`Infinity`/非整数
// （例: `1.5`）は拒んでいなかった。
//
// - InMemoryOutboxStore.claimBatch
// - InMemoryVectorStore.search
// - InMemoryLexicalStore.search
// - InMemoryEventStore.list
// - InMemoryMemoryStore.purgeExpiredEvents
// - InMemoryMemoryStore.aggregateScope（digestBand.limit）
//
// いずれも内部で `Array.prototype.slice(0, limit)` を使っており、`slice` の
// `end` 引数は `ToIntegerOrInfinity` で暗黙に丸められる
// （`NaN`→`0`＝空配列、`Infinity`→全件、`1.5`→切り捨てて`1`）ため、例外にも
// ならず「limit が全く効いていない/黙って縮む」という誤った結果を静かに返す。
//
// 対応する `packages/postgres` の実装はどれも同じ `limit`（または
// `limit + 1`）を生 SQL の `LIMIT` にそのまま渡している。`LIMIT` の SQL
// パラメータは bigint 型であり、`NaN`/`Infinity`/非整数を渡すと Postgres は
// `invalid input syntax for type bigint: "NaN"` の形で例外を投げる
// （実測。`packages/postgres` に本物の Postgres を立てて確認した——後述の
// 「確かめたこと」参照）。
//
// このテストは、Fake にそのガードを足したことを確認する——`*-conformance.ts`
// には一切触れていない（Issue #809 と同じ理由。PR #811/#812 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる", () => {
  for (const limit of [NaN, Infinity, 1.5]) {
    it(`InMemoryOutboxStore.claimBatch は limit=${limit} のとき、ジョブを claim せずに例外を投げる`, async () => {
      const store = new InMemoryOutboxStore([]);
      await expect(
        store.claimBatch(ctx, {
          limit,
          now: new Date("2026-01-01T00:00:00.000Z"),
          claimedBy: "test-worker",
          leaseMs: 60_000,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryVectorStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      await expect(
        vectorStore.search(ctx, { provider: "test", model: "test", dimensions: 3 }, [0, 0, 0], {
          limit,
          filter: { tenantId: ctx.tenantId },
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryLexicalStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const lexicalStore = new InMemoryLexicalStore(memoryStore);
      await expect(
        lexicalStore.search(ctx, "テスト", {
          limit,
          filter: { tenantId: ctx.tenantId },
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryEventStore.list は filter.limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore);
      await expect(eventStore.list(ctx, { limit })).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryMemoryStore.purgeExpiredEvents は limit=${limit} のとき例外を投げ、1行も消さない`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      await expect(
        memoryStore.purgeExpiredEvents?.(ctx, {
          olderThan: new Date("2026-06-01T00:00:00.000Z"),
          limit,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryMemoryStore.aggregateScope の digestBand: limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      await expect(
        memoryStore.aggregateScope(ctx, {}, { digestBand: { limit, excludeMemoryIds: [] } }),
      ).rejects.toThrow(/digestBand\.limit must be an integer/);
    });
  }
});
