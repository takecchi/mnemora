import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `tags` は LLM が返した並びのまま保存される（並べ替えない）ので、別々の `observe()` が同じ語彙を違う順で返すと、
 * `labels` の行ロックを逆順に取り合って `deadlock detected`（40P01）になりうる。`labels` を触る順は `tags` の並びではなく名前の順に固定し、`Memory.tags` の並び・重複は変えない。
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
        if (r.status === "rejected") {
          const reason = r.reason as Error & { cause?: { message?: string; code?: string } };
          // drizzle は元の例外を `Failed query` で包む。deadlock かどうかは cause の SQLSTATE・文面にある。
          failures.push(
            `${reason.message.slice(0, 60)} <-${reason.cause?.code ?? ""} ${reason.cause?.message ?? ""}`,
          );
        }
      }
      expect(failures).toEqual([]);
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
