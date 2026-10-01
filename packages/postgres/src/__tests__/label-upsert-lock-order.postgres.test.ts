import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 同じ語彙を逆の並びで `tags` に持つ記憶を同時に作っても、`labels` の行ロックが循環待ちにならない
 * （ADR 0476）。
 *
 * 【実測 2026-10-02】`upsertProposedLabels` は `tags` の並びのまま `labels` を1行ずつ
 * `INSERT … ON CONFLICT DO UPDATE` する。`tags` は LLM が返した並びのまま保存される（並べ替えない）ので、
 * 別々の `observe()` が同じ語彙を違う順で返すと、片方が `a` → `b`、もう片方が `b` → `a` の順で行ロックを
 * 取り合い、Postgres が `deadlock detected`（40P01）で片方を落とす。1回の `createMemory` は
 * 「本文が正しくても raw の例外で落ちる」。直す前は、同じ4語を逆順で持つ6件を6接続で同時に作る
 * 6ラウンドで 36 件中 25 件が落ちた。
 *
 * 直し方は、`labels` を触る順を、`tags` の並びではなく名前の順に固定すること（`contested` ペアの行ロックを
 * id 昇順で取るのと同じ形）。`Memory.tags` の並び・重複は変えない。
 */
afterAll(async () => {
  await closeTestClient();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("PostgresMemoryStore.createMemory は逆順の tags の同時作成で deadlock しない（ADR 0476）", () => {
  it("同じ4語を逆の並びで持つ記憶を6件ずつ同時に作っても、1件も落ちず proposedCount が揃う", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const failures: string[] = [];
    const ROUNDS = 6;
    for (let round = 0; round < ROUNDS; round += 1) {
      const ctx: Ctx = { tenantId: `label-lock-order-${round}` };
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: `lock-order-${round}-${i}`,
              content: `lock-order-${round}-${i}`,
              tags: i % 2 === 0 ? ["a", "b", "c", "d"] : ["d", "c", "b", "a"],
            }),
          ),
        ),
      );
      for (const r of results) {
        if (r.status === "rejected") failures.push(String((r.reason as Error).message));
      }
      const labels = await store.listLabels(ctx);
      expect(labels.map((l) => [l.name, l.proposedCount])).toEqual([
        ["a", 6],
        ["b", 6],
        ["c", 6],
        ["d", 6],
      ]);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("Memory.tags の並びと重複は変えない（ロックの順だけを固定する）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "label-lock-order-tags" };
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "lock-order-tags",
        content: "lock-order-tags",
        tags: ["d", "a", "d", "b"],
      }),
    );
    expect(memory.tags).toEqual(["d", "a", "d", "b"]);
    expect((await store.listLabels(ctx)).map((l) => [l.name, l.proposedCount])).toEqual([
      ["a", 1],
      ["b", 1],
      ["d", 1],
    ]);
  });
});
