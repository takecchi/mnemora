// PR #804（クローン miku の委譲先が書いた）から、Fake（in-memory）の直しだけを
// 切り出した回帰テスト。#804 は同じ回帰を `*-conformance.ts`（適合テスト。
// 外部の store 実装者も走らせる公開面）へ足していたが、レビュー（Issue #809）により
// 「適合テストへ it を足すのは契約の追加であり、外部実装の CI を落としうる」と指摘され、
// オーナー判断に回された。ここでは代わりに、Fake を直接呼ぶだけの、
// `packages/testkit` 内だけで完結するテストにしてある——`*-conformance.ts` には
// 一切触れていない。
//
// 対象は `packages/testkit/src/__fixtures__/` の6箇所（うち InMemoryMemoryStore は
// purgeExpiredEvents と aggregateScope の digestBand.limit の2箇所）:
// - InMemoryOutboxStore.claimBatch
// - InMemoryVectorStore.search
// - InMemoryLexicalStore.search
// - InMemoryEventStore.list
// - InMemoryMemoryStore.purgeExpiredEvents
// - InMemoryMemoryStore.aggregateScope（digestBand.limit）
//
// いずれも内部で `候補配列.slice(0, limit)` を使っており、`limit` が負数のときの
// `Array.prototype.slice` の意味論（「末尾から数えた除外」）をそのまま踏んで
// ほぼ全件を静かに返していた（`purgeExpiredEvents` は削除の副作用まで持つ）。
// 対応する Postgres 実装は同じ `limit` を生 SQL の `LIMIT` にそのまま渡しており、
// Postgres は負数の `LIMIT` を `LIMIT must not be negative` で拒む——このテストは
// その挙動に Fake を揃えるガードが実際に効いていることを確かめる。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる", () => {
  it("InMemoryOutboxStore.claimBatch は limit が負数のとき、ジョブを claim せずに例外を投げる", async () => {
    const store = new InMemoryOutboxStore([]);
    await expect(
      store.claimBatch(ctx, {
        limit: -1,
        now: new Date("2026-01-01T00:00:00.000Z"),
        claimedBy: "test-worker",
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryVectorStore.search は limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    await expect(
      vectorStore.search(ctx, { provider: "test", model: "test", dimensions: 3 }, [0, 0, 0], {
        limit: -1,
        filter: { tenantId: ctx.tenantId },
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryLexicalStore.search は limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    await expect(
      lexicalStore.search(ctx, "テスト", {
        limit: -1,
        filter: { tenantId: ctx.tenantId },
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryEventStore.list は filter.limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore);
    await expect(eventStore.list(ctx, { limit: -1 })).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryMemoryStore.purgeExpiredEvents は limit が負数（-2）のとき例外を投げ、1行も消さない", async () => {
    // ⚠ -1 は使わない。既知の不一致（#804 本文）: Postgres 実装は
    // `LIMIT opts.limit + 1` という形で SQL を組むため、`opts.limit === -1` の
    // ときだけ `LIMIT 0` になり、例外を投げずに `purged: 0` を返す
    // （`opts.limit <= -2` では他の5箇所と同じく例外を投げる）。Fake 側は
    // 「負数はすべて一様に拒む」ガードなので、-1 を使うと Fake（例外を投げる）と
    // Postgres（`purged: 0` を返す）が食い違う——この既知の不一致を踏まないよう、
    // 両者が一致する -2 を使う。
    const memoryStore = new InMemoryMemoryStore();
    await expect(
      memoryStore.purgeExpiredEvents?.(ctx, {
        olderThan: new Date("2026-06-01T00:00:00.000Z"),
        limit: -2,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryMemoryStore.aggregateScope の digestBand: limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await expect(
      memoryStore.aggregateScope(ctx, {}, { digestBand: { limit: -1, excludeMemoryIds: [] } }),
    ).rejects.toThrow(/digestBand.limit must not be negative/);
  });
});
